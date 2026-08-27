/**
 * The vocabulary of an Intervention: what automation says when it stops, what an
 * Operator is shown, and what they say when they hand control back.
 *
 * CONTEXT.md defines an Intervention as "the episode in which automation stops, a
 * person takes the live Session, resolves the state, and returns control.
 * Includes the record of what they did." All four of those clauses are types
 * here, because the record is the deliverable: an Intervention nobody can read
 * afterwards is a manual step with extra steps.
 *
 * Nothing in this module knows about HTTP, browsers or Effect services. It is
 * the shape of the episode, so the state machine, the operator interface and the
 * Evidence log all describe the same thing rather than three similar things.
 */

/**
 * What the automation says when it stops.
 *
 * Every field answers a question an Operator asks in the first ten seconds:
 * which capability, which step, what was it trying to do, why did it stop, and
 * what is actually on the screen. `accessibility` is the same YAML the engine
 * itself perceived, so the Operator and the automation are looking at one
 * account of the screen rather than two.
 */
export interface InterventionRequest {
  readonly capability: string
  readonly version: string
  readonly runId: string
  readonly stepId: string
  /** The Step's `intent`, in the Artifact author's words. */
  readonly stepIntent: string
  /** One line. Why automation stopped. */
  readonly reason: string
  /** The longer form: what was expected, and what was there instead. */
  readonly detail: string
  readonly url: string
  /** The accessibility tree at the moment it stopped. */
  readonly accessibility: string
}

/** A raised Intervention: the request, plus who raised it and when. */
export interface Intervention extends InterventionRequest {
  readonly interventionId: string
  /** The live browser Session an Operator is being handed. */
  readonly sessionId: string
  readonly raisedAt: string
}

/** One thing an Operator did while holding the Session, as they described it. */
export interface OperatorAction {
  readonly at: string
  readonly detail: string
}

/**
 * How the Operator classified the state as they handed control back.
 *
 * `resolved` means the screen is now in a state automation can carry on from,
 * and the run resumes. `unresolved` means it is not, and the run ends as
 * `intervention_required` — which is an honest answer rather than a failure,
 * because the automation is not broken and there is nothing to page anyone about.
 *
 * ## Extension point for ticket 13
 *
 * Ticket 13 asks the Operator one further question at this moment — whether
 * automation should handle this state itself next time — and turns the answer
 * into an Artifact Amendment. That is an added field on `ControlReturn` and an
 * added control on the return-of-control form, not a new mechanism: this type,
 * `returnControl`, the `intervention.resolve` Evidence event and the operator
 * interface's `/return` handler are all already the single place it happens.
 *
 * Widening this union is how the answer gets said. `business_outcome` (ticket
 * 13) and `requires_human` (ticket 14) are the two values it grows, and both are
 * classifications of the *state* rather than of this episode — which is the
 * distinction that makes the answer worth storing in an Artifact at all.
 */
export type ControlReturnClassification = "resolved" | "unresolved"

/** What an Operator submits when they hand the Session back. */
export interface ControlReturn {
  /** Who is handing it back. Written into Evidence; never inferred. */
  readonly operator: string
  readonly classification: ControlReturnClassification
  /** What they did, or why they could not. Free text, in their own words. */
  readonly detail: string
}

/**
 * The whole episode, from raise to return.
 *
 * The three checklist questions ticket 12 has to answer — who took control, what
 * they did, and when they returned it — are three fields on this record, and the
 * same three are written into Evidence as they happen. The record is what a
 * caller and the operator interface read; Evidence is what an auditor reads.
 */
export interface InterventionRecord {
  readonly intervention: Intervention
  /** `undefined` until somebody takes control. */
  readonly operator: string | undefined
  readonly tookControlAt: string | undefined
  readonly actions: ReadonlyArray<OperatorAction>
  readonly returnedAt: string | undefined
  /**
   * `unattended` is the machine's own answer when nobody arrived before the
   * wait expired. It is not something an Operator can say.
   */
  readonly classification: ControlReturnClassification | "unattended" | undefined
  readonly detail: string | undefined
}

/**
 * What `pause` returns to the engine once the episode is over.
 *
 * `resumed` is the only question the engine asks. Everything else about the
 * episode is in the record, and the engine deliberately does not branch on it:
 * deciding what an Operator's classification *means* is ticket 13's job, and
 * putting that decision in the executor is how it would end up implied.
 */
export type InterventionOutcome =
  | { readonly resumed: true; readonly record: InterventionRecord }
  | {
      readonly resumed: false
      /** Why the run is not continuing, in a sentence a caller can be given. */
      readonly reason: string
      /** Absent when the pause was refused before any episode began. */
      readonly record: InterventionRecord | undefined
    }

/** A fresh record for a newly raised Intervention. Nobody has touched it yet. */
export const raise = (intervention: Intervention): InterventionRecord => ({
  intervention,
  operator: undefined,
  tookControlAt: undefined,
  actions: [],
  returnedAt: undefined,
  classification: undefined,
  detail: undefined
})
