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
  type Target as SurfaceTarget,
  type TargetFailure,
  SurfaceAdapter,
  describeTarget
} from "@cua/surface"
import { type StepReadings, evaluate, resolveValue } from "./checkpoint.ts"
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
     *
     * `page` is the URL the run is on when it asks. Policy checks every Action
     * against the origin it happens *on*, and a navigation additionally against
     * where it goes; without the first half, a click that followed a link
     * off-allowlist would leave everything after it unchecked (ticket 07).
     */
    const authorised = <A>(
      step: Step,
      type: string,
      subject: string,
      page: string | undefined,
      act: (surface: SurfaceAdapterService) => Effect.Effect<A, ReplayFailure>
    ): Effect.Effect<A, ReplayFailure | EvidenceUnwritable> =>
      Effect.gen(function* () {
        const at = { stepId: step.id, stepIntent: step.intent }

        yield* session.claim(`${type} ${subject}`).pipe(
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
          type,
          subject,
          stepId: step.id,
          mode: "replay",
          ...(page === undefined ? {} : { page })
        }
        const verdict = yield* policy.authorise(proposal)
        yield* evidence.record({
          kind: "policy.check",
          stepId: step.id,
          action: proposal.type,
          subject,
          verdict: verdict.verdict,
          reason: verdict.reason,
          policy: verdict.policy,
          risk: verdict.risk,
          ...(verdict.origin === undefined ? {} : { origin: verdict.origin })
        })
        if (verdict.verdict === "deny") {
          return yield* Effect.fail<ReplayFailure>({
            reason: "policy_violation",
            ...at,
            expected: `policy ${verdict.policy} to permit ${proposal.type}`,
            observed: verdict.reason,
            action: proposal.type,
            subject
          })
        }

        return yield* act(surface)
      })

    /**
     * Authorises every read a Checkpoint declares, then hands back the reader.
     *
     * A `targetReads` assertion reads a live control, which is an `extract` by
     * any other name, and an `extract` the Policy engine never saw would be a
     * second path to the adapter — the one thing a chokepoint cannot have. So the
     * reads are put through the same gate the Step's own Action went through, and
     * the function that performs them does not exist until the gate has allowed
     * them all. `EvaluationContext` takes only `observe` and `resolveTarget` off
     * the adapter, so Checkpoint evaluation has no way to construct one itself.
     *
     * Authorisation is per Checkpoint rather than per poll: evaluation retries the
     * same read it was permitted, and asking again on every hundred-millisecond
     * tick would bury the record under duplicates without deciding anything new.
     *
     * **The invariant to keep.** Every assertion kind that calls `read` must be
     * one this loop authorises. Today that is `targetReads` and only `targetReads`.
     * A later ticket adding an assertion that reads a control has to add it here
     * as well, or that read reaches the adapter unjudged.
     */
    const authorisedReader = (
      step: Step,
      page: string
    ): Effect.Effect<
      (target: SurfaceTarget) => Effect.Effect<string, TargetFailure>,
      ReplayFailure | EvidenceUnwritable
    > =>
      Effect.gen(function* () {
        for (const assertion of step.checkpoint.expect) {
          if (assertion.assert !== "targetReads") continue
          const target = toSurfaceTarget(assertion.target)
          yield* authorised(step, "extract", describeTarget(target), page, () =>
            Effect.succeed(undefined)
          )
        }
        return (target: SurfaceTarget) => surface.extract(target)
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

        const performed = yield* performAction(step, before.url)
        if (performed.read !== undefined) readings.set(step.id, performed.read)
        const read = performed.read

        // Authorised against wherever the Action left the run, not where it
        // started: a click that followed a link off the allowlist is exactly the
        // case this is here to catch.
        const readTarget = yield* authorisedReader(step, performed.url)

        const outcome = yield* evaluate(
          { surface, inputs, readings, read: readTarget },
          step.checkpoint
        ).pipe(
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
          verdict: outcome.held ? "held" : "failed",
          expected: outcome.held ? step.checkpoint.description : outcome.expected,
          observed: outcome.held ? "the intended state was reached" : outcome.observed,
          waitedMillis: outcome.waitedMillis
        })

        steps.push({
          id: step.id,
          intent: step.intent,
          action: step.action.type,
          checkpoint: outcome.held ? "held" : "failed",
          ...(read === undefined ? {} : { read })
        })

        if (!outcome.held) {
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
      })

    /**
     * Carries out one Action, and reports what it read and where it left the run.
     *
     * A Target is resolved inside the same authorisation as the Action that uses
     * it, so a resolution can never be reused across a policy decision. It also
     * gives the `action` Evidence event the reasoning that actually picked the
     * control, next to the strategy the Artifact declared for it — a Target that
     * starts resolving for a different reason than the recorded one is then
     * visible in the record rather than silently fine.
     *
     * The `url` it returns is the adapter's own report of where the Surface ended
     * up, taken from the state each acting method returns rather than from a
     * second observation. That is what the Step's Checkpoint reads are then
     * authorised against.
     */
    const performAction = (
      step: Step,
      url: string
    ): Effect.Effect<
      { readonly read: string | undefined; readonly url: string },
      ReplayFailure | EvidenceUnwritable
    > =>
      Effect.gen(function* () {
        const action = step.action
        const fail = failing(step)

        if (action.type === "navigate") {
          const path = resolveValue({ inputs, readings }, action.path)
          if (path === undefined) return yield* Effect.fail(unresolvable(fail, action.path))
          const destination = new URL(path, baseUrl).toString()
          const opened = yield* authorised(step, "navigate", destination, url, (surface) =>
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
          return { read: undefined, url: opened.url }
        }

        const surfaceTarget = toSurfaceTarget(action.target)
        const described = describeTarget(surfaceTarget)
        const onTargetFailure = targetFailed(fail, action.type, described, url)

        const outcome = yield* authorised(step, action.type, described, url, (surface) =>
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
                const filled = yield* surface
                  .fill(surfaceTarget, value)
                  .pipe(Effect.catch(onTargetFailure))
                return { resolution, read: undefined, url: filled.url }
              }
              case "click": {
                const clicked = yield* surface
                  .click(surfaceTarget)
                  .pipe(Effect.catch(onTargetFailure))
                return { resolution, read: undefined, url: clicked.url }
              }
              case "extract": {
                const read = yield* surface
                  .extract(surfaceTarget)
                  .pipe(Effect.catch(onTargetFailure))
                // An extract moves nothing, so the run is still where it was.
                return { resolution, read, url }
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

        return { read: outcome.read, url: outcome.url }
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
