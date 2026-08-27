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
 * ## The human rung
 *
 * A Checkpoint that does not hold is not always the automation being broken.
 * Sometimes the application has correctly refused, and getting past it needs
 * authority rather than perception. When an Operator is reachable, this engine
 * stops there, hands them the live Session, and waits (`handOff` below).
 *
 * Resuming re-asks the **Checkpoint**, never the Action. The Action already
 * happened; what failed is the state it was supposed to produce, and a person has
 * just changed that state by hand. Re-running the Action would at best be
 * redundant and at worst irreversible — clicking a link that is no longer on the
 * screen the Operator left behind. `evaluate` is idempotent, so asking again
 * costs nothing and assumes nothing about what they did.
 *
 * That is also what "resumes from the paused step" means concretely: the fiber
 * never unwound. Every reading taken before the pause is still in hand, the
 * Steps before it do not run again, and the Steps after it run exactly once.
 */

import { Effect, Result } from "effect"
import {
  type CapabilityArtifact,
  type OutputValue,
  type ResolvedInputs,
  type Step,
  type ValueRef,
  capabilityRef,
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

    const runStep = (step: Step): Effect.Effect<void, StepProblem> =>
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

        // The same evaluation, available twice: once now, and once after an
        // Operator has been in the session. It is idempotent, so re-asking is how
        // the run finds out what they did rather than being told.
        const verify = evaluate({ surface, inputs, readings }, step.checkpoint).pipe(
          Effect.catch((unavailable) =>
            Effect.fail<StepProblem>(
              fail({
                reason: "surface_failed",
                expected: `to verify: ${step.checkpoint.description}`,
                observed: unavailable.reason
              })
            )
          ),
          Effect.tap((outcome) =>
            evidence.record({
              kind: "checkpoint",
              stepId: step.id,
              description: step.checkpoint.description,
              verdict: outcome.held ? "held" : "failed",
              expected: outcome.held ? step.checkpoint.description : outcome.expected,
              observed: outcome.held ? "the intended state was reached" : outcome.observed,
              waitedMillis: outcome.waitedMillis
            })
          )
        )

        let outcome = yield* verify
        let escalation: Escalated | undefined

        if (!outcome.held) {
          // The Recovery Ladder's human rung. Everything above it — waiting,
          // retrying, matching harder — has already had its turn by the time a
          // Checkpoint has spent its whole bound and still does not hold.
          const handed = yield* handOff(step, outcome)
          if (handed.resumed) {
            outcome = yield* verify
            if (!outcome.held) {
              // They said they had resolved it and the screen disagrees. Not a
              // failure of the automation, and not something to escalate a
              // second time: report it and let a person read the record.
              escalation = escalated(
                step,
                outcome,
                `control was returned as resolved, but ${outcome.expected} is still not true`
              )
            }
          } else {
            escalation = handed.escalation
          }
        }

        steps.push({
          id: step.id,
          intent: step.intent,
          action: step.action.type,
          checkpoint: outcome.held ? "held" : "failed",
          ...(read === undefined ? {} : { read })
        })

        if (outcome.held) return
        return yield* Effect.fail<StepProblem>(
          escalation ??
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
      })

    /**
     * Hand the live Session to a person, and wait.
     *
     * Asking `handoffAvailable` first is the whole difference between an
     * Intervention and a Hard Failure. A Checkpoint that will not hold on an
     * unattended run has nobody to resolve it, and returning
     * `intervention_required` into an empty room would name a person as
     * responsible for a run no person can see. So an unattended run reports the
     * Hard Failure it always did, and only a run with an Operator reachable stops
     * and asks.
     *
     * ## Seam
     *
     * Only a failed Checkpoint escalates today, because it is the case where the
     * Action landed and the resulting *state* is the problem — which is exactly
     * what a person can change by hand. Ticket 05 routes a Target that matched
     * nothing into the same rung; note that its resume semantics differ, because
     * there the Action never ran and re-asking the Checkpoint would prove
     * nothing. That branch re-attempts the Step.
     */
    const handOff = (
      step: Step,
      outcome: Extract<CheckpointOutcome, { held: false }>
    ): Effect.Effect<
      { readonly resumed: boolean; readonly escalation: Escalated | undefined },
      EvidenceUnwritable
    > =>
      Effect.gen(function* () {
        if (!(yield* session.handoffAvailable)) {
          return { resumed: false, escalation: undefined }
        }

        const episode = yield* session.pause({
          capability: artifact.capability,
          version: artifact.version,
          runId,
          stepId: step.id,
          stepIntent: step.intent,
          reason: `the checkpoint "${step.checkpoint.description}" did not hold`,
          detail: `expected ${outcome.expected}; observed ${outcome.observed}`,
          url: outcome.state.url,
          accessibility: outcome.state.accessibility
        })

        return episode.resumed
          ? { resumed: true, escalation: undefined }
          : { resumed: false, escalation: escalated(step, outcome, episode.reason) }
      })

    const escalated = (
      step: Step,
      outcome: Extract<CheckpointOutcome, { held: false }>,
      reason: string
    ): Escalated => ({
      _tag: "Escalated",
      reason: `${step.checkpoint.description}: ${reason}`,
      stepId: step.id,
      accessibility: outcome.state.accessibility
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
        Effect.succeed<ReplayResult>(
          isEscalation(problem)
            ? {
                result: "intervention_required",
                ...common,
                steps,
                reason: problem.reason,
                stepId: problem.stepId,
                accessibility: problem.accessibility
              }
            : {
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
              }
        )
      )
    )

    yield* finalise(surface, evidence, result, startedAt)
    return result
  })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A Step stopped because a person is needed, not because anything is broken.
 *
 * Internal, and carried in the same error channel as a `ReplayFailure` purely so
 * that one Step abandoning the run short-circuits the loop. The boundary turns it
 * into the `intervention_required` class, which is a *result* — a run that ends
 * this way reports no failure anywhere, exactly as a Business Outcome does.
 *
 * It is not a member of `ReplayFailure` for that reason. Putting it there would
 * make "an Intervention is a kind of failure" true in the type that the result
 * contract exists to keep it false in.
 */
interface Escalated {
  readonly _tag: "Escalated"
  /** Why the run is not continuing, in a sentence a caller can be given. */
  readonly reason: string
  readonly stepId: string
  /** What the screen showed when it stopped, so an Operator has context. */
  readonly accessibility: string
}

/** Everything one Step can stop for. */
type StepProblem = ReplayFailure | EvidenceUnwritable | Escalated

const isEscalation = (problem: StepProblem): problem is Escalated =>
  "_tag" in problem && problem._tag === "Escalated"

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
