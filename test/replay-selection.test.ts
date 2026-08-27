/**
 * Selection by discovered enum: one Capability serving every account, and the
 * matching rule that makes multi-tenant reuse fall out for free.
 *
 * Everything here runs the real Artifact against the real Heritage Core in a
 * real browser. That matters more for this ticket than for most: the claim under
 * test is that Replay *reads the live list*, so a test that fed it a list would
 * be testing the wrong thing entirely.
 *
 * Four properties, in the order they build on each other:
 *
 *   1. The same Artifact returns the savings balance by default and the checking
 *      balance on request. One document, no second discovery run.
 *   2. Matching is by token subset against the live labels, so a Tenant that
 *      labels the same account `Regular Savings` matches `Savings` with no
 *      Override anywhere. This is the property ticket 16 is built on, which is
 *      why it is proved here rather than assumed there.
 *   3. Nothing matching and several things matching are different outcomes,
 *      distinguishable by a caller and diagnosable by a person.
 *   4. No model is involved, and the choice is reproducible from the Evidence.
 *
 * `it.live` throughout, not `it.effect`: checkpoint evaluation polls with
 * `Effect.sleep`, and under `@effect/vitest`'s TestClock those never come back.
 */

import { it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { expect } from "vitest"
import { prepareInputs } from "@cua/artifact"
import { isTokenSubsetOf, tokensOf } from "@cua/surface"
import { replay, shippedArtifact } from "./support/replay-harness.ts"

/** The label-variant tenant fixture: `Regular Savings`, `Checking Account`. */
const VARIANT_TENANT = "22222"

/** A member holding two savings accounts, so `Savings` matches both. */
const TWO_SAVINGS = "33333"

// ---------------------------------------------------------------------------
// One capability, every account
// ---------------------------------------------------------------------------

it.live("returns the savings balance by default and the checking balance on request", () =>
  Effect.gen(function* () {
    const artifact = shippedArtifact()

    const savings = yield* replay({ artifact, inputs: { memberId: "12345" } })
    const checking = yield* replay({
      artifact,
      inputs: { memberId: "12345", accountType: "Checking" }
    })

    if (savings.result.result !== "success") throw new Error("savings run did not succeed")
    if (checking.result.result !== "success") throw new Error("checking run did not succeed")

    // Two different accounts, from the same six steps of the same document. The
    // previous version of this artifact could only ever have returned the first
    // of these, because the label it clicked was written into it.
    expect(savings.result.outputs["availableBalance"]).toEqual({
      type: "money",
      value: { amount: 4182.55, currency: "USD" }
    })
    expect(checking.result.outputs["availableBalance"]).toEqual({
      type: "money",
      value: { amount: 1204.18, currency: "USD" }
    })

    expect(savings.result.version).toBe(checking.result.version)
    expect(savings.result.steps.map((step) => step.id)).toEqual(
      checking.result.steps.map((step) => step.id)
    )
  })
)

it.live("omitting the parameter uses the default the artifact recorded", () =>
  Effect.gen(function* () {
    const artifact = shippedArtifact()
    const declared = artifact.inputs["accountType"]!
    expect(declared.default).toBe("Savings")

    const omitted = yield* replay({ artifact, inputs: { memberId: "12345" } })
    const explicit = yield* replay({
      artifact,
      inputs: { memberId: "12345", accountType: declared.default! }
    })

    if (omitted.result.result !== "success") throw new Error("the defaulted run did not succeed")
    if (explicit.result.result !== "success") throw new Error("the explicit run did not succeed")
    expect(omitted.result.outputs).toEqual(explicit.result.outputs)
  })
)

// ---------------------------------------------------------------------------
// The property ticket 16 rests on
// ---------------------------------------------------------------------------

it.live("a tenant labelling the account differently still matches, with no override", () =>
  Effect.gen(function* () {
    // Member 22222's institution calls these "Regular Savings" and "Checking
    // Account". Nothing about the artifact, the inputs or the configuration
    // changes — the only thing that differs is what the screen says.
    const artifact = shippedArtifact()

    const savings = yield* replay({ artifact, inputs: { memberId: VARIANT_TENANT } })
    if (savings.result.result !== "success") {
      throw new Error(`expected success, got ${JSON.stringify(savings.result)}`)
    }
    expect(savings.result.outputs["availableBalance"]).toEqual({
      type: "money",
      value: { amount: 812.4, currency: "USD" }
    })

    // And the other direction of the same rule: "Checking" is a token subset of
    // "Checking Account".
    const checking = yield* replay({
      artifact,
      inputs: { memberId: VARIANT_TENANT, accountType: "Checking" }
    })
    if (checking.result.result !== "success") throw new Error("the checking run did not succeed")
    expect(checking.result.outputs["availableBalance"]).toEqual({
      type: "money",
      value: { amount: 3905.62, currency: "USD" }
    })

    // The record says which label it actually landed on, so the claim is
    // checkable from the evidence rather than inferred from the balance.
    const action = savings.events.find(
      (event) => event.kind === "action" && event.stepId === "open-account"
    )
    if (action === undefined || action.kind !== "action") throw new Error("no selection recorded")
    expect(action.target).toContain("Regular Savings")
    expect(action.rationale).toContain("Regular Savings")
  })
)

// ---------------------------------------------------------------------------
// The two ways it can fail to land on exactly one item
// ---------------------------------------------------------------------------

it.live("nothing matching and several things matching are different outcomes", () =>
  Effect.gen(function* () {
    const artifact = shippedArtifact()

    // "Primary Savings" is a legal value — it is one of the discovered labels —
    // but it is not a token subset of "Regular Savings" or "Checking Account",
    // so this tenant genuinely offers nothing that answers to it.
    const none = yield* replay({
      artifact,
      inputs: { memberId: VARIANT_TENANT, accountType: "Primary Savings" }
    })
    if (none.result.result !== "failure") throw new Error("expected a failure")
    if (none.result.failure.reason !== "no_matching_item") {
      throw new Error(`expected no_matching_item, got ${none.result.failure.reason}`)
    }

    // The code the artifact declared, not one the engine invented.
    expect(none.result.failure.code).toBe("NO_MATCHING_ITEM")
    // And what *was* on offer, which is the first thing anyone wants to know and
    // the thing a plain "target not found" cannot tell them.
    expect(none.result.failure.items).toEqual(["Regular Savings", "Checking Account"])
    expect(none.result.failure.stepId).toBe("open-account")

    // Member 33333 holds two savings accounts. Both carry every token of
    // "Savings", and picking one would return a balance for an account nobody
    // asked for — so the run stops and names both (ADR-0007).
    const several = yield* replay({ artifact, inputs: { memberId: TWO_SAVINGS } })
    if (several.result.result !== "failure") throw new Error("expected a failure")
    if (several.result.failure.reason !== "ambiguous_match") {
      throw new Error(`expected ambiguous_match, got ${several.result.failure.reason}`)
    }
    expect(several.result.failure.code).toBe("AMBIGUOUS_MATCH")
    expect(several.result.failure.candidates).toEqual(["Primary Savings", "Regular Savings"])

    // The two are distinguishable without reading prose: different reasons,
    // different codes, different payloads.
    expect(none.result.failure.reason).not.toBe(several.result.failure.reason)
    expect(none.result.failure.code).not.toBe(several.result.failure.code)
  })
)

it.live("an ambiguous selection stops before it acts, rather than after", () =>
  Effect.gen(function* () {
    const { result } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: TWO_SAVINGS }
    })
    if (result.result !== "failure") throw new Error("expected a failure")

    // Nothing was clicked. The run is still on Member Detail, and the steps after
    // the selection never ran — which is the difference between refusing to guess
    // and guessing and then noticing.
    expect(result.steps.map((step) => `${step.id}:${step.checkpoint}`)).toEqual([
      "open-member-search:held",
      "enter-member-number:held",
      "run-member-search:held"
    ])
    if (result.failure.reason !== "ambiguous_match") throw new Error("wrong reason")
    expect(result.failure.url).toMatch(/\/member\?/)
  })
)

