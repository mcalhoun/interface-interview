/**
 * Whether a Capability's recovery rules may re-perform its Actions.
 *
 * ## The gap this closes
 *
 * A Recoverable Condition that resumes `at-step` navigates back to where a Step
 * began and **attempts the Step's Action again**. That is exactly right for a
 * read: a search re-run returns the same screen. It is exactly wrong for a
 * transfer. Ticket 06 shipped the mechanism and said so out loud — "`at-step`
 * re-attempts a Step's Action, so it is only as safe as that Action is
 * repeatable" — and nothing stopped an Artifact from declaring one over an
 * irreversible Action.
 *
 * ## Why the check is here and not in the schema
 *
 * `RISK` in `Policy.ts` is the one classification of what an Action can cost, and
 * a second table in `@cua/artifact` that a document could disagree with would be
 * worth less than none. So the risk question is asked here, where the answer
 * already lives, and `@cua/artifact` carries only the field the author writes the
 * justification into. The import of the Artifact's types is type-only, so
 * `@cua/policy` still has no runtime dependency on `@cua/artifact` — ticket 07's
 * arrangement is unchanged.
 *
 * ## The rule
 *
 * A recovery rule that could cause a **risky** Action to be performed a second
 * time is refused unless the rule says in writing why that is safe. Two sources
 * of such an Action, and they are reached by different routes:
 *
 *   1. **the rule's own `remedy` Actions, whatever `resume` says.** The engine
 *      runs the whole remedy once per attempt (`recovery.ts`, the `attempt`
 *      generator) and `resume` decides only what happens *after* it. So a rule
 *      with `attempts: 3` performs every remedy Action up to three times, and a
 *      `resume: here` rule is no exception. This counts when `attempts > 1`;
 *      at `attempts: 1` the remedy runs once and once is not a repeat.
 *   2. **every Step's Action, when `resume` is `at-step`.** Resuming there
 *      returns to where the Step began and attempts its Action again, and
 *      nothing in the Artifact says which Steps a `detect` matches, so all of
 *      them count. A `resume: here` rule re-evaluates the Checkpoint where it
 *      stands and performs no Step Action, so the Steps do not count for one.
 *
 * The `at-step` filter therefore applies to the second source only. An earlier
 * version skipped every `resume: here` rule outright, on the reasoning that such
 * a rule "repeats nothing" — which was true of the Steps and false of the remedy,
 * and left a risky remedy Action free to run `attempts` times with no
 * justification at all. That is precisely the silent re-performance of an
 * irreversible Action this check exists to stop.
 *
 * This is ticket 07's precedent one layer up: a risky action cannot be permitted
 * silently, and the justification travels with the permission. A read-only
 * Capability needs no ceremony — every Action is `safe`, so nothing is required.
 * A Capability that moved money would have to argue for the retry in the document
 * a person approves, next to the rule it belongs to, and "this posts a transfer"
 * is an argument nobody signs.
 *
 * Pure and total. The engine runs it before a run performs anything, and the CLI
 * runs it before a browser is even asked for, so a bad rule is refused rather
 * than fired.
 */

import type { CapabilityArtifact, RecoverableCondition } from "@cua/artifact"
import { riskOf } from "./Policy.ts"

/** How much justification an `at-step` rule has to carry to be believed. */
export const REPEATABLE_JUSTIFICATION_MINIMUM = 80

/** One reason a declared recovery rule may not re-perform an Action. */
export interface UnsafeRepeat {
  /** The rule's code, e.g. `SESSION_EXPIRED`. */
  readonly condition: string
  /** The risky action types the rule could cause to happen twice. */
  readonly actions: ReadonlyArray<string>
  /** What a reviewer has to do about it, in the document's own words. */
  readonly remedy: string
}

/**
 * Every recovery rule in this Artifact that could repeat a risky Action without
 * saying why that is safe. Empty means the Artifact's recovery rules are legal.
 *
 * Both `resume` values are examined. `at-step` is not a precondition of the check
 * — it decides only whether the Capability's Steps are one of the things that
 * could happen twice.
 */
