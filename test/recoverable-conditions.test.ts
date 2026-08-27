/**
 * Getting past transient states with nobody involved.
 *
 * Two conditions, chosen because they fail differently. A "System Busy"
 * interstitial blocks cleanly at a Step boundary and needs an *action*, because
 * the screen is static and waiting on it waits forever. A session expiry strands
 * the run somewhere it never meant to be, and getting past it means both
 * re-authenticating and getting back to the Step that was interrupted. A slow
 * panel sits behind both as the case where acting would be exactly wrong.
 *
 * Everything below runs the real mock application in a real browser, because a
 * transient condition is a property of a moment and a stubbed browser has no
 * moments in it.
 *
 * **`it.live` throughout.** Recovery backs off with `Effect.sleep`, and under
 * `@effect/vitest`'s TestClock these hang rather than fail — the same trap
 * tickets 02 and 03 recorded.
 */

import { it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import { expect } from "vitest"
import { DEFAULT_PANEL_DELAY_MILLIS, TRANSIENT_MEMBER, serve } from "@cua/legacy-core"
import type { EvidenceEvent } from "@cua/evidence"
import { type RecoverableCondition, recoverableConditions } from "@cua/artifact"
import type { SurfaceState } from "@cua/surface"
import { type CheckpointOutcome, RECOVERY_BUDGET_PER_RUN, recover } from "@cua/replay"
import { type ReplayOutcome, replay, shippedArtifact } from "./support/replay-harness.ts"

/** Where the expiry toggle has to fire to land inside `open-account`. */
const EXPIRE_BEFORE_ACCOUNT = 2
const PASSWORD = "HERITAGE"

/**
 * One run per scenario, asked several questions.
 *
 * A run here costs a browser, a server and — for the scenarios that recover —
 * several seconds of genuine backing off, which is the behaviour under test and
 * not something to mock away. Each scenario is therefore the fixture: run once,
 * and asserted on from as many angles as it takes. The outcome is a result plus
 * the evidence read back off disk, so nothing about it depends on the browser
 * still being open.
 */
const scenario = (make: Effect.Effect<ReplayOutcome, unknown>) => {
  let pending: Promise<ReplayOutcome> | undefined
  return Effect.promise(() => (pending ??= Effect.runPromise(make)))
}

/** Member 55555: the busy interstitial, and the slow panel behind it. */
const overlayRun = scenario(
  replay({ artifact: shippedArtifact(), inputs: { memberId: TRANSIENT_MEMBER } })
)

/** A session that expires part-way through, with credentials to sign back on. */
const expiredRun = scenario(
  replay({
    artifact: shippedArtifact(),
    inputs: { memberId: "12345", operatorPassword: PASSWORD },
    core: { expireSessionAfter: EXPIRE_BEFORE_ACCOUNT }
  })
)

/** The same expiry with no password, so the condition never clears. */
const strandedRun = scenario(
  replay({
    artifact: shippedArtifact(),
    inputs: { memberId: "12345" },
    core: { expireSessionAfter: EXPIRE_BEFORE_ACCOUNT }
  })
)

type Kind = EvidenceEvent["kind"]

const of = <K extends Kind>(
  outcome: ReplayOutcome,
  kind: K
): ReadonlyArray<Extract<EvidenceEvent, { kind: K }>> =>
  outcome.events.filter((event): event is Extract<EvidenceEvent, { kind: K }> =>
    event.kind === kind
  )

const at = <K extends Kind>(
  outcome: ReplayOutcome,
  kind: K,
  stepId: string
): ReadonlyArray<Extract<EvidenceEvent, { kind: K }>> =>
  of(outcome, kind).filter((event) => event.stepId === stepId)

// ---------------------------------------------------------------------------
// The fixture: what Heritage Core actually does
// ---------------------------------------------------------------------------

it.live("answers member 55555 with a busy interstitial before it answers with the record", () =>
  Effect.gen(function* () {
    const core = yield* serve({ port: 0 })
    const get = (path: string) =>
      Effect.promise(() => fetch(core.origin + path).then((response) => response.text()))

    const first = yield* get(`/member?memberNumber=${TRANSIENT_MEMBER}`)
    expect(first).toContain("System Busy")
    expect(first).not.toContain("Member Detail")
    // The way out is a control, not a delay: no script and no meta refresh
    // anywhere, so this screen never becomes the record on its own.
    expect(first).toContain(`<a href="/member?memberNumber=${TRANSIENT_MEMBER}">Continue</a>`)
    expect(first).not.toMatch(/<script|http-equiv="refresh"/i)

    yield* get(`/member?memberNumber=${TRANSIENT_MEMBER}`)
    const third = yield* get(`/member?memberNumber=${TRANSIENT_MEMBER}`)
    expect(third).toContain("Member Detail")
    expect(third).toContain("DELPHINE R OKONKWO")
  }).pipe(Effect.scoped)
)

it.live("serves member 55555's balance panel late, and everyone else's promptly", () =>
  Effect.gen(function* () {
    const core = yield* serve({ port: 0 })
    const timed = (path: string) =>
      Effect.promise(async () => {
        const started = Date.now()
        await fetch(core.origin + path).then((response) => response.text())
        return Date.now() - started
      })

    const slow = yield* timed(
      `/account/panel?memberNumber=${TRANSIENT_MEMBER}&accountNumber=0000055555-S01`
    )
    const prompt = yield* timed("/account/panel?memberNumber=12345&accountNumber=0000012345-S01")

    expect(slow).toBeGreaterThanOrEqual(DEFAULT_PANEL_DELAY_MILLIS - 50)
    expect(prompt).toBeLessThan(DEFAULT_PANEL_DELAY_MILLIS)
  }).pipe(Effect.scoped)
)

it.live("turns every screen into Sign On once the expiry toggle fires, until somebody signs on", () =>
  Effect.gen(function* () {
    const core = yield* serve({ port: 0, expireSessionAfter: 1 })
    const get = (path: string) =>
      Effect.promise(() => fetch(core.origin + path).then((response) => response.text()))
    // Sign-on is a POST: the password is a credential and a GET form would put
    // it in the address bar, and therefore in `page.url()` and in Evidence.
    const signOn = (password: string) =>
      Effect.promise(() =>
        fetch(`${core.origin}/signon`, {
          method: "POST",
          body: new URLSearchParams({ password })
        }).then((response) => response.text())
      )

    expect(yield* get("/")).toContain("Member Number Search")

    // The toggle is expressed in page requests rather than in routes, so it
    // fires part-way through whatever flow happens to be running.
    const stranded = yield* get("/member?memberNumber=12345")
    expect(stranded).toContain("Session Expired")
    expect(stranded).not.toContain("Member Detail")
    expect(yield* get("/account?memberNumber=12345&accountNumber=0000012345-S01")).toContain(
      "Session Expired"
    )

    // An empty password is refused, so an automation that cannot supply one
    // genuinely stays stuck rather than being waved through.
    expect(yield* signOn("")).toContain("Session Expired")

    // Signing on returns the operator to Member Search — not to the screen they
    // were on. Losing your place is the point of this condition.
    expect(yield* signOn(PASSWORD)).toContain("Member Number Search")
    expect(yield* get("/member?memberNumber=12345")).toContain("Member Detail")
  }).pipe(Effect.scoped)
)

// ---------------------------------------------------------------------------
// The overlay: waits, retries, completes
// ---------------------------------------------------------------------------

it.live("replays member 55555 to a successful result by retrying past the interstitial", () =>
  Effect.gen(function* () {
    const outcome = yield* overlayRun

    expect(outcome.result.result).toBe("success")
    if (outcome.result.result !== "success") return
    expect(outcome.result.outputs["availableBalance"]).toEqual({
      type: "money",
      value: { amount: 917.4, currency: "USD" }
    })

    // The step that met the interstitial still held. A step that recovered is a
    // step that held — that is the distinction the whole taxonomy rests on — and
    // the result says which condition it got past, so a caller can tell a smooth
    // run from a bumpy one without opening the evidence.
    const search = outcome.result.steps.find((step) => step.id === "run-member-search")
    expect(search?.checkpoint).toBe("held")
    expect(search?.recovered).toBe("TRANSIENT_OVERLAY")

    // Every other step ran clean.
    expect(
      outcome.result.steps.filter((step) => step.recovered !== undefined).map((step) => step.id)
    ).toEqual(["run-member-search"])
  })
)

it.live("takes more than one attempt to clear the interstitial, and records each one", () =>
  Effect.gen(function* () {
    const outcome = yield* overlayRun

    const detected = of(outcome, "recovery.detected")
    expect(detected).toHaveLength(1)
    expect(detected[0]?.condition).toBe("TRANSIENT_OVERLAY")
    expect(detected[0]?.stepId).toBe("run-member-search")
    // What was detected, in the screen's own words rather than an exception's.
    expect(detected[0]?.observed).toContain("Heritage Core - Please Wait")

    const attempts = of(outcome, "recovery.attempt")
    expect(attempts.length).toBeGreaterThan(1)
    expect(attempts.map((event) => event.attempt)).toEqual(
      attempts.map((_, index) => index + 1)
    )

    // What was attempted: the remedy's own intent, from the artifact.
    for (const attempt of attempts) {
      expect(attempt.attempted).toEqual(["Ask the host for the member record again."])
    }

    // Whether it cleared: false until it did, then true, and never assumed.
    expect(attempts.slice(0, -1).every((attempt) => !attempt.cleared)).toBe(true)
    expect(attempts.at(-1)?.cleared).toBe(true)

    const resolved = of(outcome, "recovery.resolved")
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.cleared).toBe(true)
    expect(resolved[0]?.attempts).toBe(attempts.length)
  })
)

