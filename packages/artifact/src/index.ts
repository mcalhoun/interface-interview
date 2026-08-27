/**
 * Capability Artifacts: the typed, versioned, immutable documents describing how a
 * Capability is carried out.
 *
 * The schema in `CapabilityArtifact.ts` is the focal point of this system. Replay
 * executes it, Discovery compiles into it, and a reviewer approves it without
 * reading any code. Start there.
 */

export type { Action, ActionType, ItemList, SelectFromListAction } from "./Action.ts"
export { Action as ActionSchema, describeItemList } from "./Action.ts"

export type { OutcomeCode, OutcomeDeclaration, OutcomeDeclarations } from "./BusinessOutcomes.ts"
export {
  OutcomeCode as OutcomeCodeSchema,
  OutcomeDeclaration as OutcomeDeclarationSchema,
  OutcomeDeclarations as OutcomeDeclarationsSchema
} from "./BusinessOutcomes.ts"

export type { Assertion, Checkpoint, OutcomeBranch } from "./Checkpoint.ts"
export {
  Assertion as AssertionSchema,
  Checkpoint as CheckpointSchema,
  describeAssertion,
  describeBranch,
  OutcomeBranch as OutcomeBranchSchema
} from "./Checkpoint.ts"

export type { CapabilityArtifact, Step, SurfaceDeclaration } from "./CapabilityArtifact.ts"
export {
  CapabilityArtifact as CapabilityArtifactSchema,
  capabilityRef,
  declaredOutcome,
  declaredOutcomeCodes,
  recoverableConditions,
  Step as StepSchema,
  SurfaceDeclaration as SurfaceDeclarationSchema
} from "./CapabilityArtifact.ts"

export type { RecoverableCondition, RecoveryResume, RemedyStep } from "./Recovery.ts"
export {
  RecoverableCondition as RecoverableConditionSchema,
  RecoveryResume as RecoveryResumeSchema,
  RemedyStep as RemedyStepSchema
} from "./Recovery.ts"

export type {
  Declassifier,
  InputDeclaration,
  InputDeclarations,
  ResolvedInput,
  ResolvedInputs
} from "./Inputs.ts"
export {
  classifySensitive,
  declassifiesNothing,
  InputDeclaration as InputDeclarationSchema,
  InputDeclarations as InputDeclarationsSchema,
  InputsInvalid,
  InputType,
  isRequired,
  isSensitive,
  prepareInputs
} from "./Inputs.ts"

export type {
  Money,
  OutputDeclaration,
  OutputDeclarations,
  OutputParseProblem,
  OutputValue,
  OutputValues
} from "./Outputs.ts"
export {
  describeOutputValue,
  Money as MoneySchema,
  OutputDeclaration as OutputDeclarationSchema,
  OutputDeclarations as OutputDeclarationsSchema,
  OutputType,
  OutputValue as OutputValueSchema,
  OutputValues as OutputValuesSchema,
  parseOutput
} from "./Outputs.ts"

export { ArtifactInvalid, bakedInLiterals, formatArtifact, parseArtifact } from "./parse.ts"

export type { CapabilityTarget } from "./Target.ts"
export { CapabilityTarget as CapabilityTargetSchema, toSurfaceTarget } from "./Target.ts"

export {
  ARTIFACTS_DIRECTORY,
  listCapabilities,
  listVersions,
  loadArtifact
} from "./store.ts"

export type { ValueRef } from "./Value.ts"
export { describeValueRef, ValueRef as ValueRefSchema } from "./Value.ts"
