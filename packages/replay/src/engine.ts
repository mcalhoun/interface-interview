/**
 * Deterministic Replay: running a Capability Artifact against a live Surface with
 * nothing deciding anything.
 *
 * ## The headline claim, and where it lives
 *
 * `replayCapability` returns
 * `Effect<ReplayResult, never, SurfaceAdapter | Policy | Evidence | Session>`.
 * Those four services and no others. A model is not reachable from here, and
 * that is not a convention — adding a `LanguageModel` call anywhere in this file
 * or anything it imports puts `LanguageModel` into that requirement set, and
 * `test/replay-has-no-model.test.ts` stops compiling. ADR-0003, and SPEC user
 * story 22.
 *
 * A README sentence, a runtime assertion, an unset environment variable: each of
 * those survives someone adding a model call six months from now. A type error
 * does not. This is the concrete payoff of choosing Effect.
 *
 * ## The other rule
 *
 * Determinism means no model in the loop, not no logic. This engine reads live
 * screens and matches against them. Given the same Artifact, the same inputs and
 * the same Surface it takes the same path and produces the same outputs, which
 * `test/replay-determinism.test.ts` demonstrates by running it twice and
 * comparing both the outputs and the Step sequence.
 *
 * ## Shape
 *
 * The internal error channel carries `ReplayFailure`, the schema value, rather
 * than exceptions. Everything a run can go wrong with is a member of that union,
 * and the outer boundary folds it into the `failure` class of `ReplayResult`. So
 * the public signature has `never` in its error channel: every outcome is a value
 * the caller branches on, which is the entire point of the result contract.
 *
 * ## Business Outcomes are not in that channel
 *
 * A Step whose Checkpoint reaches a declared Business Outcome ends the run, and
 * it would be trivial to end it by failing with a signal value and folding that
 * at the boundary. It is deliberately not done that way. `runStep` *returns* the
 * outcome it reached, so a legitimate domain answer never travels through an
 * error channel at any point in its life, not even briefly and internally.
 *
 * That matters because the brief names confusing a domain answer for a failure as
 * the most common design mistake in this problem, and every mechanism that makes
 * the mistake easy is one that lets an outcome share a road with a fault: a
 * `catch` written for `SurfaceUnavailable` catches it too, a log line that prints
 * the error channel prints it, an exit code derived from "did the effect fail"
 * reports it. Keeping it on the success channel means none of those can happen by
 * accident, and the type of `runStep` says so.
 */

import { Effect, Result } from "effect"
import {
  type CapabilityArtifact,
  type Checkpoint,
  type OutputValue,
  type ResolvedInputs,
  type Step,
  type ValueRef,
  capabilityRef,
  declaredOutcome,
  describeValueRef,
  parseOutput,
  toSurfaceTarget
} from "@cua/artifact"
import { Evidence, type EvidenceUnwritable } from "@cua/evidence"
import { type ActionRequest, Policy } from "@cua/policy"
import { Session } from "@cua/session"
import {
  type SurfaceAdapterService,
  type TargetFailure,
  SurfaceAdapter,
  describeTarget
} from "@cua/surface"
import { type CheckpointOutcome, type StepReadings, evaluate, resolveValue } from "./checkpoint.ts"
import type { ReplayFailure, ReplayFailureBody, ReplayResult, StepRecord } from "./ReplayResult.ts"
import { describeResult } from "./ReplayResult.ts"

export interface ReplayRequest {
  readonly artifact: CapabilityArtifact
  /**
   * Already validated. `prepareInputs` is a pure `Result` and is called before
   * the Surface Layer is provided, so a bad call never opens a browser.
   */
  readonly inputs: ResolvedInputs
  /**
   * The Tenant's installation. Deliberately not in the Artifact: which
   * institution this runs against is environment, so one vendor-level Capability
   * serves all of them, and Policy has an origin to check rather than one baked
   * into a document nobody re-reads.
   */
  readonly baseUrl: string
  readonly runId: string
}