it.live("believes the checkpoint rather than the remedy", () =>
  Effect.gen(function* () {
    const outcome = yield* overlayRun

    // This is the whole rule, and the interstitial is the case that proves it.
    // The first Continue click *worked* — it was found, it was pressed, it
    // navigated — and the recovery still reported `cleared: false`, because the
    // screen that came back was another interstitial. Nothing anywhere infers
    // success from an action that did not throw.
    const first = of(outcome, "recovery.attempt")[0]
    expect(first?.attempted.every((what: string) => !what.includes("did not work"))).toBe(true)
    expect(first?.cleared).toBe(false)

    // And the verdict came from re-evaluating the step's own checkpoint: the
    // step has a `failed` checkpoint event before the recovery and a `held` one
    // after it, from the same evaluator, against the live screen.
    const verdicts = at(outcome, "checkpoint", "run-member-search")
    expect(verdicts.map((event) => event.verdict)).toEqual(["failed", "held"])
    expect(verdicts[1]!.seq).toBeGreaterThan(of(outcome, "recovery.attempt").at(-1)!.seq)
  })
)

it.live("waits out the slow panel instead of acting on it", () =>
  Effect.gen(function* () {
    const outcome = yield* overlayRun

    // Nothing was declared for lateness and nothing fired for it: the only
    // recovery in this run was the interstitial, at the previous step.
    expect(at(outcome, "recovery.detected", "open-account")).toEqual([])
    expect(at(outcome, "checkpoint", "open-account").map((event) => event.verdict)).toEqual([
      "held"
    ])

    // The run did wait, though. The panel is a second document inside an iframe
    // and it takes most of a second, and that time is spent between arriving at
    // Member Detail and reporting the click that opened the account.
    const arrived = at(outcome, "checkpoint", "run-member-search").at(-1)!
    const opened = at(outcome, "action", "open-account")[0]!
    const waited = Date.parse(opened.at) - Date.parse(arrived.at)
    expect(waited).toBeGreaterThanOrEqual(DEFAULT_PANEL_DELAY_MILLIS - 100)
  })
)

