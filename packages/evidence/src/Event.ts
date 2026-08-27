/**
 * The Evidence event union: everything either execution mode can record.
 *
 * All thirteen kinds SPEC lists are defined here, at the tracer bullet, even
 * though Replay at this point emits six of them. That is deliberate on two
 * counts. A union that grows a member per ticket is a union nothing can be
 * validated against, and — more importantly — `decide` and the `assist.*` kinds
 * have to exist *and be unreachable from Replay* for ADR-0003's second proof to
 * mean anything. "A Replay run contains no `decide` event" is only a claim worth
 * testing if `decide` is a thing that could have been written.
 *
 * SPEC, "Evidence": assisted recovery gets its own kinds rather than reusing
 * `decide`, so consulting a model during Replay can never hide behind a
 * discovery-shaped event.
 *
 * Every event carries run, session and step identifiers, so Discovery, Replay and
 * Intervention records join up (SPEC user story 63).
 *
 * The `recovery.*` kinds are the one addition to SPEC's list. They are added
 * rather than folded into the existing kinds for exactly the reason SPEC gives
 * for `assist.*` having its own: getting past a transient state unattended must
 * not be able to hide inside an ordinary `action` or a re-run `checkpoint`. See
 * the note above them.
 */

import { Schema } from "effect"

/** The identifiers every event carries, whatever kind it is. */
const Envelope = {
  /** Unique per run. Names the Evidence directory too. */
  runId: Schema.String,
  /** The live browser Session the run holds. Joins Replay to an Intervention. */
  sessionId: Schema.String,
  /** Zero-based, monotonic within a run. Makes ordering assertable. */
  seq: Schema.Int,
  at: Schema.String,
  /** The Step this happened during; absent for run-level events. */
  stepId: Schema.optional(Schema.String)
} as const

const event = <const Kind extends string, Fields extends Schema.Struct.Fields>(
  kind: Kind,
  fields: Fields
) => Schema.Struct({ ...Envelope, kind: Schema.Literal(kind), ...fields })

// ---------------------------------------------------------------------------
// Run level
// ---------------------------------------------------------------------------

const RunStart = event("run.start", {
  /** `replay` or `discovery`. The single most important thing about a run. */
  mode: Schema.Literals(["replay", "discovery"]),
  capability: Schema.String,
  version: Schema.String,
  baseUrl: Schema.String,
  /**
   * Input *names* and whether each is sensitive. Never the values: an Artifact
   * carries no runtime data and neither does its Evidence (ADR-0008).
   */
  inputs: Schema.Array(Schema.Struct({ name: Schema.String, sensitive: Schema.Boolean }))
})

const RunEnd = event("run.end", {
  /** The Result class the caller received. The four of the error taxonomy. */
  result: Schema.Literals(["success", "business_outcome", "intervention_required", "failure"]),
  summary: Schema.String,
  durationMillis: Schema.Int
})

// ---------------------------------------------------------------------------
// Perception and action
// ---------------------------------------------------------------------------

const Observe = event("observe", {
  url: Schema.String,
  title: Schema.String,
  frames: Schema.Array(Schema.String),
  /**
   * The accessibility YAML as observed. This is the largest thing in the file and
   * the reason a run can be reconstructed without a screen recording; it is also
   * the text ticket 08 scrubs.
   */
  accessibility: Schema.String
})

/**
 * A model chose what to do next. **Discovery only.**
 *
 * Replay cannot emit this, and a test over a Replay run's Evidence asserts the
 * kind never appears. That is ADR-0003's secondary proof, the one readable from
 * artifacts alone by someone who does not want to take the type system's word
 * for it.
 */
const Decide = event("decide", {
  rationale: Schema.String,
  action: Schema.String
})

/**
 * Policy was asked, and this is what it said.
 *
 * One of these exists for every Action either mode performs, recorded before the
 * Action reaches the adapter — which is the auditable form of SPEC user story 57.
 * `policy` and `risk` are required rather than optional because the useful
 * question a year later is not "was it allowed" but "under which document, and
 * how did that document classify what it let through", and neither is
 * recoverable from a bare verdict.
 */
const PolicyCheck = event("policy.check", {
  action: Schema.String,
  /** Where the action would land. What an origin allowlist is checked against. */
  subject: Schema.String,
  verdict: Schema.Literals(["allow", "deny"]),
  reason: Schema.String,
  /** Which Policy document was in force. */
  policy: Schema.String,
  /** How that document's vocabulary classifies this Action type. */
  risk: Schema.Literals(["safe", "risky", "unknown"]),
  /** The origin the Action was judged against, absent before a page is open. */
  origin: Schema.optional(Schema.String)
})

const ActionEvent = event("action", {
  action: Schema.String,
  target: Schema.optional(Schema.String),
  /** Which strategy the Artifact declared for this Target. */
  declaredStrategy: Schema.optional(Schema.String),
  /**
   * Which strategies the adapter actually applied, and why it picked what it did.
   * Recorded next to the declared one so a Target that starts resolving for a
   * different reason than the one written down shows up in the record.
   */
  resolvedBy: Schema.optional(Schema.Array(Schema.String)),
  rationale: Schema.optional(Schema.String)
})

