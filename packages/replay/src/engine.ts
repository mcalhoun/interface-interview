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
 * ## The order inside a failed Checkpoint
 *
 * Five things contribute to what happens when a Checkpoint does not hold, and the
 * order is the semantic core of this system rather than an implementation detail:
 *
 * ```
 *   expect
 *     ->  declared Business Outcomes                 (ADR-0004, ticket 04)
 *     ->  declared Recoverable Conditions            (ticket 06)
 *     ->  one bounded assisted consultation          (ADR-0005, ticket 15)
 *     ->  hand off to a person                       (ADR-0006, ticket 12)
 *           labelled by what this Capability has learned about the state
 *           (`requiresHuman:`, ticket 14) — and a state it has already learned
 *           needs authority skips the consultation entirely.
 * ```
 *
 * A state the Artifact already declares as a Business Outcome is an *answer*. It
 * must never be retried as though it were a transient glitch, and stopping a
 * person to confirm what the document already says would escalate a terminal
 * domain result as though it were breakage. A Recoverable Condition is a state
 * the application is passing through, so it sits above the handoff: waking
 * somebody for something the system can get past on its own is exactly what the
 * ladder exists to avoid. A consultation performs nothing and re-evaluates
 * nothing, so it sits below both and above the person: it is the cheapest rung
 * that can tell "the application answered" from "the automation is broken" for a
 * state nobody has written down yet.
 *
 * And that last clause is the whole of where ticket 14 meets ticket 15. A state
 * the document has *already* classified as needing authority is not a question,
 * so it is not asked: the run short-circuits from the recovery rung straight to
 * the human one, carrying the learned code and the sentence somebody who solved
 * it wrote. SPEC's ladder says the same thing — "low confidence, **or
 * authority-class state**" — and ADR-0005 says such a state is never proposable
 * as automatable, of which not proposing it at all is the stronger form.
 *
 * It is enforced by types rather than by statement order. `evaluate` folds
 * `expect` and the outcome branches together and only `verdict: "failed"` leaves
 * it, so no lower rung can be handed an outcome — `attemptRecovery`,
 * `attemptAssist` and `handOff` are all downstream of a `FailedCheckpoint`. Then
 * each rung's turn is a value only that rung can build:
 *
 *   - `attemptRecovery` is the only producer of an `Unrecovered`;
 *   - `classifyAsHumanRequired` takes an `Unrecovered` and is the only producer
 *     of a `Classified`;
 *   - `attemptAssist` is the only producer of an `Unassisted`;
 *   - `handOff` takes `ForAPerson = Unassisted | Classified` and nothing else.
 *
 * So reaching a person without recovery having had its turn does not compile, and
 * neither does reaching one without the assisted rung having had its turn for a
 * state nothing has classified.
 */

