/**
 * Policy: the one place that decides whether an Action may happen.
 *
 * Read `policies/default.yaml` first. It is the statement of what this system may
 * do, and it is meant to be readable without reading any of this package.
 *
 * `Policy.ts` is the vocabulary that file is written in and the risk
 * classification it may not override. `PolicyDocument.ts` is its schema and the
 * checks that make a wrong file refuse to load. `decide.ts` is the whole
 * decision, pure. `origins.ts` is what "an allowed origin" means.
 */

export type { ActionMode, ActionRequest, PolicyVerdict, Risk } from "./Policy.ts"
export {
  ACTION_TYPES,
  ActionMode as ActionModeSchema,
  ActionRequest as ActionRequestSchema,
  Policy,
  PolicyVerdict as PolicyVerdictSchema,
  RISK,
  RISKY_ACTION_TYPES,
  Risk as RiskSchema,
  riskOf
} from "./Policy.ts"

export type { CompiledPolicy, ModeRule, PermittedAction, PolicyDocument } from "./PolicyDocument.ts"
export {
  compilePolicy,
  JUSTIFICATION_MINIMUM,
  ModeRule as ModeRuleSchema,
  parsePolicy,
  PermittedAction as PermittedActionSchema,
  PolicyDocument as PolicyDocumentSchema,
  PolicyInvalid
} from "./PolicyDocument.ts"

export { decide } from "./decide.ts"

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
