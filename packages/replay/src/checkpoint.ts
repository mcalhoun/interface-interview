/**
 * Evaluating a Checkpoint against a live Surface.
 *
 * The rule this module exists to enforce: **never infer success from the absence
 * of an exception.** Heritage Core answers a search for a member who does not
 * exist with HTTP 200 and a perfectly well-formed page. A click that lands on the
 * Cross-Reference Lookup instead of the search button navigates successfully to
 * somewhere that is not Member Detail. Playwright raises nothing in either case.
 * So every Step names, in advance, something that will be observable afterwards,
 * and the Step is believed only when that thing is observed.
 *
 * Evaluation is a bounded poll rather than a single read, because Heritage Core
 * does full page loads and a Checkpoint is asserted the instant the Action
 * returns. The poll is over `observe`, so what a Checkpoint sees is exactly what
 * the rest of the system sees: the accessibility tree, the location, and what
 * earlier Steps read. Nothing here can reach markup.
 *
 * ## Why not `SurfaceAdapter.waitFor`
 *
 * The adapter's `waitFor` polls one condition and, on expiry, reports the
 * condition and how long it waited. A Checkpoint is a *set* of assertions and its
 * failure has to say which one failed and what was there instead — SPEC user
 * story 29. Polling here means the failing assertion and the state that defeated
 * it come from the same observation.
 *
 * ## Three verdicts, not two
 *
 * A Checkpoint's intended state either was reached or was not — but "was not" is
 * two entirely different things, and collapsing them is the mistake this system
 * exists to avoid. The application may be broken, or the application may have
 * answered a question the caller asked and the answer is simply not the happy
 * path. Searching for a member who does not exist is the second, and it is a
 * result the caller needs rather than a fault anyone should be paged about.
 *
 * So `evaluate` returns `held`, `outcome` or `failed`:
 *
 *   - **held** — every assertion in `expect` is true.
 *   - **outcome** — `expect` is not true, and every condition of a Business
 *     Outcome branch the Artifact declared *is*. Terminal, and not a failure.
 *   - **failed** — neither, within the bound. Everything downstream of a failed
 *     Checkpoint — recovery, then handing off to a person — hangs off this one
 *     verdict, and only off this one.
 *
 * `expect` is always tried first, on every pass, so a screen that satisfies the
 * intended state can never be re-read as an outcome. Branches are tried in the
 * order the Artifact lists them.
 *
 * A matching branch returns **immediately**, without waiting out the remaining
 * bound. That is not an optimisation: a declared outcome is a definite state, not
 * a state that has yet to settle, and making a legitimate domain answer cost a
 * five-second timeout would be treating it as a failure in everything but name.
 *
 * ## The ladder below a failed Checkpoint
 *
 * The order of evaluation and escalation is the
 * semantic core of the system:
 *
 * ```
 *   expect -> declared Business Outcomes -> recovery -> bounded assistance -> person
 * ```
 *
 * A declared outcome is what the application *means*; a Recoverable Condition is
 * a state it is passing through; an Intervention is what is left when neither
 * applies. Checking recovery before outcomes would let a transient-overlay rule
 * spend a run's budget retrying a question the application has already answered
 * and then report a Hard Failure for a run that succeeded. Handing off before
 * recovery would wake a person for something the system can get past on its own.
 *
 * The first arrow is structural: `evaluate` folds `expect` and the outcome
 * branches together and only `verdict: "failed"` leaves this module, so nothing
 * downstream can see an outcome to mistake for a fault. The rest of the ladder is
 * enforced by the recovery and handoff orchestration in `engine.ts`.
 *
 * ## What `evaluate` turned out to be for
 *
 * This function ended up doing three jobs, and it is worth naming them because
 * they are the same job:
 *
 *   1. **Verifying a Step.** What it was written for.
 *   2. **Waiting out a slow load.** Bounded polling already handles lateness,
 *      without needing a separate recovery condition.
 *   3. **Detecting a Recoverable Condition, and deciding whether one cleared.**
 *      A rule's `detect` is a list of the same assertions, evaluated with a bound
 *      of zero — one look, no waiting. And a recovery decides whether it worked
 *      by calling this function again, against the live screen, rather than by
 *      believing its own remedy. Re-evaluating is free because this is idempotent,
 *      and it is the difference between a run that recovered and a run that says
 *      it did.
 *
 * `recovery.ts` is where that loop lives; it reaches this function only through
 * closures the engine hands it, so nothing in it can touch a browser.
 */

