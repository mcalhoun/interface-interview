/**
 * Let a language model discover the capability, compile it, and replay it.
 *
 *     bun run test/support/drive-the-discovery-run.ts          # needs OPENAI_API_KEY
 *
 * Not a test — Vitest only collects `*.test.ts` — and it is the one driver here
 * that costs money, because it makes real calls to a real provider. It exists so
 * that the committed evidence of a model-driven run, and the artifact compiled
 * from it, come out of one command rather than out of a transcript somebody
 * pasted.
 *
 * Nothing is scripted. The model is the real one, the browser is a real
 * Chromium, the application is the real Heritage Core fixture, the policy is the
 * shipped `policies/default.yaml`, and the evidence is written by the real
 * writer with the real scrubber.
 *
 * ## The chain it produces, in one run
 *
 *   goal (a sentence)
 *     -> a live model driving a live browser        (evidence/discovery/<run>/)
 *     -> a Trajectory
 *     -> a compiled Capability Artifact             (artifacts/<capability>/)
 *     -> that document replayed unedited by the engine that has no model
 *
 * The last step is the point of the whole exercise, so it is done here rather
 * than left to a reader: the document is handed straight to `replay` with
 * nothing in between, and the balance it reads is printed.
 *
 * ## Two things it checks and reports rather than asserts
 *
 * 1. **The selection default is the goal's own word.** The goal says "savings";
 *    the screen says "Primary Savings". Recording the screen's label would bind
 *    the capability to this institution's label table and quietly undo
 *    multi-tenant reuse. The driver prints both words side by side.
 * 2. **No value the run typed survives in the document.** The compiler's three
 *    gates already refuse to emit one, and they run here in-process, where the
 *    values still exist and all three can actually look for something.
 *
 * ## Re-running it
 *
 * The evidence directory is removed and rewritten, because an Evidence run
 * directory is exclusive by design. The Artifact store is not: `writeArtifact`
 * refuses to replace a stored version, so a second run reports the refusal and
 * replays the version already on disk. Cut a new one with `--version`.
 */

import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import {
  DEFAULT_BOUNDS,
  DEFAULT_PROVIDER,
  compileArtifact,
  discover,
  discoveredSecrets,
  providerFor
} from "@cua/agent"
import {
  ARTIFACTS_DIRECTORY,
  describeOutputValue,
  loadArtifact,
  writeArtifact
} from "@cua/artifact"
import { evidenceFiles } from "@cua/evidence"
import { serve } from "@cua/legacy-core"
import { DEFAULT_POLICY, POLICIES_DIRECTORY, loadPolicy, policyFrom } from "@cua/policy"
import { playwrightSurface } from "@cua/surface"
import { Effect, Layer, Result } from "effect"
import { replay } from "./replay-harness.ts"
import { scanForSecrets } from "./secret-scan.ts"

/**
 * The goal, and the model.
 *
 * `gpt-4.1`, not the `DEFAULT_MODEL` the CLI uses. That is a finding rather than
 * a preference: `gpt-4.1-mini` proposes an over-constrained Target on the first
 * screen and then repeats it until the loop stops it for cycling. The default is
 * left alone — `provider.ts` argues for it, and one observation is not grounds to
 * overturn an argument — but the run that is committed as evidence has to say
 * which model actually produced it.
 */
const GOAL = "Look up the savings account balance of member 12345"
const MODEL = "gpt-4.1"
const CAPABILITY = "member.account-balance.discovered"
const VERSION = "1.0.0"
/**
 * The run id, which is also the evidence directory's name.
 *
 * It deliberately contains no word from the Goal. Discovery registers every value
 * it discovers with the scrubber, `savings` among them, and the scrubber is
 * field-blind: a run id containing the word would be rewritten to
 * `[redacted:accountType]-...` in every line of the log it stamps. Found the hard
 * way.
 */
const RUN_ID = "gpt-4.1-drove-this"
const EVIDENCE_ROOT = "evidence/discovery"
const OUT = `${EVIDENCE_ROOT}/${RUN_ID}`

const say = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

