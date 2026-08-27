/**
 * Heritage Core Member Services: a stand-in for a legacy credit-union back-office
 * system with no API. It is the Surface every Capability in this repository is
 * discovered against and replayed against, and it is the test fixture, so its
 * hostility is a feature rather than set dressing. See `render.ts`.
 */

export type { Account, Member } from "./members.ts"
export { findAccount, findMember } from "./members.ts"
export { handle } from "./routes.ts"
export type { LegacyCore, LegacyCoreOptions } from "./server.ts"
export { DEFAULT_PORT, serve } from "./server.ts"
