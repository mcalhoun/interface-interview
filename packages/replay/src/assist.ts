/**
 * Assisted Recovery: the middle rung, where the system asks rather than wakes
 * somebody.
 *
 * SPEC, "Assisted recovery": "One rung sits between deterministic replay and a
 * person. Bounded to a single step and a single attempt, policy-checked, and
 * structurally incapable of acting." ADR-0005 is the whole of this module's
 * design, and the sentence to keep in view is the last one: *it may classify,
 * but never act*.
 *
 * ## Where the "cannot act" guarantee actually lives
 *
 * Not here, and that is the point of the shape of this file. What this module
 * defines is a **port** — `Advisor` — whose one operation takes a description of
 * a stuck Step and returns an `AssistReply`. Look at what an `AssistReply` can
 * be: a proposed outcome code with a confidence and a rationale, the *name* of a
 * control the screen is offering, or an admission that it could not tell. There
 * is no Target in it, no url, no verb, no value, no selector and no coordinate.
 * An implementation cannot ask this engine to click something because the type
 * it returns has nowhere to say so.
 *
 * The third arm is ticket 16's and is worth reading twice, because it is the one
 * that looks like it might act. It carries a control's *name*, chosen from a
 * closed list of what is on the screen. A name is not a Target — there is no
 * role, no scope, no ordinal — and there is no expression in the engine that
 * builds one from it. What happens to it is that it is recorded, put on the
 * Intervention, and shown to the person the run was already going to. Promoting
 * it into a stored Tenant Override needs that person's confirmation, exactly as
 * promoting a classification into a Capability version needs one.
 *
 * The implementation on the other side of that port (`@cua/agent`'s
 * `modelAdvisor`) is stricter still: the toolkit it hands the model contains no
 * acting verb at all, so a hallucination is not a click that gets refused, it is
 * a sentence that does not parse. Two independent structures, and neither is a
 * runtime flag.
 *
 * This module names no provider, imports nothing that reaches a network, and
 * would compile identically if the Advisor on the other end were a person with a
 * telephone. `test/replay-has-no-model.test.ts` scans this package for every way
 * a model could be reached and finds none, which stays true *because* the model
 * lives behind the port rather than in here.
 *
 * ## Bounded, in three separate senses
 *
 *   - **One step.** A consultation is about one `AssistConsultation`, which
 *     carries one Step's stall and one screen. There is no history parameter and
 *     no way to pass one, so the transcript cannot grow.
 *   - **One attempt.** `budget` is a `Ref<number>` initialised to
 *     `ASSIST_BUDGET_PER_RUN` (one) and spent before the Advisor is called.
 *     A second stall in the same run gets `NotProposed`, whatever it says.
 *   - **One answer.** The return type is a verdict, never a next action. There
 *     is no branch in this module that consults again with what came back, and
 *     nothing an Advisor can return that would ask it to. An agent loop is not
 *     something that has been disabled here; it is something that has no
 *     expression.
 *
 * ## The candidate set is closed, and that is the safety property
 *
 * `proposableOutcomes` builds the list of codes the model may choose from out of
 * the Artifact the run is executing. A model cannot invent an outcome code,
 * because the codes are a closed enumeration handed to it — an invented one does
 * not decode, and `consultAssist` checks membership a second time anyway
 * (`Selection.ts` duplicates its rule for the same reason: the mistake this
 * prevents is the expensive one).
 *
 * So the worst a confidently wrong model can do is return the wrong one of the
 * Capability's *own documented answers*, marked `assisted: true` with its
 * confidence and a pointer to the proposal in Evidence. It cannot produce a code
 * nobody has written down, and it cannot touch the application.
 *
 * ## What it may not classify
 *
 * Anything the Artifact has already learned needs a person. `classificationOf`
 * is the single lookup ticket 13 left for this, and ticket 14 is adding
 * `requiresHuman:` behind it; the filter below reads it, so a state promoted to
 * authority-class stops being proposable with no change to this file. SPEC:
 * "Authority-class states are never proposable as automatable."
 *
 * ## And promotion still needs a person
 *
 * A proposal that is accepted returns an outcome to the *caller*. It does not
 * touch `artifacts/`. Writing a classification into a Capability goes through
 * `proposeAmendment`, which takes an `InterventionRecord` — a thing only a human
 * handoff produces — so there is no expression anywhere that turns an
 * `AssistReply` into a stored Artifact version. ADR-0005's "a bad model call can
 * never silently change a capability" is that type, not a review convention.
 */

