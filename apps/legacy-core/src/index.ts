/**
 * Heritage Core Member Services: a stand-in for a legacy credit-union back-office
 * system with no API. It is the Surface every Capability in this repository is
 * discovered against and replayed against, and it is the test fixture, so its
 * hostility is a feature rather than set dressing. See `render.ts`.
 */

export type { TransientOptions, TransientState } from "./conditions.ts"
export {
  DEFAULT_OVERLAY_RESPONSES,
  DEFAULT_PANEL_DELAY_MILLIS,
  TRANSIENT_MEMBER,
  transientState
} from "./conditions.ts"
export type { Account, AuthorizationAttempt, Member, Restriction } from "./members.ts"
export {
  authorizationAccepted,
  authorizationAttempted,
  findAccount,
  findMember
} from "./members.ts"
export type { Router } from "./routes.ts"
export type { Tenant } from "./tenants.ts"
export {
  COMMUNITY_CU,
  DEFAULT_TENANT,
  HERITAGE_CORE,
  TENANTS,
  accountNameFor,
  tenantFor
} from "./tenants.ts"
export { router } from "./routes.ts"
export type { LegacyCore, LegacyCoreOptions } from "./server.ts"
export { DEFAULT_PORT, serve } from "./server.ts"
