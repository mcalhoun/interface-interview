/**
 * Turning a closed Intervention into a proposed Amendment.
 *
 * This is the join between the two halves of ADR-0006's ladder. `@cua/session`
 * says what an episode demonstrated (`classify`, ADR-0004's table).
 * `@cua/artifact` says what a document may take on (`declareLearnedNoMatch`, and
 * the write-once ratchet). Neither knows about the other, and this module is the
 * short piece of wiring that does — deliberately short, because everything
 * interesting is a decision one of those two made.
 *
 * ## The prose is written here, and the Operator is not asked for it
 *
 * SPEC gives the operator interface **one** question. So the code, the title,
 * the summary and the provenance are all derived: the code from what the Artifact
 * author already declared for this state, the title from the Step's own intent,
 * and the summary from the Intervention record — including, verbatim, whatever
 * the Operator wrote in the detail box, because their sentence about what they
 * saw is the most valuable line in the document and they wrote it anyway.
 *
 * Asking them to name the state would let whoever is on shift redefine a
 * Capability's contract, which is exactly the "smuggling the answer in" ADR-0004
 * refuses. What they supply is a judgement; what a document says is derived from
 * a judgement plus what is already written down.
 *
 * ## Two branches, and the asymmetry between them
 *
 * `classify` returns one of three classes and this module writes two of them.
 *
 *   - `business_outcome` — an Operator observed a state and changed nothing, so
 *     the state is terminal and observational, and the Capability learns to
 *     *answer* with it. Ticket 13.
 *   - `requires_human` — an Operator resolved it by acting, and said automation
 *     should always stop here. The Capability learns to *stop better*: sooner,
 *     under a name, routed to somebody who can act. Ticket 14. It never learns to
 *     proceed, and there is no shape of change here that could teach it to.
 *   - `recoverable` — an Operator acted and said automation should do the same
 *     thing itself. Writing a remedy down is a different mechanism from either of
 *     these, and it is ticket 15's; this returns `Unchanged` naming the class.
 *
 * The two it does write are not mirror images, and the difference is the whole
 * safety argument. Which of them an episode demonstrated is decided by `classify`
 * from **what the Operator did**, not from what they answered — and an Operator
 * who had to act cannot produce a `business_outcome` from any answer at all. So
 * the direction that costs a person forever is reachable by a radio button, and
 * the direction that makes a run unattended is not.
 */

import {
  type CapabilityArtifact,
  type LearnedClass,
  AmendmentRefused,
  declareLearnedNoMatch,
  declareRequiresHuman,
  describeItemList,
  describeValueRef,
  diffArtifacts,
  nextMinorVersion
} from "@cua/artifact"
import { type InterventionRecord, THE_QUESTION, classify } from "@cua/session"
import { Result } from "effect"

/** What the run concluded about amending the Capability it just ran. */
export type ProposedAmendment =
  /** A new version, ready to be written, and the diff a reviewer reads. */
  | {
      readonly _tag: "Amended"
      readonly amended: CapabilityArtifact
      readonly learnedClass: LearnedClass
      /** Why the Intervention justified it, in `classify`'s words. */
      readonly because: string
      /** Unified diff of the two versions, both normalised. */
      readonly diff: string
    }
  /**
   * Nothing to write, and not a problem. Much the commonest case: nobody was
   * asked, nobody came, or the Operator declined to change the Capability.
   */
  | { readonly _tag: "Unchanged"; readonly why: string }
  /**
   * Something was learned and the document would not take it. Loud, because a
   * confirmation that cannot be honoured is a thing a person needs told: they
   * answered a question believing it would change something.
   */
  | { readonly _tag: "Refused"; readonly refusal: AmendmentRefused }

export interface AmendmentRequest {
  /** The version that ran. The amendment is cut from this one. */
  readonly artifact: CapabilityArtifact
  readonly record: InterventionRecord
  /**
   * The run's Evidence scrubber. The amendment is refused if scrubbing the
   * finished document would change it — see `AmendmentOptions.scrub`.
   */
  readonly scrub?: (text: string) => string
  /** Defaults to the next minor of the version that ran. */
  readonly version?: string
}

/**
 * Read one closed Intervention and say what, if anything, the Capability should
 * learn from it.
 *
 * Pure. It opens no file and writes nothing — the caller decides whether to
 * store the result, which is what lets the CLI print the diff before anything is
 * committed to disk and lets a test drive the whole mechanism without a store.
 */
