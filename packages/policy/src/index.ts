/**
 * Policy: the one place that decides whether an Action may happen, and the one
 * place that decides which parameters may be written down in the clear.
 *
 * Ticket 03 builds the Action chokepoint; ticket 08 adds the sensitivity
 * allowlist (`Sensitivity.ts`); ticket 07 fills in the origin and action-type
 * allowlists and the conservative treatment of risky Actions.
 */

export type { ActionRequest, PolicyVerdict } from "./Policy.ts"
export {
  ActionRequest as ActionRequestSchema,
  permissive as permissivePolicy,
  Policy,
  PolicyVerdict as PolicyVerdictSchema
} from "./Policy.ts"

export type { Declassification, SensitivityPolicy } from "./Sensitivity.ts"
export {
  declassifierFor,
  declassifying,
  nothingDeclassified,
  sensitivityPolicy
} from "./Sensitivity.ts"
