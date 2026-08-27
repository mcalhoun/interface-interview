/**
 * Resolving a Target against an observed accessibility tree.
 *
 * Pure: a tree in, a decision out. Nothing here touches a browser, which is what
 * makes the awkward parts — Heritage Core's nested layout tables, its captions
 * that label nothing, its iframe — testable as data.
 *
 * The hard part is not matching. It is that Chromium does not treat a layout
 * table as presentational, so the same text is exposed at every enclosing level
 * and a naive match returns a stack of nodes that are all "right". Two rules do
 * most of the work: prefer an exact name to a containment fallback, and discard
 * any candidate that merely encloses another candidate.
 */

import {
  type IndexedNode,
  type ObservedNode,
  type TreeIndex,
  describeNode,
  isAncestorOf,
  nodeText,
  normalise,
  ownText,
  treeDistance,
  walk
} from "./AccessibilityTree.ts"
import { type Target, describeTarget } from "./Target.ts"

/** Which of the Target's strategies actually did the narrowing. */
export type TargetStrategy = "role" | "name" | "nameContains" | "label" | "textNear" | "within" | "ordinal"

/** One candidate, described well enough for a person to see why it was in the running. */
export interface TargetMatch {
  readonly description: string
  /** Ancestor trail through the accessibility tree. */
  readonly path: string
  /** `main`, or the name of the frame the node lives in. */
  readonly frame: string
  readonly text: string
}

export interface ResolvedTarget {
  readonly _tag: "Resolved"
  readonly node: ObservedNode
  readonly match: TargetMatch
  /** In the order they were applied. Recorded because the brief asks why. */
  readonly strategies: ReadonlyArray<TargetStrategy>
  readonly rationale: string
  /** How many nodes the tree offered before the Target narrowed them. */
  readonly considered: number
}

export interface UnresolvedTarget {
  readonly _tag: "NotFound"
  readonly rationale: string
  readonly considered: number
}

export interface AmbiguousTarget {
  readonly _tag: "Ambiguous"
  readonly matches: ReadonlyArray<TargetMatch>
  readonly rationale: string
}

export type Resolution = ResolvedTarget | UnresolvedTarget | AmbiguousTarget

/**
 * Roles that read as a region of a screen. Climbing to one of these is how a
 * caption becomes a scope: an operator saying "in Member Number Search" means
 * the panel that caption heads, and the caption itself is a childless cell in
 * the panel's first row.
 */
const SECTION_ROLES: ReadonlySet<string> = new Set([
  "table",
  "grid",
  "treegrid",
  "form",
  "search",
  "region",
  "group",
  "list",
  "listbox",
  "article",
  "main",
  "navigation",
  "complementary",
  "banner",
  "contentinfo",
  "dialog",
  "tabpanel"
])

/** Roles a person operates rather than reads. Never a caption. */
const CONTROL_ROLES: ReadonlySet<string> = new Set([
  "textbox",
  "searchbox",
  "button",
  "link",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "slider",
  "spinbutton",
  "switch",
  "menuitem",
  "option",
  "tab"
])

/**
 * What a node reads as when a caller extracts it.
 *
 * A control shows its value; everything else shows the text it and its
 * descendants carry. Both come from the accessibility tree, so `extract` never
 * has occasion to look at the document.
 */
export const readTextOf = (node: ObservedNode): string =>
  CONTROL_ROLES.has(node.role) ? (node.value ?? node.name ?? "") : nodeText(node)

/** Roles that group one caption with one value, e.g. a table row. */
const RECORD_ROLES: ReadonlySet<string> = new Set(["row", "listitem", "group", "form"])

/** The text that identifies a node: its accessible name, or its own text. */
const identity = (node: ObservedNode): string => node.name ?? node.value ?? ""

const containerOf = (index: TreeIndex, node: ObservedNode): ObservedNode => {
  let current = index.of(node).parent
  while (current !== undefined) {
    if (SECTION_ROLES.has(current.role)) return current
    current = index.of(current).parent
  }
  return index.root
}

