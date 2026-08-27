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
 *
 * ## Every field says what it means, because a model is handed this
 *
 * The annotations below are not decoration: `Schema.toJsonSchemaDocument` turns
 * them into the field descriptions the model receives with every turn, and
 * without them it receives a list of optional strings and has to guess. A live
 * run on gpt-4.1-mini guessed `within: { role: "table", name: "Member Number
 * Search" }` — reasonable-looking, and unsatisfiable, because a layout table has
 * no accessible name and its heading is a cell inside it. It then proposed the
 * same scope twice more and the run ended. So each field states the thing a
 * reader gets wrong about it, in the words the answer has to be written in.
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
  role: Schema.optional(
    Schema.String.annotate({
      description:
        "Rarely useful, and usually wrong: this matches a node whose OWN accessible name is " +
        "`name`, and a panel on a legacy screen has no accessible name at all — its heading " +
        "is a cell inside it. Give `name` on its own unless the region is genuinely a named " +
        "node."
    })
  ),
  name: Schema.optional(
    Schema.String.annotate({
      description:
        "The heading an operator reads at the top of the region, e.g. \"Member Number Search\". " +
        "The region it heads is searched, even though the heading is a cell in that region's " +
        "first row rather than an ancestor of anything."
    })
  )
}).annotate({
  description:
    "One region of the screen to search inside, named by its heading: " +
    "{ name: \"Member Number Search\" }."
})
export type TargetScope = typeof TargetScope.Type

export const Target = Schema.Struct({
  role: Schema.optional(
    Schema.String.annotate({
      description:
        "The node's role as the accessibility tree spells it, e.g. textbox, button, link, cell."
    })
  ),
  name: Schema.optional(
    Schema.String.annotate({
      description:
        "The node's own accessible name, as the tree shows it in quotes. A control's name and " +
        "the caption printed beside it are often the same string here, which is fine: naming " +
        "both agrees rather than conflicts."
    })
  ),
  exact: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "When true, `name` must match exactly and the containment fallback is refused."
    })
  ),
  label: Schema.optional(
    Schema.String.annotate({
      description:
        "The caption in the cell before this one in the same row. This is how a figure in a " +
        "table with no headers is named: the value cell has no name of its own, so name it by " +
        "the caption beside it — and then do NOT also give `name`, which the value cell does " +
        "not have."
    })
  ),
  textNear: Schema.optional(
    Schema.String.annotate({
      description:
        "Text the control stands near, measured in edges of the accessibility tree rather than " +
        "pixels. A control whose own name is this text counts as standing at it."
    })
  ),
  within: Schema.optional(TargetScope),
  nth: Schema.optional(
    Schema.Int.annotate({
      description:
        "Zero-based choice among several equally good matches, in document order: the first is " +
        "0. Give it only when a resolution failure told you several nodes answered; a Target " +
        "that names one control needs no ordinal."
    })
  )
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