import type { LearnedClass } from "@cua/artifact"
import { type CapabilityArtifact, classificationOf, declaredOutcome } from "@cua/artifact"
import type { EvidenceEventBody, EvidenceUnwritable } from "@cua/evidence"
import type { ConsultationRequest, PolicyVerdict } from "@cua/policy"
import { Effect, Ref, Schema } from "effect"

// ---------------------------------------------------------------------------
// The bounds
// ---------------------------------------------------------------------------

/**
 * Consultations allowed per run. One.
 *
 * A number rather than a boolean so the exhaustion path is written and tested
 * rather than implied by the absence of a loop, and so the Evidence can say
 * `assist-1` and mean the first of a known maximum.
 */
export const ASSIST_BUDGET_PER_RUN = 1

/**
 * How confident a classification has to be before a run acts on it.
 *
 * A floor rather than a judgement, and deliberately high. Below it the proposal
 * is still recorded — an auditor should be able to see what the model thought
 * and that the system declined it — and the run carries on down to the person it
 * would have reached anyway. The cost of the floor being too high is an
 * escalation that need not have happened; the cost of it being too low is a
 * caller told the application answered something it did not.
 */
export const ASSIST_CONFIDENCE_FLOOR = 0.75

/**
 * The one question this rung ever asks, in the words that reach both the
 * Advisor and the `assist.request` Evidence event.
 *
 * A constant rather than a sentence built at the call site, so that what an
 * auditor reads in the log is exactly what was asked rather than a paraphrase of
 * it. It asks what the screen *means*, in the Capability's own vocabulary, and
 * it does not ask what to do about it — there is no answer to that question this
 * rung could accept.
 */
export const ASSIST_QUESTION =
  "Which of this capability's own outcome codes, if any, does the screen below mean? " +
  "Do not propose an action: nothing you return can touch this application."

/**
 * The question asked when a control the Step named is not on the screen.
 *
 * A second constant rather than a sentence assembled at the call site, for
 * exactly the reason there is a first one: what an auditor reads in the log has
 * to be what was asked, not a paraphrase of it. Which of the two is put is a
 * choice between two values, and the engine makes it from the shape of the
 * stall.
 *
 * It asks two things because the screen could be either. A control that is not
 * there is very often the application answering — SPEC's reason for routing zero
 * matches into the ladder at all — and sometimes it is simply the institution
 * calling the button something else. The second half is a *proposal for a
 * person*, and the sentence says so, because a model that thought its answer
 * would be pressed would be answering a different question.
 */
export const ASSIST_TARGET_QUESTION =
  "The control listed below as missing is not on this screen. Either the screen means one of " +
  "this capability's own outcome codes, or this institution calls that control something " +
  "else. Say which. A control you name is a proposal for a person to confirm and nothing " +
  "will be pressed on your say-so: nothing you return can touch this application."

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * One outcome code the model may propose, with what the Artifact says it means.
 *
 * `meaning` is the declaration's own title where there is one. A code the
 * Artifact *names* but has not classified — the `onNoMatch.escalate` case, which
 * is exactly the interesting one — has no declaration yet, so the meaning is
 * where the document names it. Either way the model is choosing among terms the
 * Capability already uses, never inventing vocabulary.
 */
export interface AssistCandidate {
  readonly code: string
  readonly meaning: string
}

/**
 * One control the screen is currently offering, as an operator would point at it.
 *
 * The same discipline `AssistCandidate` follows, applied to the other axis: the
 * legal answers are read off the live tree rather than written by the model, so
 * a proposed control is one that is *on the screen*. There is no free-text field
 * here and none in the tool built from it, which is why an invented control
 * fails schema validation before anything sees it.
 *
 * `region` is the panel it sits in, which is what tells `Look Up` in the
 * Cross-Reference panel apart from `Find` in the search panel. A person deciding
 * whether to confirm needs it, and so does the model.
 */
export interface AssistControl {
  readonly name: string
  readonly role: string
  /** The panel heading it sits under, or `""` when it sits in no named region. */
  readonly region: string
}

/**
 * The whole of what an Advisor is told: one Step, one screen, one closed list of
 * answers.
 *
 * Note the absence of a history, a goal, or anything from an earlier Step. A
 * consultation is not a conversation and there is no field here in which one
 * could be resumed.
 */
