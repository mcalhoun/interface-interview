/**
 * Recoverable Conditions: the transient states a Capability declares it knows how
 * to get past on its own.
 *
 * CONTEXT.md: "A transient state the system knows how to get past on its own. A
 * slow load, a dismissable interstitial, an expired session. The run continues
 * afterwards." SPEC's classification table calls the recoverable class
 * *declarable*, learned from what a person did during an Intervention that put
 * the session back at the expected Checkpoint. So this belongs in the Artifact —
 * the reviewable document — rather than in the engine. An engine that knew what
 * "System Busy" meant would be an engine nobody could review and no Tenant could
 * override.
 *
 * ## The shape, and why each part of it is required
 *
 * A recovery is three things, and leaving any of them implicit is how automation
 * quietly starts lying about what happened:
 *
 *   - **`detect`** — what has to be true of the screen for this rule to apply.
 *     Ordinary Checkpoint assertions, evaluated against the state that defeated
 *     the Step's Checkpoint. Recovery never fires on "something went wrong"; it
 *     fires on a state somebody wrote down.
 *
 *   - **`remedy`** — a bounded, reviewable list of Actions from the same closed
 *     vocabulary every Step uses. Not a script, not a hook: a Policy engine can
 *     classify these the same way it classifies a Step's Action, and a reviewer
 *     reads them the same way. It may be empty, which declares "this one clears
 *     on its own; look again after a pause".
 *
 *   - **`attempts` and `backoffMillis`** — the bound, in the document, in
 *     numbers a reviewer can argue with. A condition that has not cleared after
 *     `attempts` tries stops being recoverable and becomes a Hard Failure. That
 *     is not a policy the engine chooses; it is a number this file makes someone
 *     write down.
 *
 * What is deliberately *not* here is any statement that the remedy worked.
 * Whether it worked is decided by re-evaluating the Step's own Checkpoint, which
 * is the one thing already trusted to say whether a state was reached.
 *
 * ## `resume`
 *
 * Two shapes, because the two conditions this ticket was written against fail
 * differently:
 *
 *   - **`here`** — the remedy left the run where it needs to be, so re-evaluate
 *     the Checkpoint and carry on. A dismissed interstitial is this: pressing
 *     Continue re-requests the very screen that was wanted.
 *
 *   - **`at-step`** — the remedy fixed the *condition* but lost the *place*. A
 *     re-authentication is this: signing back on works and lands the operator on
 *     the home screen, nowhere near the Step that was interrupted. Resuming means
 *     returning to where the Step began and attempting it again.
 *
 * `at-step` re-attempts a Step's Action, so it is safe exactly as far as that
 * Action is repeatable. Every Action in `member.account-balance` is a navigation,
 * a search field or a reading, which is why the Capability declares this at all.
 * A Capability that moves money would need Policy (ticket 07) to refuse `at-step`
 * on an irreversible Action rather than trusting the author, and that refusal
 * belongs in the Policy engine rather than in this schema.
 */

import { Schema } from "effect"
import { Action } from "./Action.ts"
import { Assertion } from "./Checkpoint.ts"

/** Where the run is once the remedy has run, and therefore what resuming means. */
export const RecoveryResume = Schema.Literals(["here", "at-step"])
export type RecoveryResume = typeof RecoveryResume.Type

/**
 * One Action of a remedy, with the reason it is there.
 *
 * `intent` is required for the same reason a Step's is: it is what Evidence
 * records as "what was attempted", and a list of bare Actions is a list nobody
 * reading a failure at 3am can interpret.
 */
export const RemedyStep = Schema.Struct({
  intent: Schema.String,
  action: Action
})
export type RemedyStep = typeof RemedyStep.Type

export const RecoverableCondition = Schema.Struct({
  /** A stable code, the way a Business Outcome has one. Recorded in Evidence. */
  condition: Schema.String,
  /** What this state is and why it is transient, for whoever approves the rule. */
  description: Schema.String,
  /** What has to hold of the screen for this rule to apply. Never "an error". */
  detect: Schema.Array(Assertion).check(Schema.isMinLength(1)),
  /** What to do about it. Empty declares that waiting is the whole remedy. */
  remedy: Schema.Array(RemedyStep),
  resume: RecoveryResume,
  /** Total tries, including the first. Beyond this the condition is a failure. */
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The first pause between tries. Subsequent pauses double it. */
  backoffMillis: Schema.Int
})
export type RecoverableCondition = typeof RecoverableCondition.Type
