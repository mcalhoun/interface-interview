/**
 * Where a value used by a Step comes from.
 *
 * Discovery records Provenance on every value it uses: derived from the Goal,
 * read off an earlier screen, or genuinely fixed (SPEC, "Parameter discovery
 * through provenance"). Compilation turns each of those into one of the three
 * references below and throws the runtime literal away. A stored Capability
 * Artifact therefore has nowhere to put a member number, which is what makes
 * ADR-0008's "no runtime value survives into an Artifact" a property of the
 * schema rather than a habit.
 *
 * The discriminator is a plain `from:` key rather than Effect's `_tag`, because
 * an Artifact is read by people. `{ from: parameter, name: memberId }` says what
 * it means in a YAML diff; `{ _tag: "Parameter", name: "memberId" }` does not.
 */

import { Schema } from "effect"

/** Supplied by the caller at Replay time, against a declared input. */
export const ParameterRef = Schema.Struct({
  from: Schema.Literal("parameter"),
  name: Schema.String
})

/**
 * Fixed in the Artifact. A path, a caption, a code — never a value that varied
 * between runs. ADR-0008: compilation rejects a constant echoing the Goal, which
 * is how a member id would otherwise quietly get baked in.
 */
export const ConstantRef = Schema.Struct({
  from: Schema.Literal("constant"),
  text: Schema.String
})

/**
 * Read off the Surface by an earlier Step. SPEC calls this `uiDerived`
 * provenance; a Step that extracts binds its reading under the Step's own id, so
 * `{ from: step, step: read-available-balance }` needs no second name to track.
 */
export const StepRef = Schema.Struct({
  from: Schema.Literal("step"),
  step: Schema.String
})

export const ValueRef = Schema.Union([ParameterRef, ConstantRef, StepRef])
export type ValueRef = typeof ValueRef.Type

/** Renders a reference the way it reads in an Evidence event or a failure report. */
export const describeValueRef = (ref: ValueRef): string => {
  switch (ref.from) {
    case "parameter":
      return `parameter ${ref.name}`
    case "constant":
      return `the constant ${JSON.stringify(ref.text)}`
    case "step":
      return `what step ${ref.step} read`
  }
}
