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
 * What the rules cannot do is decide between candidates that are genuinely
 * equal, and nothing here ever tries. Three panels on
 * `/fixtures/duplicate-labels` hold a control with the same role, the same
 * accessible name, the same caption and the same ancestor trail; taking the
 * first of them would be a coin flip dressed as a decision, and coin flips are
 * the nondeterminism this system exists to prevent. So the three outcomes are
 * kept apart on purpose:
 *
 *   - one candidate: `Resolved`, carrying `alternatives: 0` — the claim that the
 *     Target named exactly one control rather than merely reaching one.
 *   - several: `Ambiguous`, listing every candidate *told apart* by ordinal and
 *     region, plus a `remedy` saying what to add to the Target. A report whose
 *     entries are indistinguishable is not a report.
 *   - none: `NotFound`, naming the step that ran out of candidates. A different
 *     outcome from ambiguity, because an absent control is as likely to be the
 *     application telling the truth about its domain as it is to be breakage.
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

/**
 * One candidate, described well enough for a person to *act* on it.
 *
 * `description` and `path` are not always enough on their own, and the fixture
 * at `/fixtures/duplicate-labels` is why: three panels there hold a control with
 * the same role, the same accessible name and the same ancestor trail, so a
 * report built from those three fields alone lists three identical lines and
 * tells a reader nothing. `ordinal` and `region` are the two things that always
 * differ, and each is expressed in a form that can be pasted straight back into
 * the Target that failed — `nth: <ordinal>` or `within: { name: <region> }`.
 */
export interface TargetMatch {
  readonly description: string
  /** Ancestor trail through the accessibility tree. */
  readonly path: string
  /** `main`, or the name of the frame the node lives in. */
  readonly frame: string
  readonly text: string
  /** Position among the candidates, in document order. Exactly the `nth` that selects it. */
  readonly ordinal: number
  /**
   * The heading of the region this candidate sits in, as an operator reads it.
   * Exactly what `within: { name: ... }` takes. Empty when the node sits in no
   * named region.
   */
  readonly region: string
}

/**
 * One line naming a candidate uniquely.
 *
 * Every layer that reports ambiguity — the CLI, the Replay failure, a Checkpoint's
 * "observed" half — says it this way, so `2 controls matched` is never followed by
 * the same sentence twice. The ordinal comes first because it is the answer: it is
 * the `nth` that picks this one.
 */
export const describeMatch = (match: TargetMatch): string =>
  [
    `#${match.ordinal} ${match.description}`,
    match.region === "" ? undefined : `in ${JSON.stringify(match.region)}`,
    match.frame === "main" ? undefined : `[frame ${match.frame}]`
  ]
    .filter((part) => part !== undefined)
    .join(" ")

export interface ResolvedTarget {
  readonly _tag: "Resolved"
  readonly node: ObservedNode
  readonly match: TargetMatch
  /** In the order they were applied. Recorded because the brief asks why. */
  readonly strategies: ReadonlyArray<TargetStrategy>
  readonly rationale: string
  /** How many nodes the tree offered before the Target narrowed them. */
  readonly considered: number
  /**
   * How many *other* controls this Target also matched.
   *
   * Zero is the claim the whole ticket is about: the Target named exactly one
   * control and nothing had to break a tie. Anything above zero means the
   * Target matched several and only `nth` chose between them, which is a
   * materially weaker thing for an Artifact to rest on. Structured rather than
   * left in the rationale prose so a reviewer, or a later check, can see it
   * without reading a sentence.
   */
  readonly alternatives: number
}

export interface UnresolvedTarget {
  readonly _tag: "NotFound"
  readonly rationale: string
  readonly considered: number
  /**
   * The narrowing step that took the candidate set to nothing.
   *
   * Zero matches is a different situation from ambiguity — a missing control is
   * as likely to be domain truth as breakage — and this says *how* it went
   * missing. `role` emptying the set means the screen is not the one expected;
   * `name` emptying it means the control was renamed. That is the distinction a
   * recovery ladder branches on. `undefined` when the screen offered nothing at
   * all to narrow.
   */
  readonly narrowedBy: TargetStrategy | undefined
}

