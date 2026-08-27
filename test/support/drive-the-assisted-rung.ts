/**
 * Run member `88888` twice, once with the assisted rung and once without.
 *
 *     bun run test/support/drive-the-assisted-rung.ts
 *
 * Not a test — Vitest only collects `*.test.ts` — but built on the same harness
 * the tests use, and here for the reason ticket 14's driver exists: **a committed
 * evidence directory has to be the output of something in this repository.**
 * These two directories had no producer, so a later correction to redaction was
 * applied to them by hand, and files that present as machine-produced records
 * were then partly typed by a person. This closes that.
 *
 * The two runs differ in exactly one thing: whether an Advisor was passed. Same
 * member, same artifact, same policy, same browser, same evidence writer. That
 * is what makes the pair readable as a comparison rather than as two runs.
 *
 * The version is pinned to 1.0.0 on purpose. At `latest` the capability has
 * already *learned* this state from an intervention (ticket 13), so it answers
 * deterministically and the rung would never fire. 1.0.0 is the document that
 * only names the code without saying what it means, which is the state a
 * consultation is for.
 *
 * ## The model
 *
 * The judgement in `checking-only-with-assist/` is scripted at
 * `LanguageModel.make`, the same provider hook `@effect/ai-openai` fills. That
 * is not a missing key: it is that this directory exists to show the *accepted*
 * path, and a live model returning a confidence below the floor would produce a
 * declined consultation instead. The live path is one command with a key and is
 * printed in the note this driver writes beside the two directories.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { modelAdvisor } from "@cua/agent"
import type { Advisor } from "@cua/replay"
import { Effect } from "effect"
import { replay, shippedArtifact } from "./replay-harness.ts"
import { scriptedModel } from "./scripted-model.ts"

const CHECKING_ONLY = "88888"
const CAPABILITY = "member.account-balance"
const BEFORE_LEARNING = "1.0.0"
const OUT = join("evidence", "assist")

const say = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

/**
 * A confident classification, over a scripted model.
 *
 * Built exactly as the CLI builds the real one — `modelAdvisor({ model })` —
 * with a `LanguageModel` layer that answers from a script instead of from a
 * provider. With a key, the only thing that changes at this call site is which
 * Layer goes in.
 */
const confidentAdvisor = (): Advisor =>
  modelAdvisor({
    model: scriptedModel([
      {
        name: "classify",
        params: {
          proposedOutcome: "NO_MATCHING_ITEM",
          confidence: 0.93,
          rationale:
            "the account list on this screen offers only Checking; there is no savings " +
            "account to open"
        }
      }
    ])
  })

/** Copies the three files a run leaves behind into its slot under `evidence/assist/`. */
const collect = (from: string, slot: string): void => {
  const to = join(OUT, slot)
  mkdirSync(to, { recursive: true })
  for (const file of ["README.txt", "events.jsonl", "final.png"]) {
    copyFileSync(join(from, file), join(to, file))
  }
}

