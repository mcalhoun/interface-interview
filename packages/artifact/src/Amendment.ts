/**
 * Amendment: how a Capability changes because an Intervention taught it
 * something.
 *
 * SPEC's storage rule is the whole reason this module is shaped the way it is:
 *
 * > Immutable versioned files, one per version... Immutability makes "reviewable
 * > before production use" demonstrable.
 *
 * So an Amendment is not an edit. It is a *pure function from one Artifact to
 * another*, and writing the result is a separate act (`writeArtifact`, which
 * refuses to overwrite). Everything a reviewer needs in order to accept or
 * reject the change is therefore visible as a diff between two files that both
 * still exist, and nothing about the mechanism can produce a change that has no
 * previous version to be diffed against.
 *
 * ## What this module will and will not write
 *
 * It writes exactly two kinds of change, and they are the same change seen from
 * two sides: a state the Capability previously escalated **without knowing what
 * it was** becomes a state it declares. `declareLearnedNoMatch` declares one as a
 * Business Outcome the run may answer with; `declareRequiresHuman` declares one
 * as a state that always stops for a person. Nothing else. Neither can add a
 * Step, change a Target, retune a bound or touch a `robustness` paragraph,
 * because those are things a person decides and this is a mechanism a person's
 * *answer* drives. The narrowness is the safety property: an Amendment that could
 * rewrite anything would be a code generator with a human rubber stamp, and the
 * reviewer reading the diff would have to check the whole document rather than
 * one addition.
 *
 * The two are not symmetrical, and must not be. Learning a Business Outcome makes
 * a run finish unattended that previously stopped; learning a requires-human state
 * makes a run stop *better* — sooner, with a name for what it met, and routed to
 * somebody who can act — and never makes it proceed.
 *
 * ## The ratchet
 *
 * `LearnedClass` is ordered, and `atLeastAsStrictAs` is the comparison every
 * Amendment has to pass. SPEC: "These entries are write-once: no later
 * intervention can downgrade one to `business_outcome`. The rule only tightens."
 *
 * Ticket 13 could only ever travel in the `business_outcome` direction, because
 * `requiresHuman:` did not exist to be read yet. It wrote and tested the rule in
 * full anyway, and predicted that `classificationOf` was the single function a
 * new section would have to teach. That turned out to be exactly true: ticket 14
 * added one lookup there and changed nothing else in this file's refusals, and
 * the downgrade SPEC actually names became reachable.
 *
 * **The direction that matters is unreachable from below.** There is no argument
 * a caller of `declareLearnedNoMatch` can make — no answer, no operator, no
 * number of repetitions — that turns a code classified `requires_human` into a
 * Business Outcome. It is not a warning and not a default that could be
 * overridden; there is no parameter to override it with. Frequency is not
 * evidence of safety, so seeing a privileged decision a hundred times reaches the
 * same refusal it reached the first time.
 *
 * ## Nothing here quotes a value
 *
 * An Amendment writes prose into a document that outlives the run, from a record
 * made during a run that had a member number in it. So the finished document is
 * scanned for the run's own sensitive values before it is returned, and a
 * refusal never repeats what it found (ADR-0008, and ticket 11's third gate for
 * the same reason). A leak report that contains the leak is a leak.
 */

import { Result, Schema } from "effect"
import { noMatchCode, noMatchOutcome } from "./Action.ts"
import type { OutcomeDeclaration } from "./BusinessOutcomes.ts"
import type { CapabilityArtifact, Step } from "./CapabilityArtifact.ts"
import { formatArtifact } from "./parse.ts"
import { type RequiresHumanDeclaration, requiresHumanCode } from "./RequiresHuman.ts"

/**
 * The three classes a state can be learned into, in ascending strictness.
 *
 * Defined here rather than beside the Intervention that derives one, because
 * strictness is a fact about what a *document* may claim: `recoverable` sits in
 * the middle because a declared recovery rule still lets a run finish unattended,
 * and `requires_human` is the top because it is the one that permanently costs a
 * person. `@cua/session` derives which of them an episode demonstrated; this is
 * where the ordering they are compared by lives.
 */
export type LearnedClass = "business_outcome" | "recoverable" | "requires_human"

const STRICTNESS: Readonly<Record<LearnedClass, number>> = {
  business_outcome: 0,
  recoverable: 1,
  requires_human: 2
}

/**
 * Whether `proposed` may replace `existing`. The ratchet, in one expression.
 *
 * A state nobody has classified accepts anything. A state already classified
 * accepts only something at least as strict, so seeing a privileged decision a
 * hundred times never turns it into an automated one (ADR-0004).
 */
export const atLeastAsStrictAs = (
  proposed: LearnedClass,
  existing: LearnedClass | undefined
): boolean => existing === undefined || STRICTNESS[proposed] >= STRICTNESS[existing]

