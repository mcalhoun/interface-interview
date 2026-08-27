/**
 * Deterministic Replay of a Capability Artifact against a live Surface.
 *
 * `replayCapability`'s effect requires `SurfaceAdapter | Policy | Evidence |
 * Session` and nothing else, so a `LanguageModel` reappearing in the decision
 * loop fails to compile. See `engine.ts` and ADR-0003.
 */

export type { AmendmentRequest, ProposedAmendment } from "./amend.ts"
export { proposeAmendment } from "./amend.ts"

export type {
  Advisor,
  AssistCandidate,
  AssistConsultation,
  AssistControl,
  AssistGate,
  AssistOptions,
  AssistOutcome,
  AssistReply
} from "./assist.ts"
export {
  ASSIST_BUDGET_PER_RUN,
  ASSIST_CONFIDENCE_FLOOR,
  ASSIST_QUESTION,
  ASSIST_TARGET_QUESTION,
  AssistUnavailable,
  consultAssist,
  isProposable,
  proposableOutcomes
} from "./assist.ts"

export type { OverrideRequest, ProposedOverride } from "./override.ts"
export { proposeOverride } from "./override.ts"

export type { CheckpointOutcome, EvaluationContext, StepReadings } from "./checkpoint.ts"
export { DEFAULT_CHECKPOINT_MILLIS, evaluate as evaluateCheckpoint, resolveValue } from "./checkpoint.ts"

export type { AppliedOverride, ReplayRequest } from "./engine.ts"
export { replayCapability } from "./engine.ts"

export type { RunEvidenceOptions } from "./redaction.ts"
export { evidenceForRun, scrubberFor, secretsFor, sensitiveNames } from "./redaction.ts"

export type {
  RecoveryBlocked,
  RecoveryOutcome,
  RecoveryPort,
  RecoveryRequest,
  RemedyReport
} from "./recovery.ts"
export { RECOVERY_BUDGET_PER_RUN, recover } from "./recovery.ts"

export type { Choice, ChoiceContext } from "./selection.ts"
export { chooseItem } from "./selection.ts"

export type {
  ReplayFailure,
  ReplayFailureBody,
  ReplayResult,
  ReplayResultClass,
  StepRecord
} from "./ReplayResult.ts"
export {
  describeResult,
  ReplayFailure as ReplayFailureSchema,
  ReplayResult as ReplayResultSchema,
  StepRecord as StepRecordSchema
} from "./ReplayResult.ts"
