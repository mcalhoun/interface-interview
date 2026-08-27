/**
 * Getting past a Recoverable Condition, with nobody involved and a bound on how
 * long that is allowed to take.
 *
 * ## The rule this module exists to enforce
 *
 * **Never assume the fix worked.** A recovery ends by evaluating the Step's own
 * Checkpoint again — the same function, against the live screen — and believes
 * nothing else. Not that the remedy's Actions succeeded, not that the interstitial
 * is probably gone by now, not that signing back on must have worked. Re-checking
 * is free because `evaluate` is idempotent, and the alternative is a run that
 * reports success for a state it never observed.
 *
 * The corollary is the second rule: **a condition that does not clear within its
 * bound stops being recoverable.** It becomes a `recovery_exhausted` Hard Failure
 * carrying the rule that was believed, how many times it was tried, and what the
 * screen still said. Retrying forever is how a transient blip becomes a run that
 * never returns, and SPEC's taxonomy has no class for that.
 *
 * ## Why this module cannot touch the browser
 *
 * Every Surface Action a remedy performs goes through the engine's one
 * authorisation chokepoint — Session guard, then Policy, then act — exactly like a
 * Step's own Action. A remedy is not a privileged path.
 *
 * The way that is made structural rather than promised: nothing in this file
 * imports the Surface Adapter. It is handed a `RecoveryPort` of closures the
 * engine builds around its own gated executor, so there is nowhere here to put a
 * `click` even if someone wanted one. `test/replay-has-no-model.test.ts` counts
 * the adapter call sites in `engine.ts` and pins the exact set of adapter methods
 * it touches; recovery adds nothing to either number, which is the check that this
 * separation is real.
 *
 * ## The bound is `Schedule`, and it is declared in the Artifact
 *
 * `Effect.repeat` with `until` and a bounded `Schedule` is the whole loop: run an
 * attempt, stop early when the Checkpoint holds, otherwise pause and try again
 * until the schedule ends. `Schedule.max([exponential, recurs])` is Effect 4's
 * intersection — it keeps going only while *both* keep going, taking the longer
 * delay — so `attempts` and `backoffMillis` from the Artifact become a policy the
 * runtime enforces rather than a counter someone remembered to increment.
 *
 * Two Effect 4 details worth knowing, both established by experiment rather than
 * recollection:
 *
 *   - `Schedule.upTo(duration)` does **not** bound an `Effect.repeat`. Composed
 *     with `spaced` or `exponential` it repeats indefinitely. `recurs` bounds it.
 *   - When the schedule ends, `repeat` *succeeds* with the last value rather than
 *     failing. That is what makes exhaustion a value to branch on here rather
 *     than an error to catch.
 *
 * Because the loop sleeps, every test over it must be `it.live`; under
 * `@effect/vitest`'s TestClock it hangs, the same trap tickets 02 and 03 hit.
 */

import { Effect, Ref, Schedule } from "effect"
import type { Assertion, RecoverableCondition, RemedyStep } from "@cua/artifact"
import type { EvidenceEventBody, EvidenceUnwritable } from "@cua/evidence"
import type { SurfaceUnavailable } from "@cua/surface"
import type { CheckpointOutcome } from "./checkpoint.ts"

/**
 * How many recovery attempts one run gets in total, across every condition it
 * meets.
 *
 * The per-condition `attempts` bound stops one transient state being retried
 * forever. This stops a *flow* being retried forever: six steps each recovering
 * twice is a run nobody meant to authorise, even though every individual bound
 * was respected. Cheap insurance, and the number is small on purpose — a run
 * needing five recoveries is telling you something the recovery is not going to
 * fix.
 */
export const RECOVERY_BUDGET_PER_RUN = 4

/** What became of one remedy Action. A failed one is information, not an error. */
export type RemedyReport =
  | { readonly done: true; readonly what: string }
  | { readonly done: false; readonly what: string; readonly why: string }

/**
 * Everything a recovery needs from the engine, and nothing more.
 *
 * Deliberately closures rather than services. Each one is built by the engine
 * around its own authorisation chokepoint, so a remedy cannot reach the browser
 * except through the same Session guard and Policy check a Step's Action passes.
 */
export interface RecoveryPort {
  /** Do one remedy Action, through the chokepoint. */
  readonly perform: (
    remedy: RemedyStep
  ) => Effect.Effect<RemedyReport, EvidenceUnwritable>
  /**
   * Return to where the Step began and attempt its Action again.
   *
   * The engine knows the location the Step started from, because it observed it
   * before acting. Going back there is a navigation like any other and is
   * Policy-checked like any other.
   */
  readonly resumeAtStep: Effect.Effect<ReadonlyArray<RemedyReport>, EvidenceUnwritable>
  /** Evaluate the Step's own Checkpoint again. The only thing that decides. */
  readonly recheck: Effect.Effect<CheckpointOutcome, SurfaceUnavailable>
  /** Whether a rule's `detect` assertions hold of the screen right now. */
  readonly detected: (
    assertions: ReadonlyArray<Assertion>
  ) => Effect.Effect<boolean, SurfaceUnavailable>
  readonly record: (body: EvidenceEventBody) => Effect.Effect<void, EvidenceUnwritable>
}