// ---------------------------------------------------------------------------
// The expiry: stranded mid-flow, and resumed at the step it was on
// ---------------------------------------------------------------------------

it.live("re-authenticates a session that expired mid-flow and finishes the run", () =>
  Effect.gen(function* () {
    const outcome = yield* expiredRun

    expect(outcome.result.result).toBe("success")
    if (outcome.result.result !== "success") return
    expect(outcome.result.outputs["availableBalance"]).toMatchObject({
      value: { amount: 4182.55 }
    })
    expect(outcome.result.outputs["currentBalance"]).toMatchObject({
      value: { amount: 4382.55 }
    })

    const stranded = outcome.result.steps.find((step) => step.id === "open-account")
    expect(stranded?.recovered).toBe("SESSION_EXPIRED")
    expect(stranded?.checkpoint).toBe("held")

    // What was detected: an actual screen, named by the rule that recognised it.
    const detected = of(outcome, "recovery.detected")[0]
    expect(detected?.condition).toBe("SESSION_EXPIRED")
    expect(detected?.observed).toContain("Sign On")
  })
)

it.live("resumes at the step it was on rather than starting the flow again", () =>
  Effect.gen(function* () {
    const outcome = yield* expiredRun

    expect(outcome.result.result).toBe("success")

    // One run, not two. A capability that "recovered" by restarting would show
    // up here as a second run.start, and the steps before the interruption would
    // be listed twice.
    expect(of(outcome, "run.start")).toHaveLength(1)
    expect(outcome.result.steps.map((step) => step.id)).toEqual(
      shippedArtifact().steps.map((step) => step.id)
    )

    // Nothing before the interrupted step was touched again. Each of them acted
    // exactly once, which is what "resumed at the step" means as distinct from
    // "walked the flow again".
    for (const id of ["open-member-search", "enter-member-number", "run-member-search"]) {
      expect(at(outcome, "action", id), `${id} acted more than once`).toHaveLength(1)
      expect(at(outcome, "checkpoint", id).map((event) => event.verdict)).toEqual(["held"])
    }

    // What was attempted, in order: sign back on, return to where this step
    // began, attempt the step again. The return is a navigation to a location
    // the run *observed* before it acted, not a guess and not the entry point.
    const attempted = of(outcome, "recovery.attempt")[0]?.attempted ?? []
    expect(attempted).toHaveLength(4)
    expect(attempted[0]).toContain("teller password")
    expect(attempted[1]).toContain("Sign the session back on")
    expect(attempted[2]).toContain("where this step began")
    // The location, with the member number taken out of it. Both halves matter:
    // the run went back to the *member* screen rather than to the entry point,
    // and the value it was carrying never reached the log (ticket 08).
    expect(attempted[2]).toContain("/member?memberNumber=")
    expect(attempted[2]).toContain("[redacted:memberId]")
    expect(attempted[2]).not.toContain("12345")
    expect(attempted[3]).toContain("attempt the step again")
    expect(attempted.every((what: string) => !what.includes("did not work"))).toBe(true)
  })
)

