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
 * ## Expecting one of several states
 *
 * `expect` is the state the Step is *for*. `orOutcome` is the list of other
 * states the application is known to answer with, each naming a Business Outcome
 * code the caller can branch on. A Checkpoint with branches says: this is what
 * should happen, and here is what else this screen legitimately does.
 *
 *     checkpoint:
 *       description: Member Detail is showing.
 *       expect:
 *         - assert: textPresent
 *           text: Member Detail
 *       orOutcome:
 *         - code: MEMBER_NOT_FOUND
 *           when:
 *             - assert: textPresent
 *               text: Member Not Found
 *
 * A branch is written in the same assertion vocabulary as `expect`, because
 * recognising a domain answer and confirming an intended state are the same act
 * of reading a screen. Nothing about a branch is privileged: it cannot reach
 * markup, cannot consult a model, and cannot match on anything an Artifact did
 * not write down first.
 *
 * The ordering — `expect` first, branches only if it does not hold — is what
 * makes the two impossible to confuse. A screen that satisfies the intended state
 * is never re-read as an outcome.
 */

import { Schema } from "effect"
import { describeTarget } from "@cua/surface"
import { OutcomeCode } from "./BusinessOutcomes.ts"
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

/**
 * One alternative state this Step's screen is known to reach, and the Business
 * Outcome code that state means.
 *
 * Every assertion in `when` must hold for the branch to be taken, and the code
 * must be declared in the Artifact's `outcomes:` — `parseArtifact` rejects one
 * that is not, so a code a caller can receive always has prose explaining it.
 */
export const OutcomeBranch = Schema.Struct({
  code: OutcomeCode,
  /** Every one must hold. An empty list would match every screen. */
  when: Schema.Array(Assertion).check(Schema.isMinLength(1))
})
export type OutcomeBranch = typeof OutcomeBranch.Type

export const Checkpoint = Schema.Struct({
  /** What reaching this state means, in an operator's words. Shown on failure. */
  description: Schema.String,
  /** Every assertion must hold. An empty list is not a Checkpoint. */
  expect: Schema.Array(Assertion).check(Schema.isMinLength(1)),
  /**
   * Other states this screen legitimately reaches, tried in order and only when
   * `expect` does not hold. Reaching one ends the run as a Business Outcome:
   * successfully, with a code, reporting no failure anywhere.
   *
   * Absent on most Checkpoints. A Step whose screen has exactly one legitimate
   * next state should say so by having no branches, rather than by declaring a
   * branch nothing can reach.
   */
  orOutcome: Schema.optional(Schema.Array(OutcomeBranch).check(Schema.isMinLength(1))),
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

/**
 * How a taken branch reads in Evidence and in a result: the conditions that were
 * actually true, in the Artifact's own words.
 *
 * This is the "which checkpoint branch matched" half of the record. A code alone
 * would say what the system concluded; this says what it saw in order to conclude
 * it, which is the part a reviewer can disagree with.
 */
export const describeBranch = (branch: OutcomeBranch): string =>
  branch.when.map(describeAssertion).join("; and ")
