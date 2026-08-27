/**
 * What a failure says.
 *
 * SPEC user story 29: "I want a failure to tell me the step, what was expected
 * and what was observed, so that I diagnose without re-running." That is a
 * property of the result contract, and the way to check it is to make a run fail
 * on purpose and read what comes back.
 *
 * Each case here is a real failure mode of driving a legacy UI, arranged as a
 * variant of the shipped artifact. Building them by editing a valid artifact
 * rather than hand-writing broken ones keeps them honest: the only difference
 * from a working capability is the one thing under test.
 *
 * The important negative result is the first one. Heritage Core answers a search
 * for the wrong control with HTTP 200 and a perfectly well-formed page, and
 * Playwright raises nothing. Only the checkpoint catches it.
 */

import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import type { CapabilityArtifact, Step } from "@cua/artifact"
import { replay, shippedArtifact } from "./support/replay-harness.ts"

/** The shipped capability with one step replaced. */
const variant = (
  stepId: string,
  change: (step: Step) => Step
): CapabilityArtifact => {
  const artifact = shippedArtifact()
  return {
    ...artifact,
    steps: artifact.steps.map((step) => (step.id === stepId ? change(step) : step))
  }
}

/** Faster than the default, because these are meant to time out. */
const IMPATIENT = 400

it.live("a checkpoint that does not hold stops the run with step, expected and observed", () =>
  Effect.gen(function* () {
    // Press the Cross-Reference panel's submit instead of the search one. It
    // navigates perfectly successfully to a page that simply is not Member
    // Detail — no exception anywhere. Nothing but the checkpoint notices.
    const artifact = variant("run-member-search", (step) => ({
      ...step,
      action: {
        type: "click",
        target: {
          role: "button",
          name: "Look Up",
          strategy: "accessible-name",
          robustness: "deliberately the wrong control, for this test"
        }
      },
      checkpoint: { ...step.checkpoint, withinMillis: IMPATIENT }
    }))

    const { result } = yield* replay({ artifact, inputs: { memberId: "12345" } })

    expect(result.result).toBe("failure")
    if (result.result !== "failure") return

    expect(result.failure.reason).toBe("checkpoint_failed")
    expect(result.failure.stepId).toBe("run-member-search")
    expect(result.failure.stepIntent).toContain("Submit the search")
    expect(result.failure.expected).toContain("Member Detail")
    expect(result.failure.observed).toMatch(/\S/)

    // The step that failed is marked, and nothing after it ran.
    expect(result.steps.map((step) => `${step.id}:${step.checkpoint}`)).toEqual([
      "open-member-search:held",
      "enter-member-number:held",
      "run-member-search:failed"
    ])
  })
)

it.live("a failed checkpoint carries what the automation saw, so nobody re-runs to find out", () =>
  Effect.gen(function* () {
    const artifact = variant("open-member-search", (step) => ({
      ...step,
      checkpoint: {
        description: "A caption that is not on this screen appears.",
        withinMillis: IMPATIENT,
        expect: [{ assert: "textPresent", text: "Wire Transfer Authorisation" }]
      }
    }))

    const { events, result } = yield* replay({ artifact, inputs: { memberId: "12345" } })
    if (result.result !== "failure") throw new Error(`expected failure, got ${result.result}`)
    if (result.failure.reason !== "checkpoint_failed") throw new Error("wrong failure reason")

    expect(result.failure.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(result.failure.accessibility).toContain("Member Number Search")
    expect(result.failure.waitedMillis).toBeGreaterThanOrEqual(IMPATIENT)

    // The record says the same thing the result does, and a screenshot of the
    // moment is beside it (SPEC user story 65).
    const checkpoint = events.find((event) => event.kind === "checkpoint")
    expect(checkpoint && "verdict" in checkpoint ? checkpoint.verdict : undefined).toBe("failed")
    const end = events.find((event) => event.kind === "run.end")
    expect(end && "result" in end ? end.result : undefined).toBe("failure")
  })
)

it.live("a target matching nothing is distinguishable from one matching several", () =>
  Effect.gen(function* () {
    const missing = variant("run-member-search", (step) => ({
      ...step,
      action: {
        type: "click",
        target: {
          role: "button",
          name: "Authorise Wire",
          strategy: "accessible-name",
          robustness: "a control this application does not have"
        }
      }
    }))

    const first = yield* replay({ artifact: missing, inputs: { memberId: "12345" } })
    if (first.result.result !== "failure") throw new Error("expected a failure")
    expect(first.result.failure.reason).toBe("target_missing")

    // Two controls answer to a partial name on the search screen, and the run
    // stops rather than taking the first. Every candidate is listed, because
    // "which one did it mean" is the only useful question at that point.
    const ambiguous = variant("enter-member-number", (step) => ({
      ...step,
      action: {
        type: "fill",
        value: { from: "parameter", name: "memberId" },
        target: {
          role: "textbox",
          name: "Member Num",
          strategy: "accessible-name",
          robustness: "a partial name that matches the legacy field too"
        }
      }
    }))

    const second = yield* replay({ artifact: ambiguous, inputs: { memberId: "12345" } })
    if (second.result.result !== "failure") throw new Error("expected a failure")
    if (second.result.failure.reason !== "target_ambiguous") {
      throw new Error(`expected ambiguity, got ${second.result.failure.reason}`)
    }
    expect(second.result.failure.candidates.length).toBeGreaterThan(1)
    expect(second.result.failure.candidates.join(" ")).toContain("Legacy")
  })
)

it.live("a reading that is not the declared type fails as a contract problem", () =>
  Effect.gen(function* () {
    // Read the account's status cell instead of its balance. The step succeeds,
    // the checkpoint is relaxed to let it, and the *output contract* is what
    // breaks — a different problem from a broken flow, and it says so.
    const artifact = variant("read-available-balance", (step) => ({
      ...step,
      action: {
        type: "extract",
        target: {
          role: "cell",
          label: "Account Type",
          strategy: "caption-label",
          robustness: "deliberately not a monetary figure, for this test"
        }
      },
      checkpoint: {
        description: "Something was read.",
        expect: [{ assert: "stepRead", step: "read-available-balance", matches: "\\S" }]
      }
    }))

    const { result } = yield* replay({ artifact, inputs: { memberId: "12345" } })
    if (result.result !== "failure") throw new Error(`expected failure, got ${result.result}`)

    expect(result.failure.reason).toBe("output_unreadable")
    expect(result.failure.expected).toContain("USD")
    expect(result.failure.observed).toContain("SAVINGS")
  })
)
