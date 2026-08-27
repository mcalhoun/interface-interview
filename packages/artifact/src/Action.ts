/**
 * The Action vocabulary: the fixed set of operations a Capability Artifact can
 * ask for.
 *
 * Fixed is the operative word. SPEC user story 3 wants Discovery choosing from a
 * constrained vocabulary "rather than emit arbitrary code, so that every action
 * it takes is reviewable and policy-checkable". A closed union is what makes both
 * true: a reviewer reads four verbs, and the Policy engine (ticket 07) has a
 * finite set of things to classify as safe or risky.
 *
 * Every Action names its subject as a Target and its value as a `ValueRef`. There
 * is no free-text field anywhere that could hold a script, a selector or a member
 * number.
 *
 * ## Seam for ticket 09 (selection by discovered enum)
 *
 * `selectFromList` belongs here, exactly as SPEC sketches it:
 *
 *     - type: selectFromList
 *       list: { within: {...}, itemRole: link }
 *       match: { against: { from: parameter, name: accountType }, strategy: tokenSubset }
 *
 * Adding it is a member here plus one branch in the Replay executor's switch.
 * Today `open-savings-account` in `member.account-balance@1.0.0` is a plain
 * `click` on a link named `Primary Savings`; ticket 09 replaces that single Step
 * and nothing else.
 */

import { Schema } from "effect"
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

export const Action = Schema.Union([Navigate, Fill, Click, Extract])
export type Action = typeof Action.Type

/** The Action's verb, for Evidence and for Policy's classification (ticket 07). */
export type ActionType = Action["type"]
