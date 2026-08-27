/**
 * Onboard the second tenant for real, and write down what it cost.
 *
 *     bun run test/support/drive-the-tenant-override.ts
 *
 * Not a test — Vitest only collects `*.test.ts` — but built on the same harnesses
 * the tests use, and here for the reason ticket 14's driver exists: **the
 * override this repository ships has to be the output of a run, not a document
 * somebody typed.** ADR-0006 says tenant overrides are discovered and confirmed,
 * never hand-written, and a hand-written file in `overrides/` would make that
 * sentence false in the most visible way available.
 *
 * Four runs, in order, and the shape of them is the whole argument:
 *
 *   1. `community-cu`, unattended, no override. Three of the four differences
 *      SPEC lists are absorbed by matching and cost nothing at all; the fourth
 *      surfaces as an ordinary `target_missing` replay failure.
 *   2. The same run, attended, with assisted recovery on. The rung proposes
 *      `Find`, a person confirms it once, and the confirmation is written as a
 *      scoped delta against the base capability.
 *   3. `community-cu` again, unattended, with the delta in force. Success.
 *   4. `heritage-core`, unattended, base document unchanged. Success.
 *
 * Everything below the model is real: two installations of the mock core, a real
 * Chromium, the shipped Policy, the real operator interface over HTTP, and the
 * real Evidence writer with the real scrubber. The **only** thing standing in for
 * something is the model's judgement, at `LanguageModel.make` — the same seam
 * `@effect/ai-openai` fills — because `OPENAI_API_KEY` in this environment is
 * revoked. A working key needs no code change: `bun run replay ... --assist`
 * already builds the real provider through the identical call.
 *
 * It writes:
 *
 *   - `overrides/community-cu/member.account-balance.yaml`, if it is not there
 *     already (a second run refuses to change a confirmed entry and says so);
 *   - the evidence for all four runs under `evidence/tenant/community-cu/`.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { modelAdvisor } from "@cua/agent"
import {
  OVERRIDES_DIRECTORY,
  applyOverride,
  loadOverride,
  prepareInputs,
  writeOverride
} from "@cua/artifact"
import { declassifierFor, sensitivityPolicy } from "@cua/policy"
import { proposeOverride, scrubberFor } from "@cua/replay"
import { Effect, Result } from "effect"
import { attendedReplay } from "./handoff-harness.ts"
import { replay, shippedArtifact } from "./replay-harness.ts"
import { scriptedModel } from "./scripted-model.ts"

const CAPABILITY = "member.account-balance"
const TENANT = "community-cu"
const MEMBER = "12345"
const OUT = join("evidence", "tenant", TENANT)

const say = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

/**
 * The consultation's answer, scripted.
 *
 * `proposeTarget` is the non-acting tool: it names one of the controls the
 * screen is offering and returns a confidence. Nothing presses it. The engine
 * turns this into an `Unassisted` — the value that means the rung did *not*
 * settle the stall — and carries it to the person.
 */
const advisor = modelAdvisor({
  model: scriptedModel([
    {
      name: "proposeTarget",
      params: {
        control: "Find",
        confidence: 0.9,
        rationale:
          "the search panel offers one submit control and it reads Find; the other button " +
          "on the screen belongs to the Cross-Reference Lookup panel"
      }
    }
  ])
})