export interface AmbiguousTarget {
  readonly _tag: "Ambiguous"
  readonly matches: ReadonlyArray<TargetMatch>
  readonly rationale: string
  /**
   * What would make this Target name exactly one control, in the words of the
   * Target itself. An ambiguity report that a reader cannot act on is only half
   * a report.
   */
  readonly remedy: string
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

/**
 * The heading of the region a node sits in, as an operator would name it.
 *
 * The exact inverse of the caption-climbing in `scopeOf`: that turns a heading
 * into the region it heads, this turns a node back into the heading of the
 * region containing it. Round-tripping matters, because this string is handed to
 * a reader as the thing to put in `within: { name: ... }`, and an ambiguity
 * report suggesting a scope that would not then resolve is worse than no
 * suggestion at all.
 *
 * Heritage Core's panels carry no accessible name on the table itself — the
 * heading is the first cell of the first row — so the first readable leaf is
 * where to look.
 */
export const regionOf = (index: TreeIndex, node: ObservedNode): string => {
  const section = containerOf(index, node)
  if (section === index.root) return ""
  const own = identity(section)
  if (own !== "") return own
  for (const candidate of walk(section)) {
    if (candidate === section || CONTROL_ROLES.has(candidate.role)) continue
    const text = ownText(candidate)
    if (text !== "") return text
  }
  return ""
}

const toMatch = (index: TreeIndex, entry: IndexedNode, ordinal: number): TargetMatch => ({
  description: describeNode(entry.node),
  path: entry.path.join(" > "),
  frame: entry.frame,
  text: nodeText(entry.node),
  ordinal,
  region: regionOf(index, entry.node)
})

/**
 * What a reader should do about an ambiguous Target.
 *
 * Two situations, calling for different advice. When the candidates sit in
 * regions with different headings, naming one is the durable fix: it survives a
 * panel being inserted above, which an ordinal does not. When they do not — the
 * same heading, or none at all — position genuinely is the only thing separating
 * them, and saying so is more useful than suggesting a scope that would narrow
 * nothing.
 *
 * Note what is deliberately never suggested: the frame. Two candidates can sit
 * in different documents and the report says which, but a Target has nowhere to
 * put a frame and this must not invent one. On `/fixtures/frames` the region
 * headings differ anyway, which is the point — naming the ledger reaches into
 * the right document without the Target ever mentioning that one exists.
 */
const remedyFor = (matches: ReadonlyArray<TargetMatch>): string => {
  const byPosition = `choose by position with nth: 0 to ${matches.length - 1}`
  const named = matches.map((match) => match.region).filter((region) => region !== "")
  if (named.length !== matches.length || new Set(named).size !== matches.length) {
    return `these candidates share a region, so only position separates them: ${byPosition}`
  }
  return `name the region with within: { name: ${named
    .map((region) => JSON.stringify(region))
    .join(" | ")} }, or ${byPosition}`
}

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

  /**
   * Gives up, naming the step that ran out of candidates.
   *
   * Every narrowing step stops here the moment it empties the set, rather than
   * letting the remaining steps run against nothing. Two reasons, and the second
   * is the one that matters: a later step cannot put a candidate back, and if it
   * runs anyway it appends its own name to the trail and the report ends up
   * blaming the wrong part of the Target. `{ role: "slider", name: "Amount" }`
   * on a screen with no slider is a wrong-screen problem, not a renamed-control
   * problem, and has to say so.
   */
  const exhausted = (strategy: TargetStrategy): UnresolvedTarget => ({
    _tag: "NotFound",
    rationale: reasons.join("; "),
    considered,
    narrowedBy: strategy
  })

  if (target.within !== undefined) {
    const scope = scopeOf(index, target.within)
    entries = entries.filter((entry) =>
      scope.roots.some((root) => root === entry.node || isAncestorOf(index, root, entry.node))
    )
    strategies.push("within")
    reasons.push(scope.rationale)
    if (entries.length === 0) return exhausted("within")
  }

  if (target.role !== undefined) {
    entries = entries.filter((entry) => entry.node.role === target.role)
    strategies.push("role")
    reasons.push(`${entries.length} node(s) with role ${target.role}`)
    if (entries.length === 0) return exhausted("role")
  }

