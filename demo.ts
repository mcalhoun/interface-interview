/**
 * `bun run demo` runs the whole arc, unattended, in one command.
 *
 * Nine acts, in the order the system was built: a catalog an agent can read, a
 * goal that becomes a capability, deterministic replay of that capability, the
 * three things that are not failures, a person taking the live session, the two
 * amendments that came out of two interventions, the assisted rung between
 * replay and a person, the same capability at a second institution, and a scan
 * over everything the demo just wrote.
 *
 * Every act prints the command a person would run and where its evidence landed.
 * Everything under `evidence/demo/` is written by this run and is safe to delete;
 * the committed directories beside it (`discovery/`, `learning/`, `tenant/`,
 * `assist/`) are deliverables and this file never writes to them.
 *
 * ## What is real here, and what is not
 *
 * Real: one Chromium per run, the real Heritage Core fixture, the shipped
 * `policies/default.yaml`, the real Evidence writer with the real scrubber, the
 * real operator interface over HTTP, and the real amendment and override
 * mechanisms.
 *
 * Not real: the model's judgement. `OPENAI_API_KEY` in this environment is
 * revoked, so acts 2, 5 and 7b stand a script in at `LanguageModel.make`, the
 * same provider hook `@effect/ai-openai` fills, and say so where they do it.
 * Act 7a makes a genuine HTTP call to OpenAI and shows what comes back.
 *
 * Two acts drive a person, because there is nobody at this keyboard. They use
 * the same harness the tests use, which posts to the real operator interface and
 * acts on the automation's own browser window. The equivalent human command is
 * printed beside each.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { compileArtifact, modelAdvisor } from "@cua/agent"
import {
  ARTIFACTS_DIRECTORY,
  OVERRIDES_DIRECTORY,
  describeOutputValue,
  formatArtifact,
  prepareInputs
} from "@cua/artifact"
import { declassifierFor, sensitivityPolicy } from "@cua/policy"
import { type Advisor, type ReplayResult, proposeAmendment, scrubberFor } from "@cua/replay"
import { Effect, Result } from "effect"
import { runDiscovery } from "./test/support/discovery-harness.ts"
import { GOAL, readsTheScreen } from "./test/support/discovery-script.ts"
import { attendedReplay } from "./test/support/handoff-harness.ts"
import { replay, shippedArtifact } from "./test/support/replay-harness.ts"
import { respondingModel, scriptedModel } from "./test/support/scripted-model.ts"
import { UNSCANNED_EXTENSIONS, filesUnder, scanForSecrets } from "./test/support/secret-scan.ts"

const DEMO_ROOT = join("evidence", "demo")
const CAPABILITY = "member.account-balance"
const DISCOVERED = "member.account-balance.discovered"

/** Every member number this demo types, so the last act can look for all of them. */
const MEMBERS = ["12345", "99999", "55555", "88888", "77777"] as const

const say = (line = ""): void => {
  process.stdout.write(`${line}\n`)
}

const indent = (text: string, by = "  "): void => {
  for (const line of text.replace(/\n+$/, "").split("\n")) say(line === "" ? "" : by + line)
}

let actNumber = 0
const ACTS = 9

const act = (title: string): void => {
  actNumber += 1
  say()
  say("=".repeat(78))
  say(`  ACT ${actNumber} OF ${ACTS}   ${title}`)
  say("=".repeat(78))
  say()
}

const note = (lines: ReadonlyArray<string>): void => {
  for (const line of lines) say(line === "" ? "" : `  ${line}`)
  say()
}

/** Where an act's evidence was put, printed the same way every time. */
const landed = (path: string): void => {
  say(`  evidence -> ${path}`)
}

// ---------------------------------------------------------------------------
// Running the documented commands, rather than describing them
// ---------------------------------------------------------------------------

interface CliRun {
  readonly output: string
  readonly exitCode: number
  readonly evidenceDirectory: string | undefined
}

/**
 * Runs one of the CLI commands the README documents, in a child process.
 *
 * The demo could call the same functions in-process and be faster. It spawns
 * instead, because a demo whose acts are not the commands in the README is a
 * demo that can drift from it. What is printed below each `$` line is that
 * command's own output, unedited apart from the wrapper line `bun run` prints.
 */
