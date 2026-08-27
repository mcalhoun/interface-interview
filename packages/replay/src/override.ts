/**
 * Turning a closed Intervention into a stored Tenant Override.
 *
 * The sibling of `amend.ts`, and the resemblance is the argument rather than a
 * coincidence. ADR-0006: discovering a new Business Outcome, discovering that a
 * state permanently needs a person, and adapting a Capability to a Tenant whose
 * UI differs "look like three problems. They are one." So the third one is wired
 * the same way as the first two: a run fails, the ladder runs, a person is
 * handed the live Session, and what they say on the way out is read by a short
 * pure function that decides whether a document changes.
 *
 * ## The two halves, and why neither is sufficient
 *
 * An Override is written only when **both** are present:
 *
 *   - a proposal on the Intervention — assisted recovery looked at the screen
 *     the Step could not act on and named a control it thinks corresponds;
 *   - a confirmation on the return of control — a person looked at the same
 *     screen and agreed.
 *
 * Without the first there is nothing to confirm, and a person typing a control
 * name into a box would be hand-writing an override, which ADR-0006 refuses.
 * Without the second there is a model's guess about a banking screen going into
 * a document that outlives the run, which ADR-0005 refuses. The pair is the
 * mechanism, and it is why this function takes an `InterventionRecord` rather
 * than an `AssistReply`: only a human handoff produces one of those.
 *
 * ## What is derived rather than asked
 *
 * Everything except the one bit. The Step comes from the Intervention, the name
 * the Capability asks for comes from the Artifact, the proposed name comes from
 * the consultation, and the prose is written here. The Operator answers
 * "is this right?" and nothing else — the same discipline `amend.ts` follows,
 * and for the same reason: what a person supplies is a judgement, and what a
 * document says is derived from a judgement plus what is already written down.
 *
 * ## `rejected` is a result, and it writes nothing
 *
 * A person who looks at `Find`, decides it is not the search button and says so
 * has told the system something worth having. It is in the Evidence, on the
 * `intervention.resolve` event, and it is deliberately *not* in the Override
 * file: a document of confirmed correspondences with a rejected one in it would
 * be a document nobody can read at a glance.
 */

import {
  type CapabilityArtifact,
  type OverrideTarget,
  type TenantOverride,
  OverrideRefused,
  declareTargetOverride
} from "@cua/artifact"
import { THE_PROPOSAL_QUESTION, type InterventionRecord } from "@cua/session"
import { Result } from "effect"

/** What the run concluded about this Tenant's delta. */
export type ProposedOverride =
  /** A delta ready to be written, with the entry that was added to it. */
  | {
      readonly _tag: "Confirmed"
      readonly override: TenantOverride
      readonly entry: OverrideTarget
      /** Why the episode justified it, in one sentence. */
      readonly because: string
    }
  /** Nothing to write, and not a problem. The commonest case by far. */
  | { readonly _tag: "Unchanged"; readonly why: string }
  /**
   * Something was confirmed and the document would not take it. Loud, because a
   * person answered a question believing it would change something.
   */
  | { readonly _tag: "Refused"; readonly refusal: OverrideRefused }

export interface OverrideRequest {
  /** The base version that ran. The delta is written against this one. */
  readonly artifact: CapabilityArtifact
  /** The institution, e.g. `community-cu`. */
  readonly tenant: string
  readonly record: InterventionRecord
  /** This Tenant's existing delta for this Capability, if it has one. */
  readonly existing?: TenantOverride | undefined
  /** The run's Evidence scrubber. See `Override.ts`. */
  readonly scrub?: ((text: string) => string) | undefined
}

/**
 * Read one closed Intervention and say what, if anything, this Tenant's Override
 * should gain from it.
 *
 * Pure. It opens no file and writes nothing — the caller decides whether to
 * store the result, exactly as with `proposeAmendment`, which is what lets the
 * CLI print what was confirmed before anything is committed to disk.
 */