  if (target.name !== undefined) {
    const narrowed = narrowByText(
      entries,
      target.name,
      (entry) => identity(entry.node),
      target.exact === true
    )
    entries = narrowed.entries
    const strategy: TargetStrategy = narrowed.exact ? "name" : "nameContains"
    strategies.push(strategy)
    reasons.push(
      narrowed.exact
        ? `${entries.length} named exactly "${target.name}"`
        : `no exact name match, so ${entries.length} node(s) containing "${target.name}"`
    )
    if (entries.length === 0) return exhausted(strategy)
  }

  if (target.label !== undefined) {
    const narrowed = narrowByText(entries, target.label, (entry) => labelOf(index, entry.node), false)
    entries = narrowed.entries
    strategies.push("label")
    reasons.push(`${entries.length} captioned "${target.label}" by the preceding cell in their row`)
    if (entries.length === 0) return exhausted("label")
  }

  if (target.textNear !== undefined) {
    const wanted = normalise(target.textNear)
    const anchors = index.nodes.filter((entry) => {
      const text = normalise(ownText(entry.node))
      return text === wanted || (text !== "" && text.includes(wanted))
    })
    strategies.push("textNear")
    if (anchors.length === 0) {
      reasons.push(`nothing on this screen reads "${target.textNear}"`)
      return exhausted("textNear")
    }
    const scored = entries
      .filter((entry) => !anchors.some((anchor) => anchor.node === entry.node))
      .map((entry) => ({
        entry,
        distance: Math.min(
          ...anchors.map((anchor) => treeDistance(index, entry.node, anchor.node))
        )
      }))
    if (scored.length === 0) {
      reasons.push(`the only thing reading "${target.textNear}" is the candidate itself`)
      return exhausted("textNear")
    }
    const closest = Math.min(...scored.map((scored) => scored.distance))
    entries = scored.filter((scored) => scored.distance === closest).map((scored) => scored.entry)
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

  // A safety net rather than a live path: every narrowing step above returns the
  // moment it empties the set, and discarding enclosing duplicates cannot empty
  // a non-empty one. Reached only by a Target that narrowed by nothing at all
  // against a screen with no nodes.
  if (entries.length === 0) {
    return {
      _tag: "NotFound",
      rationale: reasons.length === 0 ? `nothing matched ${describeTarget(target)}` : reasons.join("; "),
      considered,
      narrowedBy: strategies[strategies.length - 1]
    }
  }

  // Every surviving candidate, numbered. The numbering is fixed here, before
  // anything chooses, so the ordinal a report hands back is the same one `nth`
  // would take — a reader can paste it straight into the Target that failed.
  const candidates = entries.map((entry, ordinal) => toMatch(index, entry, ordinal))

  if (target.nth !== undefined) {
    const chosen = entries[target.nth]
    if (chosen === undefined) {
      // Not ambiguity and not a missing control: the control set is smaller than
      // the Artifact expected, which is its own kind of drift.
      reasons.push(`asked for #${target.nth} of ${entries.length}`)
      return exhausted("ordinal")
    }
    strategies.push("ordinal")
    reasons.push(`took #${target.nth} of ${entries.length} in document order`)
    return {
      _tag: "Resolved",
      node: chosen.node,
      match: candidates[target.nth]!,
      strategies,
      rationale: reasons.join("; "),
      considered,
      alternatives: entries.length - 1
    }
  }

  // `rationale` says how it got here and `remedy` says what to do about it. Two
  // separate sentences because they answer different questions and every layer
  // that reports this shows them in different places.
  if (entries.length > 1) {
    return {
      _tag: "Ambiguous",
      matches: candidates,
      rationale: `${reasons.join("; ")}; ${entries.length} remain and nothing chooses between them`,
      remedy: remedyFor(candidates)
    }
  }

  // The claim worth making: one control answered, and nothing broke a tie.
  const only = entries[0]!
  return {
    _tag: "Resolved",
    node: only.node,
    match: candidates[0]!,
    strategies,
    rationale: reasons.length === 0 ? "the only node on the screen" : reasons.join("; "),
    considered,
    alternatives: 0
  }
}
