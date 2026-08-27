/**
 * The Action vocabulary: the fixed set of operations a Capability Artifact can
 * ask for.
 *
 * Fixed is the operative word. SPEC user story 3 wants Discovery choosing from a
 * constrained vocabulary "rather than emit arbitrary code, so that every action
 * it takes is reviewable and policy-checkable". A closed union is what makes both
 * true: a reviewer reads five verbs, and the Policy engine (ticket 07) has a
 * finite set of things to classify as safe or risky.
 *
 * Every Action names its subject as a Target and its value as a `ValueRef`. There
 * is no free-text field anywhere that could hold a script, a selector or a member
 * number.
 *
 * There are five verbs. `selectFromList` is the one that is not a single
 * physical gesture: it reads the items a screen currently offers and picks the
 * one a parameter means. It earns its place in a *closed* vocabulary because the
 * alternative is worse — without it, an Artifact has to hard-code the label of
 * the item it wants, which is both a Tenant-specific string in a vendor-level
 * document and a hidden decision no reviewer can see being made.
 */

import { Schema } from "effect"
import { TargetScopeSchema } from "@cua/surface"
import { OutcomeCode } from "./BusinessOutcomes.ts"
import { CapabilityTarget } from "./Target.ts"
import { ValueRef } from "./Value.ts"

/**
 * Go to a location. The url is relative to the Tenant's base URL, never absolute:
 * an Artifact describes a Capability of a vendor product, and which institution's
 * installation it runs against is environment, not capability. That is also what
 * gives ticket 07 something to check an origin allowlist against, and ticket 16 a
 * second Tenant with no Artifact change.
 */
const Navigate = Schema.Struct({
  type: Schema.Literal("navigate"),
  path: ValueRef
})

/** Type a value into a named control. */
const Fill = Schema.Struct({
  type: Schema.Literal("fill"),
  target: CapabilityTarget,
  value: ValueRef
})

/** Press a named control. */
const Click = Schema.Struct({
  type: Schema.Literal("click"),
  target: CapabilityTarget
})

/**
 * Read the text a named control shows, and bind it under the Step's own id so
 * later Steps and the declared outputs can refer to it.
 */
const Extract = Schema.Struct({
  type: Schema.Literal("extract"),
  target: CapabilityTarget
})

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Which items are on offer.
 *
 * `within` is the region the list sits in, named by the caption heading it —
 * `{ name: "Share and Deposit Accounts" }` means the table that caption heads,
 * even though in the accessibility tree the caption is a sibling cell in that
 * table's first row.
 *
 * SPEC's sketch spells this `labelledBy`. One spelling is kept rather than two,
 * because under the caption-climbing rule `labelledBy` and `name` mean exactly
 * the same thing, and a document with two ways to say one thing is a document a
 * reviewer has to learn twice.
 */
const ItemList = Schema.Struct({
  within: Schema.optional(TargetScopeSchema),
  /** The role each item carries; `link` for a list of account links. */
  itemRole: Schema.String
})

/**
 * How a parameter is matched against the items' labels.
 *
 * `strategy` is a single-member literal on purpose. Token subset is the matching
 * rule (ADR-0007), and a field that can only say one thing is how the Artifact
 * states which rule was applied without pretending others are configurable. A
 * second strategy would be a new ADR, not a new string.
 */
const ItemMatch = Schema.Struct({
  /**
   * The value to match. A `ValueRef` rather than SPEC's shorter
   * `{ parameter: accountType }`, so selection uses the one spelling of
   * provenance the rest of the document already uses, and so an item can also be
   * chosen by something an earlier Step read.
   */
  against: ValueRef,
  strategy: Schema.Literal("tokenSubset")
})

/** The code to escalate under when selection does not land on exactly one item. */
const Escalation = Schema.Struct({ escalate: Schema.String })

