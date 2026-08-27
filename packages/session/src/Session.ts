/**
 * Session ownership: who is currently permitted to act on the live browser.
 *
 * **Ticket 12 owns the transfer. Ticket 03 owns the guard and the identity.**
 *
 * CONTEXT.md defines Control Owner as "always answerable, never implied". The
 * cheapest way to make that untrue is to build the engine first and add ownership
 * afterwards, because by then "who holds the session" is implied by whichever
 * function happens to be on the stack. So the Replay executor asks
 * `Session.claim` before every single Surface Action, today, while the answer is
 * always yes.
 *
 * SPEC's state machine is `AUTOMATION → PAUSED → HUMAN → RESUME_REQUESTED →
 * AUTOMATION`. Only `AUTOMATION` is reachable at this point. What ticket 12 adds:
 *
 *   1. The other four states and the transitions between them.
 *   2. `pause`, which raises an Intervention and blocks on an Effect `Deferred`
 *      the operator UI's resume endpoint resolves.
 *   3. Real teeth on `claim`: it already fails with `SessionNotOwned` when the
 *      owner is not `automation`, and that failure is already in the Replay
 *      executor's error channel. Ticket 12 changes the value of a field, not the
 *      shape of anything.
 *
 * That last point is the reason this exists now rather than later: the guard's
 * failure type has to be in the executor's signature from the start, or adding it
 * later is a change to every Step's type.
 */

import { Context, Effect, Layer, Ref, Schema } from "effect"

export const ControlOwner = Schema.Literals([
  "automation",
  "paused",
  "operator",
  "resume_requested"
])
export type ControlOwner = typeof ControlOwner.Type

/**
 * The engine tried to act while it did not hold control. A Hard Failure.
 *
 * SPEC user story 41: "I want the automation unable to act while I hold control,
 * so that we cannot fight over the same session."
 */
export class SessionNotOwned extends Schema.TaggedError<SessionNotOwned>()("SessionNotOwned", {
  sessionId: Schema.String,
  owner: ControlOwner,
  attempted: Schema.String
}) {
  override get message(): string {
    return `${this.attempted} was attempted while control belonged to ${this.owner}`
  }
}

export class Session extends Context.Service<Session, {
  /** Identifies the live browser Session. Every Evidence event carries it. */
  readonly id: string
  readonly owner: Effect.Effect<ControlOwner>
  /**
   * Assert the right to perform one Action. Called before every Surface Action
   * in the Replay executor, with no path around it.
   */
  readonly claim: (attempted: string) => Effect.Effect<void, SessionNotOwned>
}>()("cua/session/Session") {}

/**
 * A Session automation holds throughout. The only reachable configuration until
 * ticket 12 adds the transfer.
 */
export const automationOwned = (id: string): Layer.Layer<Session> =>
  Layer.effect(Session)(
    Effect.gen(function* () {
      const owner = yield* Ref.make<ControlOwner>("automation")
      return {
        id,
        owner: Ref.get(owner),
        claim: (attempted: string) =>
          Ref.get(owner).pipe(
            Effect.flatMap((current) =>
              current === "automation"
                ? Effect.void
                : Effect.fail(new SessionNotOwned({ sessionId: id, owner: current, attempted }))
            )
          )
      }
    })
  )
