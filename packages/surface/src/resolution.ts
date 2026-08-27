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
 *
 * A third rule earns its place for the same reason the first two do: a control's
 * accessible name here comes from a `title` attribute, so the caption beside a
 * field and the field's own name are usually the same string. `textNear` therefore
 * treats a control named after its anchor as being *at* it rather than excluded
 * by it — see `isOwnAnchor` — which is what lets `name` and `textNear` reinforce
 * each other instead of cancelling out.
 *
 * Whatever the outcome, the sentences this file produces have to survive being
 * read next to the tree they describe. A remedy that denies something the tree
 * plainly says is worse than silence, because its reader is usually a model that
 * is about to be shown that same tree again. See `remedyForUnresolved`.
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
export type TargetStrategy =
  | "role"
  | "name"
  | "nameContains"
  /**
   * The name matched by tokens: everything the control is called is among the
   * words the Target asked for. See `narrowByText`.
   */
  | "nameTokens"
  | "label"
  | "textNear"
  | "within"
  | "ordinal"

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
  /**
   * What to do instead, in the words of the Target itself.
   *
   * The zero-match counterpart of `AmbiguousTarget.remedy`, and the same
   * argument: a failure a reader cannot act on is only half a report. It matters
   * more here than there, because the reader is often a model that will be shown
   * the identical screen next turn — an unhelpful refusal buys a repeat of the
   * same proposal, and three of those end a run.
   */
  readonly remedy: string
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
  return section === index.root ? "" : headingOf(section)
}

/** What a section is called, as an operator reads it off the screen. */
const headingOf = (section: ObservedNode): string => {
  const own = identity(section)
  if (own !== "") return own
  for (const candidate of walk(section)) {
    if (candidate === section || CONTROL_ROLES.has(candidate.role)) continue
    const text = ownText(candidate)
    if (text !== "") return text
  }
  return ""
}

/**
 * Every heading a `within` scope could have named on this screen, in document
 * order.
 *
 * The zero-match counterpart of the candidate list an ambiguity report carries.
 * A reader told only that their scope matched nothing guesses again; a reader
 * shown what the screen actually offers can pick one. Deduplicated, because
 * Heritage Core nests layout tables and the same heading heads several of them.
 */