const toMatch = (entry: IndexedNode): TargetMatch => ({
  description: describeNode(entry.node),
  path: entry.path.join(" > "),
  frame: entry.frame,
  text: nodeText(entry.node)
})

/**
 * The visible caption beside a control.
 *
 * Heritage Core writes `<td>Member Number</td><td><input title="Member
 * Number"></td>`: the caption labels nothing in the markup sense, so the only
 * way to associate the two is position within the record they share. Reading
 * backwards through the leaves of the enclosing row is that association,
 * computed over the tree.
 */
export const labelOf = (index: TreeIndex, node: ObservedNode): string | undefined => {
  let record: ObservedNode | undefined = index.of(node).parent
  while (record !== undefined && !RECORD_ROLES.has(record.role)) {
    record = index.of(record).parent
  }
  const scope = record ?? index.of(node).parent
  if (scope === undefined) return undefined

  const leaves = [...walk(scope)].filter((candidate) => candidate.children.length === 0)
  const position = leaves.findIndex(
    (leaf) => leaf === node || isAncestorOf(index, node, leaf)
  )
  if (position <= 0) return undefined

  for (let cursor = position - 1; cursor >= 0; cursor -= 1) {
    const leaf = leaves[cursor]!
    if (CONTROL_ROLES.has(leaf.role)) continue
    const text = ownText(leaf)
    if (text !== "") return text
  }
  return undefined
}

/** Exact match first; containment only when nothing matched exactly. */
const narrowByText = (
  entries: ReadonlyArray<IndexedNode>,
  wanted: string,
  read: (entry: IndexedNode) => string | undefined,
  exactOnly: boolean
): { readonly entries: ReadonlyArray<IndexedNode>; readonly exact: boolean } => {
  const target = normalise(wanted)
  const exact = entries.filter((entry) => normalise(read(entry) ?? "") === target)
  if (exact.length > 0 || exactOnly) return { entries: exact, exact: true }
  const contains = entries.filter((entry) => normalise(read(entry) ?? "").includes(target))
  return { entries: contains, exact: false }
}

/** The nodes a `within` scope opens up, and a sentence saying how it was read. */
const scopeOf = (
  index: TreeIndex,
  scope: NonNullable<Target["within"]>
): { readonly roots: ReadonlyArray<ObservedNode>; readonly rationale: string } => {
  const all = index.nodes.filter((entry) => entry.node !== index.root)

  if (scope.role !== undefined) {
    const byRole = all.filter((entry) => entry.node.role === scope.role)
    const roots = scope.name === undefined
      ? byRole
      : narrowByText(byRole, scope.name, (entry) => identity(entry.node), false).entries
    return {
      roots: roots.map((entry) => entry.node),
      rationale: `scoped to ${roots.length} ${scope.role} node(s)`
    }
  }

  if (scope.name === undefined) return { roots: [index.root], rationale: "unscoped" }

  const named = narrowByText(all, scope.name, (entry) => identity(entry.node), false)
  const roots = named.entries.map((entry) =>
    // A caption is childless. The region it heads is the nearest enclosing
    // section, which is what an operator means by "in that panel".
    entry.node.children.length > 0 ? entry.node : containerOf(index, entry.node)
  )
  const unique = [...new Set(roots)]
  return {
    roots: unique,
    rationale: unique.length === 0
      ? `nothing on this screen reads "${scope.name}"`
      : `scoped to the ${unique.map((node) => node.role).join(", ")} headed "${scope.name}"`
  }
}

