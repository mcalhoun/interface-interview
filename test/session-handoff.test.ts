/**
 * Session ownership and human handoff, asserted as externally observable
 * behaviour: the result a caller receives, the pages the operator interface
 * serves, and the events on disk.
 *
 * The claim under test is that control genuinely transfers. Two things make that
 * more than a story:
 *
 *   1. **The Operator works in the automation's own browser.** The `surface` the
 *      test acts through is the same value the engine holds. `observe` from the
 *      operator's side shows the screen the run stopped on, and the run then
 *      continues from that screen.
 *   2. **The run resumes rather than restarts.** Every Step before the pause
 *      produces exactly one `action` event across the whole run, and the readings
 *      taken before the pause are still in the outputs afterwards.
 *
 * `it.live` throughout: checkpoints poll with `Effect.sleep` and the handoff
 * waits on a `Deferred`, both of which hang under `it.effect`'s TestClock.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import { expect } from "vitest"
import { randomUUID } from "node:crypto"
import {
  type EvidenceEventBody,
  Evidence,
  EvidenceUnwritable,
  evidenceFiles,
  noSecrets
} from "@cua/evidence"
import {
  HandoffRefused,
  SessionControl,
  SessionNotOwned,
  describeOwner,
  sessionControl
} from "@cua/session"
import { shippedArtifact } from "./support/replay-harness.ts"
import { attendedReplay } from "./support/handoff-harness.ts"

const RESTRICTED = "77777"
// Ticket 09 renamed this step when the hard-coded click on "Primary Savings"
// became a selection; the Step that meets the supervisor hold is the same one.
const HELD_STEP = "open-account"

/**
 * The last version at which this state is still *unclassified*.
 *
 * Ticket 14's intervention taught 1.2.0 that the supervisor hold always needs a
 * person, so at `latest` the run escalates under a declared code with the
 * sentence somebody wrote for it, and an unattended run reports
 * `intervention_required` rather than a Hard Failure. Both of those are the
 * point of that ticket and both are asserted in
 * `test/learning-that-a-state-needs-a-human.test.ts`.
 *
 * The tests below are about the *mechanism* — that control genuinely transfers,
 * that the run resumes rather than restarts, that an unattended run escalates to
 * nobody — and none of that changed. Pinning them here keeps them testing the
 * handoff instead of quietly re-testing what the document has since learned.
 */
const BEFORE_LEARNING = "1.1.0"

/** What a supervisor does at the live browser window to release the hold. */
const releaseTheHold = (desk: {
  surface: {
    fill: (target: object, value: string) => Effect.Effect<unknown, unknown>
    click: (target: object) => Effect.Effect<unknown, unknown>
  }
}) =>
  Effect.gen(function* () {
    yield* desk.surface.fill({ role: "textbox", name: "Supervisor ID" }, "SUP7")
    yield* desk.surface.fill({ role: "textbox", name: "Authorization Code" }, "4417")
    yield* desk.surface.click({ role: "button", name: "Authorize" })
  })

// ---------------------------------------------------------------------------
// The state machine, on its own
// ---------------------------------------------------------------------------

/** A Session control with nothing else attached. No browser, no run. */
/**
 * A bare control, on its own run.
 *
 * A factory rather than a constant: the Evidence writer refuses to open a run
 * directory that already exists, because two writers sharing a `runId` would
 * interleave two sessions in one log with a `seq` that goes backwards. Every
 * test that wants one gets its own run.
 */
const bareControl = () =>
  Effect.gen(function* () {
  return yield* SessionControl
}).pipe(
  Effect.provide(
    sessionControl({ sessionId: "session-bare", waitMillis: 5_000 }).pipe(
      Layer.provideMerge(
        evidenceFiles({
          root: mkdtempSync(join(tmpdir(), "cua-machine-")),
          runId: `machine-${randomUUID()}`,
          sessionId: "session-bare",
          // Nothing sensitive is in play: this control has no run and no inputs.
          // Saying so is spelled out rather than defaulted (ticket 08).
          scrubber: noSecrets()
        })
      )
    )
  )
)

