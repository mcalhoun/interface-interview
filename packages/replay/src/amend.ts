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
 * ## What it will not amend
 *
 * A Checkpoint that failed. Ticket 12's `77777` is one of those, and the answer
 * to it is a `requiresHuman:` section (ticket 14) rather than a Business Outcome
 * — an Operator who released a supervisor hold *acted*, so `classify` returns
 * `requires_human` and this module refuses to write it as anything else. The
 * refusal names the class it derived, so ticket 14 lands as a second branch here
 * beside a first one that already says what it is waiting for.
 */

import {
  type CapabilityArtifact,
  type LearnedClass,
  AmendmentRefused,
  declareLearnedNoMatch,
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

  // Ticket 14 and ticket 15's promotions land as further branches here. Named
  // rather than lumped into a generic refusal, because "this episode taught a
  // requires-human state and nothing yet writes those down" is a different thing
  // for a person to read than "no".
  if (learned.learnedClass !== "business_outcome") {
    return {
      _tag: "Unchanged",
      why:
        `this intervention demonstrated a ${learned.learnedClass} state, and only a business ` +
        `outcome can be declared today. ${learned.because}`
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
