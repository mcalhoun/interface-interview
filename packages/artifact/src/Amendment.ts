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
 * It writes exactly one kind of change: a state the Capability previously
 * escalated becomes a state it declares. Nothing else. It cannot add a Step,
 * change a Target, retune a bound or touch a `robustness` paragraph, because
 * those are things a person decides and this is a mechanism a person's *answer*
 * drives. The narrowness is the safety property: an Amendment that could rewrite
 * anything would be a code generator with a human rubber stamp, and the reviewer
 * reading the diff would have to check the whole document rather than one
 * addition.
 *
 * ## The ratchet
 *
 * `LearnedClass` is ordered, and `atLeastAsStrictAs` is the comparison every
 * Amendment has to pass. SPEC: "These entries are write-once: no later
 * intervention can downgrade one to `business_outcome`. The rule only tightens."
 *
 * Ticket 13 only ever travels in the `business_outcome` direction, since
 * `requires_human` is the section ticket 14 adds. The rule is written and tested
 * in full anyway — `classificationOf` is the one function that has to learn
 * about a new section, and the refusal it feeds already exists — so that
 * tightening becomes a matter of a document gaining a field rather than an
 * engine gaining a rule.
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
 * The single place the ratchet reads from, and the single function ticket 14
 * extends: when `requiresHuman:` exists, it is one more lookup here, and every
 * refusal below starts enforcing it without changing.
 */
export const classificationOf = (
  artifact: CapabilityArtifact,
  code: string
): LearnedClass | undefined =>
  artifact.outcomes?.[code] !== undefined ? "business_outcome" : undefined

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
   */
  readonly scrub?: (text: string) => string
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
  options: AmendmentOptions = {}
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

  // The scan is over the *finished document*, not over the fields that went into
  // it. Prose is assembled from several places, and a check that looked at each
  // one separately would miss a value that only exists once they are joined.
  // Ticket 11's third gate is here for the same reason.
  const yaml = formatArtifact(amended)
  const scrubbed = options.scrub?.(yaml) ?? yaml
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
