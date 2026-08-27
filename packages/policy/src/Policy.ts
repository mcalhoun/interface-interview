/**
 * The Policy chokepoint: the one place that decides whether an Action may happen.
 *
 * **Ticket 03 built the chokepoint. Ticket 07 filled in the decisions.** Routing
 * every call site through one service was the invasive half and it happened first;
 * what this module adds is the judgement, and the configuration a reviewer reads
 * instead of this code.
 *
 * SPEC user story 57: "I want every action in both modes to pass the policy
 * engine before execution, so that there is one chokepoint rather than scattered
 * checks." A chokepoint is only real if there is no second path, so the Replay
 * executor performs no Surface Action except through the `authorised` gate in
 * `@cua/replay`'s `engine.ts`, and `test/replay-has-no-model.test.ts` counts the
 * adapter call sites so a fifth one appearing outside the gate fails the suite.
 * `test/policy-engine.test.ts` demonstrates the same thing behaviourally: under a
 * policy that denies everything, a real run in a real browser reaches the adapter
 * zero times.
 *
 * ## Where the decisions actually live
 *
 * In `policies/*.yaml`, not here. A reviewer asking "what is this system allowed
 * to do" should be able to answer it by reading one page of YAML — which origins,
 * which Action types, and, for anything irreversible, why it was permitted. This
 * module is the vocabulary that file is written in; `PolicyDocument.ts` is the
 * file's schema and `decide.ts` is the procedure that applies it.
 *
 * ## Risk classification lives here, not in the file
 *
 * Which Actions are safe and which are risky is a property of the Action
 * vocabulary, not of a deployment. If a Policy file could reclassify `click` as
 * safe, the classification would be worth nothing — the point of the split is
 * that permitting an irreversible Action costs something a reviewer notices. So
 * `RISK` below is the classification, and a Policy file may only decide what to
 * permit within it.
 *
 * `RISK` is `satisfies Record<ActionType, Risk>` over the Artifact's closed Action
 * union. That is the load-bearing line: ticket 09 adding `selectFromList` to the
 * vocabulary does not compile until it has been classified here, so no Action
 * type can reach the adapter that Policy has never had an opinion about. The
 * import is type-only, so this package carries no runtime dependency on
 * `@cua/artifact`.
 */

import { Context, Effect, Schema } from "effect"
import type { ActionType } from "@cua/artifact"

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

/**
 * How much a class of Action can cost if it lands somewhere unintended.
 *
 * `unknown` is not a third classification so much as the absence of one. It is
 * reachable only from outside the Artifact vocabulary — a Discovery model
 * proposing a verb nobody defined — and it is always denied. An Action nobody has
 * classified is exactly the Action that must not happen in a banking system.
 */
export const Risk = Schema.Literals(["safe", "risky", "unknown"])
export type Risk = typeof Risk.Type

/**
 * The classification.
 *
 * `navigate` and `extract` are the reading half of the vocabulary. A navigation
 * moves the browser and an extraction reads a control; neither commits anything,
 * and re-running either leaves the core banking system exactly as it was.
 *
 * `click` and `fill` are the writing half. `click` is the Action that actually
 * commits — it presses the submit buttons and the links, and a click that lands
 * one row off in a list of accounts is how the wrong account gets acted on.
 * `fill` is classified with it rather than below it because a filled field is a
 * committed field the moment something clicks submit, and because a value typed
 * into the wrong box is how a transfer acquires the wrong payee.
 *
 * A caveat worth stating rather than hiding: `navigate` is safe *because* its
 * destination is checked against the origin allowlist and its path comes from a
 * reviewed Artifact. A legacy application with mutating GET endpoints would break
 * that assumption, and the answer there is path-level rules in the Policy file
 * rather than a different classification. That extension has not been built.
 */
export const RISK = {
  navigate: "safe",
  extract: "safe",
  fill: "risky",
  click: "risky",
  // A selection resolves to a control and then presses it. It is a click that
  // worked out its own subject, so it carries a click's risk.
  selectFromList: "risky"
} as const satisfies Record<ActionType, Risk>

/** Every Action type Policy knows how to judge. A Policy file may not add to it. */
export const ACTION_TYPES: ReadonlyArray<ActionType> = Object.keys(RISK) as Array<ActionType>

export const riskOf = (type: string): Risk =>
  Object.hasOwn(RISK, type) ? RISK[type as ActionType] : "unknown"

/** The Action types this system will not perform unless a Policy names them with a reason. */
export const RISKY_ACTION_TYPES: ReadonlyArray<ActionType> = ACTION_TYPES.filter(
  (type) => RISK[type] === "risky"
)

// ---------------------------------------------------------------------------
// What Policy is asked, and what it answers
// ---------------------------------------------------------------------------

/** Which execution mode is asking. Policy applies to Discovery and Replay alike. */
export const ActionMode = Schema.Literals(["replay", "discovery"])
export type ActionMode = typeof ActionMode.Type

