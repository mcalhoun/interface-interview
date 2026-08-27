/**
 * Session: the single live browser context a run operates in, and the explicit
 * state saying which party is currently permitted to act on it.
 *
 * `Session` is what the Replay engine holds — claim, and pause. `SessionControl`
 * is what the operator interface holds — take, act, return. They are two views of
 * one `Ref`, kept apart so that the engine has no way of handing control back to
 * itself. See `Session.ts` for the transition table and `Handoff.ts` for the
 * machine.
 */

export type {
  ControlReturn,
  ControlReturnClassification,
  Intervention,
  InterventionOutcome,
  InterventionRecord,
  InterventionRequest,
  OperatorAction
} from "./Intervention.ts"

export type { ControlOwner } from "./Session.ts"
export {
  automationOwned as automationOwnedSession,
  ControlOwner as ControlOwnerSchema,
  describeOwner,
  Session,
  SessionNotOwned
} from "./Session.ts"

export type { HandoffSnapshot, OwnerTransition, SessionControlOptions } from "./Handoff.ts"
export {
  DEFAULT_HANDOFF_WAIT_MILLIS,
  handoffSession,
  HandoffRefused,
  SessionControl,
  sessionControl
} from "./Handoff.ts"