/** Runs one Capability Artifact end to end. Read the return type as a specification. */
export const replayCapability = (
  request: ReplayRequest
): Effect.Effect<ReplayResult, never, SurfaceAdapter | Policy | Evidence | Session> =>
  Effect.gen(function* () {
    const surface = yield* SurfaceAdapter
    const policy = yield* Policy
    const evidence = yield* Evidence
    const session = yield* Session

    const { artifact, baseUrl, inputs, runId } = request
    const startedAt = Date.now()
    const steps: Array<StepRecord> = []
    const readings = new Map<string, string>()

    /** The half of a result that is the same whatever class it turns out to be. */
    const common = {
      capability: artifact.capability,
      version: artifact.version,
      runId,
      sessionId: session.id,
      evidenceDirectory: evidence.directory
    }

    // -----------------------------------------------------------------------
    // The chokepoint
    // -----------------------------------------------------------------------

    /**
     * The one place a Surface Action is allowed to happen.
     *
     * Session guard, then Policy, then the Action — in that order, because asking
     * permission of a system you do not control is not asking permission. Every
     * Action in this engine goes through here; nothing calls the adapter's
     * `navigate`, `click`, `fill` or `extract` anywhere else, and
     * `test/replay-has-no-model.test.ts` counts the call sites to keep it that way.
     */
    const authorised = <A>(
      step: Step,
      subject: string,
      act: (surface: SurfaceAdapterService) => Effect.Effect<A, ReplayFailure>
    ): Effect.Effect<A, ReplayFailure | EvidenceUnwritable> =>
      Effect.gen(function* () {
        const at = { stepId: step.id, stepIntent: step.intent }

        yield* session.claim(`${step.action.type} ${subject}`).pipe(
          Effect.catch((lost) =>
            Effect.fail<ReplayFailure>({
              reason: "control_lost",
              ...at,
              expected: "automation to hold the session",
              observed: `control belongs to ${lost.owner}`,
              owner: lost.owner
            })
          )
        )

        const proposal: ActionRequest = {
          type: step.action.type,
          subject,
          stepId: step.id,
          mode: "replay"
        }
        const verdict = yield* policy.authorise(proposal)
        yield* evidence.record({
          kind: "policy.check",
          stepId: step.id,
          action: proposal.type,
          subject,
          verdict: verdict.verdict,
          reason: verdict.reason
        })
        if (verdict.verdict === "deny") {
          return yield* Effect.fail<ReplayFailure>({
            reason: "policy_violation",
            ...at,
            expected: `policy to permit ${proposal.type}`,
            observed: verdict.reason,
            action: proposal.type,
            subject
          })
        }

        return yield* act(surface)
      })

    // -----------------------------------------------------------------------
    // One step
    // -----------------------------------------------------------------------

    /**
     * Runs one Step. Returns the Business Outcome it reached, if it reached one.
     *
     * `ReachedOutcome | undefined` on the *success* channel is the shape that
     * keeps a domain answer off the same road as a fault. See the module note.
     */
    const runStep = (
      step: Step
    ): Effect.Effect<ReachedOutcome | undefined, ReplayFailure | EvidenceUnwritable> =>
      Effect.gen(function* () {
        const fail = failing(step)

        // What the Surface looked like going in. In Discovery this is the state a
        // model decided against; recording it in both modes is what lets the two
        // logs be read side by side.
        const before = yield* surface.observe.pipe(
          Effect.catch((unavailable) =>
            Effect.fail(
              fail({
                reason: "surface_failed",
                expected: "to be able to observe the surface",
                observed: unavailable.reason
              })
            )
          )
        )
        yield* evidence.record({
          kind: "observe",
          stepId: step.id,
          url: before.url,
          title: before.title,
          frames: before.frames.map((frame) => frame.name),
          accessibility: before.accessibility
        })

        const read = yield* performAction(step, before.url)
        if (read !== undefined) readings.set(step.id, read)

        const outcome = yield* evaluate({ surface, inputs, readings }, step.checkpoint).pipe(
          Effect.catch((unavailable) =>
            Effect.fail(
              fail({
                reason: "surface_failed",
                expected: `to verify: ${step.checkpoint.description}`,
                observed: unavailable.reason
              })
            )
          )
        )

        yield* evidence.record({
          kind: "checkpoint",
          stepId: step.id,
          description: step.checkpoint.description,
          verdict: outcome.verdict,
          ...describeVerdict(step.checkpoint, outcome),
          waitedMillis: outcome.waitedMillis
        })

        steps.push({
          id: step.id,
          intent: step.intent,
          action: step.action.type,
          checkpoint: outcome.verdict,
          ...(read === undefined ? {} : { read })
        })

        if (outcome.verdict === "outcome") {
          // Not a failure, and so not a `fail`. The declaration is what supplies
          // the caller-facing wording; the engine only knows the code.
          const declaration = declaredOutcome(artifact, outcome.code)
          return {
            code: outcome.code,
            detail: declaration?.title ?? `the capability reached ${outcome.code}`,
            stepId: step.id,
            because: outcome.because
          }
        }

        if (outcome.verdict === "failed") {
          return yield* Effect.fail(
            fail({
              reason: "checkpoint_failed",
              expected: outcome.expected,
              observed: outcome.observed,
              checkpoint: step.checkpoint.description,
              waitedMillis: outcome.waitedMillis,
              accessibility: outcome.state.accessibility,
              url: outcome.state.url
            })
          )
        }

        return undefined
      })

    /**
     * Carries out one Action and returns what it read, if it read anything.
     *
     * A Target is resolved inside the same authorisation as the Action that uses
     * it, so a resolution can never be reused across a policy decision. It also
     * gives the `action` Evidence event the reasoning that actually picked the
     * control, next to the strategy the Artifact declared for it — a Target that
     * starts resolving for a different reason than the recorded one is then
     * visible in the record rather than silently fine.
     */
    const performAction = (
      step: Step,
      url: string
    ): Effect.Effect<string | undefined, ReplayFailure | EvidenceUnwritable> =>
      Effect.gen(function* () {
        const action = step.action
        const fail = failing(step)

        if (action.type === "navigate") {
          const path = resolveValue({ inputs, readings }, action.path)
          if (path === undefined) return yield* Effect.fail(unresolvable(fail, action.path))
          const destination = new URL(path, baseUrl).toString()
          yield* authorised(step, destination, (surface) =>
            surface.navigate(destination).pipe(
              Effect.catch((unavailable) =>
                Effect.fail(
                  fail({
                    reason: "surface_failed",
                    expected: `to open ${destination}`,
                    observed: unavailable.reason
                  })
                )
              )
            )
          )
          yield* evidence.record({
            kind: "action",
            stepId: step.id,
            action: "navigate",
            target: destination
          })
          return undefined
        }

        const surfaceTarget = toSurfaceTarget(action.target)
        const described = describeTarget(surfaceTarget)
        const onTargetFailure = targetFailed(fail, action.type, described, url)

        const outcome = yield* authorised(step, described, (surface) =>
          Effect.gen(function* () {
            const resolution = yield* surface
              .resolveTarget(surfaceTarget)
              .pipe(Effect.catch(onTargetFailure))

            switch (action.type) {
              case "fill": {
                const value = resolveValue({ inputs, readings }, action.value)
                if (value === undefined) {
                  return yield* Effect.fail(unresolvable(fail, action.value))
                }
                yield* surface.fill(surfaceTarget, value).pipe(Effect.catch(onTargetFailure))
                return { resolution, read: undefined }
              }
              case "click":
                yield* surface.click(surfaceTarget).pipe(Effect.catch(onTargetFailure))
                return { resolution, read: undefined }
              case "extract": {
                const read = yield* surface
                  .extract(surfaceTarget)
                  .pipe(Effect.catch(onTargetFailure))
                return { resolution, read }
              }
            }
          })
        )

        yield* evidence.record({
          kind: "action",
          stepId: step.id,
          action: action.type,
          target: described,
          declaredStrategy: action.target.strategy,
          resolvedBy: outcome.resolution.strategies,
          rationale: outcome.resolution.rationale
        })

        return outcome.read
      })

    /** Builds the declared outputs from what the Steps read. */
    const collectOutputs = Effect.gen(function* () {
      const outputs: Record<string, OutputValue> = {}
      for (const [name, declaration] of Object.entries(artifact.outputs)) {
        const at = {
          stepId: declaration.from.step,
          stepIntent: `provide the declared output ${name}`
        }
        const read = readings.get(declaration.from.step)
        if (read === undefined) {
          return yield* Effect.fail<ReplayFailure>({
            reason: "output_unreadable",
            ...at,
            expected: `step ${declaration.from.step} to have read something`,
            observed: "it read nothing",
            output: name
          })
        }
        const parsed = parseOutput(name, declaration, read)
        if (Result.isFailure(parsed)) {
          return yield* Effect.fail<ReplayFailure>({
            reason: "output_unreadable",
            ...at,
            expected: parsed.failure.expected,
            observed: parsed.failure.observed,
            output: name
          })
        }
        outputs[name] = parsed.success
      }
      return outputs
    })

    // -----------------------------------------------------------------------
    // The run
    // -----------------------------------------------------------------------

    const body = Effect.gen(function* () {
      yield* evidence.record({
        kind: "run.start",
        mode: "replay",
        capability: artifact.capability,
        version: artifact.version,
        baseUrl,
        inputs: [...inputs.values()].map((input) => ({
          name: input.name,
          sensitive: input.sensitive
        }))
      })

      for (const [index, step] of artifact.steps.entries()) {
        const reached = yield* runStep(step)
        if (reached === undefined) continue

        // The application answered, and the answer is part of its domain. The run
        // stops here and stops *successfully*: no failure is constructed, none is
        // recorded, and the remaining Steps are reported as never attempted rather
        // than as having gone wrong.
        for (const skipped of artifact.steps.slice(index + 1)) {
          steps.push({
            id: skipped.id,
            intent: skipped.intent,
            action: skipped.action.type,
            checkpoint: "not_reached"
          })
        }

        yield* evidence.record({
          kind: "outcome",
          stepId: reached.stepId,
          code: reached.code,
          detail: reached.detail,
          matched: reached.because
        })

        return {
          result: "business_outcome",
          ...common,
          steps,
          code: reached.code,
          detail: reached.detail
        } satisfies ReplayResult
      }

      const outputs = yield* collectOutputs
      yield* evidence.record({
        kind: "outcome",
        code: "SUCCESS",
        detail: `${capabilityRef(artifact)} produced ${Object.keys(outputs).join(", ")}`
      })
      return { result: "success", ...common, steps, outputs } satisfies ReplayResult
    })

    const result: ReplayResult = yield* body.pipe(
      Effect.catch((problem) =>
        Effect.succeed<ReplayResult>({
          result: "failure",
          ...common,
          steps,
          failure: isEvidenceProblem(problem)
            ? {
                reason: "evidence_failed",
                stepId: steps.at(-1)?.id ?? "run",
                stepIntent: "record what happened",
                expected: "the run to be auditable",
                observed: problem.reason,
                path: problem.path
              }
            : problem
        })
      )
    )

    yield* finalise(surface, evidence, result, startedAt)
    return result
  })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A declared Business Outcome, reached at a Step.
 *
 * Not a `ReplayFailure` and not shaped like one. It has no `expected`/`observed`
 * pair because nothing went wrong: `because` says what was observed, and there is
 * nothing it was observed *instead of* that anyone needs to be told about.
 */