/**
 * A control whose Evidence writer refuses the first event of a given kind.
 *
 * Everything else is recorded, and the refusal is one-shot, because both things
 * a failed write should leave behind are worth asserting: the state the retry
 * finds, and the retry succeeding.
 */
const brittleControl = (failFirst: EvidenceEventBody["kind"], waitMillis: number) => {
  const refused: Array<string> = []
  const written: Array<EvidenceEventBody> = []
  const evidence = Layer.effect(Evidence)(
    Effect.sync(() => ({
      directory: "(no directory: this writer never reaches a disk)",
      record: (body: EvidenceEventBody) => {
        if (body.kind === failFirst && refused.length === 0) {
          refused.push(body.kind)
          return Effect.fail(
            new EvidenceUnwritable({ path: "(nowhere)", reason: "the volume went away" })
          )
        }
        written.push(body)
        return Effect.void
      },
      attach: () => Effect.void,
      written: Effect.sync(() => []),
      redact: () => Effect.void,
      scrub: (text: string) => text
    }))
  )

  return Effect.map(
    SessionControl.pipe(
      Effect.provide(
        sessionControl({ sessionId: "session-brittle", waitMillis }).pipe(
          Layer.provide(evidence)
        )
      )
    ),
    (control) => ({ control, written })
  )
}

const HELD = {
  capability: "member.account-balance",
  version: "1.1.0",
  runId: "brittle",
  stepId: HELD_STEP,
  stepIntent: "open the savings account",
  reason: "a checkpoint did not hold",
  detail: "expected a balance cell",
  url: "http://example.invalid/account",
  accessibility: "- table:"
}

/**
 * The failure this exists to rule out.
 *
 * `returnControl` used to move the owner to RESUME_REQUESTED and *then* write
 * `intervention.resolve`. If that write failed the owner stayed there, the
 * `Deferred` was never completed, and the Operator was handed an error — so when
 * the paused fiber's wait expired it read RESUME_REQUESTED as "somebody
 * answered" and resumed the run, on an episode whose resolution is in no log.
 * Nor could the Operator retry: `returnControl` is refused once the owner has
 * left HUMAN.
 */
it.live("a resolution that could not be recorded does not resume the run", () =>
  Effect.gen(function* () {
    const { control } = yield* brittleControl("intervention.resolve", 300)
    yield* control.attach("http://127.0.0.1:0")

    const paused = yield* Effect.forkChild(control.pause(HELD))
    while ((yield* control.snapshot).owner !== "paused") yield* Effect.sleep(5)
    yield* control.takeControl("j.okafor")

    const unwritable = yield* Effect.flip(
      control.returnControl({
        operator: "j.okafor",
        classification: "resolved",
        detail: "authorized the account",
        nextTime: "not_asked"
      })
    )
    expect(unwritable).toBeInstanceOf(EvidenceUnwritable)

    // Rolled back. The owner is where the Operator left it, the episode has not
    // been closed, and RESUME_REQUESTED never happened — which is the whole
    // reason the expiry below reports the truth.
    const afterFailure = yield* control.snapshot
    expect(afterFailure.owner).toBe("operator")
    expect(afterFailure.pending?.returnedAt).toBeUndefined()
    expect(afterFailure.history.map((entry) => entry.owner)).not.toContain("resume_requested")

    // And the run does not resume on the strength of it.
    const outcome = yield* Fiber.join(paused)
    expect(outcome.resumed).toBe(false)
    if (outcome.resumed) throw new Error("unreachable")
    expect(outcome.reason).toContain("no operator took control")
  })
)

