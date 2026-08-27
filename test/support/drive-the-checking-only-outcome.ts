/**
 * Drive member `88888`'s empty account list for real, and write down what it taught.
 *
 *     bun run test/support/drive-the-checking-only-outcome.ts
 *
 * Not a test — Vitest only collects `*.test.ts` — but built on the same harnesses
 * the tests use, and here for the reason ticket 14's driver exists: **a committed
 * evidence directory has to be the output of something in this repository.**
 * `evidence/learning/88888-checking-only/` was the last directory with no
 * producer, so a later correction to redaction had to be applied to it by hand,
 * and files that present as machine-produced records were then partly typed by a
 * person. This closes that.
 *
 * Everything below the operator is real: one Heritage Core, one Chromium, one
 * Session, the shipped Policy, the real operator interface over HTTP, and the
 * real Evidence writer with the real scrubber. The Operator is scripted because
 * there is nobody at this keyboard, and the command a person runs instead is in
 * `evidence/learning/88888-checking-only/README.txt`.
 *
 * ## What it writes, and the one thing it does not
 *
 *   - `intervention-run.*`: the attended run, its evidence and the screen the
 *     person was looking at;
 *   - `after-learning.events.jsonl`: the same member replayed at the learned
 *     version, unattended;
 *   - `1.0.0-to-1.1.0.diff`: **the diff of the two versions this repository
 *     ships**, rendered from the store, not from this run's proposal.
 *
 * That last choice is deliberate and is stated in the run's output. The shipped
 * `1.1.0` was cut by an earlier episode driven through `bun run replay ...
 * --handoff`, and an Artifact store is immutable, so this driver cannot replace
 * it and should not pretend to. What it can do is prove the episode still
 * classifies the same way: it runs `proposeAmendment` over its own episode and
 * reports the class and the shape of the change it would have written. The one
 * thing that legitimately differs between the two is the identifiers of the
 * intervention, which name an episode rather than a decision.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  ARTIFACTS_DIRECTORY,
  diffArtifacts,
  loadArtifact,
  prepareInputs,
  writeArtifact
} from "@cua/artifact"
import { declassifierFor, sensitivityPolicy } from "@cua/policy"
import { proposeAmendment, scrubberFor } from "@cua/replay"
import { Effect, Result } from "effect"
import { attendedReplay } from "./handoff-harness.ts"
import { replay, shippedArtifact } from "./replay-harness.ts"

const CHECKING_ONLY = "88888"
const CAPABILITY = "member.account-balance"
const FROM = "1.0.0"
const TO = "1.1.0"
const OUT = join("evidence", "learning", "88888-checking-only")

const say = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

const program = Effect.gen(function* () {
  mkdirSync(OUT, { recursive: true })
  const before = shippedArtifact(CAPABILITY, FROM)

  // -----------------------------------------------------------------------
  // 1. The run stops, and a person looks at it without touching anything.
  // -----------------------------------------------------------------------
  say(`replaying ${CAPABILITY}@${FROM} for member ${CHECKING_ONLY}, attended...`)
  const episode = yield* attendedReplay({
    artifact: before,
    inputs: { memberId: CHECKING_ONLY },
    runId: "checking-only",
    operate: (desk) =>
      Effect.gen(function* () {
        const paused = yield* desk.awaitPause
        say(`  PAUSED at ${paused.pending?.intervention.stepId}`)
        say(`    ${paused.pending?.intervention.reason}`)
        say(`    ${paused.pending?.intervention.detail}`)

        yield* desk.post("/take", { operator: "j.okafor" })

        // Deliberately no `/note`, and this is the whole of what makes the state
        // declarable. Touching nothing is the evidence: an operator who had to
        // act cannot produce a Business Outcome from any answer at all, so the
        // empty `actions` list is the fact the classification turns on rather
        // than anything anybody typed.
        yield* desk.post("/return", {
          operator: "j.okafor",
          classification: "unresolved",
          detail:
            "Looked at the account list and touched nothing. This member holds a checking " +
            "account only; there is no savings account to open, so there is nothing here " +
            "for automation or anyone else to fix. The list is complete and correct",
          nextTime: "automation_handles_it"
        })
      })
  })

  say(`  run ended: ${episode.result.result}`)
  const closed = episode.snapshot.resolved[0]
  if (closed === undefined) throw new Error("no closed intervention")
  say(`  actions the operator recorded: ${closed.actions.length}`)

  copyFileSync(
    join(episode.evidenceDirectory, "events.jsonl"),
    join(OUT, "intervention-run.events.jsonl")
  )
  copyFileSync(
    join(episode.evidenceDirectory, "README.txt"),
    join(OUT, "intervention-run.README.txt")
  )
  copyFileSync(join(episode.evidenceDirectory, "final.png"), join(OUT, "intervention-run.final.png"))

  // -----------------------------------------------------------------------
  // 2. What the episode classifies as, and the version it would cut.
  // -----------------------------------------------------------------------
  const prepared = prepareInputs(
    before.capability,
    before.inputs,
    { memberId: CHECKING_ONLY },
    declassifierFor(sensitivityPolicy, before.capability)
  )
  if (Result.isFailure(prepared)) throw new Error(prepared.failure.message)

  const proposal = proposeAmendment({
    artifact: before,
    record: closed,
    scrub: scrubberFor(prepared.success),
    version: TO
  })
  if (proposal._tag !== "Amended") {
    throw new Error(`expected an amendment, got ${proposal._tag}: ${JSON.stringify(proposal)}`)
  }
  say(`  LEARNED ${proposal.amended.capability}@${proposal.amended.version} (${proposal.learnedClass})`)
  say(`    ${proposal.because}`)

  const stored = writeArtifact(ARTIFACTS_DIRECTORY, proposal.amended)
  say(
    Result.isSuccess(stored)
      ? `  written to ${stored.success}`
      : `  not stored: ${stored.failure.message}`
  )

  // The diff of the two documents that are actually on disk. See the module
  // note: the shipped 1.1.0 was cut by an earlier episode and cannot be
  // overwritten, so writing this run's proposal here would put a diff in the
  // evidence that no stored artifact matches.
  const learned = loadArtifact(ARTIFACTS_DIRECTORY, CAPABILITY, TO)
  if (Result.isFailure(learned)) throw new Error(learned.failure.message)
  writeFileSync(
    join(OUT, `${FROM}-to-${TO}.diff`),
    `${diffArtifacts(before, learned.success)}\n`
  )
  say(`  diff written from the store: ${CAPABILITY}@${FROM} -> @${TO}`)

  // -----------------------------------------------------------------------
  // 3. The same member again, at the learned version, with nobody watching.
  // -----------------------------------------------------------------------
  say(`replaying ${CAPABILITY}@${TO} for member ${CHECKING_ONLY}, unattended...`)
  const after = yield* replay({
    artifact: learned.success,
    inputs: { memberId: CHECKING_ONLY },
    runId: "after-learning"
  })
  say(`  run ended: ${after.result.result}`)
  if (after.result.result === "business_outcome") {
    say(`    code:   ${after.result.code}`)
    say(`    detail: ${after.result.detail}`)
  }
  copyFileSync(join(after.evidenceDirectory, "events.jsonl"), join(OUT, "after-learning.events.jsonl"))

  say(`wrote ${OUT}`)
})

Effect.runPromise(program).catch((cause) => {
  console.error(String(cause))
  process.exitCode = 1
})