interface ReachedOutcome {
  readonly code: string
  /** The caller-facing sentence, from the Artifact's declaration of this code. */
  readonly detail: string
  readonly stepId: string
  /** The branch conditions that held, in the Artifact's words. */
  readonly because: string
}

/**
 * The `expected` / `observed` pair for a Checkpoint's Evidence event.
 *
 * Written so that reading the log tells the three verdicts apart without knowing
 * the schema: an outcome says the application answered, and says with what.
 */
const describeVerdict = (
  checkpoint: Checkpoint,
  outcome: CheckpointOutcome
): { readonly expected: string; readonly observed: string } => {
  switch (outcome.verdict) {
    case "held":
      return {
        expected: checkpoint.description,
        observed: "the intended state was reached"
      }
    case "outcome":
      return {
        expected: checkpoint.description,
        observed: `the declared outcome ${outcome.code} was reached instead, on branch ${outcome.branch}: ${outcome.because}`
      }
    case "failed":
      return { expected: outcome.expected, observed: outcome.observed }
  }
}

/** Attaches the Step a failure happened in, so no failure can omit it. */
const failing =
  (step: Step) =>
  (body: ReplayFailureBody): ReplayFailure =>
    ({ ...body, stepId: step.id, stepIntent: step.intent }) as ReplayFailure

