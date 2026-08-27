/**
 * Policy: the one place that decides whether an Action may happen, and the one
 * place that decides which parameters may be written down in the clear.
 *
 * Read `policies/default.yaml` first. It is the statement of what this system may
 * do, and it is meant to be readable without reading any of this package.
 *
 * `Policy.ts` is the vocabulary that file is written in and the risk
 * classification it may not override. `PolicyDocument.ts` is its schema and the
 * checks that make a wrong file refuse to load. `decide.ts` is the whole
 * decision, pure. `origins.ts` is what "an allowed origin" means.
 *
 * `Sensitivity.ts` is the parameter allowlist ticket 08 added: deny-first, so an
 * Artifact cannot declassify itself.
 */

export type {
  ActionMode,
  ActionRequest,
  ConsultationRequest,
  PolicyVerdict,
  Risk
} from "./Policy.ts"
export {
  ACTION_TYPES,
  ActionMode as ActionModeSchema,
  ActionRequest as ActionRequestSchema,
  CONSULTATION_RISK,
  ConsultationRequest as ConsultationRequestSchema,
  Policy,
  PolicyVerdict as PolicyVerdictSchema,
  RISK,
  RISKY_ACTION_TYPES,
  Risk as RiskSchema,
  riskOf
} from "./Policy.ts"

export type {
  CompiledPolicy,
  ModeRule,
  PermittedAction,
  PermittedAssist,
  PolicyDocument
} from "./PolicyDocument.ts"
export {
  compilePolicy,
  JUSTIFICATION_MINIMUM,
  ModeRule as ModeRuleSchema,
  parsePolicy,
  PermittedAction as PermittedActionSchema,
  PermittedAssist as PermittedAssistSchema,
  PolicyDocument as PolicyDocumentSchema,
  PolicyInvalid
} from "./PolicyDocument.ts"

export { decide, decideAssist } from "./decide.ts"

export type { OriginPattern } from "./origins.ts"
export { allowedBy, originMatches, originOf, parseOriginPattern } from "./origins.ts"

export {
  DEFAULT_POLICY,
  listPolicies,
  loadPolicy,
  POLICIES_DIRECTORY,
  policyFrom,
  resolvePolicyPath
} from "./store.ts"

export type { UnsafeRepeat } from "./Repeatability.ts"
export {
  REPEATABLE_JUSTIFICATION_MINIMUM,
  describeUnsafeRepeat,
  unsafeRepeats
} from "./Repeatability.ts"

export type { Declassification, SensitivityPolicy } from "./Sensitivity.ts"
export {
  declassifierFor,
  declassifying,
  nothingDeclassified,
  sensitivityPolicy
} from "./Sensitivity.ts"