it.live("puts a recovery's own actions through the same policy chokepoint as a step's", () =>
  Effect.gen(function* () {
    const outcome = yield* expiredRun

    // A remedy is not a privileged path. Every action it performs is preceded by
    // its own policy check, exactly as a step's action is, so a policy that
    // refused a sign-on would refuse this one (ticket 07).
    const actions = of(outcome, "action")
    const checks = of(outcome, "policy.check")
    // One per action, plus one for the single `targetReads` assertion the flow
    // declares: a checkpoint's read is an `extract` and passes the same gate
    // (ticket 07). A recovery adds no exception to either count.
    expect(checks).toHaveLength(actions.length + 1)
    expect(checks.every((check) => check.verdict === "allow")).toBe(true)

    const recoveryActions = at(outcome, "action", "open-account")
    expect(recoveryActions.map((event) => event.action)).toEqual([
      "selectFromList", // the step's own action, which landed on Sign On
      "fill", // the password
      "click", // Sign On
      "navigate", // back to where the step began
      "selectFromList" // the step's action again
    ])
  })
)

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

it.live("stops the run when a condition will not clear within its declared bound", () =>
  Effect.gen(function* () {
    // No operator password, so the re-authentication cannot be carried out and
    // the session stays expired however many times it is tried.
    const outcome = yield* strandedRun

    expect(outcome.result.result).toBe("failure")
    if (outcome.result.result !== "failure") return

    const failure = outcome.result.failure
    expect(failure.reason).toBe("recovery_exhausted")
    if (failure.reason !== "recovery_exhausted") return

    // Named, bounded and diagnosable: which rule was believed, how many times it
    // was tried, and what the screen still said.
    expect(failure.condition).toBe("SESSION_EXPIRED")
    expect(failure.stepId).toBe("open-account")
    const declared = recoverableConditions(shippedArtifact()).find(
      (rule) => rule.condition === "SESSION_EXPIRED"
    )!
    expect(failure.attempts).toBe(declared.attempts)
    expect(failure.observed).toContain("did not clear")
    expect(failure.accessibility).toContain("Sign On")

    // Bounded means bounded: exactly the declared number of attempts, not one
    // more, and the run ends rather than retrying forever.
    const attempts = of(outcome, "recovery.attempt")
    expect(attempts).toHaveLength(declared.attempts)
    expect(attempts.every((attempt) => attempt.of === declared.attempts)).toBe(true)
    expect(attempts.every((attempt) => !attempt.cleared)).toBe(true)
    expect(of(outcome, "recovery.resolved")[0]?.cleared).toBe(false)

    // And what was attempted says which half failed, which is the difference
    // between "the environment is broken" and "we were not given a password".
    expect(attempts[0]?.attempted[0]).toContain("did not work")
  })
)

it.live("reports an unrecognised state as an ordinary checkpoint failure, not a recovery", () =>
  Effect.gen(function* () {
    // The same member, the same application, the same interstitial — against the
    // shipped artifact with its `recoverable:` section taken away. Nothing
    // recovers, because recovery is something an artifact declares rather than
    // something the engine knows. That is what keeps the rules reviewable and a
    // tenant's overrides possible.
    //
    // The rules were folded into 1.0.0 rather than cut as 1.1.0 (SPEC reserves
    // that slot for what an Intervention teaches), so the comparison is made by
    // removing the section rather than by loading an older file.
    const { recoverable: _removed, ...withoutRules } = shippedArtifact()
    const outcome = yield* replay({
      artifact: withoutRules,
      inputs: { memberId: TRANSIENT_MEMBER }
    })

    expect(outcome.result.result).toBe("failure")
    if (outcome.result.result !== "failure") return
    expect(outcome.result.failure.reason).toBe("checkpoint_failed")
    expect(outcome.result.failure.stepId).toBe("run-member-search")
    expect(of(outcome, "recovery.detected")).toEqual([])
    expect(of(outcome, "recovery.attempt")).toEqual([])
  })
)

