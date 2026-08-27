/**
 * Checkpoints: the condition asserted after an Action to confirm the intended
 * state was actually reached.
 *
 * CONTEXT.md defines a Checkpoint as "distinct from the Action merely not
 * throwing", and that distinction is the whole reason this module exists. A
 * legacy web app answers a bad search with HTTP 200 and a different screen. A
 * click that lands on the wrong control navigates somewhere perfectly valid.
 * Neither raises anything. So a Step is only believed when something it named in
 * advance is observed afterwards, and `checkpoint` is not optional on a Step.
 *
 * Every assertion is evaluated against Surface State — the accessibility tree,
 * the location, and what earlier Steps read. None of them can reach markup.
 *
 * ## Seam for ticket 04 (declared Business Outcomes)
 *
 * A Checkpoint here asserts one intended state. Ticket 04 needs a Checkpoint to
 * expect *one of several* states and to end the run cleanly when a declared
 * outcome's branch matches. The shape to add is a sibling of `expect`:
 *
 *     checkpoint:
 *       description: ...
 *       expect: [...]                 # the intended state
 *       orOutcome:                    # ticket 04
 *         - code: MEMBER_NOT_FOUND
 *           when: [{ assert: textPresent, text: "could not be retrieved" }]
 *
 * Nothing below needs to change for that; `evaluate` already reports which
 * assertions hold, so a branch selector is a fold over the same result.
 */

import { Schema } from "effect"
import { describeTarget } from "@cua/surface"
import { CapabilityTarget, toSurfaceTarget } from "./Target.ts"
import { ValueRef, describeValueRef } from "./Value.ts"

/** Some node in the accessibility tree carries this text. */
const TextPresent = Schema.Struct({
  assert: Schema.Literal("textPresent"),
  text: Schema.String
})

/**
 * No node carries this text. Worth as much as its opposite: asserting that the
 * search panel is *gone* is how a Step proves it navigated, rather than proving
 * only that the new screen happens to share a caption with the old one.
 */
const TextAbsent = Schema.Struct({
  assert: Schema.Literal("textAbsent"),
  text: Schema.String
})

/** Exactly one control answers to this Target. Ambiguity fails the Checkpoint. */
const TargetPresent = Schema.Struct({
  assert: Schema.Literal("targetPresent"),
  target: CapabilityTarget
})

/** Nothing answers to this Target. */
const TargetAbsent = Schema.Struct({
  assert: Schema.Literal("targetAbsent"),
  target: CapabilityTarget
})

/**
 * The control this Target names reads back as the given value.
 *
 * This is what makes a `fill` verifiable. Typing into the wrong field is the
 * failure that a legacy screen full of near-duplicate captions actually produces,
 * and it is invisible to anything that only checks for an exception.
 */
const TargetReads = Schema.Struct({
  assert: Schema.Literal("targetReads"),
  target: CapabilityTarget,
  equals: ValueRef
})

/**
 * What a Step read off the screen matches this pattern.
 *
 * An `extract` that returns an empty cell, a placeholder or an error string is
 * the silent failure mode of screen-scraping, so an extraction Step asserts the
 * *shape* of what it got before anything downstream trusts it.
 */
const StepRead = Schema.Struct({
  assert: Schema.Literal("stepRead"),
  step: Schema.String,
  /** JavaScript regular expression source, anchored by whoever writes it. */
  matches: Schema.String
})

export const Assertion = Schema.Union([
  TextPresent,
  TextAbsent,
  TargetPresent,
  TargetAbsent,
  TargetReads,
  StepRead
])
export type Assertion = typeof Assertion.Type

export const Checkpoint = Schema.Struct({
  /** What reaching this state means, in an operator's words. Shown on failure. */
  description: Schema.String,
  /** Every assertion must hold. An empty list is not a Checkpoint. */
  expect: Schema.Array(Assertion).check(Schema.isMinLength(1)),
  /**
   * How long the state has to settle. Heritage Core does full page loads, so a
   * Checkpoint is a bounded poll rather than an instant read.
   */
  withinMillis: Schema.optional(Schema.Int)
})
export type Checkpoint = typeof Checkpoint.Type

/** How an assertion reads in a failure report: the "expected" half of the pair. */
export const describeAssertion = (assertion: Assertion): string => {
  switch (assertion.assert) {
    case "textPresent":
      return `the text ${JSON.stringify(assertion.text)} somewhere on screen`
    case "textAbsent":
      return `no occurrence of the text ${JSON.stringify(assertion.text)}`
    case "targetPresent":
      return `exactly one ${describeTarget(toSurfaceTarget(assertion.target))}`
    case "targetAbsent":
      return `nothing matching ${describeTarget(toSurfaceTarget(assertion.target))}`
    case "targetReads":
      return `${describeTarget(toSurfaceTarget(assertion.target))} to read back ${
        describeValueRef(assertion.equals)
      }`
    case "stepRead":
      return `what step ${assertion.step} read to match /${assertion.matches}/`
  }
}
