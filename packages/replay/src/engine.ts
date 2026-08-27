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
 */

import { Effect, Ref, Result } from "effect"
import {
  type Action,
  type Assertion,
  type CapabilityArtifact,
  type OutputValue,
  type ResolvedInputs,
  type Step,
  type ValueRef,
  capabilityRef,
  describeValueRef,
  parseOutput,
  recoverableConditions,
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
import {
  type RecoveryOutcome,
  type RecoveryPort,
  type RemedyReport,
  RECOVERY_BUDGET_PER_RUN,
  recover
} from "./recovery.ts"
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
    const conditions = recoverableConditions(artifact)
    /** Shared across every Step, so a whole flow cannot retry itself forever. */
    const budget = yield* Ref.make(RECOVERY_BUDGET_PER_RUN)

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

    const runStep = (step: Step): Effect.Effect<void, ReplayFailure | EvidenceUnwritable> =>
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

        const read = yield* performAction(step, step.action, before.url)
        if (read !== undefined) readings.set(step.id, read)

        const verify = evaluate({ surface, inputs, readings }, step.checkpoint).pipe(
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

        const recordVerdict = (result: CheckpointOutcome) =>
          evidence.record({
            kind: "checkpoint",
            stepId: step.id,
            description: step.checkpoint.description,
            verdict: result.held ? "held" : "failed",
            expected: result.held ? step.checkpoint.description : result.expected,
            observed: result.held ? "the intended state was reached" : result.observed,
            waitedMillis: result.waitedMillis
          })

        const first = yield* verify
        yield* recordVerdict(first)

        // A Checkpoint that did not hold is where a Recoverable Condition gets its
        // chance, and the *only* place: recovery reads the state that defeated the
        // Checkpoint, and re-evaluating that same Checkpoint is how it finds out
        // whether it worked. Nothing here believes the remedy on its own account.
        //
        // ORDER, when tickets 04 and 12 merge into this block. It is:
        //
        //     expect  ->  declared Business Outcomes  ->  recovery  ->  hand off
        //
        // Business Outcomes go *above* recovery, not below. A declared outcome is
        // the application answering, and an answer is not a condition to get past:
        // a recovery rule whose `detect` happened to also match the
        // member-not-found screen would spend the run's whole budget retrying a
        // question that was already answered, and report a Hard Failure for a run
        // that succeeded. Recovery earns its place only once nothing declared
        // explains the screen.
        //
        // Handing off goes below recovery, for the mirror-image reason: waking a
        // person for a state the system can get past on its own is what the
        // recovery ladder exists to avoid.
        const attemptRecovery: Effect.Effect<
          RecoveryOutcome,
          ReplayFailure | EvidenceUnwritable
        > = first.held
          ? Effect.succeed<RecoveryOutcome>({ attempted: false })
          : recover({
              conditions,
              checkpoint: step.checkpoint.description,
              failed: first,
              budget,
              port: recoveryPort(step, before.url)
            }).pipe(
              Effect.catch(
                (
                  problem
                ): Effect.Effect<never, ReplayFailure | EvidenceUnwritable> =>
                  isEvidenceProblem(problem)
                    ? Effect.fail(problem)
                    : Effect.fail(
                        fail({
                          reason: "surface_failed",
                          expected: `to recover: ${step.checkpoint.description}`,
                          observed: problem.reason
                        })
                      )
              )
            )
        const recovery = yield* attemptRecovery

        const outcome = recovery.attempted ? recovery.outcome : first
        if (recovery.attempted) yield* recordVerdict(outcome)

        const readAfter = readings.get(step.id)
        steps.push({
          id: step.id,
          intent: step.intent,
          action: step.action.type,
          checkpoint: outcome.held ? "held" : "failed",
          ...(readAfter === undefined ? {} : { read: readAfter }),
          ...(recovery.attempted && outcome.held
            ? { recovered: recovery.condition.condition }
            : {})
        })

        if (outcome.held) return

        // A condition that was recognised and would not clear is a different
        // problem from a Checkpoint that never matched anything known, and the two
        // are reported as such. SPEC: past its bound it stops being recoverable.
        return yield* Effect.fail(
          recovery.attempted
            ? fail({
                reason: "recovery_exhausted",
                expected: outcome.expected,
                observed: `${outcome.observed}; ${recovery.condition.condition} did not clear after ${recovery.attempts} attempt(s)`,
                condition: recovery.condition.condition,
                checkpoint: step.checkpoint.description,
                attempts: recovery.attempts,
                waitedMillis: outcome.waitedMillis,
                accessibility: outcome.state.accessibility,
                url: outcome.state.url
              })
            : fail({
                reason: "checkpoint_failed",
                expected: outcome.expected,
                observed: outcome.observed,
                checkpoint: step.checkpoint.description,
                waitedMillis: outcome.waitedMillis,
                accessibility: outcome.state.accessibility,
                url: outcome.state.url
              })
        )
      })

    // -----------------------------------------------------------------------
    // Recovery, wired to the same chokepoint everything else goes through
    // -----------------------------------------------------------------------

    /**
     * The closures `recover` is allowed to have.
     *
     * A remedy's Actions run through `performAction`, which runs through
     * `authorised`, which is Session guard then Policy then act. Recovery is not a
     * privileged path, and the way that is kept true is that `recovery.ts` imports
     * no adapter — there is nowhere in it to put a `click`.
     */
    const recoveryPort = (step: Step, beforeUrl: string): RecoveryPort => {
      const attempt = (
        action: Action,
        what: string,
        bindReading: boolean
      ): Effect.Effect<RemedyReport, EvidenceUnwritable> =>
        performAction(step, action, beforeUrl).pipe(
          Effect.flatMap((read) =>
            Effect.sync((): RemedyReport => {
              if (bindReading && read !== undefined) readings.set(step.id, read)
              return { done: true, what }
            })
          ),
          Effect.catch((problem) =>
            isEvidenceProblem(problem)
              ? Effect.fail(problem)
              : Effect.succeed<RemedyReport>({ done: false, what, why: problem.observed })
          )
        )

      return {
        perform: (remedy) => attempt(remedy.action, remedy.intent, false),

        /**
         * Put the run back where this Step began, then attempt the Step again.
         *
         * The location came from the observation this Step made before it acted,
         * so "where the step began" is a fact the run recorded rather than one it
         * reconstructs. Going back there is an ordinary navigation and is
         * Policy-checked as one. Before the first Step there is nowhere to go
         * back to — `about:blank` is not a place — so that case re-attempts the
         * Action alone.
         */
        resumeAtStep: Effect.gen(function* () {
          const reports: Array<RemedyReport> = []
          let repositioned = true
          if (/^https?:/i.test(beforeUrl)) {
            const back = yield* attempt(
              { type: "navigate", path: { from: "constant", text: beforeUrl } },
              `return to ${beforeUrl}, where this step began`,
              false
            )
            reports.push(back)
            repositioned = back.done
          }
          // No point attempting the Step from somewhere it was never meant to run.
          if (repositioned) {
            reports.push(yield* attempt(step.action, `attempt the step again: ${step.intent}`, true))
          }
          return reports
        }),

        recheck: evaluate({ surface, inputs, readings }, step.checkpoint),

        detected: (assertions: ReadonlyArray<Assertion>) =>
          evaluate(
            { surface, inputs, readings },
            {
              description: "the screen matches a declared recoverable condition",
              expect: assertions,
              // One look. Detection asks what is on screen now; waiting for a
              // condition to appear would be waiting for trouble.
              withinMillis: 0
            }
          ).pipe(Effect.map((result) => result.held)),

        // Stamped with the Step being recovered, so the `recovery.*` events sit
        // in the log beside the `checkpoint` they answer rather than floating at
        // run level. SPEC user story 63: the records have to join up.
        record: (body) => evidence.record({ stepId: step.id, ...body })
      }
    }

    /**
     * Carries out one Action and returns what it read, if it read anything.
     *
     * A Target is resolved inside the same authorisation as the Action that uses
     * it, so a resolution can never be reused across a policy decision. It also
     * gives the `action` Evidence event the reasoning that actually picked the
     * control, next to the strategy the Artifact declared for it — a Target that
     * starts resolving for a different reason than the recorded one is then
     * visible in the record rather than silently fine.
     *
     * The Action is a parameter rather than being read off the Step, because a
     * Recoverable Condition's remedy is a list of Actions that has to reach the
     * Surface through this same function and therefore through the same
     * authorisation. A remedy that had its own path to the browser would be a
     * second chokepoint, which is the same as none.
     */
    const performAction = (
      step: Step,
      action: Action,
      url: string
    ): Effect.Effect<string | undefined, ReplayFailure | EvidenceUnwritable> =>
      Effect.gen(function* () {
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

      for (const step of artifact.steps) yield* runStep(step)

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

const isEvidenceProblem = (problem: unknown): problem is EvidenceUnwritable =>
  typeof problem === "object" &&
  problem !== null &&
  "_tag" in problem &&
  (problem as { _tag: unknown })._tag === "EvidenceUnwritable"

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