export const proposeOverride = (request: OverrideRequest): ProposedOverride => {
  const { artifact, record, tenant } = request
  const proposal = record.intervention.proposal

  if (proposal === undefined) {
    return {
      _tag: "Unchanged",
      why:
        "no correspondent was proposed in this episode, so there is nothing a confirmation " +
        "could have been about"
    }
  }

  if (record.confirmProposal === "not_asked") {
    return {
      _tag: "Unchanged",
      why:
        `control was returned without anybody answering "${THE_PROPOSAL_QUESTION}", so the ` +
        `proposed control ${JSON.stringify(proposal.control)} stays a proposal`
    }
  }

  if (record.confirmProposal === "rejected") {
    return {
      _tag: "Unchanged",
      why:
        `${record.operator ?? "(unnamed)"} looked at the screen and said ` +
        `${JSON.stringify(proposal.control)} is not the control this step needs. Nothing is ` +
        `written, and the rejection is in the evidence for this run`
    }
  }

  const step = artifact.steps.find((candidate) => candidate.id === record.intervention.stepId)
  const action = step?.action
  if (
    step === undefined ||
    action === undefined ||
    action.type === "navigate" ||
    action.type === "selectFromList" ||
    action.target.name === undefined
  ) {
    return {
      _tag: "Unchanged",
      why:
        `step ${record.intervention.stepId} names no control in version ${artifact.version}, ` +
        `so there is nothing for a tenant to rename`
    }
  }

  const declared = declareTargetOverride(
    request.existing,
    tenant,
    artifact,
    {
      stepId: step.id,
      was: action.target.name,
      name: proposal.control,
      discoveredFrom: discoveredFor(record, proposal.confidence, proposal.rationale),
      confirmedBy: confirmedFor(record)
    },
    { scrub: request.scrub }
  )

  if (Result.isFailure(declared)) return { _tag: "Refused", refusal: declared.failure }

  const entry = declared.success.targets[declared.success.targets.length - 1]!
  return {
    _tag: "Confirmed",
    override: declared.success,
    entry,
    because:
      `${record.operator ?? "(unnamed)"} confirmed that ${tenant} calls ` +
      `${JSON.stringify(entry.was)} ${JSON.stringify(entry.name)}`
  }
}

const withoutTrailingStop = (sentence: string): string => sentence.trim().replace(/\.$/, "")

/**
 * How the correspondence was found: the run that failed, and the consultation.
 *
 * Named identifiers rather than a narrative, the same way an Amendment's
 * provenance is written — the run id, the intervention id and the Evidence
 * reference are all things an auditor can grep for, and the sentences after them
 * are the reasoning. The model's rationale is quoted and attributed, because a
 * reviewer disagreeing with the override is usually disagreeing with that.
 *
 * The first paragraph says what actually happened, and it is the ADR-0006
 * sentence made concrete: nobody detected tenant drift. Replay failed.
 */
const discoveredFor = (
  record: InterventionRecord,
  confidence: number,
  rationale: string
): string => {
  const it = record.intervention
  return [
    `Discovered by replay failing. Run ${it.runId} executed ${it.capability}@${it.version} ` +
      `against ${it.stepId} and could not resolve the control it names; that is an ordinary ` +
      `replay failure, and it is the only way tenant drift is detected here (ADR-0006).`,
    ``,
    `Assisted recovery was consulted once about that screen and proposed the control ` +
      `${JSON.stringify(record.intervention.proposal?.control ?? "(none)")} at confidence ` +
      `${confidence.toFixed(2)}. The proposal is at ` +
      `${record.intervention.proposal?.proposalRef ?? "(unrecorded)"} in that run's evidence.`,
    ``,
    `In its own words: ${JSON.stringify(withoutTrailingStop(rationale))}`,
    ``,
    `ADR-0005: the consultation could name a control and could not press one. Nothing was ` +
      `acted on, and this document exists because a person then agreed with it.`
  ].join("\n")
}

/** Who agreed, when, and what they were asked. The other half, and the binding one. */
const confirmedFor = (record: InterventionRecord): string => {
  const it = record.intervention
  return [
    `${record.operator ?? "(unnamed)"} took the live session at ` +
      `${record.tookControlAt ?? "(unknown)"} (intervention ${it.interventionId}, session ` +
      `${it.sessionId}) and returned it at ${record.returnedAt ?? "(unknown)"}.`,
    ``,
    `Asked "${THE_PROPOSAL_QUESTION}", they answered yes.`,
    ``,
    `What they said about it: ` +
      `${JSON.stringify(withoutTrailingStop(record.detail ?? "(nothing recorded)"))}`
  ].join("\n")
}
