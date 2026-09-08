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
 * person takes control and for every action they report, `intervention.observed`
 * for every value the Session saw them type, `intervention.resolve` when they
 * hand it back.
 *
 * ## The parked run keeps its eyes open
 *
 * The fiber that pauses does not only wait. It watches the screen it handed over
 * (`Watching.ts`), so that a supervisor id typed into the live window becomes a
 * scrubber needle without anybody being asked to retype it. That is the one
 * thing an Operator cannot reasonably be made to do by hand, and the first real
 * person to be asked to did not: a credential went into that run's log three
 * times. Registration happens before the event that would first quote the value,
 * every time, which is why the capture is also taken synchronously at the two
 * moments an Operator writes something down.
 *
 * ## A transition that could not be recorded did not happen
 *
 * Evidence and the state machine move together. Each transition commits to the
 * `Ref`, writes its event, and — if the write fails — puts the state back exactly
 * as it found it. Without that, a failed `evidence.record` left the machine
 * somewhere no retry could reach: `takeControl` and `returnControl` are refused
 * once the owner has moved, and a `noteAction` retry appends the action a second
 * time.
 *
 * The case that made this worth doing properly is `returnControl`. It moves
 * `HUMAN -> RESUME_REQUESTED` and then records `intervention.resolve`. If that
 * write failed, the owner stayed `resume_requested` with the `Deferred` never
 * completed — and when the paused fiber's wait expired it read that owner as an
 * answered return and **resumed the run**, on an episode whose resolution is not
 * in the log and whose Operator was told their return had failed. Rolling the
 * owner back to `operator` makes the same expiry report "nobody came", which is
 * the truth, and lets the Operator try again.
 *
 * The rollback is conditional on the state still being the one this transition
 * committed, so a concurrent settle is never clobbered; if something else has
 * moved on, the failure is reported and the state is left alone.
 */

