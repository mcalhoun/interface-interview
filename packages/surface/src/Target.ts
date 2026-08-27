/**
 * A Target: a logical description of a control, written the way an operator
 * would say it.
 *
 * Every field here is something visible in the accessibility tree. There is no
 * `selector`, no `css`, no `xpath`, no coordinate and no frame. That is not an
 * omission to be filled in later — it is the whole point of
 * docs/adr/0001-accessibility-tree-is-the-only-observation-channel.md. A model
 * that cannot see markup cannot emit a selector, and a Target that has nowhere
 * to put one cannot carry it.
 *
 * The schema is here rather than a bare TypeScript type because Discovery's
 * action vocabulary validates model output against it, so an out-of-vocabulary
 * field is rejected at the boundary instead of being quietly ignored.
 */

import { Schema } from "effect"

/**
 * A region to search inside, named by what an operator sees at the top of it.
 *
 * `{ name: "Member Number Search" }` means the panel captioned that way, even
 * though in the accessibility tree the caption is a sibling cell in the panel's
 * first row rather than an ancestor of anything.
 */
export const TargetScope = Schema.Struct({
  role: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String)
})
export type TargetScope = typeof TargetScope.Type

export const Target = Schema.Struct({
  /** ARIA role, e.g. `textbox`, `button`, `link`, `cell`. */
  role: Schema.optional(Schema.String),
  /** The accessible name. On Heritage Core this comes from a `title` attribute. */
  name: Schema.optional(Schema.String),
  /** When true, `name` must match exactly; the containment fallback is refused. */
  exact: Schema.optional(Schema.Boolean),
  /**
   * The visible caption sitting beside the control. Distinct from `name`,
   * because a legacy app routinely puts the caption in an unassociated cell and
   * the accessible name somewhere else entirely.
   */
  label: Schema.optional(Schema.String),
  /**
   * Text the control sits near. Proximity is measured in edges of the
   * accessibility tree, never in the document, so the fallback strategy does not
   * smuggle markup coupling back in.
   */
  textNear: Schema.optional(Schema.String),
  /** Restrict the search to one region of the tree. */
  within: Schema.optional(TargetScope),
  /** Zero-based choice among equally good matches, in document order. */
  nth: Schema.optional(Schema.Int)
})
export type Target = typeof Target.Type

/** Renders a Target the way it reads in a report or an intervention record. */
export const describeTarget = (target: Target): string => {
  const parts: Array<string> = []
  if (target.role !== undefined) parts.push(target.role)
  if (target.name !== undefined) parts.push(JSON.stringify(target.name))
  if (target.label !== undefined) parts.push(`labelled ${JSON.stringify(target.label)}`)
  if (target.textNear !== undefined) parts.push(`near ${JSON.stringify(target.textNear)}`)
  if (target.within !== undefined) {
    const scope = [target.within.role, target.within.name === undefined ? undefined : JSON.stringify(target.within.name)]
      .filter((part) => part !== undefined)
      .join(" ")
    parts.push(`within ${scope}`)
  }
  if (target.nth !== undefined) parts.push(`#${target.nth}`)
  return parts.length === 0 ? "any node" : parts.join(" ")
}
