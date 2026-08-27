/**
 * Drive member `77777`'s supervisor hold for real, and write down what it taught.
 *
 *     bun run test/support/drive-the-supervisor-hold.ts
 *
 * Not a test — Vitest only collects `*.test.ts` — but built on the same harness
 * the tests use, and here for one reason: **the version of an Artifact this
 * repository ships has to be the output of a run, not a document somebody typed.**
 * Ticket 13's `1.1.0` was produced by `bun run replay ... --handoff`, driven by a
 * person at the operator interface who had to touch nothing. `1.2.0` cannot be
 * produced that way in an unattended environment, because resolving `77777`
 * requires *acting in the live browser window*, and that is the whole point of it.
 *
 * So the Operator here is scripted, and everything else is real: one Heritage
 * Core, one Chromium, one Session, the shipped Policy, the real operator
 * interface over HTTP, and the real Evidence writer with the real scrubber. The
 * "person" fills the Supervisor ID and the Authorization Code and presses
 * Authorize in the automation's own browser window, exactly as ADR-0009 says a
 * handoff works, and the run finishes because they did.
 *
 * The command a person runs instead of this one, which produces the same
 * document, is in `evidence/learning/77777-supervisor-hold/README.txt`.
 *
 * It writes:
 *
 *   - `artifacts/member.account-balance/1.2.0.yaml`, if it is not there already
 *     (an Artifact store is immutable; a second run refuses and says so);
 *   - the evidence for both runs, and the 1.1.0 → 1.2.0 diff, under
 *     `evidence/learning/77777-supervisor-hold/`.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  ARTIFACTS_DIRECTORY,
  loadArtifact,
  prepareInputs,
  writeArtifact
} from "@cua/artifact"
import { declassifierFor, sensitivityPolicy } from "@cua/policy"
import { proposeAmendment, scrubberFor } from "@cua/replay"
import { Effect, Result } from "effect"
import { attendedReplay } from "./handoff-harness.ts"
import { replay, shippedArtifact } from "./replay-harness.ts"

const RESTRICTED = "77777"
const CAPABILITY = "member.account-balance"
const FROM = "1.1.0"
const TO = "1.2.0"
const OUT = join("evidence", "learning", "77777-supervisor-hold")

const say = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

const program = Effect.gen(function* () {
  mkdirSync(OUT, { recursive: true })
  const before = shippedArtifact(CAPABILITY, FROM)

  // -----------------------------------------------------------------------
  // 1. The run stops, and a person with authority resolves it.
  // -----------------------------------------------------------------------
  say(`replaying ${CAPABILITY}@${FROM} for member ${RESTRICTED}, attended...`)
  const episode = yield* attendedReplay({
    artifact: before,
    inputs: { memberId: RESTRICTED },
    runId: "supervisor-hold",
    operate: (desk) =>
      Effect.gen(function* () {
        const paused = yield* desk.awaitPause
        say(`  PAUSED at ${paused.pending?.intervention.stepId}`)
        say(`    ${paused.pending?.intervention.reason}`)

        yield* desk.post("/take", { operator: "r.mensah" })

        // The authority. Three gestures in the automation's own browser window,
        // none of which a capability has any business performing by itself.
        yield* desk.surface.fill({ role: "textbox", name: "Supervisor ID" }, "SUP7")
        yield* desk.surface.fill({ role: "textbox", name: "Authorization Code" }, "4417")
        yield* desk.surface.click({ role: "button", name: "Authorize" })
        yield* desk.post("/note", { detail: "entered supervisor override for SUP-HOLD-02" })

        // Two independent answers, and this is the pair that needs both fields:
        // the episode *is* resolved — the balances are on the screen now — and
        // the state must nevertheless always stop for a person, because what
        // resolved it was authority.
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

  say(`  run ended: ${episode.result.result}`)
  const closed = episode.snapshot.resolved[0]
  if (closed === undefined) throw new Error("no closed intervention")

  // -----------------------------------------------------------------------
  // 2. What the episode taught, and the new version it cuts.
  // -----------------------------------------------------------------------
  const prepared = prepareInputs(
    before.capability,
    before.inputs,
    { memberId: RESTRICTED },
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

  writeFileSync(join(OUT, `${FROM}-to-${TO}.diff`), `${proposal.diff}\n`)
  copyFileSync(
    join(episode.evidenceDirectory, "events.jsonl"),
    join(OUT, "intervention-run.events.jsonl")
  )
  copyFileSync(join(episode.evidenceDirectory, "README.txt"), join(OUT, "intervention-run.README.txt"))
  copyFileSync(join(episode.evidenceDirectory, "final.png"), join(OUT, "intervention-run.final.png"))

  // -----------------------------------------------------------------------
  // 3. The same member again, at the learned version, with nobody watching.
  // -----------------------------------------------------------------------
  const learned = loadArtifact(ARTIFACTS_DIRECTORY, CAPABILITY, TO)
  if (Result.isFailure(learned)) throw new Error(learned.failure.message)

  say(`replaying ${CAPABILITY}@${TO} for member ${RESTRICTED}, unattended...`)
  const after = yield* replay({
    artifact: learned.success,
    inputs: { memberId: RESTRICTED },
    runId: "after-learning"
  })
  say(`  run ended: ${after.result.result}`)
  if (after.result.result === "intervention_required") {
    say(`    code:   ${after.result.code}`)
    say(`    reason: ${after.result.reason}`)
  }
  copyFileSync(join(after.evidenceDirectory, "events.jsonl"), join(OUT, "after-learning.events.jsonl"))
  // The screen the run stopped on, and the one nothing about it is wrong with.
  copyFileSync(join(after.evidenceDirectory, "final.png"), join(OUT, "after-learning.final.png"))

  say(`wrote ${OUT}`)
})

Effect.runPromise(program).catch((cause) => {
  console.error(String(cause))
  process.exitCode = 1
})