/** A Target failure, said in the result contract's words rather than the adapter's. */
const targetFailed =
  (
    fail: (body: ReplayFailureBody) => ReplayFailure,
    action: string,
    target: string,
    url: string
  ) =>
  (problem: TargetFailure): Effect.Effect<never, ReplayFailure> => {
    switch (problem._tag) {
      case "TargetAmbiguous":
        // Never a coin flip. Every candidate is listed, because "which one did it
        // mean" is the only useful question at that point (SPEC user story 28).
        return Effect.fail(
          fail({
            reason: "target_ambiguous",
            expected: `exactly one ${target}`,
            observed: `${problem.matches.length} controls matched: ${
              problem.matches.map((match) => match.description).join(", ")
            }`,
            target,
            candidates: problem.matches.map((match) => match.description),
            url
          })
        )
      case "TargetNotFound":
        return Effect.fail(
          fail({
            reason: "target_missing",
            expected: `a control matching ${target}`,
            observed: problem.rationale,
            target,
            url
          })
        )
      case "SurfaceUnavailable":
        return Effect.fail(
          fail({
            reason: "surface_failed",
            expected: `to ${action} ${target}`,
            observed: problem.reason
          })
        )
    }
  }

/**
 * The last thing every run does, whatever became of it: a final observation, a
 * final screenshot, and `run.end`.
 *
 * A screenshot that cannot be taken does not change the verdict — SPEC user story
 * 65 wants it for debugging, and a failed run whose result flipped because the
 * camera jammed would be worse than one with no picture. Evidence that cannot be
 * written *does* change the verdict, which is why the failure above is folded
 * into the result rather than swallowed.
 */
