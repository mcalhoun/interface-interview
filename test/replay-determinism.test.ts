/**
 * Determinism: the same inputs twice give the same answer by the same route.
 *
 * Comparing outputs alone would not be enough. Two different paths through a UI
 * can arrive at the same number, and "the balance was right both times" is not
 * the property a caller is relying on when they build on this (SPEC user story
 * 21). So the step sequence is compared too, and so is the sequence of evidence
 * events, which is the closest thing to a trace of the decisions taken.
 *
 * Worth restating, because it is easy to over-read: determinism here means no
 * model in the loop, not no logic. Both runs read live screens and matched
 * against them. Same screens, same parameters, same choices.
 */

import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { replay, shippedArtifact } from "./support/replay-harness.ts"

it.live("replaying the same inputs twice produces identical outputs and steps", () =>
  Effect.gen(function* () {
    const artifact = shippedArtifact()
    const first = yield* replay({ artifact, inputs: { memberId: "12345" }, runId: "first" })
    const second = yield* replay({ artifact, inputs: { memberId: "12345" }, runId: "second" })

    expect(first.result.result).toBe("success")
    expect(second.result.result).toBe("success")

    // Everything about the result except the identifiers that are supposed to
    // differ between two runs.
    const comparable = (outcome: typeof first) => {
      const { evidenceDirectory, runId, sessionId, ...rest } = outcome.result
      return rest
    }
    expect(comparable(second)).toEqual(comparable(first))

    // And the same route to it: same steps, in the same order, each verified.
    expect(second.result.steps).toEqual(first.result.steps)

    // The evidence tells the same story too — same kinds, same steps, same order.
    const shape = (outcome: typeof first) =>
      outcome.events.map((event) => `${event.seq}:${event.kind}:${event.stepId ?? "-"}`)
    expect(shape(second)).toEqual(shape(first))
  })
)
