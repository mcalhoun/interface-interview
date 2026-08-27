/**
 * The result contract: what a caller gets back, and what they are allowed to
 * conclude from it.
 *
 * Four classes, all four defined now even though only `Success` is reachable at
 * this ticket. The brief calls the distinction between them the most common
 * design mistake in this problem, and a taxonomy that arrives one class per
 * ticket is a taxonomy that gets bolted onto an engine already shaped around
 * success-or-exception. Defining all four first forces the engine's shape.
 *
 * | Class                  | Means                                        | The caller should |
 * | ---------------------- | -------------------------------------------- | ----------------- |
 * | `Success`              | The flow completed and produced its outputs   | use the outputs |
 * | `BusinessOutcome`      | The application answered, and the answer is a legitimate domain result | branch on `code` |
 * | `InterventionRequired` | Nothing could be decided safely; a person has the session | wait or hand off |
 * | `Failure`              | The automation is broken, not the record       | page someone |
 *
 * `BusinessOutcome` is not an error. A run ending in one is a *successful* run,
 * exits zero, and reports no failure anywhere (ticket 04's checklist says so
 * explicitly). That is the whole point of separating it from `Failure`.
 *
 * ## Why this is a Schema rather than a plain union
 *
 * A result gets written into Evidence and, later, returned across a process
 * boundary to a calling agent. Encoding it through the same schema that types it
 * keeps those two from drifting.
 *
 * ## Seams
 *
 *   - ticket 04 constructs `BusinessOutcome` from a Checkpoint's declared outcome
 *     branch. The class and its `code` field need no change.
 *   - ticket 12 constructs `InterventionRequired`. It carries the Session id
 *     because an Operator has to be able to find the browser window.
 *   - ticket 15 sets `assisted` on a `BusinessOutcome` reached through Assisted
 *     Recovery, so a caller can always tell a deterministic outcome from a
 *     proposed one (user story 37) and reliability scoring is never inflated by
 *     one (user story 38).
 */

import { Schema } from "effect"
import { OutputValuesSchema } from "@cua/artifact"

/**
 * One Step as it actually ran.
 *
 * The sequence of these is what the determinism test compares between two runs:
 * identical outputs are necessary but not sufficient, because two different
 * paths through a UI can arrive at the same number.
 */
export const StepRecord = Schema.Struct({
  id: Schema.String,
  intent: Schema.String,
  action: Schema.String,
  /** `held` for every Step in a Success. */
  checkpoint: Schema.Literals(["held", "failed", "not_reached"]),
  /** What the Step read, for `extract` Steps. Absent otherwise. */
  read: Schema.optional(Schema.String)
})
export type StepRecord = typeof StepRecord.Type

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Every failure names the Step, what was expected and what was observed.
 *
 * SPEC user story 29: "I want a failure to tell me the step, what was expected
 * and what was observed, so that I diagnose without re-running." Those three
 * fields are required on every member of this union, including the ones where
 * "expected" is a slightly awkward fit, because a diagnostic that is sometimes
 * present is a diagnostic nobody relies on.
 */
const failure = <const Reason extends string, Fields extends Schema.Struct.Fields>(
  reason: Reason,
  fields: Fields
) =>
  Schema.Struct({
    reason: Schema.Literal(reason),
    stepId: Schema.String,
    stepIntent: Schema.String,
    expected: Schema.String,
    observed: Schema.String,
    ...fields
  })

/** The Action ran, and the state it was supposed to reach was not reached. */
const CheckpointFailed = failure("checkpoint_failed", {
  checkpoint: Schema.String,
  waitedMillis: Schema.Int,
  /** The accessibility tree at the moment of failure. What the automation saw. */
  accessibility: Schema.String,
  url: Schema.String
})

/**
 * Nothing on screen answers to a Target.
 *
 * Distinct from ambiguity on purpose: SPEC treats zero matches as "as likely to
 * be domain truth as breakage", so ticket 05 routes this into the Recovery
 * Ladder while ambiguity stays a Hard Failure. The result classes have to be
 * distinguishable before that can be true (ticket 05's checklist).
 */
const TargetMissing = failure("target_missing", {
  target: Schema.String,
  url: Schema.String
})

/** Two or more controls answer to a Target. Never a coin flip; all are listed. */
const TargetAmbiguous = failure("target_ambiguous", {
  target: Schema.String,
  candidates: Schema.Array(Schema.String),
  url: Schema.String
})

/**
 * A `selectFromList` read the live list and nothing in it matched.
 *
 * Distinct from `target_missing`, and the distinction is the diagnostic. A
 * missing Target says a control is not there and leaves open whether the screen
 * changed or the member simply has no such thing. A no-match says the list
 * rendered perfectly, here is everything it offered, and none of it carries the
 * tokens that were asked for — which is usually the domain saying no. Ticket 13
 * turns exactly this into a declared Business Outcome.
 */
const NoMatchingItem = failure("no_matching_item", {
  /** The Artifact's declared `onNoMatch.escalate` code. */
  code: Schema.String,
  list: Schema.String,
  /** Every label that *was* on offer. The first thing anyone wants to see. */
  items: Schema.Array(Schema.String),
  url: Schema.String
})