/**
 * What this Artifact already says about one code, if anything.
 *
 * The single place the ratchet reads from, and — as ticket 13 wrote it would be —
 * the single function ticket 14 had to extend. One more lookup, and every refusal
 * below started enforcing the downgrade rule with no other change anywhere.
 *
 * **`requiresHuman` is consulted first, and the order is load-bearing.** A
 * document that somehow carried a code in both sections is malformed —
 * `parseArtifact` refuses one — but this function is also called on documents
 * being *built*, before anything has parsed them, and on a malformed one the only
 * safe answer is the stricter of the two. Reading `outcomes` first would make a
 * requires-human entry invisible to the ratchet in exactly the case where a
 * downgrade is being attempted, which is the one case it exists for.
 */
export const classificationOf = (
  artifact: CapabilityArtifact,
  code: string
): LearnedClass | undefined =>
  artifact.requiresHuman?.[code] !== undefined
    ? "requires_human"
    : artifact.outcomes?.[code] !== undefined
      ? "business_outcome"
      : undefined

/** The Amendment was refused. Nothing was written and nothing was changed. */
export class AmendmentRefused extends Schema.TaggedError<AmendmentRefused>()("AmendmentRefused", {
  capability: Schema.String,
  reason: Schema.String
}) {
  override get message(): string {
    return `cannot amend ${this.capability}: ${this.reason}`
  }
}

/**
 * What an Operator's confirmation turns into.
 *
 * The Operator supplies exactly one bit of this — that automation should handle
 * the state itself. Everything else is read off the Artifact and the Intervention
 * record by the caller, which is why none of it is a question on a form.
 */
export interface LearnedBusinessOutcome {
  /** The version being cut. A new file; never one that already exists. */
  readonly version: string
  /** Which Step's unmatched selection is being promoted to an answer. */
  readonly stepId: string
  /** One line, in the caller's terms. What is true of the domain. */
  readonly title: string
  /** Prose for whoever approves this version: what the state is, and why. */
  readonly summary: string
  /**
   * The Intervention that justified it, in a sentence naming the record.
   *
   * Required, not optional. An outcome that appeared in a document with no
   * account of where it came from is the thing this whole mechanism exists to
   * make impossible, and making it a required field is cheaper than a review
   * convention that it should be filled in.
   */
  readonly discoveredFrom: string
}

export interface AmendmentOptions {
  /**
   * The run's own Evidence scrubber, or anything with its shape.
   *
   * An Amendment writes prose into a document that outlives the run, out of a
   * record made *during* a run that had a member number in it. An Operator
   * typing "88888 holds no savings account" into the detail box is an entirely
   * reasonable thing for them to do and an entirely unacceptable thing to
   * commit.
   *
   * A scrubber rather than a list of values, for two reasons. It needs no new
   * `Redacted.value` call site — `test/sensitive-data.test.ts` pins that set at
   * two, and an amendment is not a good enough reason to make it three. And it
   * makes the rule exactly one rule: **what this run's Evidence would have
   * redacted, its Artifact refuses to carry.** A separate list would be a second
   * definition of "sensitive" that could drift from the first.
   *
   * Detection is by comparison. If scrubbing the finished document changes it,
   * the document contains something it should not, and the Amendment is refused
   * without anything having to say what was found.
   *
   * **Required, for the same reason `EvidenceOptions.scrubber` is** (ticket 08).
   * An optional scrubber defaulting to identity does not weaken the guarantee a
   * little: it removes it entirely and silently, because the document is then
   * compared against an unchanged copy of itself and the comparison always
   * matches. Saying no has to be spelled `noScrubbing`, which is a word a
   * reviewer can grep for, rather than an argument somebody left out.
   */
  readonly scrub: (text: string) => string
}

/**
 * Promote a Step's unmatched selection from an escalation into a declared
 * Business Outcome, at a new version.
 *
 * Two lines of the document change and no others:
 *
 *   - the Step's `onNoMatch` stops saying `escalate:` and starts saying
 *     `outcome:` — the same code, reclassified;
 *   - `outcomes:` gains that code, with the prose and the provenance.
 *
 * That is deliberately the entire surface. A reviewer diffing the two versions
 * has to read an added declaration and a changed word, and the mechanism has no
 * way of having done anything else while they were reading.
 */
