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
 * An `at-step` rule that could cause a **risky** Action to be performed a second
 * time is refused unless the rule says in writing why that is safe. Two sources
 * of such an Action, and both count:
 *
 *   1. the rule's own `remedy` Actions, which run every attempt; and
 *   2. every Step's Action, because a rule fires wherever its `detect` matches
 *      and the Artifact does not say which Steps that is.
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
 * Every `at-step` rule in this Artifact that could repeat a risky Action without
 * saying why that is safe. Empty means the Artifact's recovery rules are legal.
 */
export const unsafeRepeats = (artifact: CapabilityArtifact): ReadonlyArray<UnsafeRepeat> => {
  const rules = artifact.recoverable ?? []
  const results: Array<UnsafeRepeat> = []

  for (const rule of rules) {
    if (rule.resume !== "at-step") continue

    const risky = [...new Set(repeatableActionTypes(artifact, rule).filter(isRisky))].sort()
    if (risky.length === 0) continue

    const justification = (rule.repeatable ?? "").trim()
    if (justification.length >= REPEATABLE_JUSTIFICATION_MINIMUM) continue

    results.push({
      condition: rule.condition,
      actions: risky,
      remedy:
        justification === ""
          ? `resume: at-step performs ${risky.join(", ")} a second time. Say in the rule's \`repeatable:\` why that is safe for this capability, or use resume: here.`
          : `the \`repeatable:\` justification for ${risky.join(", ")} is ${justification.length} characters; at least ${REPEATABLE_JUSTIFICATION_MINIMUM} are required, because a one-line assurance is not an argument.`
    })
  }

  return results
}

/** The sentence the engine and the CLI both report. One wording, one meaning. */
export const describeUnsafeRepeat = (unsafe: UnsafeRepeat): string =>
  `recoverable condition ${unsafe.condition}: ${unsafe.remedy}`

/**
 * Every Action type an `at-step` rule could cause to be performed again.
 *
 * The Steps are included wholesale rather than narrowed to the ones the rule
 * might fire at, because nothing in the Artifact says which Steps a `detect`
 * matches. Guessing narrower would make the check pass on a document whose
 * riskiest Step is exactly the one the condition shows up at.
 */
const repeatableActionTypes = (
  artifact: CapabilityArtifact,
  rule: RecoverableCondition
): ReadonlyArray<string> => [
  ...rule.remedy.map((remedy) => remedy.action.type),
  ...artifact.steps.map((step) => step.action.type)
]

const isRisky = (type: string): boolean => riskOf(type) === "risky"