export interface AssistConsultation {
  /** `member.account-balance@1.0.0`. The document whose vocabulary is on offer. */
  readonly capability: string
  readonly stepId: string
  readonly stepIntent: string
  /** What the Capability was trying to do, and what stopped it. One line. */
  readonly stalled: string
  /** The question being put, in the same words the Evidence event records. */
  readonly question: string
  /**
   * Where the run is, **already scrubbed**, for the model's context.
   *
   * Heritage Core puts the member number in a query parameter after the search,
   * so this is not a URL a consultation may send as it stands. The unscrubbed
   * one is what Policy judges, and it is deliberately not in this type — see
   * `AssistOptions.page`.
   */
  readonly url: string
  /**
   * The accessibility structure of the stuck screen, **already scrubbed**.
   *
   * The engine passes it through the same scrubber that writes the run's
   * Evidence, before it reaches this type. What a run's log refuses to carry,
   * its consultation refuses to send: one rule, one implementation, and the
   * property `policies/default.yaml` claims in writing when it permits assist at
   * all.
   */
  readonly accessibility: string
  /** Every code the model may choose. Closed, and never empty when consulted. */
  readonly candidates: ReadonlyArray<AssistCandidate>
  /**
   * The control the Step asked for and did not find, in the Target's own words.
   *
   * Present only when the stall is a missing control. When it is absent there is
   * nothing to propose a correspondent *for*, and `controls` is empty too.
   */
  readonly missing?: string | undefined
  /**
   * Every control the screen offers, if a correspondent may be proposed at all.
   *
   * Empty on a Checkpoint failure and on a run where the stall was not a missing
   * control. An empty list is how the `proposeTarget` tool comes to not exist for
   * that consultation: the toolkit is built from this, so there is no verb to
   * misuse rather than a verb that gets refused.
   */
  readonly controls?: ReadonlyArray<AssistControl> | undefined
}

/**
 * What comes back. A classification or an admission, and nothing else.
 *
 * This is the type that makes acting unrepresentable. Widening it is how someone
 * would break ADR-0005, and it would have to be done deliberately and in this
 * file rather than by a configuration change somewhere else.
 */
export type AssistReply =
  | {
      readonly _tag: "Classified"
      /** One of the consultation's `candidates`. Checked again on arrival. */
      readonly proposedOutcome: string
      /** 0 to 1. Compared against `ASSIST_CONFIDENCE_FLOOR`. */
      readonly confidence: number
      readonly rationale: string
    }
  | {
      /**
       * "This screen calls that control something else, and here is which."
       *
       * The third arm, and the one that has to be read carefully. It still
       * cannot describe an action: there is no verb in it, no value to type, no
       * coordinate, and `proposedControl` is one of the consultation's own
       * `controls` — a name read off the live screen, checked again on arrival.
       * What it produces is a sentence for a person, and the only thing in this
       * system that can turn it into a stored Override is somebody confirming it
       * at return of control (ADR-0006).
       *
       * Widening this to carry a Target — a role, a scope, an ordinal, anything
       * the engine could resolve — is how someone would break ADR-0005, and it
       * would have to be done here and on purpose.
       */
      readonly _tag: "TargetProposed"
      /** One of the consultation's `controls`. Checked again on arrival. */
      readonly proposedControl: string
      /** 0 to 1. Compared against the same floor a classification is. */
      readonly confidence: number
      readonly rationale: string
    }
  | {
      readonly _tag: "Unclassified"
      /** Why none of the candidates fits. Recorded, and shown to the Operator. */
      readonly rationale: string
    }

/** The Advisor could not be reached or could not answer. Never fails a run. */
export class AssistUnavailable extends Schema.TaggedError<AssistUnavailable>()(
  "AssistUnavailable",
  { reason: Schema.String }
) {
  override get message(): string {
    return this.reason
  }
}

/**
 * The port. One operation, and its return type cannot describe an action.
 *
 * `Effect<AssistReply, AssistUnavailable>` with an empty requirement channel is
 * what keeps `LanguageModel` out of the Replay engine's requirement set:
 * whatever an implementation needs, it has closed over before it gets here.
 */
export interface Advisor {
  readonly consult: (
    consultation: AssistConsultation
  ) => Effect.Effect<AssistReply, AssistUnavailable>
}