it.live("and the operator can simply try again", () =>
  Effect.gen(function* () {
    const { control, written } = yield* brittleControl("intervention.resolve", 10_000)
    yield* control.attach("http://127.0.0.1:0")

    const paused = yield* Effect.forkChild(control.pause(HELD))
    while ((yield* control.snapshot).owner !== "paused") yield* Effect.sleep(5)
    yield* control.takeControl("j.okafor")

    const body = {
      operator: "j.okafor",
      classification: "resolved" as const,
      detail: "authorized the account",
      nextTime: "not_asked" as const
    }
    yield* Effect.flip(control.returnControl(body))
    yield* control.returnControl(body)

    const outcome = yield* Fiber.join(paused)
    expect(outcome.resumed).toBe(true)

    // One resolution in the log, not two, and the trail passes through
    // RESUME_REQUESTED exactly once.
    expect(written.filter((event) => event.kind === "intervention.resolve")).toHaveLength(1)
    const snapshot = yield* control.snapshot
    expect(
      snapshot.history.filter((entry) => entry.owner === "resume_requested")
    ).toHaveLength(1)
  })
)

/**
 * The same rule, on the transition an Operator is most likely to repeat.
 *
 * `noteAction` appends to the record and then writes its event. Without the
 * rollback the obvious retry appends the action a *second* time — and
 * `classify` reads `actions.length` to decide whether an episode taught a
 * business outcome or a requires-human state (ADR-0004), so a duplicated action
 * is not a cosmetic problem.
 */
it.live("an action that could not be recorded is not left on the record", () =>
  Effect.gen(function* () {
    const { control } = yield* brittleControl("intervention.human_action", 10_000)
    yield* control.attach("http://127.0.0.1:0")

    const paused = yield* Effect.forkChild(control.pause(HELD))
    while ((yield* control.snapshot).owner !== "paused") yield* Effect.sleep(5)

    // The first `intervention.human_action` is the one `takeControl` writes, so
    // that is the write this control refuses. The transition rolls back with it.
    yield* Effect.flip(control.takeControl("j.okafor"))
    expect((yield* control.snapshot).owner).toBe("paused")

    // And the retry finds a session it can still take.
    yield* control.takeControl("j.okafor")
    const note = { detail: "pressed Authorize", entered: [] }
    yield* control.noteAction(note)
    yield* control.noteAction(note)

    const pending = (yield* control.snapshot).pending
    expect(pending?.actions).toHaveLength(2)

    yield* control.returnControl({
      operator: "j.okafor",
      classification: "resolved",
      detail: "authorized the account",
      nextTime: "not_asked"
    })
    yield* Fiber.join(paused)
  })
)

it.live("a session starts owned by automation and says so", () =>
  Effect.gen(function* () {
    const control = yield* bareControl()
    const snapshot = yield* control.snapshot

    expect(snapshot.owner).toBe("automation")
    expect(snapshot.ownerLabel).toBe("AUTOMATION")
    expect(snapshot.pending).toBeUndefined()

    // Ownership is answerable before anything has happened, which is the whole
    // difference between a state and a lock nobody has taken yet.
    yield* control.claim("navigate somewhere")
  })
)

it.live("taking control of a session nobody paused is refused, not ignored", () =>
  Effect.gen(function* () {
    const control = yield* bareControl()
    const refusal = yield* Effect.flip(control.takeControl("j.okafor"))

    if (!(refusal instanceof HandoffRefused)) throw new Error(String(refusal))
    expect(refusal.owner).toBe("automation")
    expect(refusal.expected).toBe("paused")
    expect(refusal.message).toContain("control is AUTOMATION, not PAUSED")

    // And the refusal changed nothing.
    expect((yield* control.snapshot).owner).toBe("automation")
  })
)

