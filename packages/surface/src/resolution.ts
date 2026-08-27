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
 *
 * The second half of the file does something different: *selection*, choosing
 * among the items a screen currently offers by matching a parameter against
 * their labels by token subset. That is the same tree and the same scoping rule,
 * but a different question, and it is what makes one Capability serve both a
 * savings and a checking account without a second discovery run.
 */

import {
  type AccessibilityNode,
  type IndexedNode,
  type ObservedNode,
  type TreeIndex,
  describeNode,
  indexTree,
  isAncestorOf,
  nodeText,
  normalise,
  ownText,
  treeDistance,
  walk
} from "./AccessibilityTree.ts"
import { type Target, type TargetScope, describeTarget } from "./Target.ts"

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

// ---------------------------------------------------------------------------
// Choosing among the items on a screen
// ---------------------------------------------------------------------------

/**
 * Selection, as distinct from resolution.
 *
 * Resolution answers "which control does this description name". Selection
 * answers "which of the things currently on offer does this *parameter* mean",
 * and the things on offer are read off the live screen rather than written down
 * anywhere. See
 * docs/adr/0007-selection-matches-by-token-subset-against-a-discovered-set.md.
 *
 * The rule is token subset, in one direction: every token of the wanted value
 * must appear among the tokens of an item's label. The direction is the whole
 * point. `savings` is a subset of `Primary Savings` *and* of `Regular Savings`,
 * so a Tenant that labels the same account differently still matches with no
 * Override anywhere — multi-tenant reuse falls out of the matching rule instead
 * of arriving as configuration. Meanwhile `Primary Savings` is a subset of
 * neither `Regular Savings` nor `Checking`, which is what keeps a parameter that
 * genuinely does not apply a clean no-match rather than a lucky hit.
 *
 * Nothing here consults a model. Same list, same parameter, same choice, every
 * time — which is what determinism means in this system: no model in the loop,
 * not no logic.
 */

/**
 * The comparable words in a piece of text.
 *
 * Unicode letter and number classes rather than `\w`, because an item's label is
 * whatever the Tenant configured it to be and that is not always ASCII. Case and
 * punctuation are discarded, so `Primary Savings`, `primary savings` and
 * `Primary-Savings` all compare the same.
 */
export const tokensOf = (text: string): ReadonlyArray<string> =>
  normalise(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== "")

/**
 * True when every token of `wanted` appears in `label`.
 *
 * An empty `wanted` never matches. A parameter that says nothing selecting the
 * first thing on the screen is exactly the silent wrong answer this design
 * exists to prevent.
 */
export const isTokenSubsetOf = (wanted: string, label: string): boolean => {
  const available = new Set(tokensOf(label))
  const required = tokensOf(wanted)
  return required.length > 0 && required.every((token) => available.has(token))
}

/** Which items are on offer: a role, optionally inside a named region. */
export interface ListDescription {
  /** The region the list sits in, named by the caption heading it. */
  readonly within?: TargetScope | undefined
  /** The role each item carries, e.g. `link` for a list of account links. */
  readonly itemRole: string
}

/** One thing on offer, as it reads on screen. */
export interface ListItem extends TargetMatch {
  /** What the item is called: the text a person would point at. */
  readonly label: string
}

export type Selection =
  | {
      readonly _tag: "Selected"
      readonly item: ListItem
      readonly items: ReadonlyArray<ListItem>
      readonly rationale: string
    }
  | {
      readonly _tag: "NoMatch"
      readonly items: ReadonlyArray<ListItem>
      readonly rationale: string
    }
  | {
      readonly _tag: "AmbiguousMatch"
      readonly matches: ReadonlyArray<ListItem>
      readonly items: ReadonlyArray<ListItem>
      readonly rationale: string
    }

export interface SelectionRequest {
  readonly list: ListDescription
  /** The value being matched, as the caller supplied it. */
  readonly wanted: string
  /**
   * How to name that value in prose, when quoting it would be wrong.
   *
   * A rationale ends up in Evidence and in a failure report, and an input is
   * sensitive unless an Artifact says otherwise (ADR-0008). A caller holding a
   * sensitive parameter passes a description here rather than letting the value
   * be quoted back at it.
   */
  readonly describedAs?: string | undefined
}

/** An item's own text: its accessible name, or the text it carries. */
const labelTextOf = (node: ObservedNode): string => {
  const own = identity(node)
  return own !== "" ? own : nodeText(node)
}

/** Everything the list offers, in document order. */
export const listItemsIn = (
  index: TreeIndex,
  list: ListDescription
): { readonly items: ReadonlyArray<ListItem>; readonly rationale: string } => {
  const reasons: Array<string> = []
  let entries: ReadonlyArray<IndexedNode> = index.nodes.filter((entry) => entry.node !== index.root)

  if (list.within !== undefined) {
    const scope = scopeOf(index, list.within)
    entries = entries.filter((entry) =>
      scope.roots.some((root) => root === entry.node || isAncestorOf(index, root, entry.node))
    )
    reasons.push(scope.rationale)
  }

  entries = entries.filter((entry) => entry.node.role === list.itemRole)
  // The same rule Target resolution uses: a layout table exposes the same text
  // at every enclosing level, and only the innermost node is the item itself.
  const innermost = entries.filter(
    (entry) => !entries.some((other) => other !== entry && isAncestorOf(index, entry.node, other.node))
  )
  const items = [...innermost]
    .sort((a, b) => a.order - b.order)
    .map((entry) => ({ ...toMatch(entry), label: labelTextOf(entry.node) }))

  reasons.push(
    items.length === 0
      ? `nothing with role ${list.itemRole} is on offer there`
      : `${items.length} ${list.itemRole}(s) on offer: ${
          items.map((item) => JSON.stringify(item.label)).join(", ")
        }`
  )
  return { items, rationale: reasons.join("; ") }
}

/**
 * Picks the one item whose label carries every token of the wanted value.
 *
 * Three outcomes, all of them values. The choice; nothing matching; or more than
 * one matching. The last is never settled by taking the first — ADR-0007 says an
 * item matching two or more is a Hard Failure — and the difference between "the
 * list does not have it" and "the list has it twice" is the difference between a
 * domain fact and a broken Artifact, so the two never collapse into one report.
 */
export const selectFrom = (index: TreeIndex, request: SelectionRequest): Selection => {
  const { items, rationale } = listItemsIn(index, request.list)
  const said = request.describedAs ?? JSON.stringify(request.wanted)
  const matches = items.filter((item) => isTokenSubsetOf(request.wanted, item.label))

  if (matches.length === 0) {
    return {
      _tag: "NoMatch",
      items,
      rationale: `${rationale}; no label carries every token of ${said}`
    }
  }
  if (matches.length > 1) {
    return {
      _tag: "AmbiguousMatch",
      matches,
      items,
      rationale: `${rationale}; ${matches.length} labels carry every token of ${said}: ${
        matches.map((match) => JSON.stringify(match.label)).join(", ")
      }, and nothing chooses between them`
    }
  }
  const only = matches[0]!
  return {
    _tag: "Selected",
    item: only,
    items,
    rationale: `${rationale}; every token of ${said} is in ${JSON.stringify(only.label)}`
  }
}

/**
 * The same choice, made against a tree the caller already holds.
 *
 * Replay observes once per Step and selects against that observation, so the
 * accessibility snapshot recorded in Evidence is provably the one the choice was
 * made from rather than a second look that might have differed.
 */
export const selectFromTree = (tree: AccessibilityNode, request: SelectionRequest): Selection =>
  selectFrom(indexTree(tree), request)