export const unsafeRepeats = (artifact: CapabilityArtifact): ReadonlyArray<UnsafeRepeat> => {
  const rules = artifact.recoverable ?? []
  const results: Array<UnsafeRepeat> = []

  for (const rule of rules) {
    const fromRemedy = riskyOnce(repeatedRemedyActionTypes(rule))
    const fromSteps = riskyOnce(resumedStepActionTypes(artifact, rule))
    const risky = [...new Set([...fromRemedy, ...fromSteps])].sort()
    if (risky.length === 0) continue

    const justification = (rule.repeatable ?? "").trim()
    if (justification.length >= REPEATABLE_JUSTIFICATION_MINIMUM) continue

    results.push({
      condition: rule.condition,
      actions: risky,
      remedy:
        justification === ""
          ? `${describeCauses(rule, fromRemedy, fromSteps)}. Say in the rule's \`repeatable:\` why that is safe for this capability, or ${describeFix(fromRemedy, fromSteps)}.`
          : `the \`repeatable:\` justification for ${risky.join(", ")} is ${justification.length} characters; at least ${REPEATABLE_JUSTIFICATION_MINIMUM} are required, because a one-line assurance is not an argument.`
    })
  }

  return results
}

/** The distinct risky types in a list, in a stable order. */
const riskyOnce = (types: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(types.filter(isRisky))].sort()

/**
 * Why this rule is refused, said in terms of the field that causes it, so a
 * reviewer can see which half of the document to argue for or change.
 */
const describeCauses = (
  rule: RecoverableCondition,
  fromRemedy: ReadonlyArray<string>,
  fromSteps: ReadonlyArray<string>
): string => {
  const causes: Array<string> = []
  if (fromSteps.length > 0) {
    causes.push(`resume: at-step performs a step's ${fromSteps.join(", ")} a second time`)
  }
  if (fromRemedy.length > 0) {
    causes.push(
      `attempts: ${rule.attempts} runs this rule's own remedy up to ${rule.attempts} times, ` +
        `performing ${fromRemedy.join(", ")} more than once`
    )
  }
  return causes.join("; and ")
}

/** The other way out, which is to stop the repetition rather than argue for it. */
const describeFix = (
  fromRemedy: ReadonlyArray<string>,
  fromSteps: ReadonlyArray<string>
): string => {
  const fixes: Array<string> = []
  if (fromSteps.length > 0) fixes.push("use resume: here")
  if (fromRemedy.length > 0) fixes.push("set attempts: 1")
  return fixes.join(" and ")
}

/** The sentence the engine and the CLI both report. One wording, one meaning. */
export const describeUnsafeRepeat = (unsafe: UnsafeRepeat): string =>
  `recoverable condition ${unsafe.condition}: ${unsafe.remedy}`

/**
 * The rule's own remedy Actions, when the rule can run them more than once.
 *
 * `resume` is not consulted. The engine performs the whole remedy at the top of
 * every attempt and only then asks where to resume, so the number of times a
 * remedy Action happens is `attempts` and nothing else. At `attempts: 1` the
 * remedy runs once, which is not a repeat and needs no argument.
 */
const repeatedRemedyActionTypes = (rule: RecoverableCondition): ReadonlyArray<string> =>
  rule.attempts > 1 ? rule.remedy.map((remedy) => remedy.action.type) : []

/**
 * Every Step Action an `at-step` rule could cause to be performed again, and
 * none for a rule that resumes `here`.
 *
 * The Steps are included wholesale rather than narrowed to the ones the rule
 * might fire at, because nothing in the Artifact says which Steps a `detect`
 * matches. Guessing narrower would make the check pass on a document whose
 * riskiest Step is exactly the one the condition shows up at.
 */
const resumedStepActionTypes = (
  artifact: CapabilityArtifact,
  rule: RecoverableCondition
): ReadonlyArray<string> =>
  rule.resume === "at-step" ? artifact.steps.map((step) => step.action.type) : []

const isRisky = (type: string): boolean => riskOf(type) === "risky"