export const proposeAmendment = (request: AmendmentRequest): ProposedAmendment => {
  const { artifact, record } = request

  const learned = classify(record)
  if (learned._tag === "NothingLearned") {
    return { _tag: "Unchanged", why: learned.why }
  }

  // Ticket 14's branch. It comes first because it is the one that must never be
  // reached by accident: everything below assumes a Business Outcome is being
  // written, and a `requires_human` episode falling through to it would be the
  // one bug in this file that matters.
  if (learned.learnedClass === "requires_human") {
    return requiresHumanAmendment(request, learned.because)
  }

  // Ticket 15's promotion lands as a further branch here. Named rather than
  // lumped into a generic refusal, because "this episode taught a recoverable
  // state and nothing yet writes those down" is a different thing for a person to
  // read than "no".
  if (learned.learnedClass !== "business_outcome") {
    return {
      _tag: "Unchanged",
      why:
        `this intervention demonstrated a ${learned.learnedClass} state, and only a business ` +
        `outcome or a requires-human state can be declared today. ${learned.because}`
    }
  }

  const step = artifact.steps.find((candidate) => candidate.id === record.intervention.stepId)
  if (step === undefined || step.action.type !== "selectFromList") {
    return {
      _tag: "Unchanged",
      why:
        `step ${record.intervention.stepId} is not a selection, so there is no unmatched ` +
        `state on it to declare. A checkpoint that failed is learned about differently`
    }
  }

  const amended = declareLearnedNoMatch(
    artifact,
    {
      version: request.version ?? nextMinorVersion(artifact.version),
      stepId: step.id,
      title: titleFor(step.intent),
      summary: summaryFor(
        record,
        describeItemList(step.action.list),
        describeValueRef(step.action.match.against)
      ),
      discoveredFrom: provenanceFor(record, learned.because)
    },
    { scrub: request.scrub ?? ((text) => text) }
  )

  if (Result.isFailure(amended)) return { _tag: "Refused", refusal: amended.failure }

  return {
    _tag: "Amended",
    amended: amended.success,
    learnedClass: learned.learnedClass,
    because: learned.because,
    diff: diffArtifacts(artifact, amended.success)
  }
}

/**
 * A Checkpoint that would not hold, and an Operator who got past it with
 * authority.
 *
 * Separate from the Business Outcome path rather than folded into it, because
 * almost nothing is shared: there is no selection to reclassify, no list to
 * describe, and the state is recognised by the Step rather than by a code the
 * author wrote. What the two do share is the shape of the transaction — one
 * derived declaration, one required provenance sentence, one scrubbed document —
 * and that is `Amendment.ts`'s job on both sides.
 *
 * The Step is not required to be any particular kind of Action. A Checkpoint can
 * fail after any of them, and "what kind of gesture preceded the state a person
 * had to have authority to resolve" is not a question with a useful answer.
 */
const requiresHumanAmendment = (
  request: AmendmentRequest,
  because: string
): ProposedAmendment => {
  const { artifact, record } = request

  const step = artifact.steps.find((candidate) => candidate.id === record.intervention.stepId)
  if (step === undefined) {
    return {
      _tag: "Unchanged",
      why:
        `this intervention was raised at step ${record.intervention.stepId}, which this ` +
        `version of the capability does not have`
    }
  }

  const amended = declareRequiresHuman(
    artifact,
    {
      version: request.version ?? nextMinorVersion(artifact.version),
      stepId: step.id,
      title: requiresHumanTitleFor(step.intent),
      summary: requiresHumanSummaryFor(record, step.checkpoint.description),
      discoveredFrom: requiresHumanProvenanceFor(record, because)
    },
    { scrub: request.scrub ?? ((text) => text) }
  )

  if (Result.isFailure(amended)) return { _tag: "Refused", refusal: amended.failure }

  return {
    _tag: "Amended",
    amended: amended.success,
    learnedClass: "requires_human",
    because,
    diff: diffArtifacts(artifact, amended.success)
  }
}

// ---------------------------------------------------------------------------
// The prose, derived
// ---------------------------------------------------------------------------

const withoutTrailingStop = (sentence: string): string => sentence.trim().replace(/\.$/, "")

/**
 * The caller-facing line, built from the Step's own `intent`.
 *
 * The intent is the Artifact author's sentence about what this Step is for, in
 * an operator's words, and it is the closest thing to a domain description the
 * system has that nobody invented at 3am. Naming the state any more specifically
 * than this would be the automation deciding what a screen means, which is the
 * one thing it is not allowed to do.
 */
const titleFor = (intent: string): string =>
  `Nothing on offer matched: ${withoutTrailingStop(intent)}.`

const summaryFor = (record: InterventionRecord, list: string, wanted: string): string =>
  [
    `The screen rendered ${list}, and nothing on it carried every token of ${wanted}. That ` +
      `is not the automation failing to see something: the list was read in full, and what ` +
      `it offered is what there was.`,
    ``,
    `Before this version, this state stopped the run and asked for a person. It no longer ` +
      `does. Somebody met it, looked at it, changed nothing, and confirmed that the ` +
      `application was answering rather than the capability being wrong — so it is an ` +
      `answer, a caller should branch on it the way they branch on any other domain result, ` +
      `and a run that ends here has succeeded.`,
    ``,
    `What that person said about it, in their own words: ` +
      `${JSON.stringify(withoutTrailingStop(record.detail ?? "(nothing recorded)"))}`
  ].join("\n")

