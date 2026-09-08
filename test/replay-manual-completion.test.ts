import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import type { CapabilityArtifact } from "@cua/artifact"
import { attendedReplay } from "../apps/demo/src/support/handoff-harness.ts"
import { shippedArtifact } from "../apps/demo/src/support/replay-harness.ts"

const manuallySearch = (artifact: CapabilityArtifact, memberId = "12345") => attendedReplay({
  artifact,
  inputs: { memberId },
  core: { tenant: "community-cu" },
  operate: (desk) => Effect.gen(function* () {
    yield* desk.awaitPause
    expect((yield* desk.post("/take", { operator: "a.reviewer" })).status).toBe(303)
    yield* desk.surface.click({ role: "button", name: "Find" })
    expect((yield* desk.post("/return", {
      operator: "a.reviewer", classification: "resolved", actionTaken: "true",
      detail: "Submitted the member search using Find.", nextTime: "not_asked"
    })).status).toBe(303)
  })
})

it.live("continues after the operator completes a missing action in the same session", () =>
  Effect.gen(function* () {
    const outcome = yield* manuallySearch(shippedArtifact(undefined, "1.1.0"))
    expect(outcome.result.result).toBe("success")
    expect(outcome.events.filter((event) => event.kind === "action" && event.stepId === "run-member-search")).toEqual([])
    expect(outcome.events.some((event) => event.kind === "checkpoint" && event.stepId === "run-member-search" && event.verdict === "held")).toBe(true)
    expect(outcome.snapshot.resolved).toHaveLength(1)
  })
)

it.live("reports a declared business outcome reached by the operator's missing action", () =>
  Effect.gen(function* () {
    const outcome = yield* manuallySearch(shippedArtifact(undefined, "1.1.0"), "99999")
    expect(outcome.result).toMatchObject({ result: "business_outcome", code: "MEMBER_NOT_FOUND" })
    expect(outcome.events.some((event) => event.kind === "outcome" && event.code === "MEMBER_NOT_FOUND" && event.matched?.includes("Operator held this session"))).toBe(true)
  })
)

it.live("still attempts the action when the operator only restores its missing control", () =>
  Effect.gen(function* () {
    const original = shippedArtifact(undefined, "1.1.0")
    const artifact: CapabilityArtifact = {
      ...original,
      outputs: {},
      steps: original.steps.slice(0, 3).map((step) => step.id !== "run-member-search" ? step : {
        ...step,
        action: { type: "click", target: {
          role: "link", name: "Return to Member Search", strategy: "accessible-name",
          robustness: "A public navigation link offered on member detail."
        } },
        checkpoint: { description: "Returned to search", withinMillis: 100, expect: [{ assert: "textPresent", text: "Member Number Search" }] }
      })
    }
    const outcome = yield* manuallySearch(artifact)
    expect(outcome.result.result).toBe("success")
    expect(outcome.events.filter((event) => event.kind === "action" && event.stepId === "run-member-search")).toHaveLength(1)
  })
)

it.live("reports the returned screen when the manual intervention did not complete or restore the action", () =>
  Effect.gen(function* () {
    const original = shippedArtifact(undefined, "1.1.0")
    const artifact: CapabilityArtifact = {
      ...original,
      steps: original.steps.map((step) => step.id !== "run-member-search" ? step : {
        ...step,
        checkpoint: { description: "Unreached result", withinMillis: 100, expect: [{ assert: "textPresent", text: "Unreached result" }] }
      })
    }
    const outcome = yield* manuallySearch(artifact)
    expect(outcome.result.result).toBe("intervention_required")
    if (outcome.result.result !== "intervention_required") return
    expect(outcome.result.accessibility).toContain('cell "Member Detail"')
    expect(outcome.result.accessibility).not.toContain('button "Find"')
  })
)

it.live("a resolved return with no action cannot skip a missing action whose checkpoint already held", () =>
  Effect.gen(function* () {
    const original = shippedArtifact(undefined, "1.1.0")
    const artifact: CapabilityArtifact = {
      ...original,
      outputs: {},
      steps: original.steps.slice(0, 3).map((step) => step.id !== "run-member-search" ? step : {
        ...step,
        checkpoint: { description: "Search panel remains visible", withinMillis: 100, expect: [{ assert: "textPresent", text: "Member Number Search" }] }
      })
    }
    const outcome = yield* attendedReplay({
      artifact, inputs: { memberId: "12345" }, core: { tenant: "community-cu" },
      operate: (desk) => Effect.gen(function* () {
        yield* desk.awaitPause
        yield* desk.post("/take", { operator: "a.reviewer" })
        yield* desk.post("/return", {
          operator: "a.reviewer", classification: "resolved",
          detail: "Only inspected the screen.", nextTime: "not_asked"
        })
      })
    })
    expect(outcome.result.result).toBe("intervention_required")
    expect(outcome.events.some((event) => event.kind === "checkpoint" && event.stepId === "run-member-search" && event.verdict === "held")).toBe(false)
  })
)
