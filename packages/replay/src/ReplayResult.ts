/**
 * The result contract: what a caller gets back, and what they are allowed to
 * conclude from it.
 *
 * Four classes. `Success` and `BusinessOutcome` are reachable; the other two are
 * defined and unreachable until tickets 12 and 15. The brief calls the
 * distinction between them the most common design mistake in this problem, and a
 * taxonomy that arrives one class per ticket is a taxonomy that gets bolted onto
 * an engine already shaped around success-or-exception. Defining all four first
 * forced the engine's shape, and it is why adding `BusinessOutcome` at ticket 04
 * changed no signature.
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
  /**
   * `held` for every Step in a Success.
   *
   * `outcome` marks the one Step whose Checkpoint reached a declared Business
   * Outcome; every Step after it is `not_reached`, because they were never
   * attempted. Neither is `failed`, and the distinction is visible in the step
   * list a caller prints without having to consult the result class.
   */
  checkpoint: Schema.Literals(["held", "outcome", "failed", "not_reached"]),
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
  /**
   * Which part of the Target ran out of candidates — `role`, `name`, `label`,
   * `within`, `textNear`, `ordinal`. `role` emptying the set means the screen is
   * not the one expected; `name` emptying it means the control was renamed.
   * That is the distinction a Recovery Ladder branches on, so it is a field
   * rather than a phrase inside `observed`.
   */
  narrowedBy: Schema.optional(Schema.String),
  url: Schema.String
})

/**
 * Two or more controls answer to a Target. Never a coin flip; all are listed.
 *
 * Each candidate is named by its ordinal and the region it sits in, not by role
 * and accessible name alone, because those are not always distinct — three
 * panels on `/fixtures/duplicate-labels` hold a control identical in both. A
 * list that cannot tell its own entries apart is not a report. `remedy` says
 * what to add to the Target, in the Target's own vocabulary.
 */
const TargetAmbiguous = failure("target_ambiguous", {
  target: Schema.String,
  candidates: Schema.Array(Schema.String),
  remedy: Schema.String,
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
 * `MEMBER_NOT_FOUND` is the first. `code` comes from the Artifact's declared
 * outcomes, never inferred by the engine: SPEC is explicit that a state becomes a
 * Business Outcome because of what a human did when they met it, not because a
 * config file named it.
 *
 * A run ending here **succeeded**. It exits zero, its Evidence contains no
 * failure, and every field of `ReplayFailure` is absent because none of them
 * applies — there is no `expected`, no `observed` and no Step to page anyone
 * about. `detail` is the caller-facing sentence from the Artifact's declaration,
 * so what the caller reads is what a reviewer approved.
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