const CheckpointEvent = event("checkpoint", {
  description: Schema.String,
  /**
   * Three verdicts, because "the intended state was not reached" is two different
   * things. `outcome` means a Business Outcome branch the Artifact declared
   * matched instead — a terminal, legitimate answer, and emphatically not a
   * `failed`. Anything reading this log to count failures has to be able to tell
   * them apart, so they are separate literals rather than a flag on one.
   */
  verdict: Schema.Literals(["held", "outcome", "failed"]),
  expected: Schema.String,
  observed: Schema.String,
  waitedMillis: Schema.Int
})

const Outcome = event("outcome", {
  /** `SUCCESS`, or the code of a declared Business Outcome the run reached. */
  code: Schema.String,
  detail: Schema.String,
  /**
   * For a Business Outcome: the Checkpoint branch conditions that held, in the
   * Artifact's own words.
   *
   * The code says what the system concluded. This says what it observed in order
   * to conclude it, which is the half a reviewer can check the Artifact against
   * and disagree with. Absent on `SUCCESS`, which concluded nothing.
   */
  matched: Schema.optional(Schema.String)
})

// ---------------------------------------------------------------------------
// Recoverable conditions
// ---------------------------------------------------------------------------

/**
 * Three kinds beyond the thirteen SPEC enumerates, and the argument for them is
 * the same one SPEC makes about `assist.*`: a recovery gets its own kinds rather
 * than borrowing existing ones, so that getting past a transient state can never
 * hide inside an ordinary `action` or a re-run `checkpoint`.
 *
 * Read together they answer the three questions a reviewer has about an
 * unattended recovery, in order — what was detected, what was attempted, and
 * whether it cleared:
 *
 *     recovery.detected  SESSION_EXPIRED at step open-savings-account
 *     recovery.attempt   attempt 1 of 2: signed back on, returned to the step
 *                        -> cleared
 *     recovery.resolved  SESSION_EXPIRED cleared after 1 attempt
 *
 * The Surface Actions a remedy performs are also recorded as ordinary `action`
 * and `policy.check` events, because a remedy's Actions pass through the same
 * Policy chokepoint as a Step's. The bracketing kinds are what make them legible
 * as a recovery rather than as part of the flow.
 */
const RecoveryDetected = event("recovery.detected", {
  /** The declared rule's code, e.g. `TRANSIENT_OVERLAY`. */
  condition: Schema.String,
  /** The rule's own description, so the log explains itself without the Artifact. */
  detail: Schema.String,
  /** The Checkpoint that did not hold, and what was there instead. */
  checkpoint: Schema.String,
  observed: Schema.String,
  url: Schema.String
})

const RecoveryAttempt = event("recovery.attempt", {
  condition: Schema.String,
  /** One-based. `of` is the declared bound, so exhaustion is visible in the log. */
  attempt: Schema.Int,
  of: Schema.Int,
  /** What was actually done, in the remedy's own words. */
  attempted: Schema.Array(Schema.String),
  /**
   * Whether the Step's Checkpoint held when it was evaluated *again* afterwards.
   * Never whether the remedy ran without complaint: that is the assumption this
   * whole mechanism exists to avoid.
   */
  cleared: Schema.Boolean,
  observed: Schema.String,
  waitedMillis: Schema.Int
})

const RecoveryResolved = event("recovery.resolved", {
  condition: Schema.String,
  cleared: Schema.Boolean,
  attempts: Schema.Int,
  detail: Schema.String
})

// ---------------------------------------------------------------------------
// The rest of the recovery ladder. Defined here, emitted by tickets 12 and 15.
// ---------------------------------------------------------------------------

const AssistRequest = event("assist.request", {
  reason: Schema.String,
  question: Schema.String
})

const AssistProposal = event("assist.proposal", {
  proposedOutcome: Schema.String,
  confidence: Schema.Finite,
  rationale: Schema.String
})

const InterventionRaise = event("intervention.raise", {
  reason: Schema.String,
  detail: Schema.String
})

const InterventionHumanAction = event("intervention.human_action", {
  operator: Schema.String,
  detail: Schema.String
})

const InterventionResolve = event("intervention.resolve", {
  operator: Schema.String,
  /** What the Operator said this state means. Ticket 13 and 14 learn from it. */
  classification: Schema.String,
  detail: Schema.String
})

export const EvidenceEvent = Schema.Union([
  RunStart,
  Observe,
  Decide,
  PolicyCheck,
  ActionEvent,
  CheckpointEvent,
  Outcome,
  RecoveryDetected,
  RecoveryAttempt,
  RecoveryResolved,
  AssistRequest,
  AssistProposal,
  InterventionRaise,
  InterventionHumanAction,
  InterventionResolve,
  RunEnd
])
export type EvidenceEvent = typeof EvidenceEvent.Type

/**
 * What a caller supplies; the writer stamps `runId`, `sessionId`, `seq` and `at`.
 *
 * Distributive on purpose: a plain `Omit` over a union keeps only the keys every
 * member shares, which here is `kind` and nothing else — every event would lose
 * its payload and every call site would compile while writing empty records.
 */
export type EvidenceEventBody = EvidenceEvent extends infer Member
  ? Member extends EvidenceEvent
    ? Omit<Member, "runId" | "sessionId" | "seq" | "at">
    : never
  : never

/**
 * The kinds a Replay run may never contain.
 *
 * `assist.*` is conditional — ticket 15 enables it explicitly with `--assist` —
 * so it is not in this list. `decide` is not conditional on anything.
 */
export const KINDS_FORBIDDEN_IN_REPLAY: ReadonlyArray<EvidenceEvent["kind"]> = ["decide"]