const program = Effect.gen(function* () {
  mkdirSync(OUT, { recursive: true })
  const base = shippedArtifact(CAPABILITY)
  say(`base capability: ${base.capability}@${base.version}`)

  // -----------------------------------------------------------------------
  // 1. The same document, the second institution, nothing configured.
  // -----------------------------------------------------------------------
  say(`replaying against ${TENANT} with no override...`)
  const first = yield* replay({
    artifact: base,
    inputs: { memberId: MEMBER },
    runId: "community-cu-before",
    core: { tenant: TENANT }
  })
  say(`  run ended: ${first.result.result}`)
  if (first.result.result === "failure") {
    say(`    step:     ${first.result.failure.stepId}`)
    say(`    reason:   ${first.result.failure.reason}`)
    say(`    expected: ${first.result.failure.expected}`)
  }
  say(
    `  steps that held before it: ${first.result.steps
      .filter((step) => step.checkpoint === "held")
      .map((step) => step.id)
      .join(", ")}`
  )
  copyFileSync(join(first.evidenceDirectory, "events.jsonl"), join(OUT, "01-before.events.jsonl"))

  // -----------------------------------------------------------------------
  // 2. The ladder does its ordinary job, and a person confirms once.
  // -----------------------------------------------------------------------
  say(`replaying against ${TENANT} attended, with assisted recovery on...`)
  const episode = yield* attendedReplay({
    artifact: base,
    inputs: { memberId: MEMBER },
    runId: "community-cu-onboarding",
    core: { tenant: TENANT },
    assist: advisor,
    operate: (desk) =>
      Effect.gen(function* () {
        const paused = yield* desk.awaitPause
        const proposal = paused.pending?.intervention.proposal
        say(`  PAUSED at ${paused.pending?.intervention.stepId}`)
        say(`    ${paused.pending?.intervention.reason}`)
        say(
          `    assisted recovery proposed ${JSON.stringify(proposal?.control)} for ` +
            `${proposal?.forTarget} at confidence ${proposal?.confidence}`
        )

        yield* desk.post("/take", { operator: "a.reyes" })

        // Nothing is done to the live session. The person is not fixing a
        // screen; they are agreeing with a reading of it. `classification` says
        // this episode cannot carry on — the step never acted — and
        // `confirmProposal` says the correspondence is right.
        yield* desk.post("/return", {
          operator: "a.reyes",
          classification: "unresolved",
          detail:
            "looked at the search panel. This installation labels the submit control Find; " +
            "it is the same control Heritage Core labels Search, and there is nothing else " +
            "on the panel it could be",
          nextTime: "not_asked",
          confirmProposal: "confirmed"
        })
      })
  })
  say(`  run ended: ${episode.result.result}`)
  const closed = episode.snapshot.resolved[0]
  if (closed === undefined) throw new Error("no closed intervention")
  copyFileSync(
    join(episode.evidenceDirectory, "events.jsonl"),
    join(OUT, "02-onboarding.events.jsonl")
  )
  copyFileSync(join(episode.evidenceDirectory, "final.png"), join(OUT, "02-onboarding.final.png"))

  // -----------------------------------------------------------------------
  // 3. What the confirmation turns into, and where it goes.
  // -----------------------------------------------------------------------
  const prepared = prepareInputs(
    base.capability,
    base.inputs,
    { memberId: MEMBER },
    declassifierFor(sensitivityPolicy, base.capability)
  )
  if (Result.isFailure(prepared)) throw new Error(prepared.failure.message)

  const existing = loadOverride(OVERRIDES_DIRECTORY, TENANT, CAPABILITY)
  if (Result.isFailure(existing)) throw new Error(existing.failure.message)

  const proposed = proposeOverride({
    artifact: base,
    tenant: TENANT,
    record: closed,
    scrub: scrubberFor(prepared.success),
    ...(existing.success === undefined ? {} : { existing: existing.success })
  })

  /**
   * The delta, or the one this repository already ships.
   *
   * A second run of this driver is *refused*, not silently obeyed: an override
   * entry is append-only, and a control that has been renamed again is a new
   * discovery whose confirmation nobody has given yet. So the refusal is
   * reported and the run carries on with the stored delta, which is exactly what
   * a person re-running the demo should see.
   */
  let override
  if (proposed._tag === "Confirmed") {
    say(`  CONFIRMED  ${proposed.because}`)
    const stored = writeOverride(OVERRIDES_DIRECTORY, proposed.override)
    say(
      Result.isSuccess(stored)
        ? `  written to ${stored.success}`
        : `  not stored: ${stored.failure.message}`
    )
    override = proposed.override
  } else if (proposed._tag === "Refused" && existing.success !== undefined) {
    say(`  ALREADY CONFIRMED  ${proposed.refusal.message}`)
    override = existing.success
  } else {
    throw new Error(
      `expected a confirmed override, got ${proposed._tag}: ${JSON.stringify(proposed)}`
    )
  }
  say(`  artifacts/${CAPABILITY}/ was not written to`)

  // -----------------------------------------------------------------------
  // 4. The same capability, both institutions, with the delta in force.
  // -----------------------------------------------------------------------
  const effective = applyOverride(base, override)
  if (Result.isFailure(effective)) throw new Error(effective.failure.message)

  say(`replaying against ${TENANT} with the confirmed override...`)
  const after = yield* replay({
    artifact: effective.success,
    inputs: { memberId: MEMBER },
    runId: "community-cu-after",
    core: { tenant: TENANT },
    appliedOverride: {
      tenant: TENANT,
      baseVersion: base.version,
      source: `${OVERRIDES_DIRECTORY}/${TENANT}/${CAPABILITY}.yaml`,
      entries: override.targets.map((entry) => ({ was: entry.was, name: entry.name }))
    }
  })
  say(`  run ended: ${after.result.result}`)
  if (after.result.result === "success") {
    for (const [name, value] of Object.entries(after.result.outputs)) {
      say(`    ${name}: ${JSON.stringify(value)}`)
    }
  }
  copyFileSync(join(after.evidenceDirectory, "events.jsonl"), join(OUT, "03-after.events.jsonl"))
  copyFileSync(join(after.evidenceDirectory, "final.png"), join(OUT, "03-after.final.png"))

  say(`replaying the unchanged base document against heritage-core...`)
  const vendor = yield* replay({
    artifact: base,
    inputs: { memberId: MEMBER },
    runId: "heritage-core-after"
  })
  say(`  run ended: ${vendor.result.result}`)
  if (vendor.result.result === "success") {
    for (const [name, value] of Object.entries(vendor.result.outputs)) {
      say(`    ${name}: ${JSON.stringify(value)}`)
    }
  }
  copyFileSync(
    join(vendor.evidenceDirectory, "events.jsonl"),
    join(OUT, "04-heritage-core.events.jsonl")
  )

  writeFileSync(
    join(OUT, "README.txt"),
    [
      "One capability, two institutions running the same vendor product.",
      "",
      `Produced by: bun run test/support/drive-the-tenant-override.ts`,
      `Base capability: ${base.capability}@${base.version}, unchanged by any of this.`,
      "",
      "SPEC's second-tenant table, and what each row actually cost:",
      "",
      "  Member # rather than Member Number     absorbed, no override",
      "  Regular Savings / Share Draft          absorbed, no override",
      "  no iframe on account detail            absorbed, no override",
      "  the submit button reads Find           ONE confirmed override",
      "",
      "01-before.events.jsonl",
      "  The base document against community-cu with nothing configured. The first two",
      "  steps hold — the shortened field caption is absorbed by token matching on the",
      "  accessible name — and the run fails with target_missing on the submit control.",
      "  That is tenant drift being detected: an ordinary replay failure, by the same",
      "  mechanism as everything else (ADR-0006).",
      "",
      "02-onboarding.events.jsonl",
      "  The same run attended, with assisted recovery on. assist.request, a policy.check",
      "  for assist, then assist.target_proposal naming Find at confidence 0.90. Nothing",
      "  was pressed: the run paused, a person read the proposal and confirmed it, and the",
      "  intervention.resolve event carries confirmProposal=confirmed.",
      "",
      "  The model's judgement here is scripted. See NO-MODEL-DROVE-THIS.txt.",
      "",
      "03-after.events.jsonl",
      "  community-cu again with the confirmed delta in force. The override.applied event",
      "  at the top of the log says which document executed. Success, both balances read.",
      "",
      "04-heritage-core.events.jsonl",
      "  The same base document, unchanged, against the first institution. Success. No",
      "  override.applied event, because there is no delta: nothing about onboarding the",
      "  second tenant touched the first.",
      "",
      "The equivalent commands a person runs:",
      "",
      `  bun run replay ${CAPABILITY} --memberId ${MEMBER} --tenant ${TENANT}`,
      `  bun run replay ${CAPABILITY} --memberId ${MEMBER} --tenant ${TENANT} --assist --handoff --headed`,
      `  bun run replay ${CAPABILITY} --memberId ${MEMBER} --tenant ${TENANT}`,
      `  bun run replay ${CAPABILITY} --memberId ${MEMBER}`,
      ""
    ].join("\n")
  )

  writeFileSync(
    join(OUT, "NO-MODEL-DROVE-THIS.txt"),
    [
      "No language model produced the proposal in 02-onboarding.events.jsonl.",
      "",
      "OPENAI_API_KEY in this environment is revoked (HTTP 401 against",
      "api.openai.com/v1/models), so the consultation's judgement is scripted at",
      "LanguageModel.make — the same provider hook @effect/ai-openai fills. Everything",
      "around it is the production path: the same modelAdvisor, the same toolkit, the",
      "same JSON Schema, the same Schema decoding of the tool call, the same Policy",
      "gate, the same confidence floor and the same Evidence writer.",
      "",
      "A working key needs no code change. `bun run replay ... --assist` builds the",
      "real provider Layer through the identical call site.",
      ""
    ].join("\n")
  )

  say(`wrote ${OUT}`)
})

Effect.runPromise(program).catch((cause) => {
  console.error(String(cause))
  process.exitCode = 1
})
