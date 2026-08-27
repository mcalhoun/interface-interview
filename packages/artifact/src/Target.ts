/**
 * A Target as an Artifact records it: the Surface Adapter's Target, plus the two
 * things a reviewer needs and a driver does not.
 *
 * SPEC user story 16 — "I want each target to record how it is identified and
 * why that strategy was chosen, so that I can judge whether it still works next
 * month" — is the reason these fields are required rather than optional. An
 * unexplained Target is exactly the artefact a reviewer cannot approve, so the
 * schema refuses to hold one.
 *
 * `strategy` is the short label; `robustness` is the argument. Replay records the
 * strategies the adapter *actually* applied alongside the declared one in
 * Evidence, so a Target that starts resolving for a different reason than the one
 * written down is visible in the record rather than silently fine.
 */

import { Schema } from "effect"
import { TargetSchema, type Target } from "@cua/surface"

export const CapabilityTarget = Schema.Struct({
  ...TargetSchema.fields,
  /**
   * How this control is picked out, in a couple of words:
   * `accessible-name`, `scoped-accessible-name`, `caption-label`, `text-near`.
   * Free text rather than an enum, because the ladder of strategies is still
   * growing (ticket 05) and an enum here would have to be revised in lockstep.
   */
  strategy: Schema.String,
  /** Why that strategy, and what would have to change on screen to break it. */
  robustness: Schema.String
})
export type CapabilityTarget = typeof CapabilityTarget.Type

/**
 * Drops the reviewer-facing annotations, leaving what the Surface Adapter takes.
 *
 * The adapter must never see `robustness`: prose about a Target is not part of
 * finding it, and letting the two travel together is how a driver ends up
 * matching on documentation.
 */
export const toSurfaceTarget = (target: CapabilityTarget): Target => {
  const { robustness: _robustness, strategy: _strategy, ...rest } = target
  return rest
}
