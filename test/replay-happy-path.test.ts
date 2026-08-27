/**
 * The tracer bullet, driven end to end: a hand-written Capability Artifact,
 * executed against the real Heritage Core in a real browser, returning a typed
 * balance.
 *
 * These assert on what a caller actually receives and what lands on disk. SPEC:
 * "a good test here asserts on externally observable behavior ... it never
 * asserts on internal call sequences. The result contract, the artifact and the
 * evidence are the product, so they are what the tests should pin."
 *
 * `it.live` throughout, not `it.effect`: checkpoint evaluation polls with
 * `Effect.sleep`, and under `@effect/vitest`'s TestClock those sleeps never come
 * back on their own.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { replay, shippedArtifact } from "./support/replay-harness.ts"

it.live("returns a typed balance with amount and currency", () =>
  Effect.gen(function* () {
    const { result } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: "12345" }
    })

    expect(result.result).toBe("success")
    if (result.result !== "success") return

    // A balance as an amount plus a currency, not a scraped string the caller has
    // to parse again (SPEC user story 25).
    expect(result.outputs["availableBalance"]).toEqual({
      type: "money",
      value: { amount: 4182.55, currency: "USD" }
    })
    expect(result.outputs["currentBalance"]).toEqual({
      type: "money",
      value: { amount: 4382.55, currency: "USD" }
    })
  })
)

it.live("every step reached the state it intended, and says which one it was", () =>
  Effect.gen(function* () {
    const { result } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: "12345" }
    })
    if (result.result !== "success") throw new Error(`expected success, got ${result.result}`)

    expect(result.steps.map((step) => step.id)).toEqual([
      "open-member-search",
      "enter-member-number",
      "run-member-search",
      "open-account",
      "read-available-balance",
      "read-current-balance"
    ])
    // Nothing infers success from the absence of an exception: every one of them
    // asserted a named condition and observed it.
    expect(result.steps.every((step) => step.checkpoint === "held")).toBe(true)
    expect(result.steps.at(-2)?.read).toBe("$4,182.55")
  })
)

it.live("writes one events.jsonl and a final screenshot to the evidence directory", () =>
  Effect.gen(function* () {
    const { evidenceDirectory, events, result } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: "12345" }
    })

    expect(result.evidenceDirectory).toBe(evidenceDirectory)
    expect(existsSync(join(evidenceDirectory, "events.jsonl"))).toBe(true)
    expect(statSync(join(evidenceDirectory, "final.png")).size).toBeGreaterThan(1000)

    // The directory documents its own limits where a reviewer will find them,
    // rather than leaving the screenshot gap unsaid (ADR-0010).
    expect(readFileSync(join(evidenceDirectory, "README.txt"), "utf8")).toContain(
      "Screenshots are NOT redacted"
    )

    // Every event kind the run is supposed to emit, and nothing from discovery or
    // the recovery ladder.
    expect(new Set(events.map((event) => event.kind))).toEqual(
      new Set(["run.start", "observe", "policy.check", "action", "checkpoint", "outcome", "run.end"])
    )
  })
)

it.live("every event carries run, session and sequence identifiers", () =>
  Effect.gen(function* () {
    const { events } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: "12345" },
      runId: "joined-up"
    })

    // This is what makes discovery, replay and intervention records join up
    // afterwards (SPEC user story 63).
    for (const event of events) {
      expect(event.runId).toBe("joined-up")
      expect(event.sessionId).toBe("session-joined-up")
      expect(typeof event.at).toBe("string")
    }
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index))
  })
)

it.live("records the reasoning that actually resolved each target", () =>
  Effect.gen(function* () {
    const { events } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: "12345" }
    })

    const fill = events.find((event) => event.kind === "action" && event.stepId === "enter-member-number")
    if (fill === undefined || fill.kind !== "action") throw new Error("no fill action recorded")

    // The artifact's declared strategy sits next to what the adapter actually
    // did, so a target that starts resolving for a different reason than the one
    // written down is visible in the record rather than silently fine.
    expect(fill.declaredStrategy).toBe("scoped-accessible-name")
    expect(fill.resolvedBy).toEqual(["within", "role", "name"])
    expect(fill.rationale).toContain("Member Number Search")
  })
)

it.live("every action passed the policy chokepoint before it happened", () =>
  Effect.gen(function* () {
    const { events } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: "12345" }
    })

    const checks = events.filter((event) => event.kind === "policy.check")
    const actions = events.filter((event) => event.kind === "action")
    expect(checks).toHaveLength(actions.length)
    expect(checks.every((check) => check.kind === "policy.check" && check.verdict === "allow")).toBe(
      true
    )

    // Ordering, not just count: a check that lands after the action it authorises
    // has authorised nothing.
    for (const action of actions) {
      const check = checks.find((candidate) => candidate.stepId === action.stepId)
      expect(check!.seq).toBeLessThan(action.seq)
    }
  })
)

it.live("records no runtime input value in the run.start event", () =>
  Effect.gen(function* () {
    const { events } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: "12345" }
    })

    const start = events.find((event) => event.kind === "run.start")
    if (start === undefined || start.kind !== "run.start") throw new Error("no run.start")

    // Names and classifications, never values. The accessibility snapshots in the
    // same file still carry the rendered member number: scrubbing those is ticket
    // 08's job at the writer's single serialisation point.
    //
    // `accountType` is here because it defaulted rather than being passed, and it
    // is classified in the same breath as the one that was — the record says what
    // the run could see, not what the caller happened to type.
    expect(start.inputs).toEqual([
      { name: "memberId", sensitive: true },
      { name: "accountType", sensitive: false }
    ])
    expect(JSON.stringify(start)).not.toContain("12345")
  })
)