// ---------------------------------------------------------------------------
// Deterministic, and reconstructable from the record
// ---------------------------------------------------------------------------

it.live("the same list and the same parameter give the same choice every time", () =>
  Effect.gen(function* () {
    const artifact = shippedArtifact()
    const inputs = { memberId: VARIANT_TENANT, accountType: "Savings" }
    const first = yield* replay({ artifact, inputs, runId: "first" })
    const second = yield* replay({ artifact, inputs, runId: "second" })

    const comparable = (outcome: typeof first) => {
      const { evidenceDirectory, runId, sessionId, ...rest } = outcome.result
      return rest
    }
    expect(comparable(second)).toEqual(comparable(first))

    // Determinism means no model in the loop, not no logic: both runs read the
    // live account list and matched against it.
    for (const outcome of [first, second]) {
      expect(outcome.events.map((event) => event.kind)).not.toContain("decide")
      expect(outcome.events.filter((event) => event.kind.startsWith("assist."))).toEqual([])
    }
  })
)

it.live("the record carries what was on offer and why one item was chosen", () =>
  Effect.gen(function* () {
    const { events } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: "12345", accountType: "Checking" }
    })

    const action = events.find(
      (event) => event.kind === "action" && event.stepId === "open-account"
    )
    if (action === undefined || action.kind !== "action") throw new Error("no selection recorded")

    expect(action.action).toBe("selectFromList")
    expect(action.declaredStrategy).toBe("tokenSubset")
    // Everything a reviewer needs to re-derive the choice by hand: the list, the
    // items, the rule, the winner. Then how the resulting target resolved.
    expect(action.rationale).toContain("Share and Deposit Accounts")
    expect(action.rationale).toContain("\"Primary Savings\", \"Checking\"")
    expect(action.rationale).toContain("every token of \"Checking\" is in \"Checking\"")
    expect(action.rationale).toContain("then")

    // The selection was made against the snapshot the same step recorded, so the
    // evidence contains the list the choice was made from rather than a second
    // look that might have differed.
    const observed = events.find(
      (event) => event.kind === "observe" && event.stepId === "open-account"
    )
    if (observed === undefined || observed.kind !== "observe") throw new Error("no observation")
    expect(observed.accessibility).toContain("Primary Savings")
    expect(observed.seq).toBeLessThan(action.seq)

    // And the selection still went through the one policy chokepoint, naming the
    // control it was actually about to press.
    const check = events.find(
      (event) => event.kind === "policy.check" && event.stepId === "open-account"
    )
    if (check === undefined || check.kind !== "policy.check") throw new Error("no policy check")
    expect(check.action).toBe("selectFromList")
    expect(check.subject).toContain("Checking")
    expect(check.seq).toBeLessThan(action.seq)
  })
)

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