/**
 * What it means when the live list offers nothing matching.
 *
 * Two spellings, and the difference between them is the whole of what an
 * Intervention teaches (ticket 13):
 *
 *   - `escalate: CODE` — *we do not know*. The list rendered, nothing in it
 *     carried the tokens asked for, and whether that is the domain saying no or
 *     the screen having changed is exactly the question. The run stops, and if
 *     somebody is attending it, a person is asked.
 *   - `outcome: CODE` — *this is an answer*. The same state, reclassified: the
 *     application is telling the caller something true about its own domain, so
 *     Replay returns it and nobody is woken.
 *
 * A document cannot start life in the second form. An Artifact author knows a
 * selection can find nothing; they do not know what finding nothing *means* at
 * an institution they have never seen. So `escalate` is what a hand-written or
 * compiled document says, and `outcome` is what an Amendment writes after an
 * Operator met the state, changed nothing, and confirmed that automation should
 * handle it itself next time (ADR-0004).
 *
 * The code does not change across that promotion, and that is deliberate. What
 * was learned is the *classification*, not the vocabulary: renaming the state at
 * intervention time would let whoever happened to be on shift redefine a
 * Capability's contract, which is the "smuggling the answer in" ADR-0004 rules
 * out. The prose that explains the code to a caller is written into `outcomes:`
 * by the Amendment, from the Intervention record.
 *
 * ## Why only `onNoMatch` has two forms
 *
 * `onMultiple` keeps one. SPEC: "two or more matches is a hard failure, never a
 * coin flip". Several items carrying every token of the parameter is a Capability
 * that has stopped being precise enough, and no amount of human confirmation
 * turns that into an answer a caller should receive — picking one would return a
 * balance for an account nobody asked for. The asymmetry in these two types is
 * that rule, stated where it cannot be forgotten.
 */
const NoMatchDisposition = Schema.Union([
  Escalation,
  Schema.Struct({ outcome: OutcomeCode })
])
export type NoMatchDisposition = typeof NoMatchDisposition.Type

/** The code this disposition names, whichever form it is in. */
export const noMatchCode = (disposition: NoMatchDisposition): string =>
  "outcome" in disposition ? disposition.outcome : disposition.escalate

/**
 * The declared Business Outcome a no-match reaches, or `undefined` while the
 * state is still unclassified.
 *
 * The one place the engine asks "is this an answer or a stop", so the branch is
 * a property of the document rather than a condition somewhere in the executor.
 */
export const noMatchOutcome = (disposition: NoMatchDisposition): string | undefined =>
  "outcome" in disposition ? disposition.outcome : undefined

/**
 * Choose one of the items a screen currently offers, and press it.
 *
 * This is the generic form of "click the savings account". Nothing about which
 * account is wanted is written here: the legal values are declared as an `enum`
 * input read off the page during Discovery, and the choice is made at Replay
 * time against the live list by token subset. That is what lets one Artifact
 * serve every account type, and what lets a Tenant labelling the same account
 * `Regular Savings` match `savings` with no Override at all (ADR-0007).
 *
 * Both failure modes are declared rather than assumed. Nothing matching and more
 * than one thing matching are different facts about the world — one is usually
 * the domain saying no, the other is always a Capability that has stopped being
 * precise enough — so each names its own escalation code.
 */
const SelectFromList = Schema.Struct({
  type: Schema.Literal("selectFromList"),
  list: ItemList,
  match: ItemMatch,
  onNoMatch: NoMatchDisposition,
  onMultiple: Escalation,
  /**
   * Why this list and this matching rule, and what would have to change on screen
   * to break them. The same reviewer contract every `Target` carries; a
   * `selectFromList` has no single Target to hang it on, so it hangs here.
   */
  robustness: Schema.String
})

export const Action = Schema.Union([Navigate, Fill, Click, Extract, SelectFromList])
export type Action = typeof Action.Type

/** The Action's verb, for Evidence and for Policy's classification (ticket 07). */
export type ActionType = Action["type"]

export type SelectFromListAction = typeof SelectFromList.Type
export type ItemList = typeof ItemList.Type

/** `link items inside "Share and Deposit Accounts"`, for a report or a log. */
export const describeItemList = (list: ItemList): string => {
  const scope = list.within === undefined
    ? "the screen"
    : [list.within.role, list.within.name === undefined ? undefined : JSON.stringify(list.within.name)]
        .filter((part) => part !== undefined)
        .join(" ")
  return `${list.itemRole} items in ${scope}`
}
