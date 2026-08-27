/**
 * Evidence: the structured record of what happened during a run. Decisions,
 * Actions, Checkpoints, Outcomes and Interventions, written at one point where
 * sensitive values are scrubbed on the way out.
 */

export type { EvidenceEvent, EvidenceEventBody } from "./Event.ts"
export {
  EvidenceEvent as EvidenceEventSchema,
  KINDS_FORBIDDEN_IN_REPLAY
} from "./Event.ts"

export type { EvidenceOptions } from "./EvidenceWriter.ts"
export { Evidence, EvidenceUnwritable, layer as evidenceFiles } from "./EvidenceWriter.ts"

export type { Scrubber, SensitiveText } from "./Scrub.ts"
export { noScrubbing, placeholderFor, scrubbing } from "./Scrub.ts"