import { Effect, Redacted } from "effect"
import {
  type Assertion,
  type Checkpoint,
  type ResolvedInputs,
  type Step,
  type ValueRef,
  describeAssertion,
  describeBranch,
  toSurfaceTarget
} from "@cua/artifact"
import type {
  SurfaceAdapterService,
  SurfaceState,
  SurfaceUnavailable,
  TargetFailure
} from "@cua/surface"
import { describeMatch, describeTarget, nodeText, normalise } from "@cua/surface"
import type { Evidence, EvidenceUnwritable } from "@cua/evidence"
import type { Policy } from "@cua/policy"
import type { Session } from "@cua/session"
import type { ReplayFailure } from "./ReplayResult.ts"

/** How long a Checkpoint has to come true when the Artifact does not say. */
export const DEFAULT_CHECKPOINT_MILLIS = 5_000

const POLL_INTERVAL_MILLIS = 100

/** What earlier Steps read, keyed by the Step that read it. */
export type StepReadings = ReadonlyMap<string, string>

/** What every verdict carries, whichever one it is. */
interface Observed {
  readonly state: SurfaceState
  readonly waitedMillis: number
}

export type CheckpointOutcome =
  /** The intended state was reached. */
  | ({ readonly verdict: "held" } & Observed)
  /**
   * A declared Business Outcome branch matched instead. Terminal and successful:
   * the run stops here and the caller gets `code` to branch on.
   */
  | ({
      readonly verdict: "outcome"
      readonly code: string
      /** Which branch, zero-based, for anyone reading the Artifact alongside. */
      readonly branch: number
      /** The conditions that held, in the Artifact's words. Goes into Evidence. */
      readonly because: string
    } & Observed)
  /** Neither, within the bound. */
  | ({
      readonly verdict: "failed"
      /** The first assertion of `expect` that did not hold, as "expected ...". */
      readonly expected: string
      /** What was there instead. Never a stack trace. */
      readonly observed: string
    } & Observed)

/** Run dependencies stay together for ordinary verification and recovery detection. */
export interface EvaluationContext {
  readonly surface: SurfaceAdapterService
  readonly policy: Policy["Service"]
  readonly session: Session["Service"]
  readonly evidence: Evidence["Service"]
  readonly inputs: ResolvedInputs
  readonly readings: StepReadings
}

type CheckpointStep = Pick<Step, "id" | "intent">
type EvaluationFailure = SurfaceUnavailable | ReplayFailure | EvidenceUnwritable

/** Each call observes and authorizes the page it actually evaluates. */
export const createCheckpointEvaluator = (context: EvaluationContext) => ({
  evaluate: (step: CheckpointStep, checkpoint: Checkpoint) => evaluate(context, step, checkpoint),
  detect: (step: CheckpointStep, assertions: ReadonlyArray<Assertion>) =>
    evaluate(context, step, {
      description: "the screen matches a declared recoverable condition",
      expect: assertions,
      withinMillis: 0
    }).pipe(Effect.map((outcome) => outcome.verdict === "held"))
})

/** Session ownership is checked on every poll, including polls on the same page. */
const permitReads = (
  context: EvaluationContext,
  step: CheckpointStep,
  checkpoint: Checkpoint,
  state: SurfaceState,
  authorise: boolean
): Effect.Effect<void, ReplayFailure | EvidenceUnwritable> =>
  Effect.gen(function* () {
    for (const assertion of assertionsOf(checkpoint)) {
      if (assertion.assert !== "targetReads") continue
      const subject = describeTarget(toSurfaceTarget(assertion.target))
      const at = { stepId: step.id, stepIntent: step.intent }
      yield* context.session.claim(`extract ${subject}`).pipe(Effect.catch((lost) =>
        Effect.fail<ReplayFailure>({
          reason: "control_lost", ...at,
          expected: "automation to hold the session",
          observed: `control belongs to ${lost.owner}`, owner: lost.owner
        })
      ))
      if (!authorise) continue
      const verdict = yield* context.policy.authorise({
        type: "extract", subject, stepId: step.id, mode: "replay", page: state.url
      })
      yield* context.evidence.record({
        kind: "policy.check", stepId: step.id, action: "extract", subject,
        verdict: verdict.verdict, reason: verdict.reason, policy: verdict.policy, risk: verdict.risk,
        ...(verdict.origin === undefined ? {} : { origin: verdict.origin })
      })
      if (verdict.verdict === "deny") return yield* Effect.fail<ReplayFailure>({
        reason: "policy_violation", ...at,
        expected: `policy ${verdict.policy} to permit extract`, observed: verdict.reason,
        action: "extract", subject
      })
    }
  })

