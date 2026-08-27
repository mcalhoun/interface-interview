/**
 * Session: the single live browser context a run operates in, and the explicit
 * state saying which party is currently permitted to act on it. Ticket 03 builds
 * the guard; ticket 12 builds the transfer that makes it interesting.
 */

export type { ControlOwner } from "./Session.ts"
export {
  automationOwned as automationOwnedSession,
  ControlOwner as ControlOwnerSchema,
  Session,
  SessionNotOwned
} from "./Session.ts"