// ---------------------------------------------------------------------------
// The candidate set
// ---------------------------------------------------------------------------

/**
 * The codes this Capability's own document names, minus the ones a person owns.
 *
 * Two sources, and the second is the reason the rung is useful at all:
 *
 *   - every code in `outcomes:`, which the Artifact has already classified as an
 *     answer;
 *   - the code the stalled Step names for the state it hit — an
 *     `onNoMatch.escalate:` code, say — which the Artifact *names* but has not
 *     classified.
 *
 * The second is precisely the state ticket 13 taught by pausing for a person:
 * the author had already written the name down, and what an Intervention added
 * was the classification. This rung proposes that same classification one rung
 * lower, for one run, without writing it anywhere.
 *
 * Anything already learned to need authority is excluded. `classificationOf`
 * reads `requiresHuman:` before `outcomes:`, so a code ticket 14's ratchet has
 * written there drops out of this list with no change to anything below.
 *
 * The engine no longer relies on that alone, and the two rules are deliberately
 * independent. This filter says what an Advisor may *answer*; the engine's
 * `classifyAsHumanRequired` short-circuits so a classified state is never *shown*
 * to one at all. A filter is the weaker guarantee — it assumes the consultation
 * is worth having and only polices the reply — and it stays because the stronger
 * one is keyed on the Step while this one is keyed on the code.
 */
/**
 * SPEC: "Authority-class states are never proposable as automatable."
 *
 * One expression, total over `LearnedClass | undefined`, so the rule is a tested
 * value rather than a condition buried in a filter. A state nobody has
 * classified and a state classified as an answer or as recoverable may all be
 * proposed; a state somebody learned needs authority may not, and no confidence
 * makes it may. That is the ratchet from ADR-0004 seen from this side: a
 * `requires_human` entry can never be downgraded by an intervention, and it must
 * not be side-stepped by a consultation either.
 */
export const isProposable = (existing: LearnedClass | undefined): boolean =>
  existing !== "requires_human"

export const proposableOutcomes = (
  artifact: CapabilityArtifact,
  named: string | undefined
): ReadonlyArray<AssistCandidate> => {
  const codes = [...Object.keys(artifact.outcomes ?? {})]
  if (named !== undefined && !codes.includes(named)) codes.push(named)

  return codes
    .filter((code) => isProposable(classificationOf(artifact, code)))
    .map((code) => {
      const declaration = declaredOutcome(artifact, code)
      return {
        code,
        meaning:
          declaration?.title ??
          `named by this capability for a state it has not yet classified as an answer`
      }
    })
}

// ---------------------------------------------------------------------------
// The rung
// ---------------------------------------------------------------------------

/**
 * What the rung concluded. `Proposed` ends the run with a Business Outcome; a
 * `NotProposed` carries the sentence the next rung down reports.
 */
export type AssistOutcome =
  | {
      readonly _tag: "Proposed"
      readonly code: string
      readonly confidence: number
      readonly rationale: string
      /** Where the proposal is in this run's Evidence. Travels to the caller. */
      readonly proposalRef: string
    }
  /**
   * A correspondent for a missing control, proposed and recorded, and **not
   * acted on**.
   *
   * Deliberately not a sibling of `Proposed` in behaviour, only in shape.
   * `Proposed` ends the run with an answer; this one changes nothing about the
   * run at all — it is carried to the person the run was already going to, and
   * the rung below decides nothing differently because of it. That asymmetry is
   * the whole of ADR-0005 at this rung: a classification is a conclusion the
   * system may act on, and a control is a suggestion only a person may act on.
   */
  | {
      readonly _tag: "TargetSuggested"
      readonly control: string
      readonly confidence: number
      readonly rationale: string
      readonly proposalRef: string
    }
  | { readonly _tag: "NotProposed"; readonly why: string }

/**
 * The two things this rung is allowed to reach, and nothing else.
 *
 * The same discipline `RecoveryPort` uses: passing closures rather than services
 * means this module has no way to observe a Surface, act on one, or write
 * anything outside the run's Evidence — there is nothing in scope to do it with.
 */
export interface AssistGate {
  readonly authorise: (request: ConsultationRequest) => Effect.Effect<PolicyVerdict>
  readonly record: (body: EvidenceEventBody) => Effect.Effect<void, EvidenceUnwritable>
}