import { Effect, Ref, Result } from "effect"
import {
  type Action,
  type Assertion,
  type CapabilityArtifact,
  type Checkpoint,
  type OutputValue,
  type RequiresHumanDeclaration,
  type ResolvedInputs,
  type Step,
  type ValueRef,
  capabilityRef,
  declaredOutcome,
  describeValueRef,
  parseOutput,
  recoverableConditions,
  requiresHumanAtStep,
  toSurfaceTarget
} from "@cua/artifact"
import { Evidence, type EvidenceUnwritable } from "@cua/evidence"
import { type ActionRequest, Policy, describeUnsafeRepeat, unsafeRepeats } from "@cua/policy"
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
import {
  type Advisor,
  type AssistGate,
  type AssistCandidate,
  ASSIST_BUDGET_PER_RUN,
  ASSIST_QUESTION,
  consultAssist,
  proposableOutcomes
} from "./assist.ts"
import { type CheckpointOutcome, type StepReadings, evaluate, resolveValue } from "./checkpoint.ts"
import { chooseItem } from "./selection.ts"
import {
  type RecoveryBlocked,
  type RecoveryOutcome,
  type RecoveryPort,
  type RemedyReport,
  RECOVERY_BUDGET_PER_RUN,
  recover
} from "./recovery.ts"
import type { ReplayFailure, ReplayFailureBody, ReplayResult, StepRecord } from "./ReplayResult.ts"
import { describeResult } from "./ReplayResult.ts"
import { scrubberFor } from "./redaction.ts"

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
  /**
   * The Assisted Recovery rung, when this run has one. Absent by default.
   *
   * SPEC: "Off by default, enabled with `--assist`." Modelled as an absent value
   * rather than a boolean, so a run without it has nothing to consult rather
   * than a flag that some later branch could read the wrong way round. Nothing
   * in this engine constructs one, and the type says what an `Advisor` may
   * return: a classification, never an action (ADR-0005, and `assist.ts`).
   *
   * `Advisor` has an empty requirement channel, which is what lets a model-backed
   * implementation exist at all without `LanguageModel` appearing in this
   * engine's requirement set. Whatever it needs, it closed over before it got
   * here.
   */
  readonly assist?: Advisor
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
    /**
     * The assisted rung's budget, shared the same way and equal to one.
     *
     * At run level rather than per Step, which is what "bounded to a single step
     * and a single attempt" means when a flow has five of them: the *run* gets
     * one consultation, about whichever Step needed it. A per-Step budget would
     * let a five-step Capability consult five times and still satisfy every
     * sentence in the spec read literally.
     */
    const assistBudget = yield* Ref.make(ASSIST_BUDGET_PER_RUN)
    /**
     * The run's own scrubber, for the one thing that leaves the building.
     *
     * Evidence scrubs on write, so everything in the log is already covered. A
     * consultation is the only text this engine sends anywhere else, and it is
     * put through the same function rather than a second definition of
     * "sensitive" that could drift from the first (ADR-0008, and ticket 13's
     * argument for passing the run's own scrubber into an Amendment). No new
     * `Redacted.value` call site: `scrubberFor` is the existing one.
     */
    const scrub = scrubberFor(inputs)

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
     *
     * The assertions are a parameter rather than being read off the Step, because
     * a Recoverable Condition's `detect` list is made of the same Assertions and
     * is evaluated against the same live screen. A detection that read a control
     * outside this gate would be the same bypass ticket 07 closed, reopened one
     * rung lower.
     */
    const authorisedReader = (
      step: Step,
      page: string,
      assertions: ReadonlyArray<Assertion>
    ): Effect.Effect<
      (target: SurfaceTarget) => Effect.Effect<string, TargetFailure>,
      ReplayFailure | EvidenceUnwritable
    > =>
      Effect.gen(function* () {
        for (const assertion of assertions) {
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

        // Rung 4 for an Action that could not be performed at all. See
        // `performOrHandOff`: the ladder below a Checkpoint that failed and the
        // ladder below an Action that never ran are the same ladder, reached at
        // different moments and resumed on different terms.
        const attempt = yield* performOrHandOff(step, before)
        const performed = attempt.performed

        // The Artifact says this state is one of its own answers. The Step is
        // over; there is no Checkpoint to ask, because there was no Action whose
        // effect a Checkpoint could confirm.
        if (performed._tag === "Answered") {
          steps.push({
            id: step.id,
            intent: step.intent,
            action: step.action.type,
            checkpoint: "outcome",
            ...(performed.assisted === undefined ? {} : { assisted: true })
          })
          return {
            reached:
              performed.assisted === undefined
                ? {
                    code: performed.code,
                    detail: detailFor(performed.code),
                    stepId: step.id,
                    because: performed.because
                  }
                : reachedByAssist(step, performed.assisted),
            afterHandoff: attempt.afterHandoff
          }
        }

        if (performed.read !== undefined) readings.set(step.id, performed.read)
        const read = performed.read

        /**
         * Ask the Checkpoint once, from the page the run is actually on.
         *
         * Available more than once on purpose: once now, once after a recovery
         * has done something about a declared transient condition, and once after
         * an Operator has been in the Session. `evaluate` is idempotent, so
         * re-asking is how the run finds out what happened rather than being told.
         *
         * `page` is a parameter rather than a closed-over constant because the
         * calls are authorised against *different* pages. The first is wherever
         * the Action left the run; the later ones are wherever a remedy or an
         * Operator left it, which is not something the engine may assume. A
         * Checkpoint's reads are `extract`s and pass the same gate as any other
         * action, so each pass asks Policy again rather than reusing a permission
         * granted before the screen moved.
         */
        const verify = (page: string): Effect.Effect<CheckpointOutcome, StepProblem> =>
          Effect.gen(function* () {
            const readTarget = yield* authorisedReader(step, page, step.checkpoint.expect)
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
          }).pipe(Effect.tap((outcome) => recordVerdict(step, outcome)))

        // ---------------------------------------------------------------
        // The ladder below a failed Checkpoint
        // ---------------------------------------------------------------
        //
        //     expect  ->  declared Business Outcomes  ->  recovery  ->  assist
        //             ->  a person, labelled by what has been learned
        //
        // Five things contribute to what happens when a Checkpoint does not hold,
        // and this is the order. The reasoning, which is the semantic core of the
        // system rather than a preference:
        //
        //   - A declared Business Outcome is the application *answering*. It must
        //     never be retried as though it were a glitch, and it must never wake
        //     a person to confirm what the Artifact already says. A recovery rule
        //     whose `detect` also matched the member-not-found screen would
        //     otherwise spend the run's whole budget on a question that was
        //     already answered and then report a Hard Failure for a run that
        //     succeeded.
        //   - A Recoverable Condition is a state the application is *passing
        //     through*. Waking a person for one is what this rung exists to
        //     avoid, so it sits above the handoff.
        //   - One bounded consultation is what is tried next, because it performs
        //     nothing and so cannot leave anything for a person to unpick — and
        //     because "what does this screen mean" is a cheaper question to ask a
        //     model than a person. Unless the document has already answered it:
        //     see `classifyAsHumanRequired` below.
        //   - An Intervention is what is left when none of those applies.
        //
        // The order is enforced by types, not by the order of these statements:
        //
        //   1. `evaluate` folds `expect` and the outcome branches together and
        //      only `verdict: "failed"` leaves it, so no lower rung can be handed
        //      an outcome — `attemptRecovery`, `attemptAssist` and `handOff` are
        //      all downstream of a `FailedCheckpoint`.
        //   2. `attemptRecovery` is the only expression in this file that can
        //      produce an `Unrecovered`, and both rungs below it take one.
        //      Handing off before recovery has had its turn does not type-check.
        //   3. `handOff` takes `ForAPerson = Unassisted | Classified`, and each
        //      arm has exactly one producer: `attemptAssist` and
        //      `classifyAsHumanRequired`. Reaching a person without the assisted
        //      rung having had its turn for an *unclassified* state does not
        //      type-check either.
        let outcome: CheckpointOutcome = yield* verify(performed.url)
        let escalation: Escalated | undefined
        // Possibly already true: an Operator may have been in the Session before
        // the Action could run at all, in which case this Step has had a person
        // in it whatever the Checkpoint goes on to say.
        let afterHandoff = attempt.afterHandoff
        let recovered: string | undefined
        let exhausted: Extract<RecoveryOutcome, { attempted: true }> | undefined
        /** Set when the assisted rung classified this stall. Ends the Step. */
        let assisted: Assisted | undefined

        if (outcome.verdict === "failed") {
          // Rung 3. Reads the state that defeated the Checkpoint, does the
          // bounded thing the Artifact declared, and re-evaluates the same
          // Checkpoint rather than believing its own remedy.
          const attempted = yield* attemptRecovery(step, before, outcome)
          outcome = attempted.outcome

          if (attempted._tag === "Recovered") {
            // A Step that recovered is still a Step that held.
            recovered = attempted.condition
          } else {
            exhausted = attempted.recovery.attempted ? attempted.recovery : undefined

            // Rung 4 is deliberately not the first thing asked here, and that
            // ordering is the whole of what composing tickets 14 and 15 means.
            //
            // Ticket 14's rung changes *what this stall is called*, not where it
            // is. A state this Capability has learned always needs a person is
            // announced under its declared code, with the sentence somebody who
            // already solved it wrote, instead of as a Checkpoint that would not
            // hold.
            //
            // `attempted: false` is the condition, and it is the right one: it
            // means no declared recovery rule recognised this screen at all.
            // Deliberately **not** consulted earlier. A rule's `detect` is one
            // look with no waiting, and skipping it would mean a session expiry
            // met at a classified Step stopped recovering — trading a real
            // unattended recovery for the appearance of failing faster. What the
            // classification saves is the *diagnosis*, not the look: the run
            // stops knowing what it met, and nobody has to work it out from an
            // expected/observed pair at 3am.
            //
            // A rule that was attempted and ran out keeps its own answer.
            // `recovery_exhausted` says the system knew exactly what it was
            // looking at, did the declared thing, and the state stayed — which is
            // a question about the environment and not about authority.
            const classified = classifyAsHumanRequired(step, attempted)

            // Rung 4, when there is anything left to ask about: one bounded
            // consultation. It cannot act, so it cannot have changed anything a
            // person would then have to unpick.
            //
            // **A classified state short-circuits straight past it and is never
            // put to a model at all.** Three reasons:
            //
            //   - ADR-0005: authority-class states are never proposable as
            //     automatable. `proposableOutcomes` enforces that by filtering
            //     what an Advisor may choose from; not asking at all is the
            //     stronger form of the same rule, and it does not rest on a
            //     filter continuing to be right.
            //   - The Capability already knows the answer. Consulting a model
            //     about a state a person has already ruled on spends money and
            //     latency re-deriving a fact that is written down — and an
            //     episode a reviewer approved outranks a proposal nobody has seen.
            //   - It keeps the assisted rung's own invariant honest. That rung
            //     exists for states nobody has classified yet; a run that meets a
            //     classified one records no `assist.*` event at all, which is the
            //     observable form of the same sentence and is what
            //     `test/assisted-recovery.test.ts` pins.
            //
            // It is a fact about the types rather than a boolean somebody could
            // flip. `classifyAsHumanRequired` is the only expression that
            // produces a `Classified`; it takes an `Unrecovered`, so recovery has
            // still had its turn; and `handOff` accepts `Classified | Unassisted`
            // and nothing else. The only two ways to reach a person are therefore
            // "the assisted rung had its turn" and "the document had already
            // answered", and neither can be skipped.
            const consulted = classified ?? (yield* attemptAssist(step, attempted))

            if (consulted._tag === "Assisted") {
              assisted = consulted
            } else {
              // Rung 5, the human one. Everything above it — waiting, the
              // Artifact's own declared outcomes, every declared recovery rule,
              // and either one bounded consultation or the classification that
              // made asking one pointless — has had its turn by now.
              const handed = yield* handOff(step, consulted)
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

                // Deliberately not another trip round the recovery rung. The
                // Artifact's rules were tried against this Checkpoint already and
                // did not clear it; a person has since acted, and if the screen
                // still disagrees the answer is a record for someone to read, not
                // another automated retry on top of a manual one.
                outcome = yield* verify(resumedAt.url)
                if (outcome.verdict === "failed") {
                  // They said they had resolved it and the screen disagrees. Not a
                  // failure of the automation, and not something to escalate a
                  // second time: report it and let a person read the record.
                  escalation = escalated(
                    step,
                    outcome.state.accessibility,
                    `control was returned as resolved, but ${outcome.expected} is still not true`
                  )
                }
              } else {
                escalation = handed.escalation
              }
            }
          }
        }

        steps.push({
          id: step.id,
          intent: step.intent,
          action: step.action.type,
          // A Step the assisted rung settled reached an outcome. Its Checkpoint
          // did not hold and never will — `assisted` is what says the answer was
          // proposed rather than observed, exactly as `recovered` says a Step
          // that held did not hold first time.
          checkpoint: assisted === undefined ? outcome.verdict : "outcome",
          ...(read === undefined ? {} : { read }),
          ...(recovered === undefined ? {} : { recovered }),
          ...(assisted === undefined ? {} : { assisted: true })
        })

        // Before both branches below, because the Checkpoint's own verdict is
        // still `failed` here: what changed is not the Checkpoint's answer but
        // that something below it produced one.
        if (assisted !== undefined) {
          return { reached: reachedByAssist(step, assisted), afterHandoff }
        }

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
          // A condition that was recognised and would not clear is a different
          // problem from a Checkpoint that never matched anything known, and the
          // two are reported as such: one asks whether the Artifact is wrong, the
          // other says the system knew exactly what it was looking at and the
          // state stayed anyway. SPEC: past its bound it stops being recoverable.
          return yield* Effect.fail<StepProblem>(
            escalation ??
              (exhausted === undefined
                ? fail({
                    reason: "checkpoint_failed",
                    expected: outcome.expected,
                    observed: outcome.observed,
                    checkpoint: step.checkpoint.description,
                    waitedMillis: outcome.waitedMillis,
                    accessibility: outcome.state.accessibility,
                    url: outcome.state.url
                  })
                : fail({
                    reason: "recovery_exhausted",
                    expected: outcome.expected,
                    observed: `${outcome.observed}; ${exhausted.condition.condition} did not clear after ${exhausted.attempts} attempt(s)`,
                    condition: exhausted.condition.condition,
                    checkpoint: step.checkpoint.description,
                    attempts: exhausted.attempts,
                    waitedMillis: outcome.waitedMillis,
                    accessibility: outcome.state.accessibility,
                    url: outcome.state.url
                  }))
          )
        }

        return { reached: undefined, afterHandoff }
      })

    /**
     * Perform a Step's Action, and take it down the ladder if its subject was
     * not on the screen at all.
     *
     * ## Which failures come here, and why only those
     *
     * Exactly two: `target_missing` and `no_matching_item`. Both are *zero
     * matches* — the screen rendered perfectly well and the thing the Step wanted
     * is not on it. SPEC: "Zero matches retries fallback strategies and then
     * enters the ladder, because a missing control is as likely to be domain
     * truth as breakage, and telling those apart is exactly the question being
     * escalated."
     *
     * `target_ambiguous` is deliberately absent and always will be. Two controls
     * answering to one Target is a Capability that has stopped being precise
     * enough, and no confirmation from anybody makes picking one of them a
     * correct answer. SPEC calls it a hard failure, never a coin flip.
     *
     * ## The resume semantics differ from a Checkpoint's, and this is why
     *
     * When a Checkpoint fails, the Action landed and the *state* is the problem,
     * so resuming re-asks the Checkpoint: `evaluate` is idempotent, a person has
     * just changed the state by hand, and asking again is how the run finds out
     * what they did. Re-running the Action there would be redundant at best and
     * irreversible at worst.
     *
     * Here the opposite holds. The Action never ran — `chooseItem` decides before
     * the chokepoint, and `resolveTarget` fails before the adapter is asked to
     * press anything — so re-asking the Checkpoint would prove nothing whatever.
     * It would fail for the reason it was always going to fail: the Step's own
     * gesture has not happened. What a returned session has to be given is the
     * Step itself, from the top.
     *
     * **That is not a repeat, which is why it needs no `repeatable:`
     * justification.** `unsafeRepeats` exists because an `at-step` recovery rule
     * re-performs an Action that *may already have landed*, so a Capability whose
     * Actions are risky has to say in writing why doing one twice is safe.
     * Nothing landed here: both zero-match failures are raised strictly before
     * the Surface is touched, so this is the Action's first attempt rather than
     * its second. Demanding a justification for repeating something that never
     * happened would teach the wrong lesson about when one is needed.
     *
     * ## Once, and then a record
     *
     * One re-attempt. If the screen still offers nothing after a person has been
     * in the Session and said they resolved it, the run stops with a record
     * rather than pausing again. Escalating twice for one state is how a run
     * stops being something a person attends and starts being something that
     * keeps interrupting them.
     *
     * ## Recovery does not get a turn on this path
     *
     * A declared Recoverable Condition is written against "the screen that
     * defeated a step's checkpoint", and `resume: here` means re-evaluate that
     * Checkpoint — which, as above, is meaningless for a Step whose Action has
     * not run. Serving both paths would need every rule to say which it is for.
     * Left undone deliberately rather than approximated: the cost is that a
     * transient interstitial met at this exact moment wakes a person, and both
     * transients this Capability declares are met at an earlier Step's
     * Checkpoint.
     */
    const performOrHandOff = (
      step: Step,
      before: SurfaceState
    ): Effect.Effect<
      { readonly performed: Performed; readonly afterHandoff: boolean },
      StepProblem
    > =>
      Effect.gen(function* () {
        const first = yield* attemptAction(step, before)
        if (first._tag !== "Blocked") return { performed: first, afterHandoff: false }

        // The assisted rung, on the path recovery does not serve. See
        // `attemptAssist` for why the asymmetry with recovery is right rather
        // than an omission: a remedy would have to act and then re-ask a
        // Checkpoint that never ran, and a classification has to do neither.
        //
        // A settled stall becomes an `Answered`: no Target, no Policy check for a
        // gesture, no `action` event — because nothing was performed. It is the
        // same shape a `selectFromList` reaching a declared outcome produces,
        // carrying the marker that says a model proposed this one.
        const consulted = yield* attemptAssist(step, {
          _tag: "ActionBlocked",
          failure: first.failure,
          state: before
        })
        if (consulted._tag === "Assisted") {
          return {
            performed: {
              _tag: "Answered",
              code: consulted.code,
              because: becauseAssisted(consulted),
              assisted: consulted
            },
            afterHandoff: false
          }
        }

        const handed = yield* handOff(step, consulted)

        // Nobody to ask, or nobody came, or they could not resolve it. An
        // unattended run reports the Hard Failure it always did: the engine's
        // behaviour with no operator attached is unchanged by this ticket, which
        // is what keeps every existing selection test honest.
        if (!handed.resumed) {
          return yield* Effect.fail<StepProblem>(handed.escalation ?? first.failure)
        }

        const resumedAt = yield* surface.observe.pipe(
          Effect.catch((unavailable) =>
            Effect.fail(
              failing(step)({
                reason: "surface_failed",
                expected: "to observe the surface control was returned on",
                observed: unavailable.reason
              })
            )
          )
        )

        const second = yield* attemptAction(step, resumedAt)
        if (second._tag !== "Blocked") return { performed: second, afterHandoff: true }

        return yield* Effect.fail<StepProblem>(
          escalated(
            step,
            before.accessibility,
            `control was returned as resolved, but ${second.failure.observed}`
          )
        )
      })

    /** The Step's Action, with a zero-match failure caught rather than propagated. */
    const attemptAction = (
      step: Step,
      at: SurfaceState
    ): Effect.Effect<Performed | Blocked, ReplayFailure | EvidenceUnwritable> =>
      performAction(step, step.action, at).pipe(
        Effect.catch((problem) =>
          isZeroMatch(problem)
            ? Effect.succeed<Performed | Blocked>({ _tag: "Blocked", failure: problem })
            : Effect.fail(problem)
        )
      )

    /** One `checkpoint` Evidence event. Emitted for every verdict a Step reaches. */
    const recordVerdict = (
      step: Step,
      outcome: CheckpointOutcome
    ): Effect.Effect<void, EvidenceUnwritable> =>
      evidence.record({
        kind: "checkpoint",
        stepId: step.id,
        description: step.checkpoint.description,
        verdict: outcome.verdict,
        ...describeVerdict(step.checkpoint, outcome),
        waitedMillis: outcome.waitedMillis
      })

    // -----------------------------------------------------------------------
    // Recovery, wired to the same chokepoint everything else goes through
    // -----------------------------------------------------------------------

    /**
     * Rung 3 of the ladder: give the Artifact's declared recovery rules their turn.
     *
     * Takes a `FailedCheckpoint` and nothing wider, which is what makes "a
     * declared Business Outcome is never retried" a compile-time fact rather than
     * a comment: there is no way to hand this function an outcome verdict.
     *
     * Returns `Recovered` or `Unrecovered`, and `Unrecovered` is the only thing
     * `handOff` accepts. Since this is the sole expression in the file that
     * produces one, handing off before recovery has run does not type-check.
     */
    const attemptRecovery = (
      step: Step,
      before: SurfaceState,
      failed: FailedCheckpoint
    ): Effect.Effect<Recovered | Unrecovered, StepProblem> =>
      Effect.gen(function* () {
        const fail = failing(step)

        const recovery = yield* recover({
          conditions,
          checkpoint: step.checkpoint.description,
          failed,
          budget,
          port: recoveryPort(step, before)
        }).pipe(
          Effect.catch((problem): Effect.Effect<never, StepProblem> => {
            if (isEvidenceProblem(problem)) return Effect.fail(problem)
            // A denial or a lost session inside a remedy is already said in the
            // result contract's words; only a dead browser needs translating.
            if (!("_tag" in problem)) return Effect.fail(problem)
            return Effect.fail(
              fail({
                reason: "surface_failed",
                expected: `to recover: ${step.checkpoint.description}`,
                observed: problem.reason
              })
            )
          })
        )

        // No declared rule matched the screen. That is not a recovery that
        // failed; it is a Checkpoint failure recovery had nothing to say about.
        if (!recovery.attempted) return { _tag: "Unrecovered", outcome: failed, recovery }

        // Recovery re-evaluated the Checkpoint, so the log gets the second
        // verdict too. Without it the record would show one failed checkpoint and
        // a run that carried on.
        yield* recordVerdict(step, recovery.outcome)

        return recovery.outcome.verdict === "failed"
          ? { _tag: "Unrecovered", outcome: recovery.outcome, recovery }
          : {
              _tag: "Recovered",
              outcome: recovery.outcome,
              condition: recovery.condition.condition
            }
      })

    /**
     * The closures `recover` is allowed to have.
     *
     * A remedy's Actions run through `performAction`, which runs through
     * `authorised`, which is Session guard then Policy then act. Recovery is not a
     * privileged path, and the way that is kept true is that `recovery.ts` imports
     * no adapter — there is nowhere in it to put a `click`.
     */
    const recoveryPort = (step: Step, before: SurfaceState): RecoveryPort => {
      const attempt = (
        action: Action,
        what: string,
        bindReading: boolean
      ): Effect.Effect<RemedyReport, EvidenceUnwritable> =>
        Effect.gen(function* () {
          // The live screen, not the one the Step remembered. A remedy acts on
          // whatever is actually there — and a `selectFromList` remedy would
          // otherwise be matched against a list that is no longer displayed.
          const at = yield* surface.observe
          const performed = yield* performAction(step, action, at)
          // A remedy whose `selectFromList` reaches a declared outcome has not
          // remedied anything: the state it was supposed to clear is the state
          // the document says is an answer, and only the Step's own Action may
          // end a run that way. Reported as a remedy that did not fire, so the
          // Checkpoint is re-asked and the ladder carries on rather than a
          // recovery rule quietly deciding a run's result.
          if (performed._tag === "Answered") {
            return {
              done: false,
              what,
              why: `this remedy reached the declared outcome ${performed.code} rather than acting`
            } satisfies RemedyReport
          }
          if (bindReading && performed.read !== undefined) readings.set(step.id, performed.read)
          return { done: true, what } satisfies RemedyReport
        }).pipe(
          Effect.catch((problem) =>
            isEvidenceProblem(problem)
              ? Effect.fail(problem)
              : Effect.succeed<RemedyReport>({
                  done: false,
                  what,
                  why: "observed" in problem ? problem.observed : problem.reason
                })
          )
        )

      /** The Checkpoint's own reads, re-authorised against wherever the run is now. */
      const evaluateHere = (
        checkpoint: Checkpoint
      ): Effect.Effect<CheckpointOutcome, RecoveryBlocked> =>
        Effect.gen(function* () {
          const at = yield* surface.observe
          const readTarget = yield* authorisedReader(step, at.url, checkpoint.expect)
          return yield* evaluate({ surface, inputs, readings, read: readTarget }, checkpoint)
        })

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
          if (/^https?:/i.test(before.url)) {
            const back = yield* attempt(
              { type: "navigate", path: { from: "constant", text: before.url } },
              `return to ${before.url}, where this step began`,
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

        recheck: evaluateHere(step.checkpoint),

        detected: (assertions: ReadonlyArray<Assertion>) =>
          evaluateHere({
            description: "the screen matches a declared recoverable condition",
            expect: assertions,
            // One look. Detection asks what is on screen now; waiting for a
            // condition to appear would be waiting for trouble.
            withinMillis: 0
          }).pipe(Effect.map((result) => result.verdict === "held")),

        // Stamped with the Step being recovered, so the `recovery.*` events sit
        // in the log beside the `checkpoint` they answer rather than floating at
        // run level. SPEC user story 63: the records have to join up.
        record: (body) => evidence.record({ stepId: step.id, ...body })
      }
    }

    /**
     * The rung above the consultation: what this Capability has already learned.
     *
     * Ticket 14's rung, kept exactly where ticket 14 put it and given one new
     * job. It fires on `recovery.attempted === false`, which means precisely "no
     * declared recovery rule recognised this screen at all", and it takes an
     * `Unrecovered` — the value only `attemptRecovery` produces — so a
     * `HumanRequired` still cannot be built before recovery has had its turn.
     *
     * Returning `undefined` is not "nothing to say": it is the condition under
     * which the assisted rung is worth asking. A recovery rule that *was*
     * attempted and ran out keeps its own answer (`recovery_exhausted`), because
     * "the system knew exactly what it was looking at, did the declared thing,
     * and the state stayed" is a question about the environment rather than about
     * authority — and it is not a state anybody has classified.
     *
     * This is the only expression that produces a `Classified`, which is what
     * makes the short-circuit past the consultation a fact about the types.
     */
    const classifyAsHumanRequired = (step: Step, stalled: Unrecovered): Classified | undefined => {
      if (stalled.recovery.attempted) return undefined
      const classified = requiresHumanAtStep(artifact, step.id)
      if (classified === undefined) return undefined
      return {
        _tag: "Classified",
        stalled: {
          _tag: "HumanRequired",
          code: classified.code,
          declaration: classified.declaration,
          outcome: stalled.outcome
        }
      }
    }

    /**
     * Rung 4 of the ladder: ask, once, before waking anybody — but only about a
     * state nobody has classified.
     *
     * ## Why this rung serves both stall paths when recovery serves one
     *
     * Ticket 13 left recovery off the action-blocked path with a reason, and the
     * reason is worth restating because it is exactly what does *not* apply
     * here. A declared Recoverable Condition **acts** — it performs a remedy —
     * and then believes the Checkpoint rather than itself. `resume: here` means
     * "re-evaluate that Checkpoint", which is meaningless for a Step whose
     * Action never ran: the Checkpoint would fail for the reason it was always
     * going to fail.
     *
     * Assisted Recovery performs nothing and re-evaluates nothing. It reads the
     * screen and says what the state means. That question is just as well posed
     * when a control was missing as when a Checkpoint would not hold — better
     * posed, in fact, because "the thing the Step wanted is not on this screen"
     * is very often the application answering rather than the Capability being
     * broken, which is precisely SPEC's reason for routing zero matches into the
     * ladder at all.
     *
     * So the middle rung sits above the human one on **both** paths, and the
     * action-blocked path stops being deterministic-then-a-person with nothing
     * in between.
     *
     * ## The one state this rung is never asked about
     *
     * A Step the Artifact has filed under `requiresHuman:` short-circuits past
     * here entirely — `classifyAsHumanRequired` above answers first, and its
     * `Classified` goes straight to `handOff`. ADR-0005 says authority-class
     * states are never proposable as automatable; `proposableOutcomes` enforces
     * that by filtering the candidate list, and not asking at all is the stronger
     * form of the same rule. It is also what keeps this rung's own invariant
     * honest: it exists for states nobody has classified yet, and a run that
     * meets a classified one records no `assist.*` event at all.
     *
     * ## The type discipline, and what it buys
     *
     * `handOff` takes a `ForAPerson`, whose two members are the `Unassisted` this
     * function is the only producer of and the `Classified` that
     * `classifyAsHumanRequired` is the only producer of. Reaching a person
     * without the assisted rung having had its turn *for an unclassified state*
     * does not compile — the same trick `Unrecovered` plays for the recovery
     * rung, extended to cover the path recovery does not serve.
     *
     * A run without `--assist` still comes through here. It gets an `Unassisted`
     * carrying no `why`, records nothing, and reaches the person it always did.
     * The ladder has one shape whether or not the rung is enabled, which is why
     * turning it on cannot change the order of anything.
     */
    const attemptAssist = (
      step: Step,
      stalled: Stalled
    ): Effect.Effect<Assisted | Unassisted, EvidenceUnwritable> =>
      Effect.gen(function* () {
        const said = describeStall(step, stalled)

        // A `no_matching_item` carries the code the Artifact named for the state
        // it hit — a code the document has written down but, at this version, has
        // not classified. That is the whole of what makes this rung useful, and
        // it is the only place a candidate comes from that is not already a
        // declared outcome. See `proposableOutcomes`.
        const named =
          stalled._tag === "ActionBlocked" && "code" in stalled.failure
            ? stalled.failure.code
            : undefined
        const candidates: ReadonlyArray<AssistCandidate> = proposableOutcomes(artifact, named)

        const proposal = yield* consultAssist(
          {
            advisor: request.assist,
            gate: assistGate,
            budget: assistBudget,
            // The unscrubbed url, for Policy. It never enters the consultation.
            page: said.url
          },
          {
            capability: capabilityRef(artifact),
            stepId: step.id,
            stepIntent: step.intent,
            // Every field below that came off the live run goes through the
            // run's own Evidence scrubber. All three, not just the tree: a
            // Heritage Core url carries the member number in a query parameter
            // after the search, and the sentence describing what stalled quotes
            // the value the Step was looking for. What this run's log refuses to
            // carry, its consultation refuses to send.
            //
            // The fields that are *not* scrubbed are the ones that cannot hold
            // runtime data by construction: the question is a constant, and the
            // capability ref, step id, intent and candidate codes come from the
            // Artifact, which carries none (ADR-0008).
            stalled: scrub(`${said.reason}. ${said.detail}`),
            question: ASSIST_QUESTION,
            url: scrub(said.url),
            accessibility: scrub(said.accessibility),
            candidates
          }
        )

        if (proposal._tag === "Proposed") {
          return {
            _tag: "Assisted",
            code: proposal.code,
            confidence: proposal.confidence,
            rationale: proposal.rationale,
            proposalRef: proposal.proposalRef
          }
        }

        return {
          _tag: "Unassisted",
          stalled,
          // A run that never enabled the rung has nothing to report about it, and
          // saying "assisted recovery was not enabled" on every ordinary
          // escalation would train an Operator to skip the line that matters.
          why: request.assist === undefined ? undefined : proposal.why
        }
      })

    /** The two things the assisted rung may reach. Nothing else is in scope for it. */
    const assistGate: AssistGate = {
      authorise: (consultation) => policy.authoriseAssist(consultation),
      record: (body) => evidence.record(body)
    }

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
     * ## Why the parameter is an `Unrecovered` rather than a failed Checkpoint
     *
     * It is the bottom rung, and the type says so. `Unrecovered` can only be
     * produced by `attemptRecovery`, so there is no expression in this engine
     * that reaches a person without every declared recovery rule having had its
     * turn first — and, transitively, without `evaluate` having ruled out both
     * the intended state and every declared Business Outcome. Waking somebody for
     * a state the system can get past on its own, or to confirm an answer the
     * Artifact already documents, are both compile errors rather than review
     * comments.
     *
     * ## Two ways a Step stalls, and one place it stops
     *
     * A Checkpoint that would not hold (`Unrecovered`) and an Action whose
     * subject was not on the screen (`ActionBlocked`) are different problems with
     * different resume semantics, and they are handed to a person by this one
     * function. There is exactly one expression in this engine that pauses a run,
     * which is what makes "the recovery ladder has one human rung" a fact about
     * the code rather than a claim in a document (ADR-0006).
     *
     * The type discipline survives the generalisation. `Unrecovered` is still
     * producible only by `attemptRecovery`, so the checkpoint path still cannot
     * reach a person before every declared recovery rule has had its turn;
     * `ActionBlocked` is producible only by `attemptAction`, which narrows to the
     * two zero-match failures and nothing else.
     *
     * ## Why the parameter is a `ForAPerson` and not just an `Unassisted`
     *
     * Two rungs sit above this one and each insists on having had its turn. The
     * consultation's insistence is `Unassisted`, which only `attemptAssist`
     * produces. The classification's is `Classified`, which only
     * `classifyAsHumanRequired` produces — and which exists precisely because the
     * consultation *must not* happen for a state a person has already ruled on
     * (ADR-0005). A boolean saying "already classified, skip the model" would
     * have been shorter and would have let either rung be skipped by anybody. A
     * two-member union cannot: whichever arm arrives here, it names the
     * expression that built it, and there is no third way to spell one.
     *
     * `why` is only ever a consultation's report, so it is read off the arm that
     * can have one rather than defaulted onto both.
     */
    const handOff = (
      step: Step,
      forPerson: ForAPerson
    ): Effect.Effect<
      { readonly resumed: boolean; readonly escalation: Escalated | undefined },
      EvidenceUnwritable
    > =>
      Effect.gen(function* () {
        const stalled = forPerson.stalled
        const said = describeStall(step, stalled)
        /** Absent on the classified arm: nothing was asked, so there is no answer. */
        const why = forPerson._tag === "Unassisted" ? forPerson.why : undefined

        if (!(yield* session.handoffAvailable)) {
          // A state nobody has classified reports the Hard Failure it always did:
          // with nobody watching, the system genuinely cannot tell a broken
          // capability from a state that needs authority, and naming a person as
          // responsible for a run no person can see is the wrong answer to that.
          //
          // A state the Artifact has *learned* always needs a person is not that
          // question any more. The ambiguity was settled by an episode a reviewer
          // approved, so saying so into an empty room is the honest report rather
          // than a summons: it never pauses, nothing waits, and the caller gets
          // the class that means "route this to a person" instead of the class
          // that means "page an engineer". SPEC's "right reason and routing".
          return stalled._tag === "HumanRequired"
            ? {
                resumed: false,
                escalation: escalated(step, said.accessibility, said.reason, stalled.code)
              }
            : { resumed: false, escalation: undefined }
        }

        const episode = yield* session.pause({
          capability: artifact.capability,
          version: artifact.version,
          runId,
          stepId: step.id,
          stepIntent: step.intent,
          reason: said.reason,
          // What the rung above tried, when it was enabled. An Operator who has
          // been woken deserves to know the system asked first and what it was
          // told, not least because "the model was not sure" and "the model was
          // sure and this deployment does not permit it to be listened to" send
          // them to very different places.
          detail:
            why === undefined
              ? said.detail
              : `${said.detail} Assisted recovery did not settle it: ${why}.`,
          url: said.url,
          accessibility: said.accessibility
        })

        return episode.resumed
          ? { resumed: true, escalation: undefined }
          : {
              resumed: false,
              escalation: escalated(
                step,
                said.accessibility,
                episode.reason,
                stalled._tag === "HumanRequired" ? stalled.code : undefined
              )
            }
      })

    /**
     * What an Operator is shown, from either kind of stall.
     *
     * The wording is the difference a person actually needs. "The checkpoint did
     * not hold" sends them looking at a screen that is wrong; "there is no
     * control matching this" sends them looking for something that is missing,
     * which is a different ten seconds of their life. A no-match also arrives
     * carrying the whole list the screen did offer, and that list is very often
     * the answer on its own.
     */
    const describeStall = (
      step: Step,
      stalled: Stalled
    ): {
      readonly reason: string
      readonly detail: string
      readonly url: string
      readonly accessibility: string
    } => {
      if (stalled._tag === "HumanRequired") {
        // The whole payoff of having learned this. An Operator meeting an
        // unclassified stall is handed "the checkpoint did not hold" and a
        // diagnosis to perform; an Operator meeting this one is handed the
        // sentence somebody who already solved it wrote down, under a code, with
        // the diagnostic still attached underneath.
        const outcome = stalled.outcome
        return {
          reason: stalled.declaration.title,
          detail:
            `${stalled.declaration.summary}\n\n` +
            `The checkpoint that reached it: expected ${outcome.expected}; observed ` +
            `${outcome.observed}.`,
          url: outcome.state.url,
          accessibility: outcome.state.accessibility
        }
      }
      if (stalled._tag === "Unrecovered") {
        const outcome = stalled.outcome
        return {
          reason: `the checkpoint "${step.checkpoint.description}" did not hold`,
          detail: `expected ${outcome.expected}; observed ${outcome.observed}`,
          url: outcome.state.url,
          accessibility: outcome.state.accessibility
        }
      }
      const failure = stalled.failure
      return {
        reason: `this step could not act: ${failure.expected} was not on the screen`,
        detail:
          `${failure.observed}. The action never ran, so nothing has been changed by ` +
          `automation. If this state is the application answering rather than the ` +
          `capability being wrong, say so when you hand control back.`,
        url: stalled.state.url,
        accessibility: stalled.state.accessibility
      }
    }

    /**
     * The caller-facing sentence for one outcome code.
     *
     * A declared outcome's own `title` where there is one. An assisted result may
     * carry a code the Artifact *names* without having declared — that is the
     * whole point of the rung — so the fallback says so plainly rather than
     * inventing prose for a state no reviewer has written about. The model's
     * rationale is deliberately not used here: it goes into Evidence, where it
     * is attributed, and not into the field a caller might quote to a member.
     */
    const detailFor = (code: string, assisted = false): string => {
      const declaration = declaredOutcome(artifact, code)
      if (declaration !== undefined) return declaration.title
      return assisted
        ? `a state this capability names but has not declared, classified for this run by ` +
          `assisted recovery. No reviewer has written what it means to a caller yet`
        : `the capability reached ${code}`
    }

    /** What the `outcome` Evidence event records as the reason, for an assisted answer. */
    const becauseAssisted = (assisted: Assisted): string =>
      `assisted recovery proposed ${assisted.code} at confidence ` +
      `${assisted.confidence.toFixed(2)}: ${assisted.rationale}`

    const reachedByAssist = (step: Step, assisted: Assisted): ReachedOutcome => ({
      code: assisted.code,
      detail: detailFor(assisted.code, true),
      stepId: step.id,
      because: becauseAssisted(assisted),
      assisted
    })

    const escalated = (
      step: Step,
      accessibility: string,
      reason: string,
      code?: string
    ): Escalated => ({
      _tag: "Escalated",
      // A stall nobody has classified is named by the Checkpoint that would not
      // hold, because that is the only name it has. A classified one is named by
      // the declaration, and prefixing the checkpoint onto it would bury the
      // sentence somebody wrote for exactly this moment under the sentence the
      // author wrote for every other one. The checkpoint is still in the detail.
      reason: code === undefined ? `${step.checkpoint.description}: ${reason}` : reason,
      stepId: step.id,
      accessibility,
      ...(code === undefined ? {} : { code })
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
     * just a url because the choice is made against the tree the run just saw.
     *
     * The Action is a parameter rather than being read off the Step, because a
     * Recoverable Condition's remedy is a list of Actions that has to reach the
     * Surface through this same function and therefore through the same
     * authorisation. A remedy that had its own path to the browser would be a
     * second chokepoint, which is the same as none. `at` is then the state the
     * remedy is acting from — a fresh observation, not the Step's remembered one.
     */
    const performAction = (
      step: Step,
      action: Action,
      at: SurfaceState
    ): Effect.Effect<Performed, ReplayFailure | EvidenceUnwritable> =>
      Effect.gen(function* () {
        const fail = failing(step)
        const url = at.url

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
          return { _tag: "Acted", read: undefined, url: opened.url }
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
          const choice = chooseItem({ inputs, tree: at.tree, url }, action, wanted)
          // The Artifact has classified this state as one of its own answers, so
          // there is no control to press and nothing has gone wrong. It leaves on
          // the success channel and the Step is over — the Checkpoint is not
          // asked, because a Checkpoint asks whether an Action reached the state
          // it was for, and this Action correctly did not act at all.
          //
          // Deliberately no `action` Evidence event. Nothing was performed: no
          // Target was resolved, no control was pressed, and Policy was never
          // asked because there was nothing to ask about. An `action` event here
          // would put a gesture in the log that never happened. The `outcome`
          // event the run loop writes carries `because` — the whole selection
          // rationale, including everything the list did offer — so the record
          // still explains itself.
          if (choice._tag === "Declared") {
            return { _tag: "Answered", code: choice.code, because: choice.because }
          }
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

        return { _tag: "Acted", read: outcome.read, url: outcome.url }
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
      // Before anything is performed, and before the first `run.start`: an
      // `at-step` recovery rule re-performs a Step's own Action, so a Capability
      // whose Actions are risky has to say in writing why doing one twice is
      // safe. Refused here rather than at the moment the rule would fire, so a
      // rule that could repeat an irreversible Action never reaches a browser.
      // The CLI asks the same question earlier still, before a browser is even
      // requested; this is the backstop that cannot be forgotten.
      const unsafe = unsafeRepeats(artifact)
      if (unsafe.length > 0) {
        const first = artifact.steps[0]!
        return yield* Effect.fail<ReplayFailure>({
          reason: "artifact_unexecutable",
          stepId: first.id,
          stepIntent: first.intent,
          expected: "every at-step recovery rule to justify repeating a risky action",
          observed: unsafe.map(describeUnsafeRepeat).join("; ")
        })
      }

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
          detail: reached.detail,
          // The three fields SPEC names, and only when they apply. A caller that
          // has never heard of this rung sees the same result it always did;
          // one that has can tell a proposed answer from an observed one without
          // reading the Evidence, and follow `proposalRef` when it wants to.
          ...(reached.assisted === undefined
            ? {}
            : {
                assisted: true,
                confidence: reached.assisted.confidence,
                proposalRef: reached.assisted.proposalRef
              })
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
                ...(problem.code === undefined ? {} : { code: problem.code }),
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
  /**
   * Present when a model proposed this code rather than the Artifact's own
   * branch conditions matching it.
   *
   * Optional and absent on every deterministic outcome, which is what carries
   * SPEC user story 38 — "an assisted result never counted as deterministic" —
   * from the result contract into the engine: there is no way to construct one
   * of these with the marker set except through `reachedByAssist`, and no way to
   * reach that except through the rung.
   */
  readonly assisted?: Assisted
}

/**
 * The assisted rung settled a stall.
 *
 * Produced only by `attemptAssist`, and note what it does not contain: no
 * Target, no Action, no url. A classification cannot be turned into a gesture
 * downstream because there is nothing in it to turn into one (ADR-0005).
 */
interface Assisted {
  readonly _tag: "Assisted"
  readonly code: string
  readonly confidence: number
  readonly rationale: string
  /** `events.jsonl#assist-1`. Travels to the caller on the result. */
  readonly proposalRef: string
}

/**
 * A stall the assisted rung did not settle, and the only thing `handOff` takes.
 *
 * `attemptAssist` is the only expression that produces one, which is how "the
 * assisted rung sits above the human one" becomes a fact the compiler enforces
 * rather than an ordering of two statements. `why` is absent when the rung was
 * not enabled: there is nothing to report about a consultation that never
 * happened.
 */
interface Unassisted {
  readonly _tag: "Unassisted"
  readonly stalled: Stalled
  readonly why: string | undefined
}

/**
 * A stall the assisted rung was never asked about, because the Artifact had
 * already answered.
 *
 * The other thing `handOff` takes, and `classifyAsHumanRequired` is the only
 * expression that produces one. It exists as its own type rather than as a
 * boolean on `Unassisted` for the reason the rest of this ladder is types:
 * "the model was consulted and had nothing" and "the model was deliberately not
 * consulted" are different facts about a run, and a flag lets them be set by
 * anybody in either direction.
 *
 * `stalled` is narrowed to `HumanRequired`, so this arm cannot be used to walk an
 * unclassified state past the consultation. Between the two members of
 * `ForAPerson`, every path to `session.pause` has either had the assisted rung's
 * turn or has a declaration saying why asking would be pointless — and both have
 * had recovery's, because `classifyAsHumanRequired` takes an `Unrecovered` and
 * `attemptAssist`'s `Unassisted` carries the `Stalled` it was given.
 */
interface Classified {
  readonly _tag: "Classified"
  readonly stalled: HumanRequired
}

/**
 * The two ways a stall may legitimately reach a person, and there are exactly
 * two.
 *
 * Widening this union is the only way to add a third, which is deliberately a
 * change somebody has to make in this file, next to the sentence saying why the
 * first two are the ones that exist.
 */
type ForAPerson = Unassisted | Classified

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
/** A Checkpoint that reached neither the intended state nor a declared outcome. */
type FailedCheckpoint = Extract<CheckpointOutcome, { verdict: "failed" }>

/**
 * A failed Checkpoint that a declared recovery rule got past.
 *
 * `outcome` is the *re-evaluated* verdict, never the remedy's own report: a
 * recovery is believed only when the Checkpoint says so.
 */
interface Recovered {
  readonly _tag: "Recovered"
  readonly outcome: Exclude<CheckpointOutcome, FailedCheckpoint>
  /** The declared rule's code. Goes onto the `StepRecord` as `recovered`. */
  readonly condition: string
}

/**
 * A failed Checkpoint that recovery did not get past — either because no declared
 * rule matched the screen at all, or because the rule that did ran out of
 * attempts.
 *
 * This is the *only* thing `handOff` accepts, and `attemptRecovery` is the only
 * expression that produces one. That is how the last two rungs of the ladder are
 * ordered by the compiler rather than by the order of two statements somebody
 * could swap without noticing.
 */
interface Unrecovered {
  readonly _tag: "Unrecovered"
  readonly outcome: FailedCheckpoint
  /** What recovery had to say, including `attempted: false` when nothing matched. */
  readonly recovery: RecoveryOutcome
}

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
  /**
   * The Artifact's declared code, when the state is one it has learned always
   * needs a person. Absent for a state nothing has classified — which is a
   * distinction a caller routes on, so it stays a field rather than a phrase
   * inside `reason`.
   */
  readonly code?: string
  /** What the screen showed when it stopped, so an Operator has context. */
  readonly accessibility: string
}

/**
 * How a Step's Action ended when nothing went wrong.
 *
 * Two ways, and they are as different as a Checkpoint holding and a Checkpoint
 * reaching an outcome. `Acted` is the ordinary one: a control was pressed, maybe
 * something was read, and the run is somewhere new. `Answered` is a
 * `selectFromList` that found nothing in a list the Artifact has *learned* to
 * interpret — no control, no Policy check, no gesture at all, and a Business
 * Outcome as the result.
 *
 * `Answered` is on the success channel for the reason the module note gives at
 * length: a domain answer must never share a road with a fault, not even briefly
 * and not even internally.
 */
type Performed =
  | { readonly _tag: "Acted"; readonly read: string | undefined; readonly url: string }
  | {
      readonly _tag: "Answered"
      readonly code: string
      readonly because: string
      /**
       * Set when the assisted rung supplied the code rather than the Artifact's
       * own `onNoMatch: outcome:` declaring it.
       *
       * The two are the same shape and must not be the same fact: one is a
       * classification a reviewer approved into a document, the other is one a
       * model proposed for this run only.
       */
      readonly assisted?: Assisted
    }

/** A missing control, or a list that offered nothing matching. Never ambiguity. */
type ZeroMatchFailure = Extract<
  ReplayFailure,
  { reason: "target_missing" } | { reason: "no_matching_item" }
>

/**
 * An Action whose subject was not on the screen, so it never ran.
 *
 * The only thing `handOff`'s `ActionBlocked` arm accepts, and `attemptAction` is
 * the only expression that produces one — the same discipline `Unrecovered` has
 * on the Checkpoint side. Narrowing happens in `isZeroMatch` and nowhere else,
 * so the set of failures that can reach a person is one predicate rather than a
 * condition repeated at every call site.
 */
interface Blocked {
  readonly _tag: "Blocked"
  readonly failure: ZeroMatchFailure
}

/** An Action whose subject was not on the screen, described for whoever arrives. */
interface ActionBlocked {
  readonly _tag: "ActionBlocked"
  readonly failure: ZeroMatchFailure
  /** The screen the Action was attempted against. What the Operator is shown. */
  readonly state: SurfaceState
}

/**
 * A stall this Capability has already learned always needs a person.
 *
 * `classifyAsHumanRequired` is the only expression that produces one, and it
 * takes an `Unrecovered` — so this arm is still downstream of recovery having had
 * its turn, exactly as the other two are. What it *is* upstream of is the
 * assisted rung: a state a person has ruled on is never put to a model.
 */
interface HumanRequired {
  readonly _tag: "HumanRequired"
  /** The Artifact's code for this state. Derived from the Step, never named. */
  readonly code: string
  readonly declaration: RequiresHumanDeclaration
  /** The Checkpoint failure that reached it, kept for the diagnostic half. */
  readonly outcome: FailedCheckpoint
}

/**
 * Every way a Step stalls badly enough to want a person.
 *
 * One union, so there is one `session.pause` in this engine. See `handOff`.
 *
 * The three arms are three different things to say to whoever arrives, and the
 * type is what keeps them from being said interchangeably. `Unrecovered`: the
 * Checkpoint would not hold and nothing declared got past it. `ActionBlocked`:
 * the Action never ran, because its subject was not on the screen.
 * `HumanRequired`: the document already knows what this is.
 */
type Stalled = Unrecovered | ActionBlocked | HumanRequired

/**
 * Whether a problem is a zero match, and therefore a question rather than a
 * fault.
 *
 * SPEC's line in one predicate: a missing control is as likely to be domain
 * truth as breakage, and telling those apart is exactly what is being escalated.
 * Ambiguity is excluded on purpose, and excluded *here* rather than assumed
 * absent, because the two target failures sit next to each other in the union
 * and admitting the wrong one would be a one-word mistake with a coin flip at
 * the end of it.
 */
const isZeroMatch = (
  problem: ReplayFailure | EvidenceUnwritable
): problem is ZeroMatchFailure =>
  !isEvidenceProblem(problem) &&
  (problem.reason === "target_missing" || problem.reason === "no_matching_item")

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
