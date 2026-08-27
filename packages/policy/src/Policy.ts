/**
 * The Policy chokepoint.
 *
 * **Ticket 07 owns the decisions. Ticket 03 owns the chokepoint.** What exists
 * here is the single place every Action from either execution mode passes through
 * before reaching the Surface Adapter, and a permissive Layer that says yes to
 * everything while recording that it was asked. That split is deliberate: routing
 * every call site through one service is the expensive, invasive half, and doing
 * it after the call sites exist means finding them all again.
 *
 * SPEC user story 57: "I want every action in both modes to pass the policy
 * engine before execution, so that there is one chokepoint rather than scattered
 * checks." The chokepoint is only real if there is no second path, so the Replay
 * executor performs *no* Surface Action except through the `authorised` gate in `engine.ts`,
 * and `test/replay-has-no-model.test.ts` counts the adapter call sites.
 *
 * ## What ticket 07 fills in
 *
 * 1. Real configuration — an origin allowlist and an action-type allowlist — as
 *    a file a reviewer reads, not logic in code.
 * 2. Risk classification. `navigate`, `extract` and reading are safe;
 *    `click` and `fill` can be irreversible depending on what they land on, and
 *    the risky class is treated conservatively by default.
 * 3. A `deny` verdict becoming a `PolicyViolation` Replay failure. The result
 *    class already exists in `@cua/replay`; nothing here needs to move for it.
 */

import { Context, Effect, Layer, Schema } from "effect"

/** One Action asking to happen, in terms Policy can judge without a browser. */
export const ActionRequest = Schema.Struct({
  /** `navigate`, `fill`, `click`, `extract`. The Artifact's Action vocabulary. */
  type: Schema.String,
  /**
   * What the Action would land on: an absolute URL for `navigate`, the Target's
   * description otherwise. This is what an origin allowlist is checked against.
   */
  subject: Schema.String,
  /** Which Step is asking, so a denial can be reported against a Step. */
  stepId: Schema.String,
  /** Which mode is asking. Policy applies to Discovery and Replay alike. */
  mode: Schema.Literals(["replay", "discovery"])
})
export type ActionRequest = typeof ActionRequest.Type

export const PolicyVerdict = Schema.Union([
  Schema.Struct({ verdict: Schema.Literal("allow"), reason: Schema.String }),
  Schema.Struct({ verdict: Schema.Literal("deny"), reason: Schema.String })
])
export type PolicyVerdict = typeof PolicyVerdict.Type

export class Policy extends Context.Service<Policy, {
  /**
   * May this Action happen?
   *
   * Total rather than failing: a denial is a verdict the caller records as
   * Evidence and turns into a `PolicyViolation` result, not an exception that
   * skips the record.
   */
  readonly authorise: (request: ActionRequest) => Effect.Effect<PolicyVerdict>
}>()("cua/policy/Policy") {}

/**
 * Allows everything, and says so.
 *
 * The reason string is deliberately explicit rather than empty, because it lands
 * in every `policy.check` Evidence event, and evidence that a run happened under
 * a permissive policy is more useful than evidence that says nothing.
 */
export const permissive: Layer.Layer<Policy> = Layer.succeed(Policy)({
  authorise: () =>
    Effect.succeed({
      verdict: "allow",
      reason: "permissive policy: no origin or action-type restrictions configured yet (ticket 07)"
    })
})