export interface AssistOptions {
  /**
   * The Advisor, or `undefined` when assisted recovery was not enabled.
   *
   * Off is the *absence of a value*, not a flag consulted inside a branch. A run
   * without `--assist` has no Advisor to call, records no `assist.*` event, and
   * reaches this function only so that the ladder has one shape.
   */
  readonly advisor: Advisor | undefined
  readonly gate: AssistGate
  /**
   * The real url this stall happened on, unscrubbed, for Policy to judge.
   *
   * Here rather than on the `AssistConsultation` on purpose. An origin allowlist
   * has to be applied to the origin the run is actually on: a scrubbed url whose
   * port happened to contain a member's number would parse to no origin at all
   * and be denied for the wrong reason. But the consultation is the value handed
   * to an `Advisor`, and an implementation that could read a raw url off it
   * could send one. So the two live apart: the unredacted url reaches Policy and
   * the Evidence writer, which scrubs on write, and never reaches an Advisor.
   */
  readonly page: string
  /** Shared across the run. One consultation, whatever stalls. */
  readonly budget: Ref.Ref<number>
  /** Defaults to `ASSIST_CONFIDENCE_FLOOR`. */
  readonly floor?: number
}

/**
 * Consult once, about one Step, and say what may be concluded.
 *
 * The order below is the order of the reasons, and each early return is a
 * different sentence for whoever reads the run:
 *
 *   1. no Advisor — the rung was not enabled, and nothing is recorded;
 *   2. nothing to propose — the Capability names no code for this state;
 *   3. no budget — a consultation already happened in this run;
 *   4. Policy — the deployment permits consulting, from this origin, or does not;
 *   5. the Advisor — unreachable, or unable to classify;
 *   6. the floor — a proposal too uncertain to act on is recorded and refused.
 *
 * Steps 1 to 3 record nothing at all, which is what makes "a replay without
 * `--assist` contains no `assist.*` event" true by construction rather than by a
 * test that happens to pass. From step 4 on, every path leaves a record.
 */