const finalise = (
  surface: SurfaceAdapterService,
  evidence: Evidence["Service"],
  result: ReplayResult,
  startedAt: number
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* surface.captureEvidence.pipe(
      Effect.flatMap((captured) =>
        evidence
          .record({
            kind: "observe",
            url: captured.state.url,
            title: captured.state.title,
            frames: captured.state.frames.map((frame) => frame.name),
            accessibility: captured.state.accessibility
          })
          .pipe(Effect.flatMap(() => evidence.attach("final.png", captured.screenshot)))
      ),
      Effect.ignore
    )

    yield* evidence
      .record({
        kind: "run.end",
        result: result.result,
        summary: describeResult(result),
        durationMillis: Date.now() - startedAt
      })
      .pipe(Effect.ignore)
  })

const isEvidenceProblem = (
  problem: ReplayFailure | EvidenceUnwritable
): problem is EvidenceUnwritable => "_tag" in problem && problem._tag === "EvidenceUnwritable"

const unresolvable = (
  fail: (body: ReplayFailureBody) => ReplayFailure,
  ref: ValueRef
): ReplayFailure =>
  fail({
    reason: "artifact_unexecutable",
    expected: `a value for ${describeValueRef(ref)}`,
    observed: "this run has no such value"
  })

export type { StepReadings }