it.live("an unattended session refuses to pause, because nobody is listening", () =>
  Effect.gen(function* () {
    const control = yield* bareControl()
    const outcome = yield* control.pause({
      capability: "member.account-balance",
      version: "1.0.0",
      runId: "machine",
      stepId: HELD_STEP,
      stepIntent: "open the savings account",
      reason: "a checkpoint did not hold",
      detail: "expected a balance cell",
      url: "http://example.invalid/account",
      accessibility: "- table:"
    })

    expect(outcome.resumed).toBe(false)
    expect(outcome.record).toBeUndefined()
    expect((yield* control.snapshot).owner).toBe("automation")
  })
)

it.live("the machine walks AUTOMATION, PAUSED, HUMAN, RESUME_REQUESTED, AUTOMATION", () =>
  Effect.gen(function* () {
    const control = yield* bareControl()
    yield* control.attach("http://127.0.0.1:0")

    const paused = yield* Effect.forkChild(
      control.pause({
        capability: "member.account-balance",
        version: "1.0.0",
        runId: "machine",
        stepId: HELD_STEP,
        stepIntent: "open the savings account",
        reason: "a checkpoint did not hold",
        detail: "expected a balance cell",
        url: "http://example.invalid/account",
        accessibility: "- table:"
      })
    )

    while ((yield* control.snapshot).owner !== "paused") yield* Effect.sleep(5)

    yield* control.takeControl("j.okafor")
    expect((yield* control.snapshot).ownerLabel).toBe("HUMAN")

    // The engine's own guard, at the exact call site the executor uses. This is
    // the ownership guard: it does not warn, it does not queue, it refuses.
    const refused = yield* Effect.flip(control.claim("click Authorize"))
    expect(refused).toBeInstanceOf(SessionNotOwned)
    expect(refused.owner).toBe("operator")

    // And at the edge of the Effect world it is literally a throw, not a value
    // somebody might forget to inspect.
    const thrown = yield* Effect.promise(() =>
      Effect.runPromise(control.claim("fill Supervisor ID")).then(
        () => "the guard let the engine act",
        (cause: unknown) => String(cause)
      )
    )
    expect(thrown).toContain("was attempted while control belonged to HUMAN")

    // `entered` is required and empty is an ordinary answer: this operator
    // pressed something rather than typing a credential. The case where they do
    // type one is `test/operator-interface-authentication.test.ts`.
    yield* control.noteAction({
      detail: "entered supervisor override SUP-HOLD-02",
      entered: []
    })
    yield* control.returnControl({
      operator: "j.okafor",
      classification: "resolved",
      detail: "authorized the account",
      // Ticket 13's one question, declined. This suite is about the transfer of
      // control; a return that also amended a stored Capability would be testing
      // two things at once, and `not_asked` is exactly what an episode where
      // nobody answered should record.
      nextTime: "not_asked"
    })

    const outcome = yield* Fiber.join(paused)
    expect(outcome.resumed).toBe(true)

    // Sampling the owner cannot show RESUME_REQUESTED: completing the Deferred
    // resumes the parked run immediately, so by the time `returnControl` has
    // returned, the run has already taken the session back. The state is real
    // and the trail is where it is answerable — which is the point of keeping
    // one rather than only a current value.
    const snapshot = yield* control.snapshot
    expect(snapshot.history.map((entry) => describeOwner(entry.owner))).toEqual([
      "AUTOMATION",
      "PAUSED",
      "HUMAN",
      "RESUME_REQUESTED",
      "AUTOMATION"
    ])
    expect(snapshot.history.map((entry) => entry.by)).toEqual([
      "the session opened",
      `automation stopped at step ${HELD_STEP}`,
      "j.okafor took control",
      "j.okafor returned control as resolved",
      "the run took control back and resumed"
    ])

    // The episode is closed, and it says who and what.
    expect(snapshot.pending).toBeUndefined()
    expect(snapshot.resolved).toHaveLength(1)
    expect(snapshot.resolved[0]!.operator).toBe("j.okafor")
    expect(snapshot.resolved[0]!.actions.map((action) => action.detail)).toEqual([
      "entered supervisor override SUP-HOLD-02"
    ])
    expect(snapshot.resolved[0]!.classification).toBe("resolved")
  })
)

