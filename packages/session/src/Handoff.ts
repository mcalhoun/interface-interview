/**
 * The Control Owner state machine, and the operator-facing half of a Session.
 *
 * ## What makes the transfer real
 *
 * One process, one browser, one `Ref` (ADR-0009). The Operator drives the same
 * visible window the automation was driving, and the run is not "restarted with
 * a human in the loop" — it is a fiber, parked on a `Deferred`, holding every
 * reading it has taken so far, resumed in place.
 *
 * `Deferred` is the whole mechanism. A paused run awaits one, the operator
 * interface's return-of-control handler completes it, and the run continues from
 * the statement after the `await`. No polling, no re-entry point, no state
 * machine reconstructing where it had got to — because it never went anywhere.
 *
 * ## Why the two halves are separate interfaces
 *
 * `Session` (automation) can claim and pause. `SessionControl` (this module) can
 * take, act and return. The engine holds the first and cannot reach the second,
 * so there is no expression in the executor that hands control back to itself.
 * That is the difference between an ownership state and a boolean somebody
 * remembers to check.
 *
 * ## Every transition is refused, never ignored
 *
 * Each method below asserts the state it expects and fails with `HandoffRefused`
 * otherwise: taking control of a session nobody paused, acting after handing it
 * back, returning a session you never took. A state machine whose illegal
 * transitions silently do nothing is a state machine that is lying about what it
 * enforces.
 *
 * ## Evidence is written as it happens, not reconstructed afterwards
 *
 * `intervention.raise` when automation stops, `intervention.human_action` when a
 * person takes control and for every action they report, `intervention.resolve`
 * when they hand it back. These are written by the fiber doing the thing, which
 * matters: the paused run cannot record what the Operator did, because it is
 * asleep while they do it.
 */

import { Context, Deferred, Effect, Layer, Ref, Schema } from "effect"
import { Evidence, type EvidenceUnwritable } from "@cua/evidence"
import {
  type ControlReturn,
  type Intervention,
  type InterventionOutcome,
  type InterventionRecord,
  type InterventionRequest,
  raise
} from "./Intervention.ts"
import { type ControlOwner, ControlOwner as ControlOwnerSchema, Session, SessionNotOwned, describeOwner } from "./Session.ts"

/**
 * A transition was attempted from the wrong state.
 *
 * Carries both halves of the disagreement, because "you cannot do that" without
 * saying what the session is actually doing is the least useful error in
 * software.
 */
export class HandoffRefused extends Schema.TaggedError<HandoffRefused>()("HandoffRefused", {
  sessionId: Schema.String,
  attempted: Schema.String,
  owner: ControlOwnerSchema,
  expected: ControlOwnerSchema
}) {
  override get message(): string {
    return `cannot ${this.attempted}: control is ${describeOwner(this.owner)}, not ${
      describeOwner(this.expected)
    }`
  }
}

/**
 * One change of hands.
 *
 * CONTEXT.md asks for a Control Owner that is "always answerable, never
 * implied", and the current owner alone does not quite deliver that: it answers
 * who holds the Session but not how it got to them. `RESUME_REQUESTED` in
 * particular is real and brief — the parked run wakes the instant its `Deferred`
 * completes — so sampling the owner is not a way to find out whether the machine
 * went through it. The trail is, and it makes the sequence auditable rather than
 * merely observable if you look fast enough.
 */
export interface OwnerTransition {
  readonly at: string
  readonly owner: ControlOwner
  /** What moved it, in a sentence: "j.okafor took control". */
  readonly by: string
}

/** Everything the operator interface renders, in one atomic read. */
export interface HandoffSnapshot {
  readonly sessionId: string
  readonly owner: ControlOwner
  /** SPEC's label for `owner`. What the operator interface prints. */
  readonly ownerLabel: string
  /** Where an Operator can reach this run, once an interface is attached. */
  readonly operatorUrl: string | undefined
  /** The episode in progress, if the run is paused or held. */
  readonly pending: InterventionRecord | undefined
  /** Episodes already closed, oldest first. */
  readonly resolved: ReadonlyArray<InterventionRecord>
  /** Every change of hands this Session has been through, oldest first. */
  readonly history: ReadonlyArray<OwnerTransition>
}

/**
 * The operator-facing half of a Session.
 *
 * Held by the operator interface and by nothing else in a production run. The
 * test suite holds it too, which is the only way to drive a handoff without a
 * person, and it drives exactly the calls the HTTP handlers drive.
 */