const regionsOffered = (index: TreeIndex): ReadonlyArray<string> => {
  const headings: Array<string> = []
  for (const entry of index.nodes) {
    if (entry.node === index.root || !SECTION_ROLES.has(entry.node.role)) continue
    const heading = headingOf(entry.node)
    if (heading !== "" && !headings.includes(heading)) headings.push(heading)
  }
  return headings
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
 * Roles that stand for a whole document rather than a control inside one.
 *
 * A `within` naming one of these is the mistake this whole branch exists for.
 */
const FRAME_ROLES: ReadonlySet<string> = new Set(["iframe", "frame"])

/**
 * Whether a scope was reaching for a frame.
 *
 * Two spellings, because a reader can arrive at the same wrong idea from either
 * end: `{ role: "iframe" }` names the boundary node by role, and
 * `{ name: "acctdetail" }` names it by the string the browser calls that frame.
 * Neither can work — the iframe node has no accessible name and the frame name
 * lives outside the tree — and both deserve the same answer.
 */
const scopeNamesAFrame = (index: TreeIndex, scope: TargetScope): boolean => {
  if (scope.role !== undefined && FRAME_ROLES.has(scope.role)) return true
  if (scope.name === undefined) return false
  const wanted = normalise(scope.name)
  return index.nodes.some(
    (entry) => entry.node.frame !== undefined && normalise(entry.node.frame) === wanted
  )
}

/** As many region headings as are worth reading in one sentence. */
const REGIONS_SUGGESTED = 8

const regionAdvice = (index: TreeIndex): string => {
  const offered = regionsOffered(index)
  if (offered.length === 0) return "this screen has no named region to scope to"
  const shown = offered.slice(0, REGIONS_SUGGESTED).map((region) => JSON.stringify(region))
  const more = offered.length - shown.length
  return (
    `the regions this screen offers are ${shown.join(", ")}` +
    (more > 0 ? ` and ${more} more` : "")
  )
}

/**
 * Every node that reads as the text a `textNear` points at.
 *
 * Shared by the narrowing step and the remedy, deliberately: the remedy's whole
 * job is to say something true about the anchor, and it can only do that from
 * the same set the narrowing used. Two sentences computed from two different
 * sets is how a report ends up contradicting itself.
 */
const anchorsFor = (index: TreeIndex, textNear: string): ReadonlyArray<IndexedNode> => {
  const wanted = normalise(textNear)
  if (wanted === "") return []
  return index.nodes.filter((entry) => {
    const text = normalise(ownText(entry.node))
    return text === wanted || (text !== "" && text.includes(wanted))
  })
}

/**
 * Whether a candidate *is* the text it was told to stand near.
 *
 * This is the one asymmetry in proximity, and it exists because of how this
 * class of application names its controls. Heritage Core writes
 * `<td>Member Number</td><td><input title="Member Number">`: the caption beside
 * a field and the field's own accessible name are the same string, so
 * `{ name: "Member Number", textNear: "Member Number" }` is a natural thing for
 * a person — or a model reading the tree — to write. Excluding a candidate from
 * being its own anchor makes that Target unsatisfiable, and worse, leaves the
 * nearest *other* control holding the answer: on Member Search that was
 * `textbox "Branch"`, five edges away, which no reader would have chosen.
 *
 * So a control whose accessible name is exactly the anchor text is at distance
 * zero. Distance is still the model — this is not a separate strategy with its
 * own verdict — because "nearest to that text" and "is that text" are the same
 * question asked at two ranges, and keeping one scale means a control that names
 * itself still loses to nothing and wins against everything, with no ordering
 * rule written anywhere.
 *
 * Two limits keep it from swallowing the neighbouring reading:
 *
 *   - **Controls only.** A cell whose text is "Current Balance" is not near
 *     itself; it *is* the caption, and a caller asking for the cell near it
 *     means the figure beside it. `CONTROL_ROLES` is already the line this file
 *     draws between what a person operates and what they read, and `labelOf`
 *     draws it in the same place.
 *   - **Exactly, not loosely.** `textbox "Member Number (Legacy)"` merely
 *     contains the anchor text; that is a coincidence of substrings, not a
 *     caller naming one control twice, so it is measured against the real
 *     anchors like anything else.
 */
const isOwnAnchor = (node: ObservedNode, textNear: string): boolean =>
  CONTROL_ROLES.has(node.role) && normalise(ownText(node)) === normalise(textNear)

/**
 * How far a candidate stands from the anchor text, in edges of the tree.
 *
 * `undefined` when there is nothing to measure: the candidate is the only thing
 * on the screen reading that text and does not name itself with it. Note that a
 * candidate is never its own anchor for the purposes of distance — otherwise
 * every node containing the text would collapse to zero and proximity would
 * stop meaning anything.
 */
const nearness = (
  index: TreeIndex,
  entry: IndexedNode,
  anchors: ReadonlyArray<IndexedNode>,
  textNear: string
): number | undefined => {
  if (isOwnAnchor(entry.node, textNear)) return 0
  const others = anchors.filter((anchor) => anchor.node !== entry.node)
  return others.length === 0
    ? undefined
    : Math.min(...others.map((anchor) => treeDistance(index, entry.node, anchor.node)))
}

/** As many anchors as are worth naming in one sentence. */
const ANCHORS_SHOWN = 3

/** As many roles as are worth naming in one sentence. */
const ROLES_SUGGESTED = 10

/** The distinct roles a set of candidates offers, in document order. */
const rolesAdvice = (entries: ReadonlyArray<IndexedNode>): string => {
  const roles: Array<string> = []
  for (const entry of entries) {
    if (!roles.includes(entry.node.role)) roles.push(entry.node.role)
  }
  if (roles.length === 0) return "there was nothing on the screen to name"
  const shown = roles.slice(0, ROLES_SUGGESTED)
  const more = roles.length - shown.length
  return `the roles on offer are ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`
}

/**
 * What the failing narrowing step was handed, and what had already run.
 *
 * Carried into the remedy so it can say *which* set ran out. Without it, every
 * sentence is a claim about the whole screen, and a claim about the whole screen
 * is false the moment anything narrowed first: `{ role: "button", name: "Member
 * Number" }` used to be told "nothing is called Member Number" while a textbox
 * on the same screen was called exactly that. A reader — a model, usually — that
 * is told something the tree in front of it contradicts has no move except to
 * propose the same thing again.
 */
interface Narrowing {
  /** Strategies applied so far, the one that emptied the set last. */
  readonly applied: ReadonlyArray<TargetStrategy>
  /** The candidates the failing step was handed. */
  readonly offered: ReadonlyArray<IndexedNode>
}

/**
 * How to get to the node the reader was plainly describing, in the Target's own
 * words.
 *
 * A remedy that says "something else on this screen is called that" and stops
 * leaves the reader to work out the scope again from the tree. Naming the region
 * the node actually sits in makes the correction a substitution rather than a
 * fresh attempt, and the region heading is exactly what `within` takes —
 * `regionOf` is `scopeOf`'s inverse, so the suggestion resolves.
 */
const reachFor = (index: TreeIndex, node: ObservedNode): string => {
  const region = regionOf(index, node)
  return (
    `Reach for it as role ${JSON.stringify(node.role)}` +
    (region === "" ? "" : `, within: { name: ${JSON.stringify(region)} }`) +
    ", or drop the parts of this Target that excluded it."
  )
}

/** The candidate set a remedy is talking about, named the way it was arrived at. */
const offeredBy = (narrowing: Narrowing): string => {
  const earlier = narrowing.applied.slice(0, -1)
  return earlier.length === 0
    ? `the ${narrowing.offered.length} node(s) on this screen`
    : `the ${narrowing.offered.length} candidate(s) left by ${earlier.join(", then ")}`
}

/**
 * What a reader should do about a Target that named nothing.
 *
 * Written per narrowing step, because "not found" is at least four different
 * situations and the useful sentence differs in each. The `within` branch is the
 * one with history: a real discovery run proposed
 * `within: { role: "iframe", name: "acctdetail" }` against Account Detail,
 * having read `iframe [frame=acctdetail]` in the tree it was shown, and then
 * proposed it twice more because nothing it was told back suggested anything
 * else. The renderer no longer offers that handle (see
 * `formatAccessibilityTree`), and this says what to reach for instead if a
 * reader gets there anyway.
 *
 * ## Every sentence here has to survive being read next to the tree
 *
 * The reader of a remedy is usually a model that is about to be shown the same
 * screen again. Telling it something the tree contradicts — "nothing is called
 * X" when X is plainly a node's name, "X is not text on this screen" when X is a
 * caption on it — costs more than saying nothing: the advice cannot be taken,
 * so the same proposal comes back, and three of those end a run. So each branch
 * checks the tree before it makes a claim, and where the thing named *does*
 * exist, the remedy says where it is instead of denying it.
 *
 * What it never says is "name the frame differently". A Target has nowhere to
 * put a frame, and advice that cannot be taken is worse than none — the same
 * rule `remedyFor` follows on the ambiguous side.
 */
const remedyForUnresolved = (
  index: TreeIndex,
  target: Target,
  narrowedBy: TargetStrategy | undefined,
  narrowing: Narrowing
): string => {
  const everything = index.nodes.filter((entry) => entry.node !== index.root)
  switch (narrowedBy) {
    case "within": {
      const scope = target.within
      if (scope !== undefined && scopeNamesAFrame(index, scope)) {
        return (
          "that is a frame, and a frame is not a region a Target can name — nor does it need " +
          "to be, because the contents of every frame on this screen are already part of the " +
          `tree you were shown. Scope by the heading of the section the control sits in (${
            regionAdvice(index)
          }), or drop within and name the control on its own.`
        )
      }
      // A scope naming a role that is not on the screen is a different mistake
      // from a scope naming a heading that is not on it, and the region list
      // alone would read as a contradiction: "no region is headed that way,
      // the regions are A, B" when the reader asked for A with the wrong role.
      if (scope?.role !== undefined) {
        // The heading first, whatever the role turns out to be. This is the
        // common case and the one a bare "none of them is named that" reads as
        // a contradiction against: the heading IS on the screen, and the region
        // list this would otherwise print says so in the next breath. The role
        // asked for is simply not the role of the region that heading heads —
        // `scopeOf` already tries the heading when the name matches no node of
        // that role — so the sentence names the role it actually is, and the
        // spelling that works.
        if (scope.name !== undefined) {
          const headed = headedBy(index, everything, scope.name)
          const region = headed[0]
          if (region !== undefined) {
            return (
              `the region headed ${JSON.stringify(scope.name)} is a ${region.role}, not a ` +
              `${scope.role}, and nothing with role ${JSON.stringify(scope.role)} is named that ` +
              `either. Drop the role and scope by the heading alone: ` +
              `within: { name: ${JSON.stringify(scope.name)} }.`
            )
          }
        }
        const withRole = everything.filter((entry) => entry.node.role === scope.role)
        if (withRole.length === 0) {
          return (
            `nothing on this screen has role ${JSON.stringify(scope.role)} to scope to. ` +
            `Scope by the heading of the section instead (${regionAdvice(index)}), ` +
            "or drop within and name the control on its own."
          )
        }
        if (scope.name !== undefined) {
          return (
            `this screen has ${withRole.length} node(s) with role ${JSON.stringify(scope.role)}, ` +
            `but none of them is named or headed ${JSON.stringify(scope.name)}. Scope by ` +
            `heading alone (${regionAdvice(index)}), or drop within and name the control on ` +
            "its own."
          )
        }
      }
      return (
        `no region on this screen is headed that way: ${regionAdvice(index)}. ` +
        "Name one of those, or drop within and name the control on its own."
      )
    }
    case "role": {
      const role = target.role ?? ""
      const elsewhere = everything.filter((entry) => entry.node.role === role)
      if (elsewhere.length > 0) {
        return (
          `nothing among ${offeredBy(narrowing)} has role ${JSON.stringify(role)}, ` +
          `though ${elsewhere.length} node(s) elsewhere on this screen do. Widen or drop the ` +
          "scope — or scope to the region that holds the control rather than one beside it."
        )
      }
      return (
        `nothing on this screen has role ${JSON.stringify(role)}. ` +
        "Either this is not the screen you expected, or the control carries a different role — " +
        `${rolesAdvice(narrowing.offered)}.`
      )
    }
    case "name":
    case "nameContains":
    case "nameTokens": {
      const name = target.name ?? ""
      const read = (entry: IndexedNode) => identity(entry.node)
      const anywhere = narrowByText(everything, name, read, target.exact === true, true).entries[0]
      if (anywhere !== undefined) {
        // The one thing the node's own name does not tell a reader: whether it
        // is the thing they wanted. On a caption/value screen the node called
        // "Available Balance" is the caption, and a reader asking for a cell of
        // that name is usually after the figure beside it — which has no name
        // at all, and is reached with `label`. A live run alternated between
        // this Target and a scope correction until the run ended, because the
        // remedy only ever pointed at the caption.
        const alsoLabel = CONTROL_ROLES.has(anywhere.node.role) || target.label !== undefined
          ? ""
          : ` If what you want is the value beside that caption rather than the caption itself, ` +
            `that node has no name of its own: name it by the caption instead and leave name ` +
            `out — { role: ${JSON.stringify(anywhere.node.role)}, label: ${JSON.stringify(name)} }.`
        return (
          `${JSON.stringify(name)} does name ${describeNode(anywhere.node)} on this screen, but ` +
          `nothing among ${offeredBy(narrowing)} is called that. ` +
          reachFor(index, anywhere.node) +
          alsoLabel
        )
      }
      const loosely = target.exact !== true
        ? undefined
        : narrowByText(everything, name, read, false, true).entries[0]
      if (loosely !== undefined) {
        return (
          `nothing is called exactly ${JSON.stringify(name)}, though ` +
          `${describeNode(loosely.node)} contains it. Spell the name the way the tree does, ` +
          "or drop exact."
        )
      }
      return (
        `nothing on this screen is called ${JSON.stringify(name)}. ` +
        "Use the words that appear in the tree, or, if this is a figure in a table, name it by " +
        "the caption beside it with label instead of name."
      )
    }
    case "label": {
      const label = target.label ?? ""
      const anywhere = narrowByText(
        everything,
        label,
        (entry) => labelOf(index, entry.node),
        false
      ).entries[0]
      if (anywhere !== undefined) {
        // `name` and `label` together are how a reader most often over-specifies
        // a figure: the caption is the only thing on the row with a name, so the
        // name matches the caption and the label then matches nothing. The
        // remedy has to name the field to remove, because "drop what excluded
        // it" is one abstraction too many for a reader that has already tried
        // three spellings. A live run alternated between exactly these two for
        // its last six turns.
        const dropName = target.name === undefined
          ? ""
          : ` Leave name out: the cell a caption labels carries no accessible name of its own, ` +
            "which is the whole reason label exists."
        return (
          `${JSON.stringify(label)} does caption ${describeNode(anywhere.node)} on this screen, ` +
          `but nothing among ${offeredBy(narrowing)} carries that caption. ` +
          reachFor(index, anywhere.node) +
          dropName
        )
      }
      return (
        `no row on this screen puts ${JSON.stringify(label)} beside a value. ` +
        "Check the caption reads exactly that in the tree, or name the control by role and name."
      )
    }
    case "textNear": {
      const textNear = target.textNear ?? ""
      const anchors = anchorsFor(index, textNear)
      if (anchors.length === 0) {
        return (
          `${JSON.stringify(textNear)} is not text on this screen. ` +
          "Anchor on something the tree actually says, or drop textNear."
        )
      }
      // The anchor exists, so do not say it does not. What ran out is something
      // to measure: the only node reading that text is the candidate itself,
      // and it does not carry the text as its own name.
      const readers = anchors.slice(0, ANCHORS_SHOWN).map((anchor) => describeNode(anchor.node))
      const more = anchors.length - readers.length
      return (
        `${JSON.stringify(textNear)} is on this screen — it reads as ${readers.join(", ")}` +
        `${more > 0 ? ` and ${more} more` : ""} — but the only node reading it is the candidate ` +
        "itself, so proximity to it separates nothing. Drop textNear and let role and name stand " +
        "on their own, or anchor on the caption of a neighbouring row instead."
      )
    }
    case "ordinal":
      return (
        "fewer controls answered than the ordinal asked for. Drop nth, or use the count the " +
        "rationale reports."
      )
    case undefined:
      return "the screen offered nothing at all to narrow. Check that it has finished loading."
  }
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
/** Which rung of the ladder below actually narrowed the set. */
type TextMatch = "exact" | "contains" | "tokens"

/**
 * A ladder, tried in order, stopping at the first rung that finds anything.
 *
 * 1. **exact** — the text is what the Target said, once punctuation and case are
 *    normalised. Always preferred, and the only rung an `exact: true` Target
 *    will accept.
 * 2. **contains** — the Target's text appears inside the control's. This is what
 *    lets `Member Number` reach `Member Number (Legacy)`, which is why the
 *    Artifact scopes that Target to a panel.
 * 3. **tokens** — every word the control is called is among the words the Target
 *    asked for. Opt-in, and used for the accessible name only.
 *
 * ## The third rung, and why it points the way it does
 *
 * ADR-0007 chose token subset for *selection* because a Tenant's label for a
 * product is longer than the word a caller uses for it: `savings` ⊂ `Regular
 * Savings`. A Tenant's caption for a *field* varies the other way. The vendor's
 * label table ships `Member Number`; an institution whose caption column is
 * narrower configures `Member #`, and shortening it is the only thing they did.
 *
 * So the containment rung above already covers the lengthening direction, and
 * this one covers the shortening direction: the control's own words have to be a
 * subset of the words the Target asked for. `Member #` is `member`, which is
 * among `member number`, so it matches. `Branch` is not. Neither is `Find` among
 * `search` — which is the whole point of the fourth row of SPEC's tenant table,
 * and the reason there is a discovered Override in this repository at all.
 *
 * ## Why it is the last rung and never the first
 *
 * It is strictly weaker than the two above it, so it must never take a candidate
 * away from them: a screen where something matches exactly is a screen where the
 * exact match is the answer. It runs only when the set is *already empty*, which
 * means the alternative to it is `NotFound`. That also makes it safe to add to a
 * system whose whole claim is determinism — the same tree and the same Target
 * still give the same answer, and no Target that resolved yesterday resolves to
 * something else today.
 *
 * A rung that empties the set reports itself as `contains`, because the honest
 * thing to tell a reader is that the *name* ran out of candidates, not that a
 * fallback nobody asked for did.
 */
const narrowByText = (
  entries: ReadonlyArray<IndexedNode>,
  wanted: string,
  read: (entry: IndexedNode) => string | undefined,
  exactOnly: boolean,
  byTokens = false
): { readonly entries: ReadonlyArray<IndexedNode>; readonly how: TextMatch } => {
  const target = normalise(wanted)
  const exact = entries.filter((entry) => normalise(read(entry) ?? "") === target)
  if (exact.length > 0 || exactOnly) return { entries: exact, how: "exact" }
  const contains = entries.filter((entry) => normalise(read(entry) ?? "").includes(target))
  if (contains.length > 0 || !byTokens) return { entries: contains, how: "contains" }
  const abbreviated = entries.filter((entry) => isTokenSubsetOf(read(entry) ?? "", wanted))
  return abbreviated.length === 0
    ? { entries: contains, how: "contains" }
    : { entries: abbreviated, how: "tokens" }
}

/**
 * The regions a heading opens up: the node that reads that way, or — since a
 * caption is childless — the nearest enclosing section, which is what an
 * operator means by "in that panel".
 */
const headedBy = (
  index: TreeIndex,
  entries: ReadonlyArray<IndexedNode>,
  heading: string
): ReadonlyArray<ObservedNode> => {
  const named = narrowByText(entries, heading, (entry) => identity(entry.node), false)
  return [
    ...new Set(
      named.entries.map((entry) =>
        entry.node.children.length > 0 ? entry.node : containerOf(index, entry.node)
      )
    )
  ]
}

/** The nodes a `within` scope opens up, and a sentence saying how it was read. */
const scopeOf = (
  index: TreeIndex,
  scope: NonNullable<Target["within"]>
): { readonly roots: ReadonlyArray<ObservedNode>; readonly rationale: string } => {
  const all = index.nodes.filter((entry) => entry.node !== index.root)

  if (scope.role !== undefined) {
    const byRole = all.filter((entry) => entry.node.role === scope.role)
    const named = scope.name === undefined
      ? byRole
      : narrowByText(byRole, scope.name, (entry) => identity(entry.node), false).entries
    if (named.length > 0 || scope.name === undefined) {
      return {
        roots: named.map((entry) => entry.node),
        rationale: `scoped to ${named.length} ${scope.role} node(s)`
      }
    }

    // The same fallback rung the name-only path *is*, offered here rather than
    // refused. `within: { role: "table", name: "Member Number Search" }` reads
    // as "the table headed Member Number Search", and that is a thing on the
    // screen — but a layout table carries no accessible name, so matching the
    // heading against the table's own name can only ever fail. A live discovery
    // run proposed exactly this scope, was told to drop the role, and proposed
    // it again twice.
    //
    // Safe for the same reason the token rung above is: it runs only when the
    // set is already empty, so the alternative to it is `NotFound` and no scope
    // that resolved yesterday resolves differently today.
    const headed = headedBy(index, all, scope.name).filter((node) => node.role === scope.role)
    return {
      roots: headed,
      rationale: headed.length === 0
        ? `no ${scope.role} is named or headed "${scope.name}"`
        : `no ${scope.role} is named "${scope.name}", so scoped to the ${scope.role} headed that way`
    }
  }

  if (scope.name === undefined) return { roots: [index.root], rationale: "unscoped" }

  const unique = headedBy(index, all, scope.name)
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
  const exhausted = (
    strategy: TargetStrategy,
    offered: ReadonlyArray<IndexedNode>
  ): UnresolvedTarget => ({
    _tag: "NotFound",
    rationale: reasons.join("; "),
    considered,
    narrowedBy: strategy,
    remedy: remedyForUnresolved(index, target, strategy, { applied: strategies, offered })
  })

  if (target.within !== undefined) {
    const offered = entries
    const scope = scopeOf(index, target.within)
    entries = entries.filter((entry) =>
      scope.roots.some((root) => root === entry.node || isAncestorOf(index, root, entry.node))
    )
    strategies.push("within")
    reasons.push(scope.rationale)
    if (entries.length === 0) return exhausted("within", offered)
  }

  if (target.role !== undefined) {
    const offered = entries
    entries = entries.filter((entry) => entry.node.role === target.role)
    strategies.push("role")
    reasons.push(`${entries.length} node(s) with role ${target.role}`)
    if (entries.length === 0) return exhausted("role", offered)
  }

  if (target.name !== undefined) {
    const offered = entries
    // The one place the token rung is offered. A caption (`label`) and a region
    // heading (`within`) are text an operator reads off the screen rather than a
    // control's own name, and widening those would start matching panels by
    // their words rather than by what they are called.
    const narrowed = narrowByText(
      entries,
      target.name,
      (entry) => identity(entry.node),
      target.exact === true,
      true
    )
    entries = narrowed.entries
    const strategy: TargetStrategy =
      narrowed.how === "exact" ? "name" : narrowed.how === "tokens" ? "nameTokens" : "nameContains"
    strategies.push(strategy)
    reasons.push(
      narrowed.how === "exact"
        ? `${entries.length} named exactly "${target.name}"`
        : narrowed.how === "tokens"
          ? `no exact or containing name match, so ${entries.length} node(s) whose own words ` +
            `are all among "${target.name}"`
          : `no exact name match, so ${entries.length} node(s) containing "${target.name}"`
    )
    if (entries.length === 0) return exhausted(strategy, offered)
  }

  if (target.label !== undefined) {
    const offered = entries
    const narrowed = narrowByText(entries, target.label, (entry) => labelOf(index, entry.node), false)
    entries = narrowed.entries
    strategies.push("label")
    reasons.push(`${entries.length} captioned "${target.label}" by the preceding cell in their row`)
    if (entries.length === 0) return exhausted("label", offered)
  }

  if (target.textNear !== undefined) {
    const textNear = target.textNear
    const offered = entries
    const anchors = anchorsFor(index, textNear)
    strategies.push("textNear")
    if (anchors.length === 0) {
      reasons.push(`nothing on this screen reads "${textNear}"`)
      return exhausted("textNear", offered)
    }
    // A candidate that carries the anchor text as its own accessible name is at
    // distance zero rather than excluded — see `isOwnAnchor`. Excluding it made
    // `{ name: X, textNear: X }` unsatisfiable, which on this application is the
    // ordinary case, because a control's name and the caption beside it are the
    // same string.
    const scored = offered.flatMap((entry) => {
      const distance = nearness(index, entry, anchors, textNear)
      return distance === undefined ? [] : [{ entry, distance }]
    })
    if (scored.length === 0) {
      reasons.push(`the only thing reading "${textNear}" is the candidate itself`)
      return exhausted("textNear", offered)
    }
    const closest = Math.min(...scored.map((scored) => scored.distance))
    entries = scored.filter((scored) => scored.distance === closest).map((scored) => scored.entry)
    // Proximity in edges of the accessibility tree. Not pixels, not DOM order.
    reasons.push(
      closest === 0
        ? `${entries.length} node(s) named "${textNear}" themselves, which is as near ` +
          "as a control gets to the text that names it"
        : `${entries.length} node(s) ${closest} tree edge(s) from "${textNear}", the closest on the screen`
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
    const narrowedBy = strategies[strategies.length - 1]
    return {
      _tag: "NotFound",
      rationale: reasons.length === 0 ? `nothing matched ${describeTarget(target)}` : reasons.join("; "),
      considered,
      narrowedBy,
      remedy: remedyForUnresolved(index, target, narrowedBy, {
        applied: strategies,
        offered: innermost
      })
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
      return exhausted("ordinal", entries)
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
    .map((entry, ordinal) => ({ ...toMatch(index, entry, ordinal), label: labelTextOf(entry.node) }))

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

/** One control the screen offers, named the way an operator would point at it. */
export interface OfferedControl {
  readonly name: string
  readonly role: string
  /** The panel it sits under, or `""` when it sits in no named region. */
  readonly region: string
}

/**
 * Every control of one role the screen is currently offering.
 *
 * Built out of the same machinery a selection uses, and for a related purpose: a
 * closed list of things that are really there, so that a question about the
 * screen can be asked with the answers enumerated rather than left open. It is
 * what assisted recovery is handed when a Target found nothing, and it is why a
 * proposed correspondent is one of the screen's own controls rather than free
 * text.
 *
 * Deduplicated by name, because Chromium exposes a layout table's contents at
 * every enclosing level and a list with `Find` in it three times tells a reader
 * nothing the list with it once does not. Unnamed nodes are dropped for the same
 * reason: `""` is not something anybody can confirm.
 */
export const controlsOfferedIn = (
  tree: AccessibilityNode,
  itemRole: string
): ReadonlyArray<OfferedControl> => {
  const { items } = listItemsIn(indexTree(tree), { itemRole })
  const seen = new Set<string>()
  const controls: Array<OfferedControl> = []
  for (const item of items) {
    const name = item.label.trim()
    if (name === "" || seen.has(name)) continue
    seen.add(name)
    controls.push({ name, role: itemRole, region: item.region })
  }
  return controls
}

/** A value a screen showed under a caption somebody asked about. */
export interface LabelledValue {
  /** The caption as declared, not as rendered. What a policy entry names. */
  readonly caption: string
  /** What sat beside it, trimmed. */
  readonly text: string
}

/**
 * Every value on a screen that sits under one of the named captions.
 *
 * The same caption-reading rule `labelOf` gives a Target, run in the opposite
 * direction: instead of asking "what is this control called", it asks "what is
 * under the thing called *that*". Heritage Core writes a record as
 * `<td>Member Name</td><td>MARGUERITE A ELLSWORTH</td>`, so the association is
 * positional within the enclosing row and this is the one function in the
 * workspace that computes it.
 *
 * It exists so that a caller can treat a *field* as sensitive rather than a
 * value, which is the only way to be sensitive about text that is nobody's
 * parameter. `packages/policy/src/Sensitivity.ts` declares which captions;
 * nothing here decides.
 *
 * Matching is on the normalised caption, because a caption is rendered text and
 * `Member Name` and `MEMBER NAME` are the same field. Values are deduplicated,
 * because Chromium exposes a layout table's contents at every enclosing level
 * and the same name is reachable a dozen times over.
 */
export const labelledValuesIn = (
  tree: AccessibilityNode,
  captions: ReadonlyArray<string>
): ReadonlyArray<LabelledValue> => {
  const wanted = new Map(captions.map((caption) => [normalise(caption), caption]))
  if (wanted.size === 0) return []

  const index = indexTree(tree)
  const found: Array<LabelledValue> = []
  const seen = new Set<string>()

  for (const node of walk(tree)) {
    const label = labelOf(index, node)
    if (label === undefined) continue
    const caption = wanted.get(normalise(label))
    if (caption === undefined) continue
    const text = readTextOf(node).trim()
    // A value that *is* its own caption is the caption cell reading itself, which
    // happens where a row repeats. Nothing to redact and redacting it would blank
    // the field name out of the log.
    if (text === "" || normalise(text) === normalise(label)) continue
    const key = `${caption} ${text}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push({ caption, text })
  }
  return found
}
