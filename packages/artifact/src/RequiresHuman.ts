/**
 * The states this Capability has learned it must never handle itself.
 *
 * SPEC's third class, and the one that must never go wrong:
 *
 * > Learning a `requires_human` state does not make it automatable. It makes
 * > replay fail fast with the right reason and routing instead of burning a
 * > stuck-detection cycle to reach a generic unknown state. The system learns
 * > that it must escalate and why. It never learns to proceed. These entries are
 * > write-once: no later intervention can downgrade one to `business_outcome`.
 * > The rule only tightens.
 *
 * ## Why this is its own section and not a flag on an outcome
 *
 * `BusinessOutcomes.ts` said in advance why: "entries there are write-once and
 * can never be downgraded to a Business Outcome, and a separate section is what
 * makes that rule enforceable by looking at a diff."
 *
 * A boolean on an `OutcomeDeclaration` would put the two classes in one table,
 * and a downgrade would then be a one-character edit that no reviewer reading a
 * diff of `outcomes:` would necessarily notice. Two disjoint sections make a
 * downgrade a *move*: a code leaves `requiresHuman:` and appears under
 * `outcomes:`, which is four changed lines in the middle of a review document,
 * and `parseArtifact` refuses a document where a code appears in both. The rule
 * is expressible as a shape rather than only as a check.
 *
 * ## What an entry says, and what it deliberately does not say
 *
 * It says: **when this Step's Checkpoint does not hold and nothing above it in
 * the ladder has claimed the state, a person with authority is required.** It
 * carries no `detect` assertions, and that absence is the honest part.
 *
 * A Recoverable Condition can carry a `detect` because somebody wrote one: the
 * "System Busy" interstitial announces itself. A requires-human state is learned
 * from an episode in which a person acted in the live browser window, and the
 * system has no structural record of *what they did* — a real Operator clicks in
 * Chromium, not through an API. Inventing a `detect` from the accessibility tree
 * the run happened to capture would be the automation deciding what a screen
 * means, which is precisely what ADR-0004 refuses. So the recognition rule is the
 * one thing the document already knows for certain: which Step's Checkpoint
 * reached it.
 *
 * The cost is stated rather than hidden. A different unrecognised state at the
 * same Step is reported under this entry's code too. That is the correct answer
 * anyway — both need a person — and the entry's `title` and `summary` say what
 * the state was known to be, so nobody reads it as a claim that the screen was
 * recognised.
 *
 * ## The code, and why the mechanism will not name the state
 *
 * Ticket 13's precedent: an Intervention teaches a state's *classification*, not
 * a Capability's vocabulary. There the code already existed — the Artifact's
 * author had written `onNoMatch: { escalate: NO_MATCHING_ITEM }` — and the
 * amendment only changed what the document said that code meant.
 *
 * A Checkpoint that fails has no such authored code, so one has to come from
 * somewhere, and the only safe somewhere is *mechanically, from what is already
 * written down*. `requiresHumanCode` derives it from the Step id and the class,
 * both of which are already in the document, and consults nothing an Operator
 * typed. `open-account` becomes `OPEN_ACCOUNT_REQUIRES_HUMAN`.
 *
 * That is a deliberately unlovely code, and a prettier caller-facing one — an
 * `ACCOUNT_RESTRICTED` — is a hand-written version cut after the fact by somebody
 * who owns the Capability's contract. Ticket 13 said the same of
 * `ACCOUNT_TYPE_NOT_HELD`. Letting whoever is on shift supply the word would let
 * one person's ten seconds at a terminal rename a Capability's public vocabulary,
 * and the fact that it would read better is not an argument for it.
 */

import { Schema } from "effect"
import { OutcomeCode } from "./BusinessOutcomes.ts"

/**
 * One state a person with authority is always required for.
 *
 * The three prose fields are the same three an `OutcomeDeclaration` carries, for
 * the same two readers — except that `discoveredFrom` is **required** here.
 *
 * A Business Outcome can be hand-written by an author who knows the domain; the
 * one at 1.0.0 of the shipped Capability was. A requires-human entry can only
 * ever come from an episode in which a person resolved the state by acting, so a
 * document carrying one with no account of where it came from is a document
 * claiming an unfalsifiable thing. Making the field required is cheaper than a
 * review convention that it should be filled in.
 */
export const RequiresHumanDeclaration = Schema.Struct({
  /**
   * The Step whose Checkpoint reaches this state.
   *
   * The whole recognition rule, and the only field an engine reads. See the
   * module note on why there is nothing else to read.
   */
  step: Schema.String,
  /** One line, in the caller's terms. What is true of the domain. */
  title: Schema.String,
  /**
   * Prose for whoever approves this version: what the state is, why no amount of
   * retrying or better perception resolves it, and what a caller should do.
   */
  summary: Schema.String,
  /** The Intervention that justified it, naming the record. Required. */
  discoveredFrom: Schema.String
})
export type RequiresHumanDeclaration = typeof RequiresHumanDeclaration.Type

/** Every always-escalating state this Capability knows about, keyed by code. */
export const RequiresHumanDeclarations = Schema.Record(OutcomeCode, RequiresHumanDeclaration)
export type RequiresHumanDeclarations = typeof RequiresHumanDeclarations.Type

/**
 * The code a learned requires-human state is filed under, derived from the Step.
 *
 * Total, pure, and the *only* expression in the system that produces one of these
 * names. Deriving it in one place is what makes "the mechanism does not invent
 * domain vocabulary" checkable: there is nowhere else a word could get in.
 */
export const requiresHumanCode = (stepId: string): string =>
  `${stepId.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}_REQUIRES_HUMAN`