export const declareLearnedNoMatch = (
  artifact: CapabilityArtifact,
  learned: LearnedBusinessOutcome,
  options: AmendmentOptions
): Result.Result<CapabilityArtifact, AmendmentRefused> => {
  const refuse = (reason: string) =>
    Result.fail(new AmendmentRefused({ capability: artifact.capability, reason }))

  if (learned.version === artifact.version) {
    return refuse(
      `version ${learned.version} is the version being amended. An amendment is a new ` +
        `version beside the old one, so that the two can be diffed`
    )
  }

  const step = artifact.steps.find((candidate) => candidate.id === learned.stepId)
  if (step === undefined) return refuse(`there is no step ${learned.stepId}`)
  if (step.action.type !== "selectFromList") {
    return refuse(
      `step ${learned.stepId} is a ${step.action.type}, and only a selection that matched ` +
        `nothing can be promoted to a declared outcome this way`
    )
  }

  // Already an answer. Not an error worth a stack trace, but not a no-op either:
  // a caller that thinks it is teaching the document something should be told
  // the document already knew.
  const already = noMatchOutcome(step.action.onNoMatch)
  if (already !== undefined) {
    return refuse(
      `step ${learned.stepId} already declares ${already} when its selection matches nothing`
    )
  }

  const code = noMatchCode(step.action.onNoMatch)

  // The ratchet. Today `classificationOf` can only answer `business_outcome`,
  // so this refuses a redeclaration; when ticket 14 adds `requiresHuman:` it
  // starts refusing the downgrade SPEC actually names, with no change here.
  const existing = classificationOf(artifact, code)
  if (!atLeastAsStrictAs("business_outcome", existing)) {
    return refuse(
      `${code} is already classified as ${existing} in this capability. A learned ` +
        `classification only ever tightens: it can never be downgraded to a business outcome`
    )
  }
  if (existing !== undefined) {
    return refuse(`${code} is already a declared business outcome of this capability`)
  }

  const declaration: OutcomeDeclaration = {
    title: learned.title,
    summary: learned.summary,
    discoveredFrom: learned.discoveredFrom
  }

  const amended: CapabilityArtifact = {
    ...artifact,
    version: learned.version,
    outcomes: { ...(artifact.outcomes ?? {}), [code]: declaration },
    steps: artifact.steps.map((candidate): Step =>
      candidate.id === learned.stepId && candidate.action.type === "selectFromList"
        ? { ...candidate, action: { ...candidate.action, onNoMatch: { outcome: code } } }
        : candidate
    )
  }

  return carriesNothingSensitive(amended, options, refuse)
}

/**
 * What an Operator's confirmation turns into on the other side of the ladder.
 *
 * The same five fields `LearnedBusinessOutcome` carries, and deliberately so:
 * what an Operator supplies is one bit either way, and everything else is derived
 * from the Artifact and the Intervention record. A shape that asked for more here
 * than there would be an interface admitting that this decision needs more
 * thought than the other one, which is backwards — this is the decision that can
 * never be taken back.
 */
export interface LearnedRequiresHuman {
  /** The version being cut. A new file; never one that already exists. */
  readonly version: string
  /** Which Step's Checkpoint reaches the state. The whole recognition rule. */
  readonly stepId: string
  /** One line, in the caller's terms. What is true of the domain. */
  readonly title: string
  /** Prose for whoever approves this version: what the state is, and why. */
  readonly summary: string
  /** The Intervention that justified it, in a sentence naming the record. */
  readonly discoveredFrom: string
}

/**
 * Declare that a Step's Checkpoint reaches a state automation must never handle
 * itself, at a new version.
 *
 * One section appears and nothing else moves: `requiresHuman:` gains an entry
 * naming the Step, with the prose and the provenance. No Target, no bound, no
 * assertion changes, because nothing about *how the Capability works* was
 * learned. What was learned is what the state it already stopped on means.
 *
 * ## What this does not do, and it is the point
 *
 * It does not make the state automatable, and there is no version of it that
 * could. The entry has no remedy, no branch and no outcome code a run can return
 * as an answer; the only thing Replay does with one is stop sooner and say a
 * better sentence. SPEC: "The system learns that it must escalate and why. It
 * never learns to proceed."
 *
 * ## Why an existing classification is refused in both directions
 *
 * A code already under `requiresHuman:` is refused because these entries are
 * write-once and a second episode teaches nothing the document does not already
 * say. A code already under `outcomes:` is refused too — even though the ratchet
 * permits that direction — because tightening a declared Business Outcome takes a
 * *value out of the Capability's published contract*, and a caller may already
 * have a branch on it. That is a breaking change to a signature, which is a
 * hand-written version cut by whoever owns the Capability, not something an
 * Intervention performs while nobody is looking. The mechanism refuses to make
 * it and says so rather than quietly declining.
 */