export const resolveTargetIn = (index: TreeIndex, target: Target): Resolution => {
  const reasons: Array<string> = []
  const strategies: Array<TargetStrategy> = []

  let entries: ReadonlyArray<IndexedNode> = index.nodes.filter((entry) => entry.node !== index.root)
  const considered = entries.length

  if (target.within !== undefined) {
    const scope = scopeOf(index, target.within)
    entries = entries.filter((entry) =>
      scope.roots.some((root) => root === entry.node || isAncestorOf(index, root, entry.node))
    )
    strategies.push("within")
    reasons.push(scope.rationale)
    if (entries.length === 0) {
      return { _tag: "NotFound", rationale: reasons.join("; "), considered }
    }
  }

  if (target.role !== undefined) {
    entries = entries.filter((entry) => entry.node.role === target.role)
    strategies.push("role")
    reasons.push(`${entries.length} node(s) with role ${target.role}`)
  }

  if (target.name !== undefined) {
    const narrowed = narrowByText(
      entries,
      target.name,
      (entry) => identity(entry.node),
      target.exact === true
    )
    entries = narrowed.entries
    strategies.push(narrowed.exact ? "name" : "nameContains")
    reasons.push(
      narrowed.exact
        ? `${entries.length} named exactly "${target.name}"`
        : `no exact name match, so ${entries.length} node(s) containing "${target.name}"`
    )
  }

  if (target.label !== undefined) {
    const narrowed = narrowByText(entries, target.label, (entry) => labelOf(index, entry.node), false)
    entries = narrowed.entries
    strategies.push("label")
    reasons.push(`${entries.length} captioned "${target.label}" by the preceding cell in their row`)
  }

  if (target.textNear !== undefined) {
    const wanted = normalise(target.textNear)
    const anchors = index.nodes.filter((entry) => {
      const text = normalise(ownText(entry.node))
      return text === wanted || (text !== "" && text.includes(wanted))
    })
    if (anchors.length === 0) {
      reasons.push(`nothing on this screen reads "${target.textNear}"`)
      return { _tag: "NotFound", rationale: reasons.join("; "), considered }
    }
    const scored = entries
      .filter((entry) => !anchors.some((anchor) => anchor.node === entry.node))
      .map((entry) => ({
        entry,
        distance: Math.min(
          ...anchors.map((anchor) => treeDistance(index, entry.node, anchor.node))
        )
      }))
    const closest = Math.min(...scored.map((scored) => scored.distance))
    entries = scored.filter((scored) => scored.distance === closest).map((scored) => scored.entry)
    strategies.push("textNear")
    // Proximity in edges of the accessibility tree. Not pixels, not DOM order.
    reasons.push(
      `${entries.length} node(s) ${closest} tree edge(s) from "${target.textNear}", the closest on the screen`
    )
  }

  // Layout tables put the same text on a cell, its row, its rowgroup and its
  // table. Every one of those is a true match and only the innermost is useful.
  const innermost = entries.filter(
    (entry) => !entries.some((other) => other !== entry && isAncestorOf(index, entry.node, other.node))
  )
  if (innermost.length !== entries.length) {
    reasons.push(`${entries.length - innermost.length} enclosing duplicate(s) discarded`)
  }
  entries = [...innermost].sort((a, b) => a.order - b.order)

  if (entries.length === 0) {
    return {
      _tag: "NotFound",
      rationale: reasons.length === 0 ? `nothing matched ${describeTarget(target)}` : reasons.join("; "),
      considered
    }
  }

  if (target.nth !== undefined) {
    const chosen = entries[target.nth]
    if (chosen === undefined) {
      reasons.push(`asked for #${target.nth} of ${entries.length}`)
      return { _tag: "NotFound", rationale: reasons.join("; "), considered }
    }
    strategies.push("ordinal")
    reasons.push(`took #${target.nth} of ${entries.length} in document order`)
    return {
      _tag: "Resolved",
      node: chosen.node,
      match: toMatch(chosen),
      strategies,
      rationale: reasons.join("; "),
      considered
    }
  }

  if (entries.length > 1) {
    return {
      _tag: "Ambiguous",
      matches: entries.map(toMatch),
      rationale: `${reasons.join("; ")}; ${entries.length} remain and nothing chooses between them`
    }
  }

  const only = entries[0]!
  return {
    _tag: "Resolved",
    node: only.node,
    match: toMatch(only),
    strategies,
    rationale: reasons.length === 0 ? "the only node on the screen" : reasons.join("; "),
    considered
  }
}