import { Context, Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect"
import { Evidence, type EvidenceUnwritable } from "@cua/evidence"
import {
  type ControlReturn,
  type Intervention,
  type InterventionOutcome,
  type InterventionRecord,
  type InterventionRequest,
  type OperatorNote,
  operatorFieldLabel,
  raise
} from "./Intervention.ts"
import { type ScreenWatch, type WatchState, beganWith, sawEntries } from "./Watching.ts"
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
 * A transition was attempted without something it cannot be recorded without.
 *
 * Two things, and both were found by the first person to use this for real.
 *
 * **A name.** It used to be optional, and the run a real operator drove records
 * `operator: "(unnamed)"` on both the take and the return. A privileged decision
 * attributed to nobody is worse than useless in a system whose whole argument is
 * that a person's judgement is what makes a classification legitimate: the
 * Amendment derived from that episode names them in its provenance, and
 * "(unnamed)" there is a document nobody can stand behind.
 *
 * **A reason, when somebody reports they are stuck.** `blocked` says the request
 * made no sense or the screen was wrong, and an episode that says so without
 * saying how is a dead end for whoever picks it up.
 *
 * Refused here rather than in the form, for the reason every other rule is: a
 * guard that lives in a page is a guard anyone with `curl` walks around.
 */
export class HandoffIncomplete extends Schema.TaggedError<HandoffIncomplete>()(
  "HandoffIncomplete",
  {
    sessionId: Schema.String,
    attempted: Schema.String,
    /** What is missing, in the words the person is about to read. */
    missing: Schema.String
  }
) {
  override get message(): string {
    return `cannot ${this.attempted}: ${this.missing}`
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
    request: InterventionRequest,
    watch: ScreenWatch
  ) => Effect.Effect<InterventionOutcome, EvidenceUnwritable>
  /**
   * Register an operator interface as reachable. Until one is, a run has nobody
   * to escalate to and `Session.handoffAvailable` says so.
   */
  readonly attach: (operatorUrl: string) => Effect.Effect<void>
  readonly detach: Effect.Effect<void>
  /** `PAUSED → HUMAN`. Refused without a name to attribute it to. */
  readonly takeControl: (
    operator: string
  ) => Effect.Effect<InterventionRecord, HandoffRefused | HandoffIncomplete | EvidenceUnwritable>
  /**
   * Record one thing the Operator did while holding the Session, in their own
   * words.
   *
   * It used to carry a list of what they had typed as well, because that was the
   * only way the Evidence scrubber could learn a value no Artifact declared. The
   * Session observes those now (`Watching.ts`), and this call takes a look at the
   * screen before it writes anything, so a note that quotes a code the person
   * typed is redacted in the very event that reports it.
   *
   * What is left is the half observation cannot infer: why they did it, what the
   * screen was actually refusing, what the next person should know.
   */
  readonly noteAction: (
    note: OperatorNote
  ) => Effect.Effect<InterventionRecord, HandoffRefused | HandoffIncomplete | EvidenceUnwritable>
  /**
   * `HUMAN → RESUME_REQUESTED`, and the signal the paused run is waiting on.
   *
   * Refused without a name, and refused without a reason when the Operator is
   * reporting that they could not act. Takes a last look at the screen first, so
   * the resolution event cannot be the place a credential lands.
   */
  readonly returnControl: (
    body: ControlReturn
  ) => Effect.Effect<InterventionRecord, HandoffRefused | HandoffIncomplete | EvidenceUnwritable>
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

/**
 * How often the parked run looks at the screen it handed over.
 *
 * Short enough that a value typed into a control is seen while it is still in
 * it, which is the only chance there is for a form that clears itself on
 * submission. Long enough that it is a few accessibility snapshots a second
 * rather than a busy loop, and nothing else is contending for the browser: the
 * run is asleep and the person is reading.
 *
 * The synchronous captures on `noteAction` and `returnControl` are the other
 * half and they race nobody, but they can only see what is still on the screen
 * when they run. Between the two, a person typing at human speed is caught while
 * they type, and anything still visible when they write something down is caught
 * again.
 */
export const SCREEN_WATCH_INTERVAL_MILLIS = 250

interface Waiting {
  readonly record: InterventionRecord
  /** Completed by `returnControl`, awaited by `pause`. The whole transfer. */
  readonly deferred: Deferred.Deferred<ControlReturn>
}

/** The screen a paused Session is watching, and what it has seen on it. */
interface Watched {
  readonly watch: ScreenWatch
  readonly seen: WatchState
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
 * required evidence, and none of them can be
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

      /**
       * The screen this Session is currently watching, if it is paused.
       *
       * Set by `pause`, cleared when the episode settles. Held apart from
       * `State` on purpose: it is not part of the machine an auditor reads, and
       * putting it there would make every capture a change to the state the
       * transition rollback compares against.
       */
      const screen = yield* Ref.make<Watched | undefined>(undefined)

      /**
       * Look at the screen, register anything new on it, and say which fields it
       * came from.
       *
       * The whole capture mechanism, in one expression that three callers share:
       * the watching fiber, `noteAction`, and `returnControl`. The two
       * synchronous callers are what make the ordering a guarantee rather than a
       * race -- registration happens before the event that could quote the value,
       * because it happens in the same statement that writes it.
       *
       * Never fails. An observation that could not be taken is an empty answer,
       * because a person mid-episode must not be blocked by a snapshot that
       * arrived while the page was navigating.
       */
      const capture: Effect.Effect<ReadonlyArray<string>> = Effect.gen(function* () {
        const watching = yield* Ref.get(screen)
        if (watching === undefined) return []
        const entries = yield* watching.watch.entries
        const { register, state: seen } = sawEntries(watching.seen, entries)
        yield* Ref.update(screen, (current) =>
          current === watching ? { ...current, seen } : current
        )
        if (register.length === 0) return []
        // Before anything else. `EvidenceWriter.record` scrubs on write, so a
        // value registered here is redacted in every event written after this
        // line -- including the one immediately below, and including the note an
        // Operator is in the middle of writing.
        yield* evidence.redact(
          register.map((entry) => ({
            label: operatorFieldLabel(entry.field),
            text: entry.value
          }))
        )
        return [...new Set(register.map((entry) => operatorFieldLabel(entry.field)))]
      })

      /**
       * Put what was captured on the record, and in the log.
       *
       * No rollback, unlike every other write here, and the difference is real:
       * this appends to a set of field names, so a write that fails and is
       * retried adds nothing twice. The
       * redaction has already happened and is not undone by anything -- a needle
       * the log no longer needs is harmless, and one it needed and lost is not.
       */
      const noteCapture = (fields: ReadonlyArray<string>): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (fields.length === 0) return
          const held = yield* Ref.modify(
            state,
            (current): [InterventionRecord | undefined, State] => {
              if (current.pending === undefined) return [undefined, current]
              const record: InterventionRecord = {
                ...current.pending.record,
                observed: [...new Set([...current.pending.record.observed, ...fields])]
              }
              return [record, { ...current, pending: { ...current.pending, record } }]
            }
          )
          if (held === undefined) return
          yield* evidence.record({
            kind: "intervention.observed",
            stepId: held.intervention.stepId,
            fields
          }).pipe(Effect.ignore)
        })

      /** Both halves, in the order that makes the ordering a guarantee. */
      const captureScreen: Effect.Effect<void> = capture.pipe(Effect.flatMap(noteCapture))

      /**
       * Undo a transition whose Evidence event could not be written.
       *
       * Conditional on the state still being the one that transition committed.
       * Nothing else can normally have moved it — the operator's half is driven
       * by one interface and the run is asleep — but the paused fiber's wait can
       * expire at any instant, and putting an older state back over a settle that
       * has already happened would be a worse bug than the one this is fixing.
       * Reference equality is the check, because `State` is replaced wholesale on
       * every change and never mutated.
       */
      const rollBack = (previous: State, committed: State): Effect.Effect<void> =>
        Ref.update(state, (current) => (current === committed ? previous : current))

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
        request: InterventionRequest,
        watch: ScreenWatch
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
            const next: State = {
              ...enter(current, "paused", `automation stopped at step ${request.stepId}`),
              pending: { record, deferred },
              raised: current.raised + 1
            }
            return [
              {
                kind: "raised",
                record,
                operatorUrl: current.operatorUrl,
                previous: current,
                committed: next
              },
              next
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

          // A pause nobody could record is a pause that did not happen: the run
          // fails with `EvidenceUnwritable`, and leaving the Session parked in
          // PAUSED behind it would strand it on a `Deferred` no operator has been
          // told about and no retry can reach.
          yield* evidence.record({
            kind: "intervention.raise",
            stepId: request.stepId,
            reason: request.reason,
            detail: request.detail
          }).pipe(Effect.onError(() => rollBack(started.previous, started.committed)))

          // What was on the screen before anybody touched it. Never registered:
          // these are the values automation put there, the run's own scrubber
          // already covers them, and calling them operator input would say a
          // person typed something they did not.
          yield* Ref.set(screen, { watch, seen: beganWith(yield* watch.entries) })

          if (options.announce !== undefined) {
            yield* options.announce(started.record.intervention, started.operatorUrl)
          }

          // The parked fiber keeps its eyes open. A person can type a code into
          // the live window and press the button that clears it in the same
          // second, and Heritage Core's override form posts: after that the
          // characters are nowhere on the screen and nowhere in the address, and
          // the panel quotes the supervisor id back in prose that nothing can
          // attribute. Looking while they work is the only chance there is. A
          // child fiber, so it is interrupted with the run and cannot outlive the
          // episode it belongs to.
          const watching = yield* Effect.forkChild(
            captureScreen.pipe(
              Effect.andThen(Effect.sleep(SCREEN_WATCH_INTERVAL_MILLIS)),
              Effect.forever
            )
          )

          // The pause itself. This fiber holds every reading the run has taken
          // and stays exactly where it is; resuming is the next statement, not a
          // re-entry point.
          //
          // The race's own result is deliberately discarded. The state below is
          // the authority on whether anybody came, so an Operator who returned
          // control a millisecond before the bound expired is not reported as a
          // timeout on the strength of which fiber the scheduler ran first.
          yield* Deferred.await(deferred).pipe(Effect.timeoutOption(waitMillis))
          yield* Fiber.interrupt(watching)
          yield* Ref.set(screen, undefined)

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

          if (settled.closed.classification === "resolved") {
            return { resumed: true, record: settled.closed }
          }
          // Two ways not to resume, and they are worth telling apart in the
          // sentence a caller is handed. "I looked and this needs a person" is a
          // judgement about the state; "I could not act on this" is a report
          // about the episode, and whoever reads the run has to know that
          // nobody has actually assessed the screen yet.
          return {
            resumed: false,
            reason:
              settled.closed.classification === "blocked"
                ? `the operator could not act on this state: ${
                    settled.closed.detail ?? "no reason given"
                  }`
                : `the operator returned control without resolving the state: ${
                    settled.closed.detail ?? "no detail given"
                  }`,
            record: settled.closed
          }
        })

      // -------------------------------------------------------------------
      // The operator's half
      // -------------------------------------------------------------------

      /**
       * Applies one operator transition, records it, or refuses it. Every one
       * goes through here, which is what makes "refused, never ignored" true of
       * all of them rather than of the ones somebody remembered to guard.
       *
       * `step` returns the new record, the new owner and what to call the move.
       * An owner that does not change (an Operator recording a second action)
       * leaves no entry in the trail: the trail is changes of hands, not activity.
       *
       * **`event` is a parameter rather than a `tap` at the call site, because
       * the write and the transition have to be one thing.** The event is written
       * from the state it describes — `record` already carries the operator, the
       * timestamp and the action — and a write that fails puts the state back.
       * Otherwise the machine lands somewhere no retry can reach: `takeControl`
       * and `returnControl` refuse once the owner has moved, and a second
       * `noteAction` appends the action twice. Either the transition and its
       * event both happened or neither did.
       */
      const transition = (
        attempted: string,
        expected: ControlOwner,
        step: (waiting: Waiting) => [InterventionRecord, ControlOwner, string],
        event: (record: InterventionRecord) => Effect.Effect<void, EvidenceUnwritable>
      ): Effect.Effect<InterventionRecord, HandoffRefused | EvidenceUnwritable> =>
        Ref.modify(state, (current): [Transitioned, State] => {
          if (current.owner !== expected || current.pending === undefined) {
            return [{ ok: false, owner: current.owner }, current]
          }
          const [record, owner, by] = step(current.pending)
          const moved = owner === current.owner ? current : enter(current, owner, by)
          const next: State = { ...moved, pending: { ...current.pending, record } }
          return [{ ok: true, record, previous: current, committed: next }, next]
        }).pipe(
          Effect.flatMap(
            (
              outcome
            ): Effect.Effect<InterventionRecord, HandoffRefused | EvidenceUnwritable> =>
              outcome.ok
                ? event(outcome.record).pipe(
                    Effect.onError(() => rollBack(outcome.previous, outcome.committed)),
                    Effect.map(() => outcome.record)
                  )
                : Effect.fail(
                    new HandoffRefused({ sessionId, attempted, owner: outcome.owner, expected })
                  )
          )
        )

      /** The name is the attribution. An episode nobody signed teaches nothing. */
      const named = (
        operator: string,
        attempted: string
      ): Effect.Effect<string, HandoffIncomplete> => {
        const name = operator.trim()
        return name === ""
          ? Effect.fail(
              new HandoffIncomplete({
                sessionId,
                attempted,
                missing: "say who you are; this session records a person, not a role"
              })
            )
          : Effect.succeed(evidence.scrub(name))
      }

      const takeControl = (operator: string) =>
        named(operator, "take control").pipe(Effect.flatMap((name) => takeAs(name)))

      const takeAs = (operator: string) =>
        transition(
          "take control",
          "paused",
          (waiting) => [
            { ...waiting.record, operator, tookControlAt: now() },
            "operator",
            `${operator} took control`
          ],
          (record) =>
            evidence.record({
              kind: "intervention.human_action",
              stepId: record.intervention.stepId,
              operator,
              detail: "took control of the live session"
            })
        )

      const noteAction = (note: OperatorNote) =>
        Effect.gen(function* () {
          /**
           * A look at the screen before anything is written, and the ordering is
           * the whole mechanism.
           *
           * `EvidenceWriter.record` scrubs on write, so a value registered first
           * is redacted in the very note that reports it -- an Operator who
           * writes "entered 4417 as the override" gets `entered
           * [redacted:authorizationCode] as the override` rather than having
           * their own note be the leak. It used to work because they were asked
           * to type the value into a second box; it works now because the
           * Session can see the box they already typed it into.
           */
          yield* captureScreen

          // The appended action and its event stand or fall together. A write
          // that failed after the append would leave the action on the record
          // with nothing in the log about it, and the obvious retry would append
          // it a second time. These are notes, not proof of a mutation:
          // learning reads observed changes and explicit action confirmations.
          return yield* transition(
            "record an action",
            "operator",
            (waiting) => [
              {
                ...waiting.record,
                actions: [...waiting.record.actions, { at: now(), detail: evidence.scrub(note.detail), kind: "note" }]
              },
              "operator",
              "(no change of hands)"
            ],
            (record) =>
              evidence.record({
                kind: "intervention.human_action",
                stepId: record.intervention.stepId,
                operator: record.operator ?? "(unnamed)",
                detail: note.detail
              })
          )
        })

      /**
       * The stuck path has to say what it was stuck on.
       *
       * `blocked` is the only classification whose whole content is the
       * sentence: a resolved episode is evidenced by the screen and an
       * unresolved one by the state it was left in, and this one is evidenced by
       * nothing but what the person says. An empty box there is a dead end for
       * whoever picks the run up.
       */
      const reasoned = (body: ControlReturn): Effect.Effect<void, HandoffIncomplete> =>
        (body.classification === "blocked" || body.actionTaken === true) && body.detail.trim() === ""
          ? Effect.fail(
              new HandoffIncomplete({
                sessionId,
                attempted: "return control",
                missing: body.classification === "blocked"
                  ? "say what stopped you; a run that could not be done is only useful " +
                    "to the next person if it says why"
                  : "describe the action you are confirming"
              })
            )
          : Effect.void

      const returnControl = (body: ControlReturn) =>
        Effect.gen(function* () {
          const operator = yield* named(body.operator, "return control")
          yield* reasoned(body)
          // The last look, and the one that catches what a submitted form left
          // in the address bar rather than in the control it came from. Before
          // the resolution event, which carries the Operator's own words and is
          // therefore the last place a credential could land.
          yield* captureScreen
          return yield* returnAs({ ...body, operator, detail: evidence.scrub(body.detail) })
        })

      const returnAs = (body: ControlReturn) =>
        transition(
          "return control",
          "operator",
          (waiting) => [
            {
              ...waiting.record,
              operator: body.operator,
              returnedAt: now(),
              classification: body.classification,
              detail: body.detail,
              actions: body.actionTaken === true
                ? [...waiting.record.actions, { at: now(), detail: body.detail, kind: "confirmed_action" }]
                : waiting.record.actions,
              // The answer to the one question, recorded on the episode it was
              // asked about. An Amendment reads it from here, together
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
          ],
          // The dangerous one. RESUME_REQUESTED is what the paused fiber reads as
          // "somebody answered", so if this write fails the owner is rolled back
          // to HUMAN and the wait expires as "nobody came" — the truth — instead
          // of resuming a run on an episode whose resolution is not in the log.
          (record) =>
            evidence.record({
              kind: "intervention.resolve",
              stepId: record.intervention.stepId,
              operator: body.operator,
              classification: body.classification,
              detail: body.actionTaken === true ? `Confirmed action: ${body.detail}` : body.detail,
              nextTime: body.nextTime,
              confirmProposal: body.confirmProposal ?? "not_asked"
            })
        ).pipe(
          // Only now: the run wakes to a state that already says it may proceed,
          // and only if the resolution was recorded. A `Deferred` completed
          // before the event is written is a resume nobody can account for.
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
      /** The state before the pause, to put back if the raise cannot be written. */
      readonly previous: State
      /** The state this pause committed, so a rollback can tell it is still current. */
      readonly committed: State
    }

interface Settled {
  readonly answered: boolean
  readonly closed: InterventionRecord
}

type Transitioned =
  | {
      readonly ok: true
      readonly record: InterventionRecord
      readonly previous: State
      readonly committed: State
    }
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