it.live("acting after handing the session back is refused", () =>
  Effect.gen(function* () {
    const control = yield* bareControl()
    yield* control.attach("http://127.0.0.1:0")

    const paused = yield* Effect.forkChild(
      control.pause({
        capability: "member.account-balance",
        version: "1.0.0",
        runId: "machine",
        stepId: HELD_STEP,
        stepIntent: "open the savings account",
        reason: "a checkpoint did not hold",
        detail: "expected a balance cell",
        url: "http://example.invalid/account",
        accessibility: "- table:"
      })
    )
    while ((yield* control.snapshot).owner !== "paused") yield* Effect.sleep(5)

    yield* control.takeControl("j.okafor")
    yield* control.returnControl({
      operator: "j.okafor",
      classification: "unresolved",
      detail: "could not reach a supervisor",
      nextTime: "not_asked"
    })
    const outcome = yield* Fiber.join(paused)
    expect(outcome.resumed).toBe(false)

    const refusal = yield* Effect.flip(control.noteAction({ detail: "one more thing", entered: [] }))
    if (!(refusal instanceof HandoffRefused)) throw new Error(String(refusal))
    expect(refusal.expected).toBe("operator")
  })
)

// ---------------------------------------------------------------------------
// A real run, a real browser, a real person
// ---------------------------------------------------------------------------

it.live(
  "a restricted account pauses, an operator resolves it, and the run finishes the step it stopped on",
  () =>
    Effect.gen(function* () {
      const outcome = yield* attendedReplay({
        artifact: shippedArtifact(undefined, BEFORE_LEARNING),
        inputs: { memberId: RESTRICTED },
        runId: "handoff-resolved",
        operate: (desk) =>
          Effect.gen(function* () {
            const paused = yield* desk.awaitPause

            // What the interface serves, over HTTP, as a person would see it.
            const served = yield* desk.served
            expect(served.ownerLabel).toBe("PAUSED")
            const raised = served.pending!.intervention
            expect(raised.capability).toBe("member.account-balance")
            expect(raised.stepId).toBe(HELD_STEP)
            expect(raised.reason).toContain("did not hold")
            expect(raised.detail).toContain("Available Balance")
            expect(raised.url).toContain("/account?")
            expect(raised.accessibility).toContain("SUPERVISOR AUTHORIZATION REQUIRED")
            expect(raised.sessionId).toBe(paused.sessionId)

            const page = yield* desk.get("/")
            expect(page.status).toBe(200)
            expect(page.body).toContain("member.account-balance")
            expect(page.body).toContain(HELD_STEP)
            expect(page.body).toContain("Take control of this session")
            expect(page.body).toContain("SUPERVISOR AUTHORIZATION REQUIRED")

            // The Operator's browser is the automation's browser. This is the
            // claim ADR-0009 rests on, and it is checkable: the window is
            // already sitting on the screen the run stopped at.
            const before = yield* desk.surface.observe
            expect(before.url).toContain("/account?")
            expect(before.accessibility).toContain("Account Restriction")

            const taken = yield* desk.post("/take", { operator: "j.okafor" })
            expect(taken.status).toBe(303)
            expect((yield* desk.served).ownerLabel).toBe("HUMAN")

            // The whole point of the guard. A run of the same capability, on the
            // same live Session, while a person holds it.
            const intruder = yield* desk.replayAgain("guarded-run")
            expect(intruder.result).toBe("failure")
            if (intruder.result !== "failure") throw new Error("unreachable")
            expect(intruder.failure.reason).toBe("control_lost")
            expect(intruder.failure.observed).toContain("operator")
            expect(intruder.steps).toEqual([])

            // And it did not act: the Operator's screen is untouched.
            expect((yield* desk.surface.observe).url).toBe(before.url)

            yield* releaseTheHold(desk)
            yield* desk.post("/note", {
              detail: "entered supervisor override for SUP-HOLD-02"
            })

            const returned = yield* desk.post("/return", {
              operator: "j.okafor",
              classification: "resolved",
              detail: "authorized the account as supervisor SUP7"
            })
            expect(returned.status).toBe(303)
          })
      })

      // The run finished, from the step it stopped on.
      expect(outcome.result.result).toBe("success")
      if (outcome.result.result !== "success") throw new Error("unreachable")
      expect(outcome.result.outputs["availableBalance"]).toEqual({
        type: "money",
        value: { amount: 2730.11, currency: "USD" }
      })
      expect(outcome.result.outputs["currentBalance"]).toEqual({
        type: "money",
        value: { amount: 2905.6, currency: "USD" }
      })

      // Resumed, not restarted. Six steps, each once, in artifact order, and the
      // Step that paused among them.
      expect(outcome.result.steps.map((step) => step.id)).toEqual([
        "open-member-search",
        "enter-member-number",
        "run-member-search",
        HELD_STEP,
        "read-available-balance",
        "read-current-balance"
      ])
      expect(outcome.result.steps.every((step) => step.checkpoint === "held")).toBe(true)

      // The strongest form of the same claim: an action is what changes the
      // world, and each Step's ran exactly once across the whole episode.
      const actions = outcome.events.filter((event) => event.kind === "action")
      expect(actions.map((event) => event.stepId)).toEqual([
        "open-member-search",
        "enter-member-number",
        "run-member-search",
        HELD_STEP,
        "read-available-balance",
        "read-current-balance"
      ])

      // The checkpoint on the held step was asked twice: once before the person,
      // once after. Re-asking is how the run finds out what they did.
      const checkpoints = outcome.events.filter(
        (event) => event.kind === "checkpoint" && event.stepId === HELD_STEP
      )
      expect(checkpoints.map((event) => (event.kind === "checkpoint" ? event.verdict : "")))
        .toEqual(["failed", "held"])

      // The session was handed back before any of that, and is answerable now.
      expect(outcome.snapshot.ownerLabel).toBe("AUTOMATION")
      expect(outcome.snapshot.resolved).toHaveLength(1)
    }),
  60_000
)