/** One Action asking to happen, in terms Policy can judge without a browser. */
export const ActionRequest = Schema.Struct({
  /** `navigate`, `fill`, `click`, `extract`. Anything else is `unknown` and denied. */
  type: Schema.String,
  /**
   * What the Action would land on: an absolute URL for `navigate`, the Target's
   * description otherwise. For a `navigate` this is what the origin allowlist is
   * checked against.
   */
  subject: Schema.String,
  /**
   * The URL of the page the Action takes place *on*, absent before anything is
   * open.
   *
   * Without this an origin allowlist only constrains `navigate`, and a click that
   * followed a link off the allowlist would leave every subsequent Action —
   * including a `fill` carrying a member's data — unchecked on whatever page it
   * landed on. Checking both ends is what makes the allowlist mean "the run stays
   * inside these origins" rather than "we looked at one string once".
   */
  page: Schema.optional(Schema.String),
  /** Which Step is asking, so a denial can be reported against a Step. */
  stepId: Schema.String,
  mode: ActionMode
})
export type ActionRequest = typeof ActionRequest.Type

/**
 * The answer, and the whole of it.
 *
 * Every field lands in a `policy.check` Evidence event, which is why the verdict
 * carries the policy's name and the risk class rather than only allow or deny: an
 * auditor reading the log a year later needs to know which document was in force
 * and how it classified what it let through, and neither is recoverable from a
 * bare "allow".
 */
export const PolicyVerdict = Schema.Struct({
  verdict: Schema.Literals(["allow", "deny"]),
  /** Prose. It is the `observed` half of a policy violation, so it must be readable. */
  reason: Schema.String,
  /** Which Policy document judged this. */
  policy: Schema.String,
  risk: Risk,
  /** The origin the Action was judged against, when there was one. */
  origin: Schema.optional(Schema.String)
})
export type PolicyVerdict = typeof PolicyVerdict.Type

/**
 * One consultation of the Assisted Recovery model, in terms Policy can judge.
 *
 * Not an `ActionRequest`, and deliberately not a member of the Action
 * vocabulary. A consultation performs nothing on the Surface: it *reads* the
 * page the run is stuck on and sends that text to a model. So there is no
 * `subject` to check an origin against and no Target to describe — the only
 * questions Policy has are whether this deployment permits consulting a model at
 * all, and whether the screen it would send is one this run was allowed to be
 * on.
 *
 * Keeping it out of `ActionRequest` is what stops `ACTION_TYPES` from growing a
 * member that is not an Action. That list is asserted equal to the Discovery
 * vocabulary and to the Artifact's Action union, and a consultation belongs to
 * neither.
 */
export const ConsultationRequest = Schema.Struct({
  /** The Step whose stall is being classified, so a denial reports against it. */
  stepId: Schema.String,
  /**
   * The page the run is stuck on. Its text is what would leave the building, so
   * it is the thing the origin allowlist is checked against.
   */
  page: Schema.String,
  mode: ActionMode
})
export type ConsultationRequest = typeof ConsultationRequest.Type

/**
 * How much a consultation can cost, in the same vocabulary as an Action.
 *
 * `risky`, and it is worth saying why, because a model that cannot act looks on
 * its face like the safest thing in the system. What is irreversible about a
 * consultation is not what it does to the application — it does nothing — but
 * what it does to the screen: once a member's details have been sent to a third
 * party, no later decision recalls them. Classifying it with `click` and `fill`
 * means it costs the same thing they cost in a Policy document, which is a
 * written reason from whoever accepted it.
 *
 * As with `RISK`, this is a property of the vocabulary and not of a deployment.
 * A Policy file may decide whether to permit a consultation; it may not decide
 * that consulting is cheap.
 */
export const CONSULTATION_RISK: Risk = "risky"

export class Policy extends Context.Service<Policy, {
  /**
   * May this Action happen?
   *
   * Total rather than failing: a denial is a verdict the caller records as
   * Evidence and turns into a `policy_violation` result, not an exception that
   * skips the record. A run stopped by Policy has to leave behind the reason it
   * was stopped, or the control is unauditable.
   */
  readonly authorise: (request: ActionRequest) => Effect.Effect<PolicyVerdict>
  /**
   * May the Assisted Recovery rung consult a model about this stalled Step?
   *
   * Separate from `authorise` because it answers a different question about a
   * different kind of thing, and folding it in would have meant either widening
   * `ActionRequest` with fields an Action has no use for or adding a member to
   * the Action vocabulary that performs no Action. A Policy that says nothing
   * about consulting denies it, like everything else this engine does not
   * mention (ADR-0005, and `policies/default.yaml`).
   *
   * Total, for the same reason `authorise` is: a denial is a verdict the rung
   * records as Evidence and falls back from, never an exception that skips the
   * record.
   */
  readonly authoriseAssist: (request: ConsultationRequest) => Effect.Effect<PolicyVerdict>
  /** Which document is in force, for the run's own record. */
  readonly name: string
}>()("cua/policy/Policy") {}
