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
 * A correspondence assisted recovery proposed, carried to the person who will
 * decide about it.
 *
 * This is data, and it is only ever data. Nothing between here and the Operator
 * acts on it: the Step's Action still names the control the Artifact names, the
 * run is still stopped, and the only thing this changes is what the person on
 * the other end is shown. ADR-0005 draws the line at *acting*, and naming a
 * control is not pressing one — but the line only holds if there is no
 * expression anywhere that turns one of these into a gesture, and there is not.
 *
 * Promoting it into a stored Tenant Override needs a confirmation, exactly as
 * promoting a proposed outcome into a Capability version needs one. See
 * `ProposalAnswer`.
 */
export interface TargetProposal {
  /** The control the Capability asked for and did not find, in its own words. */
  readonly forTarget: string
  /** What the consultation says corresponds to it on this screen. */
  readonly control: string
  /** 0 to 1, as the model gave it. Shown to the Operator, never acted on. */
  readonly confidence: number
  readonly rationale: string
  /** Where the proposal is in this run's Evidence, e.g. `events.jsonl#assist-1`. */
  readonly proposalRef: string
}

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
  /**
   * What assisted recovery proposed about the control that was missing, if it
   * proposed anything.
   *
   * Absent on almost every Intervention, and absent is the honest shape: a run
   * without `--assist`, a stall that is not a missing control, and a
   * consultation that could not tell are three different situations and none of
   * them has a proposal in it.
   */
  readonly proposal?: TargetProposal | undefined
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
 * ## Two axes, kept apart
 *
 * This field answers one question only: **can the run carry on from here?** It
 * is about *this episode*. `nextTime` below answers a different one — what
 * should automation do when it meets this state again — which is about the
 * *state*, and outlives the run entirely.
 *
 * Ticket 13 deliberately did not widen this union with `business_outcome`.
 * Folding the two together would make a state's classification a function of
 * whether one run happened to be resumable, and those are independent: member
 * `88888` is a perfectly good Business Outcome *and* an unresolvable episode,
 * because there is no savings account for anybody to conjure into existence. A
 * union that could not express that would have forced a lie into one field or
 * the other.
 */
export type ControlReturnClassification = "resolved" | "unresolved"

/**
 * The one question, asked once, at return-of-control.
 *
 * SPEC: "The operator UI resolves the ambiguity between rows two and three with
 * a single question at return-of-control: should automation do what you just
 * did, or always stop here? That is a per-case judgment by the person who
 * resolved it, the way real runbooks form, not an upfront policy."
 *
 * One question is the entire learning mechanism, and it is deliberately not
 * enough on its own to say what was learned. It says what the Operator *wants*;
 * what they *did* — `actions`, and specifically whether it is empty — says which
 * kind of thing they are asking for. `classify` in `Learning.ts` is where the two
 * meet, and it is ADR-0004's table.
 *
 * `not_asked` is a real answer and not an absence. A pause that expired, or a
 * return driven by something other than the operator interface, closed without
 * anybody being asked, and a record that said `undefined` would leave a reader
 * unable to tell that from an interface that forgot to ask. Nothing is learned
 * from it either way, which is the point: an unanswered question teaches
 * nothing, and it should take a value to say so.
 */
export type NextTimeAnswer = "automation_handles_it" | "always_stop_here" | "not_asked"

/**
 * The second question, asked only when there is a proposal to ask about.
 *
 * `nextTime` is asked at every return of control, because every episode is about
 * *a state* and the question "what should automation do next time it meets this
 * one" is always well posed. This one is not: it asks whether a specific control
 * on a specific screen is the correspondent of a specific Target, and that
 * question does not exist unless a consultation proposed one. So it is optional
 * on `ControlReturn` — an interface with no proposal on screen must not be made
 * to answer about one — and required on the record, where `not_asked` says
 * plainly that it never came up.
 *
 * `rejected` is a real answer and not the same as `not_asked`. A person who
 * looked at `Find`, decided it is not the search button, and said so has told the
 * system something worth having in the record; a person who was never shown it
 * has not.
 */
export type ProposalAnswer = "confirmed" | "rejected" | "not_asked"

/** How the second question reads on the operator interface and in a report. */
export const THE_PROPOSAL_QUESTION =
  "Assisted recovery could not find one control and proposes a correspondent. Is it right?"

/** What an Operator submits when they hand the Session back. */
export interface ControlReturn {
  /** Who is handing it back. Written into Evidence; never inferred. */
  readonly operator: string
  readonly classification: ControlReturnClassification
  /** What they did, or why they could not. Free text, in their own words. */
  readonly detail: string
  /** Their answer to the one question. Required, so it can never be implied. */
  readonly nextTime: NextTimeAnswer
  /**
   * Whether the proposed correspondent is right. Only meaningful when the
   * Intervention carried a proposal; absent reads as `not_asked`.
   *
   * This is the confirmation ADR-0006 requires before a Tenant Override is
   * written. A model proposed it, this field is a person agreeing, and nothing
   * is stored without both.
   */
  readonly confirmProposal?: ProposalAnswer | undefined
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
  /**
   * What the Operator answered when asked how automation should treat this state
   * next time. `not_asked` until somebody is asked, and after an expiry.
   */
  readonly nextTime: NextTimeAnswer
  /**
   * What the Operator said about the proposed correspondent, or `not_asked`.
   *
   * Required here even though it is optional on `ControlReturn`, for the same
   * reason `nextTime` is: a record a reader cannot tell "they said no" from
   * "nobody asked" is a record that cannot justify what was written from it.
   */
  readonly confirmProposal: ProposalAnswer
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
  detail: undefined,
  nextTime: "not_asked",
  confirmProposal: "not_asked"
})