export class SessionControl extends Context.Service<SessionControl, {
  readonly sessionId: string
  readonly snapshot: Effect.Effect<HandoffSnapshot>
  /** The same guard `Session.claim` exposes, over the same state. */
  readonly claim: (attempted: string) => Effect.Effect<void, SessionNotOwned>
  /** The automation half of the pause. See `Session.pause`. */
  readonly pause: (
    request: InterventionRequest
  ) => Effect.Effect<InterventionOutcome, EvidenceUnwritable>
  /**
   * Register an operator interface as reachable. Until one is, a run has nobody
   * to escalate to and `Session.handoffAvailable` says so.
   */
  readonly attach: (operatorUrl: string) => Effect.Effect<void>
  readonly detach: Effect.Effect<void>
  /** `PAUSED → HUMAN`. */
  readonly takeControl: (
    operator: string
  ) => Effect.Effect<InterventionRecord, HandoffRefused | EvidenceUnwritable>
  /** Record one thing the Operator did while holding the Session. */
  readonly noteAction: (
    detail: string
  ) => Effect.Effect<InterventionRecord, HandoffRefused | EvidenceUnwritable>
  /** `HUMAN → RESUME_REQUESTED`, and the signal the paused run is waiting on. */
  readonly returnControl: (
    body: ControlReturn
  ) => Effect.Effect<InterventionRecord, HandoffRefused | EvidenceUnwritable>
}>()("cua/session/SessionControl") {}

export interface SessionControlOptions {
  readonly sessionId: string
  /**
   * How long a paused run waits for an Operator before giving up and reporting
   * that nobody came.
   *
   * A bound rather than a forever, because an unattended process blocked on a
   * `Deferred` nobody will ever complete is indistinguishable from a hang, and a
   * run that reports "no operator took control within twenty minutes" is a
   * result someone can act on. Ten minutes by default; the CLI overrides it.
   */
  readonly waitMillis?: number
  /**
   * Called the moment a run pauses, with the operator interface's URL.
   *
   * SPEC: "On pause it starts a `Bun.serve` operator UI, prints the URL, and
   * blocks on an Effect `Deferred`". The interface is started up front instead —
   * it is in-process either way (ADR-0009) and a server nobody has visited costs
   * nothing — so this is the moment its URL is worth saying out loud. Without it
   * a terminal running a paused capability simply goes quiet.
   */
  readonly announce?: (
    intervention: Intervention,
    operatorUrl: string
  ) => Effect.Effect<void>
}

export const DEFAULT_HANDOFF_WAIT_MILLIS = 600_000

interface Waiting {
  readonly record: InterventionRecord
  /** Completed by `returnControl`, awaited by `pause`. The whole transfer. */
  readonly deferred: Deferred.Deferred<ControlReturn>
}

interface State {
  readonly owner: ControlOwner
  readonly operatorUrl: string | undefined
  readonly pending: Waiting | undefined
  readonly resolved: ReadonlyArray<InterventionRecord>
  readonly history: ReadonlyArray<OwnerTransition>
  readonly raised: number
}

const now = (): string => new Date().toISOString()

const initial: State = {
  owner: "automation",
  operatorUrl: undefined,
  pending: undefined,
  resolved: [],
  history: [{ at: now(), owner: "automation", by: "the session opened" }],
  raised: 0
}

/**
 * Move the Session to a new owner, recording what moved it.
 *
 * The single place `owner` is assigned. An assignment that skipped this would be
 * a change of hands nobody can account for afterwards, which is the failure mode
 * the trail exists to rule out.
 */
const enter = (current: State, owner: ControlOwner, by: string): State => ({
  ...current,
  owner,
  history: [...current.history, { at: now(), owner, by }]
})

/**
 * A Session that can be handed to a person and taken back.
 *
 * Requires `Evidence` because an Intervention that is not recorded did not
 * usefully happen: who took control, what they did and when they returned it are
 * the three questions this ticket exists to answer, and none of them can be
 * reconstructed after the fact from a run that was asleep at the time.
 */