it.live("leaves a healthy run entirely alone", () =>
  Effect.gen(function* () {
    const outcome = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: "12345" }
    })

    expect(outcome.result.result).toBe("success")
    expect(outcome.events.filter((event) => event.kind.startsWith("recovery."))).toEqual([])
    expect(outcome.result.steps.every((step) => step.recovered === undefined)).toBe(true)
  })
)

// ---------------------------------------------------------------------------
// The other bound: a whole flow cannot retry itself forever
// ---------------------------------------------------------------------------

/**
 * The per-condition bound is not the only one. Six steps each recovering twice is
 * a run nobody meant to authorise even though every individual bound held, so a
 * run carries a budget of attempts shared across every condition it meets.
 *
 * No end-to-end scenario reaches that ceiling — the shipped artifact's two rules
 * between them cannot spend it — so it is exercised against the recovery loop
 * directly. The port is the engine's own seam rather than a stubbed browser:
 * `recover` is handed closures precisely so that it cannot reach one, and that is
 * what makes the arithmetic checkable without pretending to be Chromium.
 */
const nowhere: SurfaceState = {
  url: "http://127.0.0.1/nowhere",
  title: "Nowhere",
  frames: [],
  tree: { role: "document", properties: {}, children: [] },
  accessibility: "- document",
  observedAt: new Date(0).toISOString()
}

const neverClears: Extract<CheckpointOutcome, { verdict: "failed" }> = {
  verdict: "failed",
  state: nowhere,
  waitedMillis: 0,
  expected: "somewhere else",
  observed: "still nowhere"
}

const insistent = {
  condition: "NEVER_CLEARS",
  description: "A condition whose remedy is tried and tried and never works.",
  detect: [{ assert: "textPresent", text: "anything" }],
  remedy: [],
  resume: "here",
  attempts: 3,
  backoffMillis: 1
} as const satisfies RecoverableCondition

const spending = (startingBudget: number) =>
  Effect.gen(function* () {
    const recorded: Array<EvidenceEvent["kind"]> = []
    let rechecks = 0
    const budget = yield* Ref.make(startingBudget)

    const outcome = yield* recover({
      conditions: [insistent],
      checkpoint: "somewhere else",
      failed: neverClears,
      budget,
      port: {
        perform: () => Effect.succeed({ done: true, what: "nothing to do" }),
        resumeAtStep: Effect.succeed([]),
        recheck: Effect.sync(() => {
          rechecks += 1
          return neverClears
        }),
        detected: () => Effect.succeed(true),
        record: (body) => Effect.sync(() => void recorded.push(body.kind))
      }
    })

    return { outcome, rechecks, recorded, left: yield* Ref.get(budget) }
  })

it.live("spends the run's shared recovery budget, and stops when it is gone", () =>
  Effect.gen(function* () {
    // Room for one attempt, though the rule asks for three. The bound that binds
    // is the tighter of the two.
    const capped = yield* spending(1)
    expect(capped.rechecks).toBe(1)
    expect(capped.left).toBe(0)
    expect(capped.outcome.attempted).toBe(true)
    if (capped.outcome.attempted) expect(capped.outcome.attempts).toBe(1)

    // Nothing left at all: the condition is still recognised and recorded, and
    // nothing is tried, because trying is what the budget rations.
    const spent = yield* spending(0)
    expect(spent.rechecks).toBe(0)
    expect(spent.recorded).toEqual(["recovery.detected", "recovery.resolved"])
    expect(spent.outcome.attempted).toBe(true)
    if (spent.outcome.attempted) {
      expect(spent.outcome.attempts).toBe(0)
      expect(spent.outcome.outcome.verdict).toBe("failed")
    }

    // And the rule's own bound is what binds when the budget allows it.
    const roomy = yield* spending(RECOVERY_BUDGET_PER_RUN)
    expect(roomy.rechecks).toBe(insistent.attempts)
    expect(roomy.left).toBe(RECOVERY_BUDGET_PER_RUN - insistent.attempts)
  })
)