/**
 * Polls until the intended state holds, a declared outcome branch matches, or the
 * Checkpoint's bound expires.
 *
 * Surface, permission and Evidence failures stop evaluation. A failed assertion
 * and a declared Business Outcome are verdicts for the caller to handle. They
 * never enter the error channel, where recovery could mistake a domain answer
 * for a fault.
 */
const evaluate = (
  context: EvaluationContext,
  step: CheckpointStep,
  checkpoint: Checkpoint
): Effect.Effect<CheckpointOutcome, EvaluationFailure> =>
  Effect.gen(function* () {
    const bound = checkpoint.withinMillis ?? DEFAULT_CHECKPOINT_MILLIS
    const startedAt = Date.now()
    // One Policy record per declared read and page in this evaluation.
    // A new call or a changed page always asks again.
    let permittedPage: string | undefined

    // A first pass runs before any sleeping, so a Checkpoint over a state that is
    // already true costs nothing. Most of them are.
    while (true) {
      const state = yield* context.surface.observe
      yield* permitReads(context, step, checkpoint, state, permittedPage !== state.url)
      permittedPage = state.url
      const firstFailure = yield* firstUnmet(context, checkpoint.expect, state)

      if (firstFailure === undefined) {
        return { verdict: "held", state, waitedMillis: Date.now() - startedAt }
      }

      // The intended state is not here. Before concluding anything about that,
      // ask whether this is one of the states the Artifact said the application
      // legitimately reaches.
      const branches = checkpoint.orOutcome ?? []
      for (const [branch, declared] of branches.entries()) {
        if ((yield* firstUnmet(context, declared.when, state)) !== undefined) continue
        return {
          verdict: "outcome",
          code: declared.code,
          branch,
          because: describeBranch(declared),
          state,
          waitedMillis: Date.now() - startedAt
        }
      }

      const waitedMillis = Date.now() - startedAt
      if (waitedMillis >= bound) {
        return { verdict: "failed", state, waitedMillis, ...firstFailure }
      }
      yield* Effect.sleep(POLL_INTERVAL_MILLIS)
    }
  })

/** Include every place evaluation can read a control before checking any assertion. */
const assertionsOf = (checkpoint: Checkpoint): ReadonlyArray<Assertion> => [
  ...checkpoint.expect,
  ...(checkpoint.orOutcome ?? []).flatMap((branch) => branch.when)
]

/**
 * The first assertion in the list that does not hold, or `undefined` if they all
 * do.
 *
 * Shared by `expect` and by every outcome branch, deliberately: a branch is
 * evaluated by exactly the same code, against exactly the same observation, as
 * the intended state it is an alternative to. There is no separate, laxer path
 * for recognising a domain answer.
 */
const firstUnmet = (
  context: EvaluationContext,
  assertions: ReadonlyArray<Assertion>,
  state: SurfaceState
): Effect.Effect<{ expected: string; observed: string } | undefined, SurfaceUnavailable> =>
  Effect.gen(function* () {
    for (const assertion of assertions) {
      const observed = yield* check(context, assertion, state)
      if (observed !== undefined) return { expected: describeAssertion(assertion), observed }
    }
    return undefined
  })

/**
 * `undefined` when the assertion holds; otherwise what was observed instead.
 *
 * The observed string is written for someone reading a failure report at 3am, so
 * it says what was there rather than restating what was wanted.
 */