export const sessionControl = (
  options: SessionControlOptions
): Layer.Layer<SessionControl, never, Evidence> =>
  Layer.effect(SessionControl)(
    Effect.gen(function* () {
      const evidence = yield* Evidence
      const state = yield* Ref.make(initial)
      const sessionId = options.sessionId
      const waitMillis = options.waitMillis ?? DEFAULT_HANDOFF_WAIT_MILLIS

      const read = Ref.get(state)

      const snapshot: Effect.Effect<HandoffSnapshot> = read.pipe(
        Effect.map((current) => ({
          sessionId,
          owner: current.owner,
          ownerLabel: describeOwner(current.owner),
          operatorUrl: current.operatorUrl,
          pending: current.pending?.record,
          resolved: current.resolved,
          history: current.history
        }))
      )

      const claim = (attempted: string): Effect.Effect<void, SessionNotOwned> =>
        read.pipe(
          Effect.flatMap((current) =>
            current.owner === "automation"
              ? Effect.void
              : Effect.fail(
                  new SessionNotOwned({ sessionId, owner: current.owner, attempted })
                )
          )
        )

      // -------------------------------------------------------------------
      // AUTOMATION -> PAUSED -> (a person) -> AUTOMATION
      // -------------------------------------------------------------------

      const pause = (
        request: InterventionRequest
      ): Effect.Effect<InterventionOutcome, EvidenceUnwritable> =>
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<ControlReturn>()

          // One atomic step from AUTOMATION to PAUSED, carrying the intervention
          // and the deferred with it. Anything that reads the state after this
          // sees a paused session with something to act on, never a paused
          // session with nothing in it.
          const started = yield* Ref.modify(state, (current): [Started, State] => {
            if (current.operatorUrl === undefined) return [{ kind: "unattended" }, current]
            if (current.owner !== "automation") {
              return [{ kind: "busy", owner: current.owner }, current]
            }
            const intervention: Intervention = {
              ...request,
              interventionId: `${sessionId}-intervention-${current.raised + 1}`,
              sessionId,
              raisedAt: now()
            }
            const record = raise(intervention)
            return [
              { kind: "raised", record, operatorUrl: current.operatorUrl },
              {
                ...enter(current, "paused", `automation stopped at step ${request.stepId}`),
                pending: { record, deferred },
                raised: current.raised + 1
              }
            ]
          })

          if (started.kind === "unattended") {
            return {
              resumed: false,
              reason: "no operator interface is attached to this run",
              record: undefined
            }
          }
          if (started.kind === "busy") {
            return {
              resumed: false,
              reason: `control already belongs to ${describeOwner(started.owner)}`,
              record: undefined
            }
          }

          yield* evidence.record({
            kind: "intervention.raise",
            stepId: request.stepId,
            reason: request.reason,
            detail: request.detail
          })

          if (options.announce !== undefined) {
            yield* options.announce(started.record.intervention, started.operatorUrl)
          }

          // The pause itself. This fiber holds every reading the run has taken
          // and stays exactly where it is; resuming is the next statement, not a
          // re-entry point.
          //
          // The race's own result is deliberately discarded. The state below is
          // the authority on whether anybody came, so an Operator who returned
          // control a millisecond before the bound expired is not reported as a
          // timeout on the strength of which fiber the scheduler ran first.
          yield* Deferred.await(deferred).pipe(Effect.timeoutOption(waitMillis))

          // RESUME_REQUESTED -> AUTOMATION, and it happens here or nowhere.
          const settled = yield* Ref.modify(state, (current): [Settled, State] => {
            const held = current.pending?.record ?? started.record
            const answered = current.owner === "resume_requested"
            const closed: InterventionRecord = answered
              ? held
              : {
                  ...held,
                  returnedAt: now(),
                  classification: "unattended",
                  detail: `no operator took control within ${waitMillis}ms`,
                  // Nobody arrived, so nobody was asked. Left explicit rather
                  // than defaulted, so the record cannot be read as an interface
                  // that forgot to ask.
                  nextTime: "not_asked"
                }
            return [
              { answered, closed },
              {
                ...enter(
                  current,
                  "automation",
                  answered
                    ? "the run took control back and resumed"
                    : "the run took control back: nobody came"
                ),
                pending: undefined,
                resolved: [...current.resolved, closed]
              }
            ]
          })

          if (!settled.answered) {
            yield* evidence.record({
              kind: "intervention.resolve",
              stepId: request.stepId,
              operator: "(nobody)",
              classification: "unattended",
              detail: settled.closed.detail ?? "the wait expired",
              // Nobody arrived, so neither question was put to anybody.
              nextTime: "not_asked",
              confirmProposal: "not_asked"
            })
            return {
              resumed: false,
              reason: settled.closed.detail ?? "no operator took control",
              record: settled.closed
            }
          }

          return settled.closed.classification === "resolved"
            ? { resumed: true, record: settled.closed }
            : {
                resumed: false,
                reason: `the operator returned control without resolving the state: ${
                  settled.closed.detail ?? "no detail given"
                }`,
                record: settled.closed
              }
        })

      // -------------------------------------------------------------------
      // The operator's half
      // -------------------------------------------------------------------

      /**
       * Applies one operator transition, or refuses it. Every one goes through
       * here, which is what makes "refused, never ignored" true of all of them
       * rather than of the ones somebody remembered to guard.
       *
       * `step` returns the new record, the new owner and what to call the move.
       * An owner that does not change (an Operator recording a second action)
       * leaves no entry in the trail: the trail is changes of hands, not activity.
       */
      const transition = (
        attempted: string,
        expected: ControlOwner,
        step: (waiting: Waiting) => [InterventionRecord, ControlOwner, string]
      ): Effect.Effect<InterventionRecord, HandoffRefused> =>
        Ref.modify(state, (current): [Transitioned, State] => {
          if (current.owner !== expected || current.pending === undefined) {
            return [{ ok: false, owner: current.owner }, current]
          }
          const [record, owner, by] = step(current.pending)
          const moved = owner === current.owner ? current : enter(current, owner, by)
          return [
            { ok: true, record },
            { ...moved, pending: { ...current.pending, record } }
          ]
        }).pipe(
          Effect.flatMap((outcome) =>
            outcome.ok
              ? Effect.succeed(outcome.record)
              : Effect.fail(
                  new HandoffRefused({ sessionId, attempted, owner: outcome.owner, expected })
                )
          )
        )

      const takeControl = (operator: string) =>
        transition("take control", "paused", (waiting) => [
          { ...waiting.record, operator, tookControlAt: now() },
          "operator",
          `${operator} took control`
        ]).pipe(
          Effect.tap((record) =>
            evidence.record({
              kind: "intervention.human_action",
              stepId: record.intervention.stepId,
              operator,
              detail: "took control of the live session"
            })
          )
        )

      const noteAction = (detail: string) =>
        transition("record an action", "operator", (waiting) => [
          {
            ...waiting.record,
            actions: [...waiting.record.actions, { at: now(), detail }]
          },
          "operator",
          "(no change of hands)"
        ]).pipe(
          Effect.tap((record) =>
            evidence.record({
              kind: "intervention.human_action",
              stepId: record.intervention.stepId,
              operator: record.operator ?? "(unnamed)",
              detail
            })
          )
        )

      const returnControl = (body: ControlReturn) =>
        transition("return control", "operator", (waiting) => [
          {
            ...waiting.record,
            operator: body.operator,
            returnedAt: now(),
            classification: body.classification,
            detail: body.detail,
            // The answer to the one question, recorded on the episode it was
            // asked about. Ticket 13's Amendment reads it from here, together
            // with `actions`, which is the other half of ADR-0004's table.
            nextTime: body.nextTime,
            // The second question, when there was one to ask. An absent answer
            // is `not_asked` rather than a refusal: the same careful direction
            // the operator interface takes, and for the same reason — a field
            // nobody filled in must never read as a confirmation.
            confirmProposal: body.confirmProposal ?? "not_asked"
          },
          // Not `automation`. The Operator has finished; the automation has not
          // yet noticed. Those are two facts and this state keeps them apart.
          "resume_requested",
          `${body.operator} returned control as ${body.classification}`
        ]).pipe(
          Effect.tap((record) =>
            evidence.record({
              kind: "intervention.resolve",
              stepId: record.intervention.stepId,
              operator: body.operator,
              classification: body.classification,
              detail: body.detail,
              nextTime: body.nextTime,
              confirmProposal: body.confirmProposal ?? "not_asked"
            })
          ),
          // Only now: the run wakes to a state that already says it may proceed.
          Effect.tap(() =>
            read.pipe(
              Effect.flatMap((current) =>
                current.pending === undefined
                  ? Effect.void
                  : Deferred.succeed(current.pending.deferred, body)
              )
            )
          )
        )

      return {
        sessionId,
        snapshot,
        claim,
        pause,
        attach: (operatorUrl: string) =>
          Ref.update(state, (current) => ({ ...current, operatorUrl })),
        detach: Ref.update(state, (current) => ({ ...current, operatorUrl: undefined })),
        takeControl,
        noteAction,
        returnControl
      }
    })
  )

type Started =
  | { readonly kind: "unattended" }
  | { readonly kind: "busy"; readonly owner: ControlOwner }
  | {
      readonly kind: "raised"
      readonly record: InterventionRecord
      readonly operatorUrl: string
    }

interface Settled {
  readonly answered: boolean
  readonly closed: InterventionRecord
}

type Transitioned =
  | { readonly ok: true; readonly record: InterventionRecord }
  | { readonly ok: false; readonly owner: ControlOwner }

/**
 * The automation-facing view of a `SessionControl`.
 *
 * Deliberately narrow. Everything an Operator can do is absent from it, so the
 * engine has no expression available that returns the Session to itself.
 */
export const handoffSession: Layer.Layer<Session, never, SessionControl> =
  Layer.effect(Session)(
    Effect.gen(function* () {
      const control = yield* SessionControl
      return {
        id: control.sessionId,
        owner: control.snapshot.pipe(Effect.map((current) => current.owner)),
        claim: control.claim,
        handoffAvailable: control.snapshot.pipe(
          Effect.map((current) => current.operatorUrl !== undefined)
        ),
        pause: control.pause
      }
    })
  )
