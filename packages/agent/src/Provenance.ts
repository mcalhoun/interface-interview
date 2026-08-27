/**
 * Provenance: where a value the model typed actually came from.
 *
 * This is the subtlest thing in the Discovery loop and the reason ticket 11 can
 * derive a Capability's input schema mechanically instead of guessing at it.
 *
 * SPEC, "Parameter discovery through provenance": `fill` cannot take a bare
 * string. Every value carries one of three origins, and the compiler reads them
 * rather than a human writing an input schema by hand:
 *
 *   - `goalDerived` — the value came out of the Goal, and the model names the
 *     semantic role it inferred (`memberId`). Each distinct name becomes a
 *     declared input; each use becomes a parameter reference; the literal is
 *     thrown away.
 *   - `uiDerived` — the value was read off an earlier screen. It becomes a
 *     reference to the Step that read it.
 *   - `constant` — the value is genuinely fixed and belongs in the document.
 *
 * ## The checks, and why they are here rather than in the compiler
 *
 * A tag is only worth what it costs to get wrong. Nothing stops a model from
 * labelling `12345` a `constant`, and if nothing checks, ticket 11 writes a
 * member number into a stored Capability. So both directions are checked at the
 * moment the model proposes the value, against the Goal text it was given:
 *
 *   - **A `goalDerived` value must be in the Goal.** Every token of the literal
 *     has to appear in the Goal text. `12345` is; `Primary Savings` is not, when
 *     the Goal said "savings". This is the check that enforces ticket 09's
 *     warning — see `Selection.ts` — and it is the same `isTokenSubsetOf` the
 *     Surface uses to match a list item, applied a third time.
 *   - **A `constant` must not be in the Goal.** This is ADR-0008's second half
 *     ("a `constant` colliding with the goal is a compile error") moved one stage
 *     earlier. `bakedInLiterals` in `@cua/artifact` is the backstop at emission;
 *     catching it here means the model is told to re-tag and the run continues,
 *     rather than the whole discovery being thrown away at the end.
 *
 * A rejection is a value, never a throw: it goes back to the model as the result
 * of its proposal, and it tries again. That is what makes a mis-tag a recoverable
 * conversation rather than a failed run.
 */

import { isTokenSubsetOf } from "@cua/surface"
import { Schema } from "effect"

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * A value derived from the Goal, named with the semantic role the model inferred
 * from the Goal text and the field's own label.
 *
 * `name` is the load-bearing half. `literal` is discarded by the compiler; `name`
 * becomes the declared input, so `memberId` and `member_number_field` produce
 * very different Capabilities from the same run.
 */
const GoalDerived = Schema.Struct({
  kind: Schema.Literal("goalDerived"),
  /**
   * The semantic role, in the caller's vocabulary rather than the screen's:
   * `memberId`, not `Member Number`. This becomes a declared input name.
   */
  name: Schema.String,
  /** The characters to type on this run. Thrown away when the Artifact is written. */
  literal: Schema.String
})

/** A value read off an earlier screen. Becomes a reference to the Step that read it. */
const UiDerived = Schema.Struct({
  kind: Schema.Literal("uiDerived"),
  /** The id of an earlier `extract` step whose reading this is. */
  fromStep: Schema.String
})

/**
 * A value that is genuinely fixed and belongs in the stored document.
 *
 * Checked against the Goal, because this is the tag a lazy or hurried model
 * reaches for when it cannot be bothered to name a parameter, and it is the one
 * that silently bakes a member identifier into a Capability.
 */
const Constant = Schema.Struct({
  kind: Schema.Literal("constant"),
  literal: Schema.String
})

export const ProvenancedValue = Schema.Union([GoalDerived, UiDerived, Constant])
export type ProvenancedValue = typeof ProvenancedValue.Type

export type GoalDerivedValue = typeof GoalDerived.Type

/** Renders a value's origin for Evidence, without quoting a sensitive literal. */
export const describeProvenance = (value: ProvenancedValue): string => {
  switch (value.kind) {
    case "goalDerived":
      return `goal-derived parameter ${value.name}`
    case "uiDerived":
      return `read by step ${value.fromStep}`
    case "constant":
      return `the fixed value ${JSON.stringify(value.literal)}`
  }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** Why a proposed value's provenance was refused, in words meant for the model. */
export interface MistaggedValue {
  readonly complaint: string
}

/**
 * Whether a value's declared origin survives contact with the Goal.
 *
 * `readings` is the set of Step ids that have actually read something, so a
 * `uiDerived` value cannot point at a Step that read nothing — the same
 * referential check `parseArtifact` makes, made early enough to be fixable.
 *
 * Returns `undefined` when the tag holds. A complaint is phrased at the model,
 * because that is who receives it.
 */
export const checkProvenance = (
  value: ProvenancedValue,
  goal: string,
  readings: ReadonlySet<string>
): MistaggedValue | undefined => {
  switch (value.kind) {
    case "goalDerived": {
      if (value.name.trim() === "") {
        return {
          complaint:
            "a goalDerived value must name the semantic role you inferred, e.g. \"memberId\". " +
            "The name becomes a parameter of the capability, so it cannot be blank."
        }
      }
      if (!isTokenSubsetOf(value.literal, goal)) {
        return {
          complaint:
            `you tagged ${JSON.stringify(value.literal)} as goalDerived, but it does not appear ` +
            `in the goal. Every word of a goal-derived value has to come from the goal text. ` +
            `If you read this value off the screen, tag it uiDerived and name the step that ` +
            `read it. If it is genuinely fixed, tag it constant.`
        }
      }
      return undefined
    }
    case "uiDerived": {
      if (!readings.has(value.fromStep)) {
        const known = [...readings]
        return {
          complaint:
            `no step called ${JSON.stringify(value.fromStep)} has read anything yet. ` +
            (known.length === 0
              ? "Nothing has been extracted on this run, so no value can come from an earlier screen."
              : `Steps that have read something: ${known.join(", ")}.`)
        }
      }
      return undefined
    }
    case "constant": {
      // ADR-0008, enforced at proposal time rather than at emission. Containment
      // rather than equality, because `Member 12345` is the shape the mistake
      // actually takes.
      if (isTokenSubsetOf(value.literal, goal)) {
        return {
          complaint:
            `you tagged ${JSON.stringify(value.literal)} as a constant, but it comes from the ` +
            `goal. A constant is written into the stored capability verbatim, so a value out ` +
            `of the goal would bake this run's data into every future run. Tag it goalDerived ` +
            `and name the parameter it should become.`
        }
      }
      return undefined
    }
  }
}