it.live(
  "evidence records who took control, what they did, and when they returned it",
  () =>
    Effect.gen(function* () {
      const outcome = yield* attendedReplay({
        artifact: shippedArtifact(),
        inputs: { memberId: RESTRICTED },
        runId: "handoff-evidence",
        operate: (desk) =>
          Effect.gen(function* () {
            yield* desk.awaitPause
            yield* desk.post("/take", { operator: "r.mensah" })
            yield* releaseTheHold(desk)
            yield* desk.post("/note", { detail: "entered supervisor override 4417" })
            yield* desk.post("/return", {
              operator: "r.mensah",
              classification: "resolved",
              detail: "authorized SUP-HOLD-02 and confirmed the balances rendered"
            })
          })
      })

      expect(outcome.result.result).toBe("success")

      const raise = outcome.events.find((event) => event.kind === "intervention.raise")
      expect(raise).toBeDefined()
      expect(raise!.stepId).toBe(HELD_STEP)
      if (raise!.kind !== "intervention.raise") throw new Error("unreachable")
      expect(raise!.detail).toContain("Available Balance")

      const acted = outcome.events.filter((event) => event.kind === "intervention.human_action")
      expect(acted.map((event) => (event.kind === "intervention.human_action" ? event.operator : "")))
        .toEqual(["r.mensah", "r.mensah"])
      expect(acted.map((event) => (event.kind === "intervention.human_action" ? event.detail : "")))
        .toEqual(["took control of the live session", "entered supervisor override 4417"])

      const resolved = outcome.events.find((event) => event.kind === "intervention.resolve")
      expect(resolved).toBeDefined()
      if (resolved!.kind !== "intervention.resolve") throw new Error("unreachable")
      expect(resolved!.operator).toBe("r.mensah")
      expect(resolved!.classification).toBe("resolved")
      expect(resolved!.detail).toContain("authorized SUP-HOLD-02")

      // In order, and joined to the run and the session by the envelope every
      // event carries, so an auditor reads one file and sees the whole episode.
      const order = outcome.events
        .filter((event) => event.kind.startsWith("intervention."))
        .map((event) => event.kind)
      expect(order).toEqual([
        "intervention.raise",
        "intervention.human_action",
        "intervention.human_action",
        "intervention.resolve"
      ])
      expect(new Set(outcome.events.map((event) => event.sessionId))).toEqual(
        new Set(["session-handoff-evidence"])
      )

      // And the returned-at times are on the record the caller can read, not
      // only in the log.
      const record = outcome.snapshot.resolved[0]!
      expect(record.operator).toBe("r.mensah")
      expect(record.tookControlAt).toBeDefined()
      expect(record.returnedAt).toBeDefined()
      expect(Date.parse(record.returnedAt!)).toBeGreaterThanOrEqual(
        Date.parse(record.tookControlAt!)
      )
    }),
  60_000
)

