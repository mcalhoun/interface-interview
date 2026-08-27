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
 * it come from the same observation. `waitFor` stays the right tool for ticket
 * 06's transient conditions, which wait on one thing and do not need to explain
 * themselves.
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
 *   - **failed** — neither, within the bound. A Hard Failure.
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
 * ## Seam for ticket 06 (recoverable conditions)
 *
 * A Checkpoint that reaches neither within its bound returns `verdict: "failed"`
 * with the state that defeated it. Ticket 06 inspects that state for a known
 * transient condition, does something bounded about it, and calls `evaluate`
 * again — re-evaluating rather than assuming the fix worked, which its checklist
 * requires. The return type already carries everything that needs.
 *
 * The order to add it in is: `expect`, then declared outcomes, then recoverable
 * conditions. An outcome is what the application *means*; a recoverable condition
 * is a state the application is passing through. Checking recovery first would
 * let a transient-overlay rule swallow a terminal domain answer.
 */

import { Effect } from "effect"
import {
  type Assertion,
  type Checkpoint,
  type ResolvedInputs,
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
import { describeMatch } from "@cua/surface"

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

export interface EvaluationContext {
  readonly surface: SurfaceAdapterService
  readonly inputs: ResolvedInputs
  readonly readings: StepReadings
}

/**
 * Polls until the intended state holds, a declared outcome branch matches, or the
 * Checkpoint's bound expires.
 *
 * Fails only when the Surface itself is unreachable. Neither of the other two
 * verdicts is an error channel: "the intended state was not reached" and "the
 * domain answered something else" are both information the caller acts on, and a
 * Business Outcome in particular must never travel as an exception — the moment
 * it does, every `catch` upstream starts treating a legitimate answer as a fault.
 */
export const evaluate = (
  context: EvaluationContext,
  checkpoint: Checkpoint
): Effect.Effect<CheckpointOutcome, SurfaceUnavailable> =>
  Effect.gen(function* () {
    const bound = checkpoint.withinMillis ?? DEFAULT_CHECKPOINT_MILLIS
    const startedAt = Date.now()

    // A first pass runs before any sleeping, so a Checkpoint over a state that is
    // already true costs nothing. Most of them are.
    while (true) {
      const state = yield* context.surface.observe
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
        state.accessibility.includes(assertion.text)
          ? undefined
          : `no such text on ${describeScreen(state)}`
      )

    case "textAbsent":
      return Effect.succeed(
        state.accessibility.includes(assertion.text)
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
 * disagree about what a parameter means. This is also the single unwrap point
 * ticket 08 turns into an explicit `Redacted.value(...)`.
 */
export const resolveValue = (
  context: Pick<EvaluationContext, "inputs" | "readings">,
  ref: ValueRef
): string | undefined => {
  switch (ref.from) {
    case "parameter":
      return context.inputs.get(ref.name)?.text
    case "constant":
      return ref.text
    case "step":
      return context.readings.get(ref.step)
  }
}
