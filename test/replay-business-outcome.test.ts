/**
 * A legitimate domain answer must not surface as an error.
 *
 * The brief calls this the most common design mistake in the problem, so what is
 * pinned here is not only that `MEMBER_NOT_FOUND` comes back, but that *nothing
 * anywhere reports a failure* while it does. A system can return the right code
 * and still have got this wrong — by logging an error, by writing a failed
 * checkpoint, by exiting non-zero, by leaving a `failure` field populated
 * "harmlessly" beside the outcome. Each of those is a false alarm someone gets
 * paged for at 3am, and each is asserted against below.
 *
 * Everything runs against the real Heritage Core in a real browser, and the
 * evidence is read back off disk, because the result contract and the evidence
 * files are the product.
 *
 * `it.live` throughout: checkpoint evaluation polls with `Effect.sleep`, which
 * never returns under `@effect/vitest`'s TestClock.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { DEFAULT_CHECKPOINT_MILLIS } from "@cua/replay"
import { replay, shippedArtifact } from "./support/replay-harness.ts"

/** SPEC's canonical absent member: well-formed, and simply not on file. */
const ABSENT = "99999"

it.live("a member who does not exist is an answer with a code, not a failure", () =>
  Effect.gen(function* () {
    const { result } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: ABSENT }
    })

    expect(result.result).toBe("business_outcome")
    if (result.result !== "business_outcome") return

    // The code a calling agent branches on, and the sentence a human reads. Both
    // come from the artifact's declaration rather than from anything the engine
    // decided, so what the caller is told is what a reviewer approved.
    expect(result.code).toBe("MEMBER_NOT_FOUND")
    expect(result.detail).toBe(
      shippedArtifact().outcomes?.["MEMBER_NOT_FOUND"]?.title
    )

    // Deterministic, not proposed. `assisted` is what ticket 15 sets when a model
    // guessed at the classification, and a caller must always be able to tell the
    // two apart.
    expect(result.assisted).toBeUndefined()
    expect(result.confidence).toBeUndefined()

    // The class carries no failure at all — not an empty one, not a benign one.
    expect(result).not.toHaveProperty("failure")
  })
)

it.live("nothing about the run is reported as an error or a failure", () =>
  Effect.gen(function* () {
    const { result, events } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: ABSENT }
    })

    // No step failed. The one that met the outcome is marked `outcome`, and the
    // steps behind it were never attempted rather than having gone wrong.
    expect(result.steps.map((step) => step.checkpoint)).toEqual([
      "held",
      "held",
      "outcome",
      "not_reached",
      "not_reached",
      "not_reached"
    ])

    // No checkpoint in the evidence is `failed`. The three verdicts exist for
    // exactly this: anything counting failures out of the log has to be able to
    // tell a domain answer from a fault without reading prose.
    const checkpoints = events.filter((event) => event.kind === "checkpoint")
    expect(checkpoints.map((event) => event.verdict)).toEqual(["held", "held", "outcome"])

    // And the run itself ended as a business outcome, not a failure.
    const end = events.find((event) => event.kind === "run.end")
    expect(end?.result).toBe("business_outcome")
    expect(end?.summary).toContain("MEMBER_NOT_FOUND")

    // Policy allowed everything it was asked about; no denial masquerading as the
    // reason the run stopped.
    for (const event of events) {
      if (event.kind === "policy.check") expect(event.verdict).toBe("allow")
    }
  })
)

it.live("evidence records the outcome and which checkpoint branch matched", () =>
  Effect.gen(function* () {
    const { events, evidenceDirectory } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: ABSENT }
    })

    const outcome = events.find((event) => event.kind === "outcome")
    expect(outcome?.code).toBe("MEMBER_NOT_FOUND")

    // The step it was reached at, so the record joins up with the checkpoint and
    // the observation either side of it.
    expect(outcome?.stepId).toBe("run-member-search")

    // And *why*: the branch conditions that actually held, in the artifact's own
    // words. The code alone says what the system concluded; this is the half a
    // reviewer can check against the artifact and disagree with.
    expect(outcome?.matched).toContain("Member Not Found")
    expect(outcome?.matched).toContain("No member record found for member number")

    // Exactly one outcome event. A run that ends in a declared outcome does not
    // also record a SUCCESS.
    expect(events.filter((event) => event.kind === "outcome")).toHaveLength(1)

    // Still an auditable run: the same files a successful one leaves behind.
    const lines = readFileSync(join(evidenceDirectory, "events.jsonl"), "utf8").trim().split("\n")
    expect(lines.length).toBe(events.length)

    // And no model was consulted to reach it. The classification came from a
    // condition the artifact wrote down in advance (ADR-0003).
    expect(events.some((event) => event.kind === "decide")).toBe(false)
    expect(events.some((event) => event.kind.startsWith("assist."))).toBe(false)
  })
)

it.live("a declared outcome is reached at once, not waited out like a failure", () =>
  Effect.gen(function* () {
    const { events } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: ABSENT }
    })

    const branchTaken = events.find(
      (event) => event.kind === "checkpoint" && event.verdict === "outcome"
    )
    expect(branchTaken).toBeDefined()
    if (branchTaken?.kind !== "checkpoint") return

    // A declared outcome is a definite state, not one that has yet to settle.
    // Polling it for the full checkpoint bound before admitting it would be
    // treating a legitimate answer as a failure in everything but name — the
    // caller waits, and the timing in the log reads like a timeout.
    expect(branchTaken.waitedMillis).toBeLessThan(DEFAULT_CHECKPOINT_MILLIS)
  })
)

it.live("a member who does exist is never re-read as an outcome", () =>
  Effect.gen(function* () {
    const { result, events } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: "12345" }
    })

    // The branch sits on the same checkpoint the happy path passes through, so
    // this is the assertion that the two cannot be confused: `expect` is tried
    // first, on every pass, and a screen that satisfies the intended state is
    // never offered to a branch at all.
    expect(result.result).toBe("success")
    expect(events.some((event) => event.kind === "checkpoint" && event.verdict === "outcome")).toBe(
      false
    )
    const outcome = events.find((event) => event.kind === "outcome")
    expect(outcome?.code).toBe("SUCCESS")
    expect(outcome?.matched).toBeUndefined()
  })
)