export const consultAssist = (
  options: AssistOptions,
  consultation: AssistConsultation
): Effect.Effect<AssistOutcome, EvidenceUnwritable> =>
  Effect.gen(function* () {
    const { advisor, gate } = options
    const floor = options.floor ?? ASSIST_CONFIDENCE_FLOOR

    if (advisor === undefined) {
      return notProposed("assisted recovery was not enabled for this run (--assist)")
    }

    const controls = consultation.controls ?? []

    /**
     * A consultation needs something to classify with.
     *
     * `candidates` is the closed enumeration `classify` is built over, so an
     * empty one is not a smaller question — it is an unanswerable one. The tool's
     * `proposedOutcome` becomes a `Schema.Literals` over no values, which renders
     * as `{"not": {}}`: a required property nothing can satisfy, sent to a model
     * that `toolChoice: "required"` obliges to call something. Even where another
     * word remains callable, the consultation spends the run's one attempt to ask
     * a question whose principal answer was removed before it was asked.
     *
     * So an empty candidate list declines here, whatever the screen offers. The
     * doc on `AssistConsultation.candidates` says "never empty when consulted";
     * this is the line that makes that true rather than hoped for.
     */
    if (consultation.candidates.length === 0) {
      return notProposed(
        `${consultation.capability} names no outcome code this state could be classified as, ` +
          `so there is nothing a consultation could return`
      )
    }

    // Spent before the Advisor is called, not after: a consultation that dies
    // half way through has still used the run's one attempt, and a budget that
    // only decrements on success is a budget a retry loop can walk around.
    const remaining = yield* Ref.getAndUpdate(options.budget, (left) => left - 1)
    if (remaining <= 0) {
      return notProposed(
        `assisted recovery is bounded to ${ASSIST_BUDGET_PER_RUN} consultation per run, and ` +
          `this run has had it`
      )
    }
    const assistId = `assist-${ASSIST_BUDGET_PER_RUN - remaining + 1}`

    yield* gate.record({
      kind: "assist.request",
      stepId: consultation.stepId,
      assistId,
      reason: consultation.stalled,
      question: consultation.question
    })

    const verdict = yield* gate.authorise({
      stepId: consultation.stepId,
      page: options.page,
      mode: "replay"
    })
    yield* gate.record({
      kind: "policy.check",
      stepId: consultation.stepId,
      action: "assist",
      subject: options.page,
      verdict: verdict.verdict,
      reason: verdict.reason,
      policy: verdict.policy,
      risk: verdict.risk,
      ...(verdict.origin === undefined ? {} : { origin: verdict.origin })
    })
    /**
     * Every path from here leaves a record and then reports the same sentence to
     * the rung below, so a declined consultation is never a gap in the log.
     */
    const decline = (
      reason: string
    ): Effect.Effect<AssistOutcome, EvidenceUnwritable> =>
      gate
        .record({ kind: "assist.declined", stepId: consultation.stepId, assistId, reason })
        .pipe(Effect.as(notProposed(reason)))

    if (verdict.verdict === "deny") {
      return yield* decline(
        `policy ${verdict.policy} refused the consultation: ${verdict.reason}`
      )
    }

    const reply = yield* advisor.consult(consultation).pipe(
      Effect.catch((unavailable) =>
        Effect.succeed<AssistReply>({
          _tag: "Unclassified",
          rationale: `the advisor could not answer: ${unavailable.reason}`
        })
      )
    )

    if (reply._tag === "Unclassified") {
      return yield* decline(
        `assisted recovery could not classify this state: ${reply.rationale}`
      )
    }

    /**
     * The proposed-control path, which records and then hands over.
     *
     * Note what is *not* here and is one line above for a classification: there
     * is no branch that returns something the engine performs. The value that
     * leaves here is `TargetSuggested`, the engine puts it on the Intervention,
     * and the next thing that happens is a person reading it.
     */
    if (reply._tag === "TargetProposed") {
      // Checked again, though the tool's own vocabulary was built from this
      // list. Same reason as below: a control nobody can see on the screen is
      // exactly the thing a person must never be asked to confirm.
      const offered = controls.some((control) => control.name === reply.proposedControl)
      if (!offered) {
        return yield* decline(
          `assisted recovery proposed a control this screen does not offer; only ` +
            `${controls.map((control) => JSON.stringify(control.name)).join(", ")} were on it`
        )
      }

      const worthShowing = reply.confidence >= floor
      yield* gate.record({
        kind: "assist.target_proposal",
        stepId: consultation.stepId,
        assistId,
        forTarget: consultation.missing ?? "(no control named)",
        proposedControl: reply.proposedControl,
        confidence: reply.confidence,
        rationale: reply.rationale,
        // "Carried to a person", never "acted on". Nothing in this system can
        // act on one of these, so there is no stronger sense for it to have.
        accepted: worthShowing
      })

      if (!worthShowing) {
        return notProposed(
          `assisted recovery proposed the control ${JSON.stringify(reply.proposedControl)} at ` +
            `confidence ${reply.confidence.toFixed(2)}, below the ${floor.toFixed(2)} this run ` +
            `requires before putting a suggestion in front of somebody`
        )
      }

      return {
        _tag: "TargetSuggested",
        control: reply.proposedControl,
        confidence: reply.confidence,
        rationale: reply.rationale,
        proposalRef: `events.jsonl#${assistId}`
      }
    }

    // Checked again, though the Advisor's own vocabulary is built from the same
    // list. `Selection.ts` duplicates its rule for the same reason: this is the
    // check whose absence would let a caller receive a code nobody documented,
    // and a check that runs in two places is cheaper than the one that does not.
    const known = consultation.candidates.some(
      (candidate) => candidate.code === reply.proposedOutcome
    )
    if (!known) {
      return yield* decline(
        `assisted recovery proposed an outcome this capability does not name; only ` +
          `${consultation.candidates.map((candidate) => candidate.code).join(", ")} were on offer`
      )
    }

    const accepted = reply.confidence >= floor
    yield* gate.record({
      kind: "assist.proposal",
      stepId: consultation.stepId,
      assistId,
      proposedOutcome: reply.proposedOutcome,
      confidence: reply.confidence,
      rationale: reply.rationale,
      accepted
    })

    if (!accepted) {
      return notProposed(
        `assisted recovery proposed ${reply.proposedOutcome} at confidence ` +
          `${reply.confidence.toFixed(2)}, below the ${floor.toFixed(2)} needed to act on it`
      )
    }

    return {
      _tag: "Proposed",
      code: reply.proposedOutcome,
      confidence: reply.confidence,
      rationale: reply.rationale,
      proposalRef: `events.jsonl#${assistId}`
    }
  })

const notProposed = (why: string): AssistOutcome => ({ _tag: "NotProposed", why })