it("token subset is one-directional, which is what makes it absorb tenant labels", () => {
  // The direction is the whole design. A short goal term is a subset of a long
  // tenant label, so it travels; a long tenant label is not a subset of a
  // different long tenant label, so it does not pretend to.
  expect(isTokenSubsetOf("Savings", "Primary Savings")).toBe(true)
  expect(isTokenSubsetOf("Savings", "Regular Savings")).toBe(true)
  expect(isTokenSubsetOf("savings", "REGULAR SAVINGS")).toBe(true)
  expect(isTokenSubsetOf("Checking", "Checking Account")).toBe(true)

  expect(isTokenSubsetOf("Primary Savings", "Regular Savings")).toBe(false)
  expect(isTokenSubsetOf("Primary Savings", "Savings")).toBe(false)
  expect(isTokenSubsetOf("Savings", "Checking")).toBe(false)

  // A parameter that says nothing must never select the first thing on screen.
  expect(isTokenSubsetOf("", "Primary Savings")).toBe(false)
  expect(isTokenSubsetOf("   ", "Primary Savings")).toBe(false)

  // Punctuation and case are not part of a word.
  expect(tokensOf("Money-Market (Tier 2)")).toEqual(["money", "market", "tier", "2"])
})

it("a value the page never offered is refused before a browser opens", () => {
  const artifact = shippedArtifact()

  // Legal, because every token of it is in one of the discovered labels. The
  // live screen, not this check, decides which account it lands on.
  for (const legal of ["Savings", "Checking", "Primary Savings", "primary savings"]) {
    const prepared = prepareInputs(artifact.capability, artifact.inputs, {
      memberId: "12345",
      accountType: legal
    })
    expect(Result.isSuccess(prepared), legal).toBe(true)
  }

  // Not legal: nothing the page offered carries these tokens, so there is no
  // point opening a browser to find out.
  for (const illegal of ["Money Market", "Certificate", "Savings Plus"]) {
    const prepared = prepareInputs(artifact.capability, artifact.inputs, {
      memberId: "12345",
      accountType: illegal
    })
    expect(Result.isFailure(prepared), illegal).toBe(true)
  }
})