/**
 * A `selectFromList` matched two or more items.
 *
 * Always a Hard Failure, never a coin flip (ADR-0007). Where a no-match is often
 * domain truth, an ambiguous match means the Capability has stopped being
 * precise enough about what it wants, and picking one would be a silently wrong
 * answer in a system where the wrong account is the worst outcome available.
 */
const AmbiguousMatch = failure("ambiguous_match", {
  /** The Artifact's declared `onMultiple.escalate` code. */
  code: Schema.String,
  list: Schema.String,
  candidates: Schema.Array(Schema.String),
  url: Schema.String
})

/** The Surface could not be reached or operated at all. */
const SurfaceFailed = failure("surface_failed", {})

/** Policy said no. Ticket 07 produces these; the class exists so it need not. */
const PolicyViolation = failure("policy_violation", {
  action: Schema.String,
  subject: Schema.String
})

/** The screen was reached and read, but not as the declared output type. */
const OutputUnreadable = failure("output_unreadable", {
  output: Schema.String
})

/** The engine tried to act while an Operator held the Session (ticket 12). */
const ControlLost = failure("control_lost", {
  owner: Schema.String
})

/** Evidence could not be written. A run nobody can audit did not usefully happen. */
const EvidenceFailed = failure("evidence_failed", {
  path: Schema.String
})

/**
 * The Artifact parsed but could not be carried out — a value a Step needed was
 * never supplied and had no default.
 *
 * In ticket 11's terms this is a compiler bug rather than a Surface problem, and
 * it says so, because the two demand completely different responses.
 */
const ArtifactUnexecutable = failure("artifact_unexecutable", {})

export const ReplayFailure = Schema.Union([
  CheckpointFailed,
  TargetMissing,
  TargetAmbiguous,
  NoMatchingItem,
  AmbiguousMatch,
  SurfaceFailed,
  PolicyViolation,
  OutputUnreadable,
  ControlLost,
  EvidenceFailed,
  ArtifactUnexecutable
])
export type ReplayFailure = typeof ReplayFailure.Type

/**
 * A failure minus the two fields the engine always fills in for itself.
 *
 * Distributive on purpose: a plain `Omit` over a union keeps only the keys every
 * member shares, which would quietly erase `candidates`, `accessibility` and the
 * rest — the very fields that make a failure diagnosable.
 */
export type ReplayFailureBody = ReplayFailure extends infer Member
  ? Member extends ReplayFailure
    ? Omit<Member, "stepId" | "stepIntent">
    : never
  : never

// ---------------------------------------------------------------------------
// The four classes
// ---------------------------------------------------------------------------

const Common = {
  capability: Schema.String,
  version: Schema.String,
  runId: Schema.String,
  sessionId: Schema.String,
  /** Where to read the full record of this run. Printed by the CLI. */
  evidenceDirectory: Schema.String,
  steps: Schema.Array(StepRecord)
} as const

const Success = Schema.Struct({
  result: Schema.Literal("success"),
  ...Common,
  outputs: OutputValuesSchema
})

/**
 * The application answered, and the answer is part of its domain.
 *
 * Ticket 04's `MEMBER_NOT_FOUND` is the first. `code` comes from the Artifact's
 * declared outcomes, never inferred by the engine: SPEC is explicit that a state
 * becomes a Business Outcome because of what a human did when they met it, not
 * because a config file named it.
 */
const BusinessOutcome = Schema.Struct({
  result: Schema.Literal("business_outcome"),
  ...Common,
  code: Schema.String,
  detail: Schema.String,
  /**
   * True when Assisted Recovery proposed this rather than the Artifact declaring
   * it (ticket 15). An assisted result never counts as deterministic.
   */
  assisted: Schema.optional(Schema.Boolean),
  confidence: Schema.optional(Schema.Finite)
})

/** Automation stopped and a person has the live Session (ticket 12). */
const InterventionRequired = Schema.Struct({
  result: Schema.Literal("intervention_required"),
  ...Common,
  reason: Schema.String,
  stepId: Schema.String,
  /** What the screen showed when it stopped, so an Operator has context. */
  accessibility: Schema.String
})

const Failure = Schema.Struct({
  result: Schema.Literal("failure"),
  ...Common,
  failure: ReplayFailure
})

export const ReplayResult = Schema.Union([
  Success,
  BusinessOutcome,
  InterventionRequired,
  Failure
])
export type ReplayResult = typeof ReplayResult.Type

/** The class only, for switching without destructuring. */
export type ReplayResultClass = ReplayResult["result"]

/** One line a human reads first: the CLI's headline and `run.end`'s summary. */
export const describeResult = (result: ReplayResult): string => {
  switch (result.result) {
    case "success":
      return `success: ${Object.keys(result.outputs).length} output(s) over ${result.steps.length} step(s)`
    case "business_outcome":
      return `business outcome ${result.code}: ${result.detail}`
    case "intervention_required":
      return `intervention required at step ${result.stepId}: ${result.reason}`
    case "failure":
      return `failure at step ${result.failure.stepId} (${result.failure.reason}): expected ${result.failure.expected}, observed ${result.failure.observed}`
  }
}
