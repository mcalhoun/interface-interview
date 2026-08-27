/**
 * Session ownership: who is currently permitted to act on the live browser.
 *
 * CONTEXT.md defines Control Owner as "always answerable, never implied". The
 * cheapest way to make that untrue is to build the engine first and add ownership
 * afterwards, because by then "who holds the session" is implied by whichever
 * function happens to be on the stack. So the Replay executor asked
 * `Session.claim` before every single Surface Action from ticket 03 onward, while
 * the answer was always yes — and the guard's failure type has been in the
 * executor's signature since then, which is why ticket 12 changed the value of a
 * field rather than the shape of every Step.
 *
 * ## The state machine
 *
 * SPEC's is `AUTOMATION → PAUSED → HUMAN → RESUME_REQUESTED → AUTOMATION`, and
 * all four states are reachable. `ControlOwner` spells the third one `operator`
 * because CONTEXT.md's word for the person is Operator; `describeOwner` renders
 * SPEC's labels for anything a person reads.
 *
 * Each arrow is a method, and each is refused rather than ignored when the
 * session is not in the state it expects:
 *
 * | Arrow                          | Method                        | Refused unless |
 * | ------------------------------ | ----------------------------- | -------------- |
 * | (any action at all)            | `Session.claim`               | `automation`   |
 * | `AUTOMATION → PAUSED`          | `Session.pause`               | `automation`   |
 * | `PAUSED → HUMAN`               | `SessionControl.takeControl`  | `paused`       |
 * | (acting, repeatedly)           | `SessionControl.noteAction`   | `operator`     |
 * | `HUMAN → RESUME_REQUESTED`     | `SessionControl.returnControl`| `operator`     |
 * | `RESUME_REQUESTED → AUTOMATION`| the waking `pause`, only      | —              |
 *
 * The last row is the one worth reading twice. Nothing an Operator can call puts
 * the Session back in automation's hands; only the paused run itself does, as it
 * wakes. `RESUME_REQUESTED` exists precisely so that "the human has finished" and
 * "the automation has taken over" are two different, separately observable
 * facts rather than one optimistic assumption.
 *
 * ## Two halves of one machine
 *
 * `Session` is the automation-facing half: claim, and pause. `SessionControl`
 * (see `Handoff.ts`) is the operator-facing half: take, act, return. They are the
 * same state underneath, and they are separate interfaces because the engine
 * must not be able to hand control back to itself.
 */

import { Context, Effect, Layer, Ref, Schema } from "effect"
import type { EvidenceUnwritable } from "@cua/evidence"
import type { InterventionOutcome, InterventionRequest } from "./Intervention.ts"

export const ControlOwner = Schema.Literals([
  "automation",
  "paused",
  "operator",
  "resume_requested"
])
export type ControlOwner = typeof ControlOwner.Type

/** SPEC's spelling of each state, for anything a person reads. */
export const describeOwner = (owner: ControlOwner): string => {
  switch (owner) {
    case "automation":
      return "AUTOMATION"
    case "paused":
      return "PAUSED"
    case "operator":
      return "HUMAN"
    case "resume_requested":
      return "RESUME_REQUESTED"
  }
}

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
    return `${this.attempted} was attempted while control belonged to ${describeOwner(this.owner)}`
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
  /**
   * Whether there is an Operator to escalate to at all.
   *
   * The engine asks before it pauses, because a checkpoint that cannot be
   * resolved and has nobody to resolve it is a Hard Failure, not an Intervention.
   * Raising `intervention_required` into an empty room would report a person as
   * responsible for a run no person can see.
   */
  readonly handoffAvailable: Effect.Effect<boolean>
  /**
   * Stop, hand the live Session to a person, and block until they hand it back.
   *
   * Never fails on account of the Operator: refusal, resolution, abandonment and
   * expiry are all values in `InterventionOutcome`, because every one of them is
   * something the engine has to report rather than something it has to catch.
   * It fails only if the episode could not be recorded, since an Intervention
   * nobody can audit is the one outcome worse than not pausing.
   */
  readonly pause: (
    request: InterventionRequest
  ) => Effect.Effect<InterventionOutcome, EvidenceUnwritable>
}>()("cua/session/Session") {}

/**
 * A Session automation holds throughout, with no Operator attached.
 *
 * This is what every unattended run gets — the test suite, CI, and a scheduled
 * replay at three in the morning. `pause` refuses immediately and says why, so
 * the engine falls back to reporting a Hard Failure rather than waiting for
 * somebody who was never going to arrive.
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
          ),
        handoffAvailable: Effect.succeed(false),
        pause: () =>
          Effect.succeed({
            resumed: false,
            reason: "this run is unattended: no operator interface is attached to it",
            record: undefined
          })
      }
    })
  )
