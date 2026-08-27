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
 *
 * ## Where those two meet: the order inside a failed Checkpoint
 *
 * `evaluate` tries `expect` first and the Artifact's `orOutcome` branches second,
 * and only a Checkpoint that reached neither — `verdict: "failed"` — is offered
 * to a person. The order is `expect` -> `orOutcome` -> `handOff`, and it is not
 * an implementation detail: a state the Artifact already declares as a Business
 * Outcome is an *answer*, and stopping a person to confirm what the document
 * already says would escalate a terminal domain result as though it were
 * breakage. A recoverable-condition rung (ticket 06) belongs above the handoff
 * and below the outcome branches, for the same reason.
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
  type SurfaceState,
  type Target as SurfaceTarget,
  type TargetFailure,
  SurfaceAdapter,
  describeMatch,
  describeTarget
} from "@cua/surface"
import { type CheckpointOutcome, type StepReadings, evaluate, resolveValue } from "./checkpoint.ts"
import { chooseItem } from "./selection.ts"
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

    /**
     * Runs one Step, and says what it concluded.
     *
     * The success channel is a `StepConclusion` rather than a bare
     * `ReachedOutcome | undefined`, because two independently good things end a
     * Step and they end it in opposite channels:
     *
     *   - A **declared Business Outcome** is a result. It stays on the success
     *     channel, always, so a domain answer never shares a road with a fault
     *     (ticket 04; see the module note, and do not "simplify" it into a signal
     *     failure folded at the boundary).
     *   - An **Intervention nobody resolved** is not a result yet: the run stops
     *     and a person is still required. That travels the error channel as
     *     `Escalated`, purely so one Step abandoning the run short-circuits the
     *     loop, and the boundary turns it into `intervention_required` — which
     *     reports no failure anywhere, exactly as a Business Outcome does.
     *
     * The case that only exists once both of those are in the same function is
     * the interesting one: a Checkpoint fails, a person resolves it by hand, and
     * the re-asked Checkpoint matches a declared outcome branch. That is a
     * Business Outcome arrived at *after* a handoff, and it has to come back on
     * the success channel like any other one. So the conclusion carries both
     * facts rather than collapsing them, and `afterHandoff` is what lets the
     * `outcome` Evidence event say a person was in the session: the same answer
     * reached with and without one is not the same event to an auditor.
     */
    const runStep = (step: Step): Effect.Effect<StepConclusion, StepProblem> =>
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

        const performed = yield* performAction(step, before)
        if (performed.read !== undefined) readings.set(step.id, performed.read)
        const read = performed.read

        /**
         * Ask the Checkpoint once, from the page the run is actually on.
         *
         * Available twice on purpose: once now, and once after an Operator has
         * been in the Session. `evaluate` is idempotent, so re-asking is how the
         * run finds out what they did rather than being told.
         *
         * `page` is a parameter rather than a closed-over constant because the
         * two calls are authorised against *different* pages. The first is
         * wherever the Action left the run; the second is wherever the Operator
         * left it, which is not something the engine may assume. A Checkpoint's
         * reads are `extract`s and pass the same gate as any other action, so the
         * second pass asks Policy again rather than reusing a permission granted
         * before a person had the keyboard.
         */
        const verify = (page: string): Effect.Effect<CheckpointOutcome, StepProblem> =>
          Effect.gen(function* () {
            const readTarget = yield* authorisedReader(step, page)
            return yield* evaluate(
              { surface, inputs, readings, read: readTarget },
              step.checkpoint
            ).pipe(
              Effect.catch((unavailable) =>
                Effect.fail<StepProblem>(
                  fail({
                    reason: "surface_failed",
                    expected: `to verify: ${step.checkpoint.description}`,
                    observed: unavailable.reason
                  })
                )
              )
            )
          }).pipe(
            Effect.tap((outcome) =>
              evidence.record({
                kind: "checkpoint",
                stepId: step.id,
                description: step.checkpoint.description,
                verdict: outcome.verdict,
                ...describeVerdict(step.checkpoint, outcome),
                waitedMillis: outcome.waitedMillis
              })
            )
          )

        // Authorised against wherever the Action left the run, not where it
        // started: a click that followed a link off the allowlist is exactly the
        // case this is here to catch.
        let outcome = yield* verify(performed.url)
        let escalation: Escalated | undefined
        let afterHandoff = false

        // Only `failed` gets here. A Checkpoint that held is done, and one that
        // matched a declared `orOutcome` branch already has an answer — asking a
        // person to confirm what the Artifact says is the mistake this ordering
        // exists to prevent.
        if (outcome.verdict === "failed") {
          // The Recovery Ladder's human rung. Everything above it — waiting,
          // retrying, matching harder, and the Artifact's own declared outcomes —
          // has had its turn by the time a Checkpoint has spent its whole bound
          // and still does not hold.
          const handed = yield* handOff(step, outcome)
          if (handed.resumed) {
            afterHandoff = true

            // Where the person left the run. Observed rather than assumed:
            // between the pause and here, the only thing that moved the Surface
            // was a human being.
            const resumedAt = yield* surface.observe.pipe(
              Effect.catch((unavailable) =>
                Effect.fail(
                  fail({
                    reason: "surface_failed",
                    expected: "to observe the surface control was returned on",
                    observed: unavailable.reason
                  })
                )
              )
            )

            outcome = yield* verify(resumedAt.url)
            if (outcome.verdict === "failed") {
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
          checkpoint: outcome.verdict,
          ...(read === undefined ? {} : { read })
        })

        if (outcome.verdict === "outcome") {
          // Not a failure, and so not a `fail`. The declaration is what supplies
          // the caller-facing wording; the engine only knows the code.
          const declaration = declaredOutcome(artifact, outcome.code)
          return {
            reached: {
              code: outcome.code,
              detail: declaration?.title ?? `the capability reached ${outcome.code}`,
              stepId: step.id,
              because: outcome.because
            },
            afterHandoff
          }
        }

        if (outcome.verdict === "failed") {
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
        }

        return { reached: undefined, afterHandoff }
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
      outcome: Extract<CheckpointOutcome, { verdict: "failed" }>
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
      outcome: Extract<CheckpointOutcome, { verdict: "failed" }>,
      reason: string
    ): Escalated => ({
      _tag: "Escalated",
      reason: `${step.checkpoint.description}: ${reason}`,
      stepId: step.id,
      accessibility: outcome.state.accessibility
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
     *
     * `selectFromList` is the one Action whose subject is not written down. It
     * works out a Target first, by matching a parameter against the labels the
     * screen is currently offering (see `selection.ts`), and then proceeds as an
     * ordinary click. That ordering is what lets Policy see the control actually
     * about to be pressed, and it is why selection adds no new way for this
     * engine to touch the Surface. It takes the whole observed state rather than
     * just a url because the choice is made against the tree the Step just saw.
     */
    const performAction = (
      step: Step,
      before: SurfaceState
    ): Effect.Effect<
      { readonly read: string | undefined; readonly url: string },
      ReplayFailure | EvidenceUnwritable
    > =>
      Effect.gen(function* () {
        const action = step.action
        const fail = failing(step)
        const url = before.url

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

        // A `selectFromList` names no control. It reads the list the Step just
        // observed and works one out, by token subset against the live labels
        // (ADR-0007). The choice happens *before* the chokepoint so that Policy
        // and the record both name the control actually about to be pressed,
        // rather than an abstract "select something".
        let surfaceTarget: SurfaceTarget
        let declaredStrategy: string
        let chosenBy: string | undefined
        if (action.type === "selectFromList") {
          const wanted = resolveValue({ inputs, readings }, action.match.against)
          if (wanted === undefined) {
            return yield* Effect.fail(unresolvable(fail, action.match.against))
          }
          const choice = chooseItem({ inputs, tree: before.tree, url }, action, wanted)
          if (choice._tag === "Unchosen") return yield* Effect.fail(fail(choice.failure))
          surfaceTarget = choice.target
          declaredStrategy = action.match.strategy
          chosenBy = choice.rationale
        } else {
          surfaceTarget = toSurfaceTarget(action.target)
          declaredStrategy = action.target.strategy
        }

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
              // A selection has already worked out *which* item; pressing it is
              // an ordinary click, through the one call site a click has ever
              // used. The engine gains no new way to reach the Surface.
              case "selectFromList":
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
          declaredStrategy,
          resolvedBy: outcome.resolution.strategies,
          // For a selection, the record carries the whole reasoning: what the
          // live list offered, why one item carried every token of the
          // parameter, and then how the resulting Target resolved. A reviewer
          // can re-derive the choice from the snapshot in the same file.
          rationale: chosenBy === undefined
            ? outcome.resolution.rationale
            : `${chosenBy}; then ${outcome.resolution.rationale}`
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

      for (const [index, step] of artifact.steps.entries()) {
        const { reached, afterHandoff } = yield* runStep(step)
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
          // Said at the moment it happened rather than reconstructed later: an
          // outcome the automation reached by itself and one that only became
          // visible after a person acted are the same value and a different fact.
          matched: afterHandoff
            ? `${reached.because} (re-asked after an Operator held this session)`
            : reached.because
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
 * What a Step concluded when nothing went wrong.
 *
 * Two facts, and they are separate on purpose. `reached` is the Artifact's own
 * answer and is the reason this type is on the *success* channel at all; the
 * alternative — failing with a signal value and folding it at the boundary —
 * would put a legitimate domain answer on the same road as a fault, which is the
 * mistake ticket 04 exists to make impossible.
 *
 * `afterHandoff` is the other half of the composition. A Step can now end in the
 * same three ways it always could *after a person has been in the Session*, so
 * "which of these came back" is no longer the whole story: an outcome the
 * automation found on its own and one that only became visible because a
 * supervisor released a hold are different events, even though they are the same
 * value. Keeping it here rather than inferring it at the boundary means the
 * Evidence log says so at the moment it happened, and it is the field ticket 13
 * reads when it turns "what the Operator did" into an Artifact Amendment.
 */
interface StepConclusion {
  /** The declared Business Outcome this Step reached. `undefined` means carry on. */
  readonly reached: ReachedOutcome | undefined
  /** Whether an Operator held the live Session during this Step and handed it back. */
  readonly afterHandoff: boolean
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
      case "TargetAmbiguous": {
        // Never a coin flip. Every candidate is listed, because "which one did it
        // mean" is the only useful question at that point (SPEC user story 28).
        // Each is described by its ordinal and region rather than by role and
        // name alone: on a screen where three panels hold the same control, a
        // list of three identical names answers nobody.
        const candidates = problem.matches.map(describeMatch)
        return Effect.fail(
          fail({
            reason: "target_ambiguous",
            expected: `exactly one ${target}`,
            observed: `${candidates.length} controls matched: ${candidates.join("; ")}`,
            target,
            candidates,
            remedy: problem.remedy,
            url
          })
        )
      }
      case "TargetNotFound":
        return Effect.fail(
          fail({
            reason: "target_missing",
            expected: `a control matching ${target}`,
            observed: problem.rationale,
            target,
            // Which part of the Target ran out of candidates. A missing control
            // is as likely to be domain truth as breakage, and this is what a
            // Recovery Ladder branches on.
            ...(problem.narrowedBy === undefined ? {} : { narrowedBy: problem.narrowedBy }),
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
