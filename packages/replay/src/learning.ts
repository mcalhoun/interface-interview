import {
  type ArtifactInvalid,
  type ArtifactNotWritable,
  OverrideRefused,
  writeArtifact,
  writeOverride
} from "@cua/artifact"
import { Evidence } from "@cua/evidence"
import { Effect, Result } from "effect"
import { type AmendmentRequest, type ProposedAmendment, proposeAmendment } from "./amend.ts"
import { type OverrideRequest, type ProposedOverride, proposeOverride } from "./override.ts"

type Stored<Proposal, Tag extends string> =
  | Exclude<Proposal, { readonly _tag: Tag }>
  | (Extract<Proposal, { readonly _tag: Tag }> & { readonly path: string })
  | {
      readonly _tag: "NotStored"
      readonly proposal: Extract<Proposal, { readonly _tag: Tag }>
      readonly failure: ArtifactInvalid | ArtifactNotWritable
    }

export type LearnedAmendment = Stored<ProposedAmendment, "Amended">
export type LearnedOverride = Stored<ProposedOverride, "Confirmed">

export interface RunLearning {
  readonly amendment: (
    options: Pick<AmendmentRequest, "version" | "confirmedOutcome"> & { readonly directory: string }
  ) => LearnedAmendment
  readonly override: (
    options: Pick<OverrideRequest, "tenant" | "existing"> & { readonly directory: string }
  ) => LearnedOverride
}

/** Capture the episode and live privacy gate before the run's Evidence leaves scope. */
export const learningForIntervention = (
  request: Pick<AmendmentRequest, "artifact" | "record">
): Effect.Effect<RunLearning, never, Evidence> => Effect.gen(function* () {
  const { scrub } = yield* Evidence
  const { artifact, record } = request
  return {
    amendment: ({ directory, ...options }) => {
      const proposal = proposeAmendment({ ...options, artifact, record, scrub })
      if (proposal._tag !== "Amended") return proposal
      const stored = writeArtifact(directory, proposal.amended)
      return Result.isFailure(stored)
        ? { _tag: "NotStored", proposal, failure: stored.failure }
        : { ...proposal, path: stored.success }
    },
    override: ({ directory, ...options }) => {
      if (record.intervention.capability !== artifact.capability ||
          record.intervention.version !== artifact.version ||
          !artifact.steps.some((step) => step.id === record.intervention.stepId)) {
        return { _tag: "Refused", refusal: new OverrideRefused({
          tenant: options.tenant, capability: artifact.capability,
          reason: "the intervention does not belong to this capability version and step"
        }) }
      }
      const proposal = proposeOverride({ ...options, artifact, record, scrub })
      if (proposal._tag !== "Confirmed") return proposal
      const stored = writeOverride(directory, proposal.override)
      return Result.isFailure(stored)
        ? { _tag: "NotStored", proposal, failure: stored.failure }
        : { ...proposal, path: stored.success }
    }
  }
})