export interface RecoveryRequest {
  /** The declared rules, in priority order. First match wins. */
  readonly conditions: ReadonlyArray<RecoverableCondition>
  /** The Checkpoint that did not hold, for the record. */
  readonly checkpoint: string
  /** The outcome that failed, carrying the state that defeated it. */
  readonly failed: Extract<CheckpointOutcome, { held: false }>
  /** The run's remaining recovery attempts, shared across every Step. */
  readonly budget: Ref.Ref<number>
  readonly port: RecoveryPort
}

/**
 * What a recovery came to.
 *
 * `attempted: false` means no declared rule matched the screen. That is not a
 * recovery that failed — it is a Checkpoint failure that recovery had nothing to
 * say about, and the engine reports it as it always did.
 */
export type RecoveryOutcome =
  | { readonly attempted: false }
  | {
      readonly attempted: true
      readonly condition: RecoverableCondition
      readonly attempts: number
      readonly outcome: CheckpointOutcome
    }

/**
 * Detect, remedy, re-check, repeat within bounds.
 *
 * Fails only when the Surface itself dies or Evidence cannot be written. A
 * condition that will not clear is a *value*: the engine turns it into a
 * `recovery_exhausted` failure with everything a reader needs.
 */
export const recover = (
  request: RecoveryRequest
): Effect.Effect<RecoveryOutcome, SurfaceUnavailable | EvidenceUnwritable> =>
  Effect.gen(function* () {
    const { budget, checkpoint, failed, port } = request

    const condition = yield* firstMatching(request.conditions, port)
    if (condition === undefined) return { attempted: false }

    yield* port.record({
      kind: "recovery.detected",
      condition: condition.condition,
      detail: condition.description,
      checkpoint,
      observed: failed.observed,
      url: failed.state.url
    })

    const remaining = yield* Ref.get(budget)
    const allowed = Math.min(condition.attempts, remaining)
    if (allowed <= 0) {
      yield* port.record({
        kind: "recovery.resolved",
        condition: condition.condition,
        cleared: false,
        attempts: 0,
        detail: `this run's budget of ${RECOVERY_BUDGET_PER_RUN} recovery attempts was already spent`
      })
      return { attempted: true, condition, attempts: 0, outcome: failed }
    }

    let attempts = 0

    const attempt = Effect.gen(function* () {
      attempts += 1
      const attempted: Array<string> = []

      for (const remedy of condition.remedy) {
        const report = yield* port.perform(remedy)
        attempted.push(describeReport(report))
      }
      if (condition.resume === "at-step") {
        for (const report of yield* port.resumeAtStep) attempted.push(describeReport(report))
      }

      // The re-check happens whatever the remedy reported. A remedy Action that
      // could not find its control has not proved the condition is still there,
      // and a Checkpoint that now holds is the truth regardless of how tidily we
      // got there. Only the screen decides.
      const outcome = yield* port.recheck

      yield* port.record({
        kind: "recovery.attempt",
        condition: condition.condition,
        attempt: attempts,
        of: allowed,
        attempted,
        cleared: outcome.held,
        observed: outcome.held ? "the intended state was reached" : outcome.observed,
        waitedMillis: outcome.waitedMillis
      })

      return outcome
    })

    const outcome = yield* Effect.repeat(attempt, {
      until: (result: CheckpointOutcome) => result.held,
      schedule: boundedBackoff(allowed, condition.backoffMillis)
    })

    yield* Ref.update(budget, (left) => Math.max(0, left - attempts))
    yield* port.record({
      kind: "recovery.resolved",
      condition: condition.condition,
      cleared: outcome.held,
      attempts,
      detail: outcome.held
        ? `${condition.condition} cleared after ${countOf(attempts)}`
        : `${condition.condition} did not clear within ${countOf(allowed)}`
    })

    return { attempted: true, condition, attempts, outcome }
  })

/**
 * The bound, as a Schedule.
 *
 * `max` is Effect 4's intersection: it recurs only while both schedules recur, so
 * `recurs` supplies the ceiling and `exponential` supplies the pauses. Verified
 * by experiment — `recurs(2)` here yields three attempts spaced `base` then
 * `2 x base` apart, and `upTo` would not have bounded it at all.
 */
const boundedBackoff = (attempts: number, backoffMillis: number) =>
  Schedule.max([Schedule.exponential(backoffMillis, 2), Schedule.recurs(Math.max(0, attempts - 1))])

/**
 * The first declared rule whose `detect` holds of the screen right now.
 *
 * Declaration order is priority order, and it is checked one rule at a time
 * against the live screen rather than against the failure text. A rule that fired
 * on the wording of an error message would be a rule that fires on the wrong
 * screen the moment somebody rewords one.
 */
const firstMatching = (
  conditions: ReadonlyArray<RecoverableCondition>,
  port: RecoveryPort
): Effect.Effect<RecoverableCondition | undefined, SurfaceUnavailable> =>
  Effect.gen(function* () {
    for (const condition of conditions) {
      if (yield* port.detected(condition.detect)) return condition
    }
    return undefined
  })

const describeReport = (report: RemedyReport): string =>
  report.done ? report.what : `${report.what} — did not work: ${report.why}`

const countOf = (attempts: number): string =>
  `${attempts} attempt${attempts === 1 ? "" : "s"}`