it.live(
  "an operator who cannot resolve it ends the run as intervention_required",
  () =>
    Effect.gen(function* () {
      const outcome = yield* attendedReplay({
        artifact: shippedArtifact(),
        inputs: { memberId: RESTRICTED },
        runId: "handoff-unresolved",
        operate: (desk) =>
          Effect.gen(function* () {
            yield* desk.awaitPause
            yield* desk.post("/take", { operator: "j.okafor" })
            // Looks, touches nothing, hands it back. Ticket 13 learns from
            // exactly this shape of episode.
            yield* desk.post("/return", {
              operator: "j.okafor",
              classification: "unresolved",
              detail: "no supervisor on the floor; the hold stands"
            })
          })
      })

      // Not a failure. Nothing is broken and nobody needs paging: a person is
      // required, and the result says so with the step and the session on it.
      expect(outcome.result.result).toBe("intervention_required")
      if (outcome.result.result !== "intervention_required") throw new Error("unreachable")
      expect(outcome.result.stepId).toBe(HELD_STEP)
      expect(outcome.result.sessionId).toBe("session-handoff-unresolved")
      expect(outcome.result.reason).toContain("without resolving")
      expect(outcome.result.reason).toContain("no supervisor on the floor")
      expect(outcome.result.accessibility).toContain("SUPERVISOR AUTHORIZATION REQUIRED")

      // The steps before it still ran, and are still reported.
      expect(outcome.result.steps.map((step) => step.checkpoint)).toEqual([
        "held",
        "held",
        "held",
        "failed"
      ])

      const end = outcome.events.find((event) => event.kind === "run.end")
      expect(end && end.kind === "run.end" ? end.result : undefined).toBe(
        "intervention_required"
      )
    }),
  60_000
)

it.live(
  "an unattended run reports a hard failure rather than escalating to nobody",
  () =>
    Effect.gen(function* () {
      const outcome = yield* attendedReplay({
        artifact: shippedArtifact(undefined, BEFORE_LEARNING),
        inputs: { memberId: RESTRICTED },
        runId: "handoff-unattended",
        attended: false
      })

      expect(outcome.result.result).toBe("failure")
      if (outcome.result.result !== "failure") throw new Error("unreachable")
      expect(outcome.result.failure.reason).toBe("checkpoint_failed")
      expect(outcome.result.failure.stepId).toBe(HELD_STEP)
      expect(outcome.result.failure.expected).toContain("Available Balance")

      // Nothing was escalated, because there was nobody to escalate to.
      expect(outcome.events.filter((event) => event.kind.startsWith("intervention."))).toEqual([])
      expect(outcome.snapshot.ownerLabel).toBe("AUTOMATION")
    }),
  60_000
)
