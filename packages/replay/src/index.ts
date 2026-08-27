/**
 * Deterministic Replay of a Capability Artifact against a live Surface.
 *
 * `replayCapability`'s effect requires `SurfaceAdapter | Policy | Evidence |
 * Session` and nothing else, so a `LanguageModel` reappearing in the decision
 * loop fails to compile. See `engine.ts` and ADR-0003.
 */

export type { CheckpointOutcome, EvaluationContext, StepReadings } from "./checkpoint.ts"
export { DEFAULT_CHECKPOINT_MILLIS, evaluate as evaluateCheckpoint, resolveValue } from "./checkpoint.ts"

export type { ReplayRequest } from "./engine.ts"
export { replayCapability } from "./engine.ts"

export type { RunEvidenceOptions } from "./redaction.ts"
export { evidenceForRun, scrubberFor, sensitiveNames } from "./redaction.ts"

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
