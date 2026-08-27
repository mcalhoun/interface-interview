/**
 * Policy: the one place that decides whether an Action may happen. Ticket 03
 * builds the chokepoint every Action passes through; ticket 07 fills in the
 * origin and action-type allowlists and the conservative treatment of risky
 * Actions.
 */

export type { ActionRequest, PolicyVerdict } from "./Policy.ts"
export {
  ActionRequest as ActionRequestSchema,
  permissive as permissivePolicy,
  Policy,
  PolicyVerdict as PolicyVerdictSchema
} from "./Policy.ts"