/**
 * The link back to the Intervention that justified this, and the argument that
 * it did.
 *
 * Named identifiers, not a narrative: `interventionId`, the session, the run and
 * the step are all fields an auditor can grep the Evidence for, and the three
 * `intervention.*` events for that run are the primary record. The sentence after
 * them is ADR-0004's reasoning applied to this episode, so a reviewer disagreeing
 * with the conclusion can see exactly which premise they are disagreeing with.
 */
const provenanceFor = (record: InterventionRecord, because: string): string => {
  const it = record.intervention
  const actions = record.actions.length === 0
    ? "recorded no actions on the live session"
    : `recorded ${record.actions.length} action(s) on the live session`

  return [
    `Learned from intervention ${it.interventionId} (session ${it.sessionId}, run ${it.runId}, ` +
      `step ${it.stepId}), raised at ${it.raisedAt}.`,
    ``,
    `${record.operator ?? "(unnamed)"} took control at ${record.tookControlAt ?? "(unknown)"}, ` +
      `${actions}, and returned it at ${record.returnedAt ?? "(unknown)"}.`,
    ``,
    `Asked "${THE_QUESTION}", they answered yes. ${because}.`,
    ``,
    `ADR-0004: an operator who resolves a state without acting has demonstrated that it is ` +
      `terminal and observational, which is what makes it declarable. The classification ` +
      `comes from what they did, not from what anyone wrote in advance, and it only ever ` +
      `tightens from here.`
  ].join("\n")
}

/**
 * The caller-facing line for a state that always stops, built from the Step's own
 * `intent` — the same source, and for the same reason, as its Business Outcome
 * counterpart above.
 *
 * It says what automation was *trying* to do, not what the screen said, because
 * the screen is the one thing the system is not allowed to interpret. "A person
 * with authority is required" is the class, and the class is what was learned.
 */
const requiresHumanTitleFor = (intent: string): string =>
  `A person with authority is required: ${withoutTrailingStop(intent)}.`

const requiresHumanSummaryFor = (record: InterventionRecord, checkpoint: string): string =>
  [
    `Automation reached this step and the checkpoint "${withoutTrailingStop(checkpoint)}" did ` +
      `not hold. Somebody took the live session and resolved it, and resolving it took ` +
      `${record.actions.length} action(s) on that session — not a longer wait, not a second ` +
      `look, and not a better description of a control. That is what makes this a permissions ` +
      `problem rather than a user interface one (ADR-0004).`,
    ``,
    `From this version on, a run that meets this state stops under a code and says this, ` +
      `rather than reporting a checkpoint that would not hold and leaving whoever arrives to ` +
      `work out what they are looking at. Every declared recovery rule still gets its one ` +
      `look first, because a transient condition can be met at this step too and getting past ` +
      `one of those unattended is worth more than appearing to fail faster; what changes is ` +
      `that when none of them recognises the screen, the answer is a lookup rather than an ` +
      `inference from having run out of things to try.`,
    ``,
    `What it does not do is get past it. Nothing was learned about how to resolve this state, ` +
      `because what resolved it was authority, and authority is not a thing a capability can ` +
      `be given in a document. This entry is write-once: no later intervention can downgrade ` +
      `it to a business outcome, however many times somebody resolves it, because frequency ` +
      `is not evidence of safety.`,
    ``,
    `What that person said about it, in their own words: ` +
      `${JSON.stringify(withoutTrailingStop(record.detail ?? "(nothing recorded)"))}`
  ].join("\n")

/**
 * The link back to the Intervention, and the argument that it justified this.
 *
 * The same identifiers the Business Outcome provenance carries, and one sentence
 * that is different in the way that matters: it names the **actions**, because
 * the actions are the evidence. An Operator's answer to the one question could
 * have been a mis-click; that they had to do something to the live session is a
 * fact the system recorded without asking, and it is the half of the
 * classification nobody can fake.
 */
const requiresHumanProvenanceFor = (record: InterventionRecord, because: string): string => {
  const it = record.intervention
  const actions = record.actions.length === 0
    ? "recorded no actions on the live session"
    : `recorded ${record.actions.length} action(s) on the live session (${
      record.actions.map((action) => withoutTrailingStop(action.detail)).join("; ")
    })`

  return [
    `Learned from intervention ${it.interventionId} (session ${it.sessionId}, run ${it.runId}, ` +
      `step ${it.stepId}), raised at ${it.raisedAt}.`,
    ``,
    `${record.operator ?? "(unnamed)"} took control at ${record.tookControlAt ?? "(unknown)"}, ` +
      `${actions}, and returned it at ${record.returnedAt ?? "(unknown)"}.`,
    ``,
    `Asked "${THE_QUESTION}", they answered no: automation should always stop here. ` +
      `${because}.`,
    ``,
    `ADR-0004: an operator who resolves a state by exercising authority has demonstrated a ` +
      `permissions problem rather than a user interface one, and a capability cannot be given ` +
      `authority by a document. The classification comes from what they did, not from what ` +
      `anyone wrote in advance, and it never moves back down: no later intervention can ` +
      `downgrade this to a business outcome.`
  ].join("\n")
}