const program = Effect.gen(function* () {
  const policy = loadPolicy(POLICIES_DIRECTORY, DEFAULT_POLICY)
  if (Result.isFailure(policy)) throw new Error(policy.failure.message)

  // An Evidence run directory is exclusive, so a re-run replaces this one rather
  // than appending a second session's events to the first one's log.
  rmSync(OUT, { recursive: true, force: true })

  const baseUrl = (yield* serve({ port: 0 })).origin
  const sessionId = randomUUID()
  const secrets = discoveredSecrets()

  say(`goal:   ${GOAL}`)
  say(`model:  ${MODEL} (${DEFAULT_PROVIDER})`)
  say(`policy: ${policy.success.name}`)
  say("")

  const trajectory = yield* discover({
    goal: GOAL,
    entry: "/",
    baseUrl,
    runId: RUN_ID,
    sessionId,
    secrets,
    bounds: DEFAULT_BOUNDS,
    modelName: MODEL
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        playwrightSurface({ headless: true }),
        policyFrom(policy.success),
        evidenceFiles({
          root: EVIDENCE_ROOT,
          runId: RUN_ID,
          sessionId,
          scrubber: secrets.registry,
          policy: "Sensitivity policy: every discovered parameter is sensitive (ADR-0008)."
        }),
        providerFor({ provider: DEFAULT_PROVIDER, model: MODEL })
      )
    )
  )

  const conclusion = trajectory.conclusion
  if (conclusion.conclusion !== "reached") {
    say(`the run did not reach the goal: ${conclusion.conclusion}`)
    say(`evidence: ${trajectory.evidenceDirectory}`)
    throw new Error("nothing to compile")
  }
  say(`GOAL REACHED in ${trajectory.steps.length} steps`)
  say(`  ${conclusion.summary}`)
  for (const step of trajectory.steps) {
    say(`  ${step.id}  ${step.intent}${step.outcome.read === undefined ? "" : ` -> ${step.outcome.read}`}`)
  }

  // Ticket 09's property, printed rather than assumed. The goal's word is what a
  // second institution's screen will still answer to; the matched label is this
  // one's, and recording it is the one mistake that undoes multi-tenant reuse.
  for (const selection of trajectory.selections) {
    say("")
    say(`selection rule (${selection.parameter}):`)
    say(`  values read off the live screen: ${selection.values.map((v) => JSON.stringify(v)).join(", ")}`)
    say(`  default recorded:               ${JSON.stringify(selection.default)}   (the goal's word)`)
    say(`  label it matched:               ${JSON.stringify(selection.matched ?? "")}   (this tenant's word, NOT recorded)`)
  }
  say("")
  say(`evidence: ${trajectory.evidenceDirectory}`)

  // ---------------------------------------------------------------------
  // Compiled here, in the process that did the run, because this is the only
  // place the values behind the parameters still exist — which is what lets
  // all three of the compiler's gates look for something.
  // ---------------------------------------------------------------------
  const compiled = compileArtifact(trajectory, {
    capability: CAPABILITY,
    version: VERSION,
    product: "Heritage Core Member Services (MSS 4.02.11)"
  })
  if (Result.isFailure(compiled)) {
    for (const reason of compiled.failure.reasons) say(`  refused: ${reason}`)
    throw new Error(`compilation refused for ${CAPABILITY}`)
  }
  say("")
  const written = writeArtifact(ARTIFACTS_DIRECTORY, compiled.success)
  if (Result.isSuccess(written)) {
    say(`artifact: ${written.success}`)
  } else {
    // An Artifact store is immutable, so a second run of this driver leaves the
    // first run's document in place. Said loudly, because everything printed
    // below it then describes a document this run did not produce, and the
    // evidence directory beside it has already been replaced.
    say(`artifact NOT stored: ${written.failure.message}`)
    say(
      "  the version below is the one already on disk, from an earlier run. Delete it " +
        "first, or pass a new version, if you want this run's document stored."
    )
  }

  // ---------------------------------------------------------------------
  // Replayed unedited, off disk, by the engine that has never seen a model.
  // Off disk rather than out of memory: what runs has to be what a reviewer
  // would have read.
  // ---------------------------------------------------------------------
  const stored = loadArtifact(ARTIFACTS_DIRECTORY, CAPABILITY, VERSION)
  if (Result.isFailure(stored)) throw new Error(stored.failure.message)

  say("")
  say(`replaying ${CAPABILITY}@${VERSION}, unedited, for member 12345...`)
  const replayed = yield* replay({
    artifact: stored.success,
    inputs: { memberId: "12345" },
    runId: "replay-of-the-discovered-capability"
  })
  say(`  run ended: ${replayed.result.result}`)
  if (replayed.result.result === "success") {
    for (const [name, value] of Object.entries(replayed.result.outputs)) {
      say(`    ${name}: ${JSON.stringify(value)}`)
    }
  }
  for (const step of replayed.result.steps) {
    say(`    ${step.id}  ${step.checkpoint}`)
  }

  // ---------------------------------------------------------------------
  // The note a reader of the evidence directory needs, written by the run
  // that produced it. The writer's own redaction note is kept beside it
  // under the name of the run it belongs to, exactly as the two learning
  // directories keep theirs.
  // ---------------------------------------------------------------------
  const leaks = scanForSecrets(OUT, ["12345"])
  const outputLines =
    replayed.result.result === "success"
      ? Object.entries(replayed.result.outputs).map(
          ([name, value]) => `    ${name}: ${describeOutputValue(value)}`
        )
      : ["    (the replay did not succeed)"]

  /** Every refusal the loop recorded, as one line each, read back off the log. */
  const refusals = readFileSync(join(OUT, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { kind: string; action?: string; rationale?: string })
    .filter((event) => event.kind === "decide" && (event.action ?? "").endsWith("(rejected)"))
    .map((event) => `${event.action}: ${(event.rationale ?? "").replace(/^refused: /, "")}`)

  copyFileSync(join(OUT, "README.txt"), join(OUT, "discovery-run.README.txt"))
  writeFileSync(
    join(OUT, "README.txt"),
    [
      "A language model drove this run",
      "===============================",
      "",
      `Produced by: bun run test/support/drive-the-discovery-run.ts`,
      `Model:       ${MODEL}, through @effect/ai-openai, over the OpenAI Responses API`,
      `Goal:        "${GOAL}"`,
      "",
      "The same run through the CLI, which does everything above except name its own",
      "evidence directory — it uses a timestamp — and except replaying the document",
      "afterwards:",
      "",
      `    bun run discover "${GOAL}" \\`,
      `      --model ${MODEL} --emit ${CAPABILITY}`,
      "",
      "Nothing here is scripted. The judgement is a real model's, the browser is a",
      "real headless Chromium, the application is the real Heritage Core fixture on",
      "an ephemeral port, the policy is the shipped policies/default.yaml, and the",
      "evidence was written by the real writer with the real scrubber.",
      "",
      "What it shows",
      "-------------",
      "",
      `The loop reached the goal in ${trajectory.steps.length} steps from a seven-word ` +
        "action vocabulary, and every",
      "step in events.jsonl reads in the same order:",
      "",
      "  decide        the model's proposal, with the rationale it gave for it",
      "  policy.check  the chokepoint, before anything touched the browser",
      "  action        what the adapter actually did, and how the Target resolved",
      "  observe       the screen afterwards",
      "",
      // Read back out of the log rather than described from memory. What a model
      // gets wrong differs from run to run, and a paragraph in this file naming
      // a correction that did not happen is exactly the kind of hand-written
      // claim this directory exists to avoid.
      ...(refusals.length === 0
        ? ["Nothing the model proposed was refused on this run."]
        : [
            `${refusals.length} proposal(s) were refused and corrected rather than ending the`,
            "run. Each is a `decide` event in the log, and each names what to change:",
            "",
            ...refusals.map((refusal) => `  ${refusal}`)
          ]),
      "",
      "The model never saw a screenshot. Screenshots are captured per step and go to",
      "this directory; what entered the prompt was the accessibility tree (ADR-0001).",
      "",
      "What it produced",
      "----------------",
      "",
      `    artifacts/${CAPABILITY}/${VERSION}.yaml`,
      "",
      "compiled in the same process, and then replayed unedited by the engine that",
      "has no model in it at all:",
      "",
      ...outputLines,
      "",
      "The whole chain is one run: a sentence, a live model, a trajectory, a compiled",
      "document, and a deterministic replay of that document.",
      "",
      "The word that was recorded",
      "--------------------------",
      "",
      "The goal says \"savings\". This institution's screen says \"Primary Savings\".",
      "What the artifact records as the selection default is the goal's word, and the",
      "matched label is reported but not recorded:",
      "",
      ...trajectory.selections.map(
        (selection) =>
          `    default: ${JSON.stringify(selection.default)}   matched: ${
            JSON.stringify(selection.matched ?? "")
          }`
      ),
      "",
      "That is what lets the same document serve an institution labelling the account",
      "\"Regular Savings\" with no override and no second artifact.",
      "",
      "Redaction",
      "---------",
      "",
      "Discovery cannot know its sensitive values in advance — its only input is a",
      "sentence, and which parameters exist is what the run is there to find out. So",
      "a value is registered with the scrubber at proposal time, before the policy",
      "check, before the action, and before the decide event that first quotes it.",
      "",
      ...(leaks.length === 0
        ? [
            "grep for the member number over everything this run wrote — events.jsonl and",
            "the writer's own redaction note, kept beside this file as",
            "discovery-run.README.txt — returns nothing. It reads [redacted:memberId]",
            "wherever the application rendered it back, including inside the account number",
            "that embeds it.",
            "",
            "It does appear in this file, twice: in the goal sentence and in the command that",
            "reproduces the run. Those are words a person types, not values the system",
            "recorded, and this file is a note rather than a record."
          ]
        : [
            "WARNING: the member number was found in what this run wrote:",
            ...leaks.map((leak) => `  ${leak.file}:${leak.line}`)
          ]),
      "",
      "The screenshots are not redacted and render the member number and the balances",
      "as captured. That is a stated limit rather than an oversight; see",
      "discovery-run.README.txt beside this file, and ADR-0010.",
      ""
    ].join("\n")
  )
  say("")
  say(`wrote ${OUT}`)
  say(`member number found in this directory's text files: ${leaks.length}`)
}).pipe(Effect.scoped)

Effect.runPromise(program).catch((cause) => {
  console.error(String(cause))
  process.exitCode = 1
})