const program = Effect.gen(function* () {
  mkdirSync(OUT, { recursive: true })
  const artifact = shippedArtifact(CAPABILITY, BEFORE_LEARNING)

  // -----------------------------------------------------------------------
  // 1. No rung. The behaviour every run had before ticket 15.
  // -----------------------------------------------------------------------
  say(`replaying ${CAPABILITY}@${BEFORE_LEARNING} for member ${CHECKING_ONLY}, no assist...`)
  const without = yield* replay({
    artifact,
    inputs: { memberId: CHECKING_ONLY },
    runId: "checking-only-without-assist"
  })
  say(`  run ended: ${without.result.result}`)
  if (without.result.result === "failure") {
    say(`    step:   ${without.result.failure.stepId}`)
    say(`    reason: ${without.result.failure.reason}`)
  }
  say(
    `  assist events: ${
      without.events.filter((event) => event.kind.startsWith("assist.")).length
    }`
  )
  collect(without.evidenceDirectory, "checking-only-without-assist")

  // -----------------------------------------------------------------------
  // 2. The same everything, with the rung enabled.
  // -----------------------------------------------------------------------
  say(`replaying ${CAPABILITY}@${BEFORE_LEARNING} for member ${CHECKING_ONLY}, with assist...`)
  const withAssist = yield* replay({
    artifact,
    inputs: { memberId: CHECKING_ONLY },
    runId: "checking-only-with-assist",
    assist: confidentAdvisor()
  })
  say(`  run ended: ${withAssist.result.result}`)
  if (withAssist.result.result === "business_outcome") {
    say(`    code:       ${withAssist.result.code}`)
    say(`    assisted:   ${withAssist.result.assisted}`)
    say(`    confidence: ${withAssist.result.confidence}`)
    say(`    proposal:   ${withAssist.result.proposalRef}`)
  }
  for (const kind of ["assist.request", "assist.proposal", "intervention.raise"]) {
    say(`  ${kind}: ${withAssist.events.filter((event) => event.kind === kind).length}`)
  }
  collect(withAssist.evidenceDirectory, "checking-only-with-assist")

  // -----------------------------------------------------------------------
  // 3. The note that says which half of this was scripted.
  // -----------------------------------------------------------------------
  writeFileSync(
    join(OUT, "NO-MODEL-DROVE-THIS.txt"),
    [
      "NO MODEL DROVE THE CLASSIFICATION IN THESE TWO RUNS",
      "===================================================",
      "",
      "Read this before reading the two run directories beside it.",
      "",
      `Produced by: bun run test/support/drive-the-assisted-rung.ts`,
      "",
      "The classification in checking-only-with-assist/events.jsonl was written by a",
      "hand-authored stand-in at LanguageModel.make, which is the same seam",
      "@effect/ai-openai fills. That is a choice about what these two directories are",
      "for rather than a missing key: they exist to show the accepted path, and a live",
      "model returning a confidence below the 0.75 floor would record a declined",
      "consultation instead. A genuine model-driven run is committed elsewhere, at",
      "evidence/discovery/gpt-4.1-drove-this/.",
      "",
      "Everything else in these two directories is real:",
      "",
      "  * a real headless Chromium, driven through the real Playwright adapter;",
      "  * the real Heritage Core fixture, on an ephemeral port;",
      "  * the shipped policies/default.yaml, including the assist: block that",
      "    permits a consultation at all;",
      "  * the real member.account-balance@1.0.0 artifact, unedited;",
      "  * the real evidence writer, including the scrubber — grep 88888 over either",
      "    events.jsonl returns nothing.",
      "",
      "The stand-in fills LanguageModel.make, so the toolkit, the JSON Schema the model",
      "is sent, and the Schema decoding of what comes back are all the production code",
      "path. What is simulated is the judgement, and only the judgement.",
      "",
      "What the two directories are for",
      "--------------------------------",
      "",
      "The same member, the same artifact, the same policy, the same browser, and the",
      "one difference is whether the assisted rung was enabled.",
      "",
      "  checking-only-without-assist/",
      "      No rung. The selection matches nothing, and an unattended run reports the",
      "      hard failure it always did:",
      "",
      "          failure at step open-account (no_matching_item)",
      "",
      "      `grep '\"kind\":\"assist' events.jsonl` returns nothing at all, which is the",
      "      point: with the rung off there is no record of a consultation, because",
      "      there was no consultation. (Plain `grep assist` does match — the run id",
      "      says `without-assist` on every line.)",
      "",
      "  checking-only-with-assist/",
      "      The rung enabled. One assist.request, one policy.check with",
      "      action: assist allowing it under the default policy, one",
      "      assist.proposal at confidence 0.93 with accepted: true, and then an",
      "      outcome:",
      "",
      "          business outcome NO_MATCHING_ITEM ... (assisted: proposed at",
      "          confidence 0.93, not a deterministic result)",
      "",
      "      No intervention.raise. Nobody was paged. And no version was written to",
      "      artifacts/ — promoting a proposal into a capability still takes a person.",
      "",
      "Neither directory contains a decide event. A replay run never emits one,",
      "whatever flags it was given.",
      "",
      "The same thing with a live model",
      "--------------------------------",
      "",
      "With a key in OPENAI_API_KEY, and no code change:",
      "",
      "    bun run replay member.account-balance --memberId 88888 --version 1.0.0",
      "    bun run replay member.account-balance --memberId 88888 --version 1.0.0 --assist",
      "",
      "The second command builds the real provider Layer through the identical call",
      "site. What it records depends on what the model answers, which is why the",
      "committed pair above is scripted: a proposal below the confidence floor is a",
      "declined consultation, and the run then degrades to exactly the unassisted",
      "result. A rung whose job is to avoid an escalation can never cause one.",
      "",
      "Without a key the second command records",
      "",
      "    assist.declined: ... the model could not be reached",
      "",
      "and degrades the same way.",
      ""
    ].join("\n")
  )

  say(`wrote ${OUT}`)
})

Effect.runPromise(program).catch((cause) => {
  console.error(String(cause))
  process.exitCode = 1
})