export const declareRequiresHuman = (
  artifact: CapabilityArtifact,
  learned: LearnedRequiresHuman,
  options: AmendmentOptions
): Result.Result<CapabilityArtifact, AmendmentRefused> => {
  const refuse = (reason: string) =>
    Result.fail(new AmendmentRefused({ capability: artifact.capability, reason }))

  if (learned.version === artifact.version) {
    return refuse(
      `version ${learned.version} is the version being amended. An amendment is a new ` +
        `version beside the old one, so that the two can be diffed`
    )
  }

  const step = artifact.steps.find((candidate) => candidate.id === learned.stepId)
  if (step === undefined) return refuse(`there is no step ${learned.stepId}`)

  // Derived, never supplied. See `RequiresHuman.ts`: an Intervention teaches a
  // state's classification, not a capability's vocabulary, and the one place a
  // name for this state can come from is the Step the author already named.
  const code = requiresHumanCode(step.id)

  const existing = classificationOf(artifact, code)
  if (existing === "requires_human") {
    return refuse(
      `${code} is already declared as a state this capability always stops on. These ` +
        `entries are write-once, and a second episode demonstrating the same thing changes ` +
        `nothing about what the document already says`
    )
  }
  if (existing !== undefined) {
    return refuse(
      `${code} is already classified as ${existing} in this capability. Tightening a declared ` +
        `outcome removes a value a caller may already branch on, which is a change to a ` +
        `published contract and belongs in a hand-written version`
    )
  }
  // The same fact from the other side: an Artifact may only classify a Step's
  // checkpoint state once, and `parseArtifact` refuses a document that does it
  // twice. Catching it here means the refusal names the step rather than
  // surfacing as an unparseable document two calls later.
  const alreadyClassified = Object.entries(artifact.requiresHuman ?? {}).find(
    ([, entry]) => entry.step === step.id
  )
  if (alreadyClassified !== undefined) {
    return refuse(
      `step ${step.id} is already classified as ${alreadyClassified[0]}, and a step's ` +
        `checkpoint reaches one classified state`
    )
  }

  const declaration: RequiresHumanDeclaration = {
    step: step.id,
    title: learned.title,
    summary: learned.summary,
    discoveredFrom: learned.discoveredFrom
  }

  const amended: CapabilityArtifact = {
    ...artifact,
    version: learned.version,
    requiresHuman: { ...(artifact.requiresHuman ?? {}), [code]: declaration }
  }

  return carriesNothingSensitive(amended, options, refuse)
}

/**
 * The last gate both Amendments pass, and the only one that reads the finished
 * document.
 *
 * The scan is over the *finished document*, not over the fields that went into
 * it. Prose is assembled from several places, and a check that looked at each one
 * separately would miss a value that only exists once they are joined. Ticket
 * 11's third gate is here for the same reason.
 *
 * Shared rather than repeated, so there is one answer to "what does an Amendment
 * refuse to carry" no matter which kind is being written.
 */
const carriesNothingSensitive = (
  amended: CapabilityArtifact,
  options: AmendmentOptions,
  refuse: (reason: string) => Result.Result<never, AmendmentRefused>
): Result.Result<CapabilityArtifact, AmendmentRefused> => {
  // The type makes the scrubber required; this is the runtime half of the same
  // rule, and it exists because the failure it prevents is silent. A caller that
  // reached here without one would compare the document against an unchanged copy
  // of itself, and every amendment would pass the check that is supposed to be
  // the last thing between an operator's sentence and a stored document.
  if (typeof options.scrub !== "function") {
    return refuse(
      "no scrubber was supplied, so the amended document could not be checked for values " +
        "this run treats as sensitive. The check is not optional (ADR-0008): an amendment " +
        "that cannot be checked is refused rather than written"
    )
  }

  const yaml = formatArtifact(amended)
  const scrubbed = options.scrub(yaml)
  if (scrubbed !== yaml) {
    return refuse(
      `the amended document would carry, on ${countChangedLines(yaml, scrubbed)} line(s), a ` +
        `value this run treats as sensitive. An artifact outlives the run it was learned from ` +
        `and carries no runtime data (ADR-0008). Rewrite the intervention detail without it`
    )
  }
  return Result.succeed(amended)
}

/**
 * How many lines the scrubber rewrote.
 *
 * Never which, and never what. A refusal about a leaked identifier that contains
 * the identifier is a leak produced by the leak check, and it lands in a
 * terminal, a CI log and a ticket. Counting the two copies against each other
 * means working the number out never requires holding the value.
 */
const countChangedLines = (before: string, after: string): number => {
  const left = before.split("\n")
  const right = after.split("\n")
  let changed = 0
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) changed += 1
  }
  return changed
}

/** `1.0.0` -> `1.1.0`. The version an Amendment cuts unless told otherwise. */
export const nextMinorVersion = (version: string): string => {
  const [major = 1, minor = 0] = version.split(".").map(Number)
  return `${major}.${minor + 1}.0`
}
