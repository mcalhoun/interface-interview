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
 * ## Seam for ticket 06 (recoverable conditions)
 *
 * A Checkpoint that does not hold within its bound returns `CheckpointOutcome`
 * with the state that defeated it. Ticket 06 inspects that state for a known
 * transient condition, does something bounded about it, and calls `evaluate`
 * again — re-evaluating rather than assuming the fix worked, which its checklist
 * requires. The return type already carries everything that needs.
 */

import { Effect } from "effect"
import {
  type Assertion,
  type Checkpoint,
  type ResolvedInputs,
  type ValueRef,
  describeAssertion,
  toSurfaceTarget
} from "@cua/artifact"
import type {
  SurfaceAdapterService,
  SurfaceState,
  SurfaceUnavailable,
  Target,
  TargetFailure
} from "@cua/surface"

/** How long a Checkpoint has to come true when the Artifact does not say. */
export const DEFAULT_CHECKPOINT_MILLIS = 5_000

const POLL_INTERVAL_MILLIS = 100

/** What earlier Steps read, keyed by the Step that read it. */
export type StepReadings = ReadonlyMap<string, string>

export type CheckpointOutcome =
  | { readonly held: true; readonly state: SurfaceState; readonly waitedMillis: number }
  | {
      readonly held: false
      readonly state: SurfaceState
      readonly waitedMillis: number
      /** The first assertion that did not hold, rendered as "expected ...". */
      readonly expected: string
      /** What was there instead. Never a stack trace. */
      readonly observed: string
    }

/**
 * All of the Surface a Checkpoint may touch by itself.
 *
 * Deliberately not `SurfaceAdapterService`. `observe` and `resolveTarget` are
 * perception: they look, and looking needs no permission. Everything in the
 * Action vocabulary is missing from this type on purpose, so a Checkpoint cannot
 * reach the adapter's acting methods even by accident — which matters because a
 * Checkpoint is the one part of Replay that is *about* touching the live system
 * without being a Step (ticket 07).
 */
export interface Perception {
  readonly observe: SurfaceAdapterService["observe"]
  readonly resolveTarget: SurfaceAdapterService["resolveTarget"]
}

export interface EvaluationContext {
  readonly surface: Perception
  /**
   * Reads a control's text, for a `targetReads` assertion.
   *
   * Supplied by the caller rather than taken off the adapter, because reading a
   * control *is* an `extract` and every `extract` passes Policy first. The engine
   * builds this function only after the gate has allowed every read the
   * Checkpoint declares, so a reader that exists is a reader that was permitted.
   * Nothing here can construct one.
   */
  readonly read: (target: Target) => Effect.Effect<string, TargetFailure>
  readonly inputs: ResolvedInputs
  readonly readings: StepReadings
}

/**
 * Polls until every assertion holds, or the Checkpoint's bound expires.
 *
 * Fails only when the Surface itself is unreachable. An assertion that does not
 * hold is a *value*, because "the state was not reached" is information the
 * caller acts on, not an exception it catches.
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
      let firstFailure: { expected: string; observed: string } | undefined

      for (const assertion of checkpoint.expect) {
        const observed = yield* check(context, assertion, state)
        if (observed !== undefined) {
          firstFailure = { expected: describeAssertion(assertion), observed }
          break
        }
      }

      const waitedMillis = Date.now() - startedAt
      if (firstFailure === undefined) return { held: true, state, waitedMillis }
      if (waitedMillis >= bound) {
        return { held: false, state, waitedMillis, ...firstFailure }
      }
      yield* Effect.sleep(POLL_INTERVAL_MILLIS)
    }
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
      return context.read(toSurfaceTarget(assertion.target)).pipe(
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
            failure.matches.map((match) => match.description).join(", ")
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