const cli = async (
  args: ReadonlyArray<string>,
  options: { readonly quiet?: boolean } = {}
): Promise<CliRun> => {
  if (options.quiet !== true) {
    say(`  $ bun run ${args.join(" ")}`)
    say()
  }
  const child = Bun.spawn({
    cmd: ["bun", "run", ...args],
    stdout: "pipe",
    stderr: "pipe"
  })
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  const exitCode = await child.exited
  const output = [out, err]
    .join("")
    .split("\n")
    // `bun run <script>` echoes the underlying command, and `error: script
    // "replay" exited with code 1` is bun reporting a non-zero exit the demo
    // reports itself. Neither is the program speaking.
    .filter((line) => !line.startsWith("$ ") && !line.startsWith("error: script "))
    .join("\n")
  if (options.quiet !== true) indent(output, "    ")
  // The summary report prints one; `--json` carries the same path as a field.
  const found = /^evidence: (.+)$/m.exec(output) ?? /"evidenceDirectory": "(.+)"/.exec(output)
  return { output, exitCode, evidenceDirectory: found?.[1] }
}

/** Copies a run's evidence under `evidence/demo/`, so one directory holds it all. */
const collect = (from: string | undefined, slot: string): string => {
  const to = join(DEMO_ROOT, slot)
  if (from !== undefined && existsSync(from)) cpSync(from, to, { recursive: true })
  else mkdirSync(to, { recursive: true })
  return to
}

const exitLine = (run: CliRun): string =>
  `  exit code ${run.exitCode}${
    run.exitCode === 0 ? "  (nothing here needs a person)" : "  (this run produced no answer)"
  }`

// ---------------------------------------------------------------------------
// The scripted stand-ins, and the banner that says they are scripted
// ---------------------------------------------------------------------------

const NO_MODEL = [
  "NOTE  No language model produced the judgement in this act. OPENAI_API_KEY in",
  "      this environment is revoked (act 7 shows the 401 off a real HTTP call),",
  "      so the model half is scripted at LanguageModel.make, the same provider",
  "      hook @effect/ai-openai fills. Everything below it is the production path.",
  "      With a working key this act is one command and no code change."
] as const

const NO_PERSON = [
  "NOTE  There is nobody at this keyboard, so the operator is scripted: it posts to",
  "      the real operator interface over HTTP and acts on the automation's own",
  "      browser window, which is what a handoff is. The command a person runs",
  "      instead is printed above."
] as const

/** Classifies confidently, over a scripted model. Built exactly as the CLI builds the real one. */
const confidentAdvisor = (): Advisor =>
  modelAdvisor({
    model: scriptedModel([
      {
        name: "classify",
        params: {
          proposedOutcome: "NO_MATCHING_ITEM",
          confidence: 0.92,
          rationale:
            "the account list on this screen offers only Checking; there is no savings " +
            "account to open"
        }
      }
    ])
  })

// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  rmSync(DEMO_ROOT, { recursive: true, force: true })
  mkdirSync(DEMO_ROOT, { recursive: true })

  say()
  say("=".repeat(78))
  say("  Computer-use automation for back-office banking, end to end")
  say("=".repeat(78))
  say()
  note([
    "A model drives a real legacy UI once and the successful run becomes a typed,",
    "versioned capability. From then on the capability is replayed with no model in",
    "the loop at all. What follows is that arc, plus the four things that make it",
    "usable in production: an error taxonomy, a policy chokepoint, redaction, and a",
    "person who can take the live session and hand it back.",
    "",
    "Everything this run writes is under evidence/demo/. Nothing else is touched."
  ])
  note([
    "READ THIS FIRST. The OPENAI_API_KEY available here is revoked, verified as an",
    "HTTP 401 in act 7. So there is no genuine model-driven discovery run in this",
    "repository, and the brief says that is the one thing that cannot be stubbed.",
    "Acts 2, 5 and 7b substitute a script for the model's judgement and label it",
    "where they do. Act 7a reaches OpenAI for real and shows what came back."
  ])

  // -------------------------------------------------------------------------
  act("The catalog: what an agent sees before it calls anything")
  // -------------------------------------------------------------------------
  note([
    "A capability is a callable signature, not a script. This is the whole",
    "agent-facing surface: what it takes, what it returns, which domain answers it",
    "can give instead of returning, where it stops for a person, and the exact line",
    "that invokes it."
  ])
  await cli(["catalog"])
  say()
  note([
    "The second entry is tagged [awaiting review] because it was written by the",
    "compiler rather than by a person. Note also that its accountType default is",
    "withheld: every parameter a model discovers is sensitive by default (ADR-0008),",
    "and the catalog publishes a parameter's domain but never its value."
  ])

  // -------------------------------------------------------------------------
  act("Discovery: a sentence becomes a capability")
  // -------------------------------------------------------------------------
  note([`  goal: "${GOAL}"`, "", "  the equivalent command, with a working key:", "", `  $ bun run discover "${GOAL}"`])
  note(NO_MODEL)

  const discovery = await Effect.runPromise(
    runDiscovery({ goal: GOAL, model: respondingModel(readsTheScreen) })
  )
  const discoveryEvidence = collect(discovery.evidenceDirectory, "02-discovery")

  const conclusion = discovery.trajectory.conclusion
  say(
    conclusion.conclusion === "reached"
      ? `  GOAL REACHED in ${discovery.trajectory.steps.length} steps: ${conclusion.summary}`
      : `  the run stopped without reaching the goal: ${conclusion.conclusion}`
  )
  say()
  say("  steps the model chose, from a seven-word vocabulary:")
  for (const step of discovery.trajectory.steps) {
    say(`    ${step.id}  ${step.intent}`)
  }
  say()
  say("  parameters it inferred from the goal, with nobody declaring a schema:")
  for (const parameter of discovery.trajectory.parameters) {
    say(`    ${parameter.name}  (sensitive: ${parameter.sensitive}; used by ${parameter.usedBy.join(", ")})`)
  }
  for (const selection of discovery.trajectory.selections) {
    say()
    say(`  the selection rule it discovered for ${selection.parameter}:`)
    say(`    values read off the live screen: ${selection.values.map((value) => JSON.stringify(value)).join(", ")}`)
    say(`    default recorded:               ${JSON.stringify(selection.default)}   <- the goal's own word`)
    say(`    label it matched:               ${JSON.stringify(selection.matched ?? "")}   <- this tenant's word, NOT recorded`)
  }
  say()
  note([
    "Which of those two words gets recorded is the whole multi-tenant argument.",
    "Recording \"Primary Savings\" would bind the capability to this institution's",
    "label table. Recording \"savings\" makes act 8 free."
  ])
  landed(discoveryEvidence)

  const compiled = compileArtifact(discovery.trajectory, {
    capability: "member.account-balance.demo",
    version: "1.0.0",
    product: "Heritage Core Member Services (MSS 4.02.11)"
  })
  if (Result.isFailure(compiled)) {
    throw new Error(`the demo's discovery run would not compile: ${compiled.failure.message}`)
  }
  const compiledPath = join(discoveryEvidence, "compiled-artifact.yaml")
  writeFileSync(compiledPath, formatArtifact(compiled.success))
  say()
  say(`  compiled to ${compiledPath}`)
  note([
    "Three gates ran before it was allowed to exist: no fixed literal may echo a",
    "goal term, no fixed literal may contain a value the run typed, and the finished",
    "YAML, prose included, is scanned for both. A member number in a capability is",
    "a compile error rather than a code review comment."
  ])

  const fromDiscovery = await Effect.runPromise(
    replay({ artifact: compiled.success, inputs: { memberId: "12345" }, runId: "compiled-replay" })
  )
  collect(fromDiscovery.evidenceDirectory, "02-discovery-replayed")
  say(`  and replayed, unedited, by the engine that has never seen a model:`)
  say(`    ${describe(fromDiscovery.result)}`)
  landed(join(DEMO_ROOT, "02-discovery-replayed"))
  note([
    `The same document is committed as artifacts/${DISCOVERED}/1.0.0.yaml,`,
    "compiled from the discovery run in evidence/discovery/. It is callable by name:",
    `  $ bun run replay ${DISCOVERED} --memberId 12345`
  ])

  // -------------------------------------------------------------------------
  act("Replay: the same call twice, and the same answer twice")
  // -------------------------------------------------------------------------
  const summary = await cli(["replay", CAPABILITY, "--memberId", "12345"])
  collect(summary.evidenceDirectory, "03-replay")
  say(exitLine(summary))
  say()
  note([
    "Six steps, six checkpoints, all held. A checkpoint is a condition written in",
    "the artifact and asserted after the action; it is not \"the action did not",
    "throw\", which is how automation ends up confidently on the wrong screen.",
    "",
    "Now the same call twice more, with --json, and the two results compared:",
    "",
    `  $ bun run replay ${CAPABILITY} --memberId 12345 --json`
  ])

  const first = await cli(["replay", CAPABILITY, "--memberId", "12345", "--json"], { quiet: true })
  const second = await cli(["replay", CAPABILITY, "--memberId", "12345", "--json"], { quiet: true })
  collect(first.evidenceDirectory, "03-determinism-a")
  collect(second.evidenceDirectory, "03-determinism-b")

  const comparable = (output: string): string =>
    output.replace(/^\s*"(runId|sessionId|evidenceDirectory)":.*$/gm, "")
  say(
    comparable(first.output) === comparable(second.output)
      ? "  Byte-identical once runId, sessionId and evidenceDirectory are removed:\n" +
        "  same outputs, same steps, same actions, same checkpoint verdicts, same order."
      : "  THE TWO RUNS DIFFER. That is a finding, not a formatting problem."
  )
  say()
  note([
    "Determinism means no model in the loop, not no logic. The account was still",
    "chosen by reading the live list and matching a parameter against it. Same list,",
    "same parameter, same choice, every time.",
    "",
    "There is no decide event anywhere in either log, and there cannot be: the replay",
    "engine's effect requires SurfaceAdapter | Policy | Evidence | Session and nothing",
    "else, so a code path reaching for a language model does not compile. A test pins",
    "that requirement set (test/replay-has-no-model.test.ts)."
  ])

  // -------------------------------------------------------------------------
  act("The taxonomy: three things that are not failures")
  // -------------------------------------------------------------------------
  note([
    "A caller has to be able to tell the application saying no from the automation",
    "breaking. Four result classes: success, business_outcome, intervention_required,",
    "failure. Two of the three below exit 0."
  ])

  say("  (a) the application answering: no such member")
  say()
  const notFound = await cli(["replay", CAPABILITY, "--memberId", "99999"])
  collect(notFound.evidenceDirectory, "04a-business-outcome")
  say(exitLine(notFound))
  say()
  note([
    "Declared in the artifact in advance, never inferred at run time from the shape",
    "of a screen. Heritage Core answers a missing member with HTTP 200 and a",
    "well-formed page, so nothing at the transport layer can tell it apart: reading",
    "the screen is the only way, which is why the recognition rule is written down."
  ])

  say("  (b) a transient condition the run gets past on its own")
  say()
  const transient = await cli(["replay", CAPABILITY, "--memberId", "55555"])
  collect(transient.evidenceDirectory, "04b-recoverable")
  say(exitLine(transient))
  say()

  say("  (c) a session that expires mid-flow, re-authenticated and resumed")
  say()
  const expired = await cli([
    "replay",
    CAPABILITY,
    "--memberId",
    "12345",
    "--operatorPassword",
    "HERITAGE",
    "--expireSessionAfter",
    "2"
  ])
  collect(expired.evidenceDirectory, "04c-session-expiry")
  say(exitLine(expired))
  say()
  note([
    "Recovery rules are declared in the artifact too, with a detect condition, a",
    "remedy in the same action vocabulary a step uses, and a bound. The run resumed",
    "at the interrupted step rather than starting over: one run.start, each step",
    "attempted once, and the steps before the interruption never re-ran.",
    "",
    "The password never appears in the evidence. Act 9 checks."
  ])

  // -------------------------------------------------------------------------
  act("Escalation: a person takes the live session, and hands it back")
  // -------------------------------------------------------------------------
  note([
    "Member 77777's savings account is held pending supervisor authorization. Nothing",
    "on the way in announces it, so the run reaches the last screen before it finds",
    "out it cannot finish. Replayed at 1.1.0, the version before anybody had met",
    "this state, it is a generic unknown state:",
    "",
    `  $ bun run replay ${CAPABILITY} --memberId 77777 --version 1.1.0 --headed --handoff`
  ])
  note(NO_PERSON)

  const before = shippedArtifact(CAPABILITY, "1.1.0")
  const episode = await Effect.runPromise(
    attendedReplay({
      artifact: before,
      inputs: { memberId: "77777" },
      runId: "supervisor-hold",
      operate: (desk) =>
        Effect.gen(function* () {
          const paused = yield* desk.awaitPause
          say(`  PAUSED at step ${paused.pending?.intervention.stepId}`)
          say(`    ${paused.pending?.intervention.reason}`)
          say(`    the live browser window is on the screen the run stopped at`)
          say()
          say("  r.mensah takes control")
          yield* desk.post("/take", { operator: "r.mensah" })
          say("    the session owner is now HUMAN; automation cannot act, and a second")
          say("    replay against this session fails with control_lost rather than racing")
          say()
          say("  r.mensah acts, in the automation's own browser window")
          yield* desk.surface.fill({ role: "textbox", name: "Supervisor ID" }, "SUP7")
          yield* desk.surface.fill({ role: "textbox", name: "Authorization Code" }, "4417")
          yield* desk.surface.click({ role: "button", name: "Authorize" })
          say("    filled Supervisor ID, filled Authorization Code, pressed Authorize")
          yield* desk.post("/note", { detail: "entered supervisor override for SUP-HOLD-02" })
          say()
          say("  r.mensah hands control back, and answers the one question")
          say("    \"Next time automation meets this state, should it handle it itself?\"")
          say("    -> no: automation should always stop here")
          yield* desk.post("/return", {
            operator: "r.mensah",
            classification: "resolved",
            detail:
              "released the supervisor hold on this account as an authorized supervisor. " +
              "Nothing about the screen was wrong and nothing was waiting to load; the " +
              "application was refusing, correctly, until somebody with the authority to " +
              "override it said so",
            nextTime: "always_stop_here"
          })
        })
    })
  )
  const episodeEvidence = collect(episode.evidenceDirectory, "05-handoff")
  say()
  say(`  the run resumed from the paused step and finished: ${describe(episode.result)}`)
  say("    it finished because a person acted. The step's checkpoint was re-asked, not")
  say("    its action re-performed: the action had already landed, and what changed was")
  say("    the state, by hand.")
  landed(episodeEvidence)

  const record = episode.snapshot.resolved[0]
  if (record === undefined) throw new Error("the demo's intervention closed without a record")
  const prepared = prepareInputs(
    before.capability,
    before.inputs,
    { memberId: "77777" },
    declassifierFor(sensitivityPolicy, before.capability)
  )
  if (Result.isFailure(prepared)) throw new Error(prepared.failure.message)

  const amendment = proposeAmendment({
    artifact: before,
    record,
    scrub: scrubberFor(prepared.success),
    version: "1.2.0"
  })
  say()
  if (amendment._tag === "Amended") {
    say(`  LEARNED  ${amendment.amended.capability}@${amendment.amended.version} (${amendment.learnedClass})`)
    say(`    ${amendment.because}`)
    writeFileSync(join(episodeEvidence, "proposed-1.1.0-to-1.2.0.diff"), `${amendment.diff}\n`)
    say(`    diff written to ${join(episodeEvidence, "proposed-1.1.0-to-1.2.0.diff")}`)
  } else {
    say(`  the episode taught nothing storable: ${amendment._tag}`)
  }
  say()
  note([
    "The demo stops one step short of storing it. artifacts/ already holds 1.2.0,",
    "cut by exactly this episode when the repository was built, and the store is",
    "append-only: writing it again is refused rather than replaced. Act 6 shows the",
    "committed version and the diff a reviewer approves."
  ])

  // -------------------------------------------------------------------------
  act("Learning: one question, one mechanism, two opposite conclusions")
  // -------------------------------------------------------------------------
  indent(readFileSync(join("evidence", "learning", "README.txt"), "utf8"))
  say()
  say("-".repeat(78))
  say("  evidence/learning/88888-checking-only/1.0.0-to-1.1.0.diff")
  say("-".repeat(78))
  indent(readFileSync(join("evidence", "learning", "88888-checking-only", "1.0.0-to-1.1.0.diff"), "utf8"))
  say()
  say("-".repeat(78))
  say("  evidence/learning/77777-supervisor-hold/1.1.0-to-1.2.0.diff")
  say("-".repeat(78))
  indent(
    readFileSync(join("evidence", "learning", "77777-supervisor-hold", "1.1.0-to-1.2.0.diff"), "utf8")
  )
  say()
  note([
    "Both artifacts were written by a run, not typed by hand. Now the before and",
    "after of each, driven live, with nobody watching:"
  ])

  const escalating = await cli(["replay", CAPABILITY, "--memberId", "88888", "--version", "1.0.0"])
  collect(escalating.evidenceDirectory, "06a-88888-before")
  say(exitLine(escalating))
  say()
  const answered = await cli(["replay", CAPABILITY, "--memberId", "88888"])
  collect(answered.evidenceDirectory, "06b-88888-after")
  say(exitLine(answered))
  say()
  note([
    "The same screen. Before: a run that stops and needs somebody. After: an answer",
    "a caller branches on, unattended, exit 0. The code did not change across the",
    "promotion: the artifact's author had already named this state. What the",
    "intervention taught is its classification, not its vocabulary."
  ])

  const generic = await cli(["replay", CAPABILITY, "--memberId", "77777", "--version", "1.1.0"])
  collect(generic.evidenceDirectory, "06c-77777-before")
  say(exitLine(generic))
  say()
  const routed = await cli(["replay", CAPABILITY, "--memberId", "77777"])
  collect(routed.evidenceDirectory, "06d-77777-after")
  say(exitLine(routed))
  say()
  note([
    "The opposite direction, and the run still stops. What the intervention bought is",
    "the diagnosis: before, a checkpoint failure and an engineer deducing the state",
    "from an expected/observed pair; after, a declared code, the sentence somebody",
    "who already solved it wrote, and a result class that routes to a person instead",
    "of reporting breakage. Learning that a state needs authority never makes it",
    "automatable, and the entry can never be downgraded."
  ])

  // -------------------------------------------------------------------------
  act("The assisted rung: between deterministic replay and waking somebody")
  // -------------------------------------------------------------------------
  note([
    "One bounded consultation, off by default, denied by any policy without an",
    "assist: block. The model gets a stuck screen and a closed list of this",
    "capability's own outcome codes. Its toolkit contains no acting verb at all.",
    "There is nowhere in it to put a control, so a hallucination cannot press one."
  ])

  say("  (a) with the key this environment actually has")
  say()
  const declined = await cli([
    "replay",
    CAPABILITY,
    "--memberId",
    "88888",
    "--version",
    "1.0.0",
    "--assist"
  ])
  const declinedEvidence = collect(declined.evidenceDirectory, "07a-assist-declined")
  say(exitLine(declined))
  say()
  say("  what the evidence records for that consultation:")
  const declinedEvents = join(declinedEvidence, "events.jsonl")
  for (const line of (existsSync(declinedEvents) ? readFileSync(declinedEvents, "utf8") : "").split("\n")) {
    if (line.trim() === "") continue
    const event = JSON.parse(line) as { kind: string; reason?: string; action?: string }
    if (event.kind === "assist.request") say(`    assist.request   the rung was reached`)
    if (event.kind === "policy.check" && event.action === "assist") {
      say(`    policy.check     assist, allowed by the shipped policy`)
    }
    if (event.kind === "assist.declined") {
      say(`    assist.declined  ${(event.reason ?? "").slice(0, 240)}`)
    }
  }
  say()
  note([
    "That is a genuine HTTP round trip to api.openai.com and a genuine 401. The",
    "wiring is proven; the judgement is not. Note what the rung did next: it reported",
    "that it could not settle the stall and the run fell through to exactly the",
    "failure it would have had anyway. A rung whose job is to avoid an escalation",
    "must never be able to cause one."
  ])

  say("  (b) the same run, with the judgement scripted, to show the accepted path")
  say()
  note(NO_MODEL)
  const artifactsBefore = fingerprint(ARTIFACTS_DIRECTORY)
  const assisted = await Effect.runPromise(
    replay({
      artifact: shippedArtifact(CAPABILITY, "1.0.0"),
      inputs: { memberId: "88888" },
      runId: "assisted",
      assist: confidentAdvisor()
    })
  )
  collect(assisted.evidenceDirectory, "07b-assist-accepted")
  say(`    ${describe(assisted.result)}`)
  if (assisted.result.result === "business_outcome") {
    say(`    assisted: ${assisted.result.assisted === true}   confidence: ${assisted.result.confidence}`)
    say(`    proposal: ${assisted.result.proposalRef}`)
  }
  landed(join(DEMO_ROOT, "07b-assist-accepted"))
  say()
  say(
    fingerprint(ARTIFACTS_DIRECTORY) === artifactsBefore
      ? "    artifacts/ is byte-for-byte unchanged across the assisted run."
      : "    artifacts/ CHANGED across the assisted run. That is a bug, not a feature."
  )
  say()
  note([
    "The result is marked assisted, carries its confidence, and points at the",
    "proposal in the evidence, so a caller can always tell a proposed answer from an",
    "observed one. It never counts as deterministic. Promoting a proposal into the",
    "capability still needs a person, through an intervention. A model can propose a",
    "meaning and can never write one down."
  ])

  // -------------------------------------------------------------------------
  act("A second institution, running the same vendor product")
  // -------------------------------------------------------------------------
  note([
    "community-cu differs from heritage-core in four ways: the member-number caption",
    "reads Member # rather than Member Number, savings and checking are labelled",
    "Regular Savings and Share Draft, the submit button reads Find rather than",
    "Search, and account detail is not in an iframe.",
    "",
    "Three of the four cost nothing. The base document, unconfigured:"
  ])

  const unconfigured = await Effect.runPromise(
    replay({
      artifact: shippedArtifact(CAPABILITY),
      inputs: { memberId: "12345" },
      runId: "community-cu-unconfigured",
      core: { tenant: "community-cu" }
    })
  )
  collect(unconfigured.evidenceDirectory, "08a-tenant-unconfigured")
  say(`    ${describe(unconfigured.result)}`)
  say(
    `    steps that held first: ${unconfigured.result.steps
      .filter((step) => step.checkpoint === "held")
      .map((step) => step.id)
      .join(", ")}`
  )
  landed(join(DEMO_ROOT, "08a-tenant-unconfigured"))
  say()
  note([
    "The shortened caption was absorbed by matching on the accessible name, and both",
    "steps before the submit held. The fourth difference is not absorbable (Find and",
    "Search share no token in either direction), so tenant drift surfaces as an",
    "ordinary replay failure, detected by the same mechanism as everything else.",
    "",
    "That failure entered the recovery ladder, the assisted rung named Find as one of",
    "the controls the screen was actually offering, and a person confirmed it once.",
    "Nothing pressed it. The confirmation was written as a scoped delta:"
  ])
  indent(readFileSync(join(OVERRIDES_DIRECTORY, "community-cu", `${CAPABILITY}.yaml`), "utf8"), "    ")
  say()
  note([
    "One entry, and the file contains none of the other three differences. It lives",
    "under overrides/, not artifacts/, so onboarding a tenant moved no file the",
    "vendor-level capability is made of. Now the same capability at both",
    "institutions:"
  ])

  const withDelta = await cli(["replay", CAPABILITY, "--memberId", "12345", "--tenant", "community-cu"])
  collect(withDelta.evidenceDirectory, "08b-tenant-with-override")
  say(exitLine(withDelta))
  say()
  const vendor = await cli(["replay", CAPABILITY, "--memberId", "12345"])
  collect(vendor.evidenceDirectory, "08c-vendor-unchanged")
  say(exitLine(vendor))
  say()
  note([
    "Of the four ways the second institution differs, three cost nothing at all and",
    "the fourth cost one line in one file that nobody wrote. The reason is that reuse",
    "falls out of the matching rule rather than arriving as configuration.",
    "",
    "The four runs behind the committed version of this act, with a README framing",
    "them against the spec's table, are in evidence/tenant/community-cu/."
  ])

  // -------------------------------------------------------------------------
  act("Safety: what is in everything this demo just wrote")
  // -------------------------------------------------------------------------
  const files = filesUnder(DEMO_ROOT)
  const skipped = files.filter((path) =>
    UNSCANNED_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))
  )
  say(`  ${files.length - skipped.length} text files under ${DEMO_ROOT}, ${skipped.length} screenshots skipped`)
  say()

  const report = (what: string, root: string, secrets: ReadonlyArray<string>): void => {
    const appearances = scanForSecrets(root, secrets)
    say(`  ${what}`)
    say(`    looked for ${secrets.map((secret) => JSON.stringify(secret)).join(", ")} in ${root}`)
    if (appearances.length === 0) {
      say("    found nothing.")
      return
    }
    say(`    found ${appearances.length} appearance(s):`)
    for (const appearance of appearances) {
      say(`      ${appearance.file}:${appearance.line}  ${JSON.stringify(appearance.secret)}`)
      say(`        ${appearance.excerpt}`)
    }
  }

  report("every member number this demo typed:", DEMO_ROOT, MEMBERS)
  say()
  // Only in the run that used it. A password is a secret where it was supplied
  // and an ordinary word everywhere else, and looking for it everywhere would
  // find the application's own banner and call it a leak.
  report(
    "the operator password, in the one run that supplied it:",
    join(DEMO_ROOT, "04c-session-expiry"),
    ["HERITAGE"]
  )
  say()
  note([
    "That second scan is the interesting one. Heritage Core's banner reads HERITAGE",
    "CORE in capitals, so the password collides with a word on every screen, and in",
    "that run's evidence the banner itself reads [redacted:operatorPassword] CORE.",
    "The scrubber is field-blind and matches by literal occurrence, which is why."
  ])
  note([
    "Every parameter is sensitive unless the artifact says otherwise in writing AND",
    "policy allowlists it, and the shipped allowlist is empty. A sensitive value is a",
    "Redacted<string> end to end with exactly two places in the workspace that unwrap",
    "one, pinned by a test. The evidence writer scrubs at the single point where an",
    "event is serialised, so redaction does not depend on any call site remembering.",
    "",
    "The cost of matching by literal occurrence is legibility: Heritage Core's",
    "account number embeds the member number, so the evidence reads",
    "00000[redacted:memberId]-S01. Illegible evidence is recoverable; a leaked",
    "identifier is not.",
    "",
    "SCREENSHOTS ARE NOT REDACTED. They render member numbers and balances as",
    "captured. The exclusion above is one line of code in test/support/secret-scan.ts",
    "so the gap is findable rather than silent, and every evidence directory says so",
    "in its own README.txt. Pixel masking is named as a gap, not half-solved."
  ])

  // -------------------------------------------------------------------------
  say()
  say("=".repeat(78))
  say("  Everything this run produced")
  say("=".repeat(78))
  say()
  for (const slot of [
    ...new Set(filesUnder(DEMO_ROOT).map((path) => path.split("/").slice(0, 3).join("/")))
  ].sort()) {
    say(`  ${slot}`)
  }
  say()
  note([
    "Committed beside it, produced the same way and kept as deliverables:",
    "",
    "  evidence/discovery/scripted-model-no-llm-drove-this/   the discovery run",
    "  evidence/learning/                                     the two amendments",
    "  evidence/tenant/community-cu/                          the second institution",
    "  evidence/assist/                                       the assisted rung",
    "",
    "REPORT.md argues every decision above. README.md is how to run any of it.",
    "",
    "The one thing missing: a discovery run a language model actually drove. The key",
    "here is revoked and act 7a shows the 401. With a working key it is one command",
    "and no code change:",
    "",
    `  $ bun run discover "${GOAL}"`
  ])
}

// ---------------------------------------------------------------------------

/** One line about how a run ended, for the acts that do not go through the CLI. */
const describe = (result: ReplayResult): string => {
  const head = `${result.capability}@${result.version}`
  switch (result.result) {
    case "success":
      return `${head}  SUCCESS  ${Object.entries(result.outputs)
        .map(([name, value]) => `${name}: ${describeOutputValue(value)}`)
        .join(", ")}`
    case "business_outcome":
      return `${head}  ${result.code}${result.assisted === true ? "  [ASSISTED]" : ""}`
    case "intervention_required":
      return `${head}  INTERVENTION REQUIRED  ${result.code ?? "(unclassified state)"}`
    case "failure":
      return `${head}  FAILURE  ${result.failure.reason} at ${result.failure.stepId}`
  }
}

/** A cheap content hash of a directory, to show that nothing in it moved. */
const fingerprint = (root: string): string =>
  [...filesUnder(root)]
    .sort()
    .map((path) => `${path}:${readFileSync(path, "utf8").length}`)
    .join("|")

await main()