const check = (
  context: EvaluationContext,
  assertion: Assertion,
  state: SurfaceState
): Effect.Effect<string | undefined, SurfaceUnavailable> => {
  switch (assertion.assert) {
    case "textPresent":
      return Effect.succeed(
        normalise(nodeText(state.tree)).includes(normalise(assertion.text))
          ? undefined
          : `no such text on ${describeScreen(state)}`
      )

    case "textAbsent":
      return Effect.succeed(
        normalise(nodeText(state.tree)).includes(normalise(assertion.text))
          ? `the text is still on ${describeScreen(state)}`
          : undefined
      )

    case "targetPresent":
      return context.surface.resolveTarget(toSurfaceTarget(assertion.target)).pipe(
        Effect.as(undefined),
        Effect.catch(resolutionProblem(state))
      )

    case "targetAbsent":
      return context.surface.resolveTarget(toSurfaceTarget(assertion.target)).pipe(
        Effect.map((resolution) => `${resolution.match.description} on ${describeScreen(state)}`),
        // Not finding it is the point; ambiguity means several of it exist.
        Effect.catch((failure) =>
          failure._tag === "TargetNotFound"
            ? Effect.succeed(undefined)
            : failure._tag === "TargetAmbiguous"
              ? Effect.succeed(`${failure.matches.length} matching controls`)
              : Effect.fail(failure)
        )
      )

    case "targetReads": {
      const wanted = resolveValue(context, assertion.equals)
      if (wanted === undefined) {
        return Effect.succeed("the artifact referred to a value this run does not have")
      }
      return context.surface.extract(toSurfaceTarget(assertion.target)).pipe(
        Effect.map((read) => (read.trim() === wanted ? undefined : `it reads ${JSON.stringify(read)}`)),
        Effect.catch(resolutionProblem(state))
      )
    }

    case "stepRead": {
      const read = context.readings.get(assertion.step)
      if (read === undefined) {
        return Effect.succeed(`step ${assertion.step} read nothing`)
      }
      return Effect.succeed(
        new RegExp(assertion.matches).test(read) ? undefined : `it read ${JSON.stringify(read)}`
      )
    }
  }
}

/** Turns a Target failure into the "observed" half, or re-raises a dead Surface. */
const resolutionProblem =
  (state: SurfaceState) =>
  (failure: TargetFailure): Effect.Effect<string, SurfaceUnavailable> => {
    switch (failure._tag) {
      case "SurfaceUnavailable":
        return Effect.fail(failure)
      case "TargetAmbiguous":
        return Effect.succeed(
          `${failure.matches.length} controls matched: ${
            failure.matches.map(describeMatch).join("; ")
          }`
        )
      case "TargetNotFound":
        return Effect.succeed(`nothing matched on ${describeScreen(state)}`)
    }
  }

const describeScreen = (state: SurfaceState): string =>
  `${JSON.stringify(state.title)} at ${state.url}`

/**
 * The text a `ValueRef` stands for in this run, or `undefined` if the run does
 * not have it.
 *
 * Shared with the executor so a Checkpoint and the Action it verifies can never
 * disagree about what a parameter means.
 *
 * ## Runtime value boundary
 *
 * A `fill` has to type real characters into a real field, and a `targetReads`
 * checkpoint has to compare against the same real characters, so somewhere the
 * `Redacted<string>` has to come apart. That somewhere is this line, and it is
 * one line because both callers were already routed through this function.
 *
 * What the unwrap does *not* do is escape. The plaintext is returned to a caller
 * that hands it straight to `SurfaceAdapter.fill` or compares it with `===`;
 * nothing stores it, and nothing puts it in an Evidence event. The one place a
 * comparison failure could quote it — `it reads "12345"` in the observed string
 * below — is a value read back off the screen, and the Evidence scrubber takes
 * that out on the way to disk.
 *
 * `test/sensitive-data.test.ts` checks the permitted unwrap boundaries.
 */
export const resolveValue = (
  context: Pick<EvaluationContext, "inputs" | "readings">,
  ref: ValueRef
): string | undefined => {
  switch (ref.from) {
    case "parameter": {
      const input = context.inputs.get(ref.name)
      return input === undefined ? undefined : Redacted.value(input.text)
    }
    case "constant":
      return ref.text
    case "step":
      return context.readings.get(ref.step)
  }
}
