import { it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { expect } from "vitest"
import { declareRequiresHuman, formatArtifact, parseArtifact, prepareInputs } from "@cua/artifact"
import { declassifierFor, sensitivityPolicy } from "@cua/policy"
import { proposeAmendment, scrubberFor } from "@cua/replay"
import { serve } from "@cua/legacy-core"
import { runDiscovery } from "../apps/demo/src/support/discovery-harness.ts"
import { respondingModel } from "../apps/demo/src/support/scripted-model.ts"
import { GOAL, readsTheScreen } from "../apps/demo/src/support/discovery-script.ts"
import { attendedReplay } from "../apps/demo/src/support/handoff-harness.ts"
import { replay } from "../apps/demo/src/support/replay-harness.ts"

const discoverArtifact = Effect.gen(function* () {
  const result = yield* runDiscovery({
    goal: GOAL, model: respondingModel(readsTheScreen),
    compilation: { capability: "member.account-balance", version: "1.0.0" }
  })
  expect(result.compilation.status).toBe("compiled")
  if (result.compilation.status !== "compiled") throw new Error("discovery did not compile the capability")
  return result.compilation.stored.artifact
})

it.live("the same discovered capability learns missing-member and validation answers from attended checkpoints", () => Effect.gen(function* () {
  const original = yield* discoverArtifact
  expect(original.authored).toBe("discovered")
  let artifact = original
  for (const sample of [
    { input: "99999", code: "MEMBER_NOT_FOUND", text: "Member Not Found", title: "No member exists for that number" },
    { input: "BAD-INPUT", code: "INPUT_VALIDATION_ERROR", text: "Member number must contain only digits.", title: "The member number has an invalid format" }
  ]) {
    const prepared = prepareInputs(artifact.capability, artifact.inputs, { memberId: sample.input }, declassifierFor(sensitivityPolicy, artifact.capability))
    if (Result.isFailure(prepared)) throw prepared.failure
    const scrub = scrubberFor(prepared.success)
    const episode = yield* attendedReplay({
      artifact, inputs: { memberId: sample.input },
      operate: (desk) => Effect.gen(function* () {
        const paused = yield* desk.awaitPause
        expect(paused.pending?.intervention.accessibility).toContain(sample.text)
        yield* desk.post("/take", { operator: "j.okafor" })
        yield* desk.post("/return", {
          operator: "j.okafor", classification: "unresolved", detail: sample.title,
          nextTime: "automation_handles_it"
        })
      })
    })
    const record = episode.snapshot.resolved[0]!
    expect(record.actions).toEqual([])
    expect(record.observed).toEqual([])
    const previous = artifact
    const amendment = proposeAmendment({ artifact, record, scrub, confirmedOutcome: sample })
    expect(amendment._tag, amendment._tag === "Refused" ? amendment.refusal.reason : "").toBe("Amended")
    if (amendment._tag !== "Amended") throw new Error("the observed checkpoint outcome was not learned")
    artifact = amendment.amended
    expect(artifact.steps.map((step) => step.action)).toEqual(original.steps.map((step) => step.action))
    expect(artifact.steps.map((step) => step.checkpoint.expect)).toEqual(original.steps.map((step) => step.checkpoint.expect))
    const formatted = formatArtifact(artifact)
    expect(formatted).not.toContain(sample.input)
    expect(Result.isSuccess(parseArtifact("learned", formatted))).toBe(true)
    const rerun = yield* replay({ artifact, inputs: { memberId: sample.input } })
    expect(rerun.result.result).toBe("business_outcome")
    if (rerun.result.result === "business_outcome") expect(rerun.result.code).toBe(sample.code)
    expect(rerun.events.some((event) => event.kind === "intervention.raise")).toBe(false)
    expect(rerun.events.some((event) => event.kind.startsWith("assist."))).toBe(false)

    for (const invalid of [
      { ...sample, text: "Unobserved public state" },
      { ...sample, text: "Member" },
      { ...sample, text: "[redacted:memberId]" },
      { ...sample, text: sample.input }
    ]) {
      expect(proposeAmendment({ artifact: previous, record, scrub, confirmedOutcome: invalid })._tag).toBe("Refused")
    }
    const wrongCause = { ...record, intervention: { ...record.intervention, reason: "the selection matched nothing" } }
    const wrongCauseResult = proposeAmendment({ artifact: previous, record: wrongCause, scrub, confirmedOutcome: sample })
    expect(wrongCauseResult._tag).toBe("Refused")
    if (wrongCauseResult._tag === "Refused") expect(wrongCauseResult.refusal.reason).toContain("did not record a failed checkpoint")
    expect(proposeAmendment({ artifact: previous, record, scrub, confirmedOutcome: { ...sample, title: sample.input } })._tag).toBe("Refused")
    expect(proposeAmendment({ artifact: previous, record, scrub, confirmedOutcome: { ...sample, code: "not a code" } })._tag).toBe("Refused")
    const strict = declareRequiresHuman(previous, {
      version: "9.0.0", stepId: record.intervention.stepId,
      title: "An authorized operator is required", summary: "This checkpoint requires a person.",
      discoveredFrom: "An earlier attended intervention."
    }, { scrub })
    if (Result.isFailure(strict)) throw strict.failure
    const downgrade = proposeAmendment({
      artifact: strict.success,
      record: { ...record, intervention: { ...record.intervention, version: strict.success.version } },
      scrub, confirmedOutcome: sample
    })
    expect(downgrade._tag).toBe("Refused")
    if (downgrade._tag === "Refused") expect(downgrade.refusal.reason).toContain("cannot be downgraded")
  }
  const missingAgain = yield* replay({ artifact, inputs: { memberId: "99999" } })
  expect(missingAgain.result.result).toBe("business_outcome")
  if (missingAgain.result.result === "business_outcome") expect(missingAgain.result.code).toBe("MEMBER_NOT_FOUND")
  const ordinary = yield* replay({ artifact, inputs: { memberId: "12345" } })
  expect(ordinary.result.result).toBe("success")
}), 60_000)

it.live("the fixture renders a concrete member-number validation result", () => Effect.gen(function* () {
  const core = yield* serve({ port: 0 })
  const response = yield* Effect.promise(() => fetch(`${core.origin}/member?memberNumber=BAD-INPUT`))
  expect(response.status).toBe(400)
  const body = yield* Effect.promise(() => response.text())
  expect(body).toContain("Member number must contain only digits.")
}).pipe(Effect.scoped))
