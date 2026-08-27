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
 * Four things now happen when a Checkpoint does not hold, and the order is the
 * semantic core of the system:
 *
 * ```
 *   expect  ->  declared Business Outcomes  ->  recovery  ->  hand off to a person
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
 * enforced in `engine.ts` — see `runCheckpoint` there, which is the single
 * expression the two lower rungs hang off.
 *
 * ## What `evaluate` turned out to be for
 *
 * This function ended up doing three jobs, and it is worth naming them because
 * they are the same job:
 *
 *   1. **Verifying a Step.** What it was written for.
 *   2. **Waiting out a slow load.** A bounded poll *is* patience. Ticket 06 looked
 *      at declaring a recoverable condition for lateness and did not, because it
 *      would have been a second mechanism for waiting sitting beside this one.
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
  type ValueRef,
  describeAssertion,
  describeBranch,
  toSurfaceTarget
} from "@cua/artifact"
import type {
  SurfaceAdapterService,
  SurfaceState,
  SurfaceUnavailable,
  Target,
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
 * Every Assertion `evaluate` may put to the screen: `expect`, and the `when` of
 * every declared outcome branch.
 *
 * This exists so the engine's `authorisedReader` can be given the whole set
 * rather than half of it. A `targetReads` sitting in an outcome branch reads a
 * live control exactly as one in `expect` does, and `evaluate` calls it through
 * the same `context.read`. Authorising only `expect` would leave that read
 * reaching the adapter with no `policy.check` in front of it and no deny path —
 * the same bypass ticket 07 closed at the Checkpoint boundary, reopened one
 * level in.
 *
 * **Keep this the definition of "what evaluation can look at".** If a later
 * ticket gives a Checkpoint a third place to hold Assertions, it goes here, and
 * the gate widens with it rather than being remembered separately.
 */
export const assertionsOf = (checkpoint: Checkpoint): ReadonlyArray<Assertion> => [
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
 * ## UNWRAP SITE 2 OF 2 (ticket 08)
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
 * The other unwrap is `scrubberFor` in `redaction.ts`.
 * `test/sensitive-data.test.ts` asserts the set is exactly these two.
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
