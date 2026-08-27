/**
 * The accessibility tree, as a value.
 *
 * Playwright hands us the tree as YAML. Everything downstream — Target
 * resolution, `textNear` proximity, `extract` — works on the parsed form of that
 * YAML and never on the document, which is what keeps the promise in
 * docs/adr/0001-accessibility-tree-is-the-only-observation-channel.md checkable
 * rather than aspirational. There is no DOM here to reach for.
 *
 * The snapshot Playwright calls `mode: "ai"` is the one worth parsing: it names
 * every node with a `[ref=...]` handle, and it inlines the contents of iframes,
 * so a caller never has to know a frame boundary was crossed. Those refs are
 * Playwright's own accessibility handles, valid only for the snapshot that
 * produced them; they are stripped before a tree is handed to a caller, so a
 * ref can never be recorded in a Capability Artifact and go stale.
 */

/** One node of an observed accessibility tree, as a caller sees it. */
export interface AccessibilityNode {
  /** ARIA role, e.g. `textbox`, `cell`, `link`. `text` for a bare text node. */
  readonly role: string
  /** The accessible name, when the node has one. */
  readonly name?: string | undefined
  /** Inline content: a text node's text, or a control's current value. */
  readonly value?: string | undefined
  /** Extra facts the snapshot carries, e.g. `url` on a link, `cursor`. */
  readonly properties: Readonly<Record<string, string>>
  /** Set on an `iframe` node: the frame's name, so frames stay nameable. */
  readonly frame?: string | undefined
  readonly children: ReadonlyArray<AccessibilityNode>
}

/**
 * The same node while it is still inside the adapter, carrying the Playwright
 * accessibility ref that lets us act on it. Never leaves the package.
 */
export interface ObservedNode extends AccessibilityNode {
  readonly ref?: string | undefined
  readonly children: ReadonlyArray<ObservedNode>
}

/** Whitespace-normalised, case-folded, for comparing names and text. */
export const normalise = (value: string): string =>
  value.replace(/\s+/g, " ").trim().toLowerCase()

/** What a node says for itself, ignoring its descendants. */
export const ownText = (node: AccessibilityNode): string =>
  [node.name, node.value].filter((part): part is string => part !== undefined && part !== "").join(" ")

/** Everything a node and its descendants say, in document order. */
export const nodeText = (node: AccessibilityNode): string =>
  [ownText(node), ...node.children.map(nodeText)]
    .filter((part) => part !== "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()

/** `textbox "Member Number"`, the way an operator would say it. */
export const describeNode = (node: AccessibilityNode): string =>
  node.name === undefined || node.name === "" ? node.role : `${node.role} "${node.name}"`

/** Depth-first walk, parents before children. */
export function* walk<N extends AccessibilityNode>(node: N): Generator<N> {
  yield node
  for (const child of node.children as ReadonlyArray<N>) yield* walk(child)
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface Line {
  readonly indent: number
  readonly body: string
}

const readLines = (yaml: string): ReadonlyArray<Line> =>
  yaml
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => ({ indent: line.length - line.trimStart().length, body: line.trimStart() }))

/** What a backslash escape stands for. Shared by YAML and by `JSON.stringify`. */
const ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  "0": "\0"
}

/**
 * Reads a double-quoted scalar starting at `start`, honouring backslash escapes.
 *
 * The escapes are decoded rather than merely skipped over, which matters in both
 * directions. Playwright's snapshot writer emits a name containing a newline as
 * `\n`, and `formatAccessibilityTree` writes one back with `JSON.stringify` —
 * the two agree on this alphabet, so treating `\n` as a literal `n` would both
 * misread a real snapshot and break the round trip.
 */
const readQuoted = (source: string, start: number): { value: string; end: number } => {
  let value = ""
  let index = start + 1
  while (index < source.length) {
    const char = source[index]!
    if (char === "\\" && index + 1 < source.length) {
      const escaped = source[index + 1]!
      if (escaped === "u" && index + 5 < source.length + 1) {
        const code = source.slice(index + 2, index + 6)
        if (/^[0-9a-fA-F]{4}$/.test(code)) {
          value += String.fromCharCode(parseInt(code, 16))
          index += 6
          continue
        }
      }
      value += ESCAPES[escaped] ?? escaped
      index += 2
      continue
    }
    if (char === '"') return { value, end: index + 1 }
    value += char
    index += 1
  }
  return { value, end: index }
}

/**
 * Splits `cell "Member Number" [ref=e29]: 12345` into head and value at the
 * first colon that is neither inside a quoted name nor inside a `[...]`
 * attribute, which is why this is a scan rather than an `indexOf`.
 */
const splitHead = (body: string): { head: string; value: string | undefined } => {
  let index = 0
  let brackets = 0
  while (index < body.length) {
    const char = body[index]!
    if (char === '"') {
      index = readQuoted(body, index).end
      continue
    }
    if (char === "[") brackets += 1
    else if (char === "]") brackets -= 1
    else if (char === ":" && brackets === 0) {
      return { head: body.slice(0, index).trim(), value: body.slice(index + 1).trim() }
    }
    index += 1
  }
  return { head: body.trim(), value: undefined }
}

interface Head {
  readonly role: string
  readonly name: string | undefined
  readonly ref: string | undefined
  /**
   * The frame this node is the boundary of, from a `[frame=...]` tag.
   *
   * Playwright never writes one — `annotateFrames` puts it on afterwards from
   * the browser's frame list. It is read back here so that
   * `formatAccessibilityTree` stays a fixed point over a tree that has frames in
   * it. Without this, re-parsing a rendered tree turned the frame name into an
   * ordinary property and the next render moved it onto a line of its own.
   */
  readonly frame: string | undefined
  readonly properties: Record<string, string>
}

const parseHead = (head: string): Head => {
  const roleMatch = /^[^\s[]+/.exec(head)
  const role = roleMatch === null ? head : roleMatch[0]
  let index = role.length
  let name: string | undefined
  let ref: string | undefined
  let frame: string | undefined
  const properties: Record<string, string> = {}

  while (index < head.length) {
    const char = head[index]!
    if (char === " ") {
      index += 1
      continue
    }
    if (char === '"') {
      const quoted = readQuoted(head, index)
      name = quoted.value
      index = quoted.end
      continue
    }
    if (char === "[") {
      const close = head.indexOf("]", index)
      const attribute = head.slice(index + 1, close === -1 ? head.length : close)
      const equals = attribute.indexOf("=")
      const key = equals === -1 ? attribute : attribute.slice(0, equals)
      const attributeValue = equals === -1 ? "true" : attribute.slice(equals + 1)
      if (key === "ref") ref = attributeValue
      else if (key === "frame") frame = attributeValue
      else properties[key] = attributeValue
      index = close === -1 ? head.length : close + 1
      continue
    }
    index += 1
  }

  return { role, name, ref, frame, properties }
}

/**
 * Unwraps a YAML single-quoted scalar sitting at the start of a line.
 *
 * Playwright's snapshot writer quotes a whole node head when it contains a
 * character YAML would otherwise read as syntax. The one this fixture produces
 * is `#`, which starts a comment: a tenant whose member-number caption reads
 * `Member #` gets `- 'textbox "Member #"'` where every other node is bare.
 *
 * The quoting is the emitter being correct. A parser that did not undo it would
 * read the role as `'textbox`, match no role filter, and report a control that
 * is plainly on the screen as missing — a whole tenant's worth of "unresolvable"
 * caused by one punctuation mark. Anything after the closing quote (the `:
 * value` half of a map entry, when the head alone needed quoting) is kept.
 */
const unwrapSingleQuoted = (body: string): string => {
  if (!body.startsWith("'")) return body
  let value = ""
  let index = 1
  while (index < body.length) {
    if (body[index] === "'") {
      // `''` is how YAML spells a literal apostrophe inside a quoted scalar.
      if (body[index + 1] === "'") {
        value += "'"
        index += 2
        continue
      }
      return value + body.slice(index + 1)
    }
    value += body[index]!
    index += 1
  }
  return value
}

const unquote = (value: string): string =>
  value.startsWith('"')
    ? readQuoted(value, 0).value
    : value.startsWith("'")
      ? unwrapSingleQuoted(value)
      : value

/**
 * Parses one aria snapshot into a tree rooted at a synthetic `document` node.
 *
 * Hand-rolled rather than delegated to a YAML library because the grammar is
 * tiny, fixed, and the shape we want out of it is a node tree rather than a
 * plain object: `- textbox "Member Number" [ref=e31]: "12345"`.
 */
export const parseAccessibilityTree = (yaml: string): ObservedNode => {
  const lines = readLines(yaml)
  let cursor = 0

  /**
   * One indentation block. `ownProperties` are the `- /url: ...` lines that
   * appeared before any sibling node, which belong to the node this block hangs
   * off rather than to anything inside it.
   */
  interface Block {
    readonly nodes: ReadonlyArray<ObservedNode>
    readonly ownProperties: Readonly<Record<string, string>>
  }

  const parseBlock = (indent: number): Block => {
    const nodes: Array<ObservedNode> = []
    const ownProperties: Record<string, string> = {}

    while (cursor < lines.length) {
      const line = lines[cursor]!
      if (line.indent !== indent || !line.body.startsWith("- ")) break
      cursor += 1

      const body = unwrapSingleQuoted(line.body.slice(2))
      if (body.startsWith("/")) {
        const separator = body.indexOf(":")
        const key = body.slice(1, separator === -1 ? body.length : separator).trim()
        const value = separator === -1 ? "" : unquote(body.slice(separator + 1).trim())
        const previous = nodes[nodes.length - 1]
        if (previous === undefined) {
          ownProperties[key] = value
        } else {
          nodes[nodes.length - 1] = {
            ...previous,
            properties: { ...previous.properties, [key]: value }
          }
        }
        continue
      }

      const { head, value } = splitHead(body)
      const parsed = parseHead(head)

      let inlineValue: string | undefined
      if (value === "|" || value === "|-") {
        // A YAML block scalar: every *deeper* line belongs to this node's text.
        //
        // Deeper is the load-bearing word. A block scalar's content is more
        // indented than the line that opened it, always — so if the next line is
        // not, this block has no content and the node's text is empty. Taking
        // the next line's indent unconditionally is what used to break here: a
        // `|` immediately followed by a sibling gave `blockIndent === indent`,
        // and the `>=` loop then ate that sibling and every one after it,
        // silently deleting the rest of the block from the tree.
        const nextIndent = lines[cursor]?.indent
        const parts: Array<string> = []
        if (nextIndent !== undefined && nextIndent > indent) {
          while (cursor < lines.length && lines[cursor]!.indent >= nextIndent) {
            parts.push(lines[cursor]!.body)
            cursor += 1
          }
        }
        inlineValue = parts.join(" ")
      } else if (value !== undefined && value !== "") {
        inlineValue = unquote(value)
      }

      const block = cursor < lines.length && lines[cursor]!.indent > indent
        ? parseBlock(lines[cursor]!.indent)
        : { nodes: [], ownProperties: {} }

      nodes.push({
        role: parsed.role,
        name: parsed.name,
        value: inlineValue,
        ref: parsed.ref,
        frame: parsed.frame,
        properties: { ...parsed.properties, ...block.ownProperties },
        children: block.nodes
      })
    }

    return { nodes, ownProperties }
  }

  const roots = lines.length === 0 ? [] : parseBlock(lines[0]!.indent).nodes
  return { role: "document", properties: {}, children: roots }
}

/**
 * Names the iframe nodes in a tree.
 *
 * The aria snapshot shows Heritage Core's Account Detail iframe as a bare
 * `iframe` node with no accessible name; the name `acctdetail` is only knowable
 * from the browser's frame list. Matching the two up in document order is what
 * lets `observe` report a frame an operator can talk about, while Targets carry
 * on saying nothing about frames at all.
 */
export const annotateFrames = (
  root: ObservedNode,
  frameNames: ReadonlyArray<string>
): ObservedNode => {
  let next = 0
  const annotate = (node: ObservedNode): ObservedNode => {
    const frame = node.role === "iframe" ? frameNames[next++] : undefined
    return { ...node, frame, children: node.children.map(annotate) }
  }
  return annotate(root)
}

// ---------------------------------------------------------------------------
// Projection and rendering
// ---------------------------------------------------------------------------

/**
 * Drops the Playwright refs on the way out of the adapter.
 *
 * A ref is a positional handle scoped to one snapshot: exactly the kind of
 * coupling a Target is supposed to replace. Callers get a tree they can only
 * describe, so the only way back to a control is to name it again.
 */
export const withoutRefs = (node: ObservedNode): AccessibilityNode => ({
  role: node.role,
  name: node.name,
  value: node.value,
  properties: node.properties,
  frame: node.frame,
  children: node.children.map(withoutRefs)
})

/**
 * Whether the parser reads this text back as itself when it is written bare.
 *
 * The renderer asks the reader rather than carrying a second, hand-maintained
 * copy of the grammar, because the two drifting apart is exactly the defect this
 * function exists to prevent. `formatAccessibilityTree` has to be a fixed point:
 * Discovery's stuck detection hashes rendered snapshots, and a tree that renders
 * to something parsing back as a *different* tree makes that hash mean nothing.
 *
 * Four ways a bare value fails to survive, all of them silently:
 *
 *   - it opens with `"` or `'`, so `unquote` reads a quoted scalar and drops
 *     whatever followed the closing quote — `"hello" world` comes back `hello`;
 *   - it is `|` or `|-`, which `parseBlock` reads as a block scalar header
 *     rather than as text;
 *   - it contains a `:`, which `splitHead` may take as the head separator;
 *   - it has leading or trailing whitespace, which `readLines` and the
 *     `.trim()` in `splitHead` remove.
 *
 * Anything that fails is emitted with `JSON.stringify`, whose escapes `readQuoted`
 * decodes.
 */
const readsBackBare = (text: string): boolean =>
  text !== "" &&
  text !== "|" &&
  text !== "|-" &&
  text === text.trim() &&
  !text.includes(":") &&
  unquote(text) === text

const renderValue = (value: string): string => {
  const flat = value.replace(/\s+/g, " ").trim()
  return readsBackBare(flat) ? flat : JSON.stringify(flat)
}

/** Renders a tree back to the YAML shape a model or an operator reads. */
export const formatAccessibilityTree = (root: AccessibilityNode): string => {
  const lines: Array<string> = []

  const render = (node: AccessibilityNode, depth: number): void => {
    const pad = "  ".repeat(depth)
    const head = [
      node.role,
      node.name === undefined ? undefined : JSON.stringify(node.name),
      node.frame === undefined ? undefined : `[frame=${node.frame}]`
    ]
      .filter((part) => part !== undefined)
      .join(" ")

    const propertyLines = Object.entries(node.properties).map(
      ([key, value]) => `${pad}  - /${key}: ${renderValue(value)}`
    )
    const hasBody = node.children.length > 0 || propertyLines.length > 0

    if (node.value !== undefined && node.value !== "") {
      lines.push(`${pad}- ${head}: ${renderValue(node.value)}`)
    } else {
      lines.push(`${pad}- ${head}${hasBody ? ":" : ""}`)
    }

    lines.push(...propertyLines)
    for (const child of node.children) render(child, depth + 1)
  }

  for (const child of root.children) render(child, 0)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Index: parents, depths and paths, which resolution needs and nodes do not carry
// ---------------------------------------------------------------------------

export interface IndexedNode {
  readonly node: ObservedNode
  readonly parent: ObservedNode | undefined
  readonly depth: number
  /** Ancestor trail, e.g. `table > rowgroup > row > cell`. */
  readonly path: ReadonlyArray<string>
  /** Document order, so `nth` and "preceding" mean something. */
  readonly order: number
  /** Name of the frame this node lives in; `main` for the top document. */
  readonly frame: string
}

export interface TreeIndex {
  readonly root: ObservedNode
  readonly nodes: ReadonlyArray<IndexedNode>
  readonly of: (node: ObservedNode) => IndexedNode
}

export const indexTree = (root: ObservedNode, mainFrameName = "main"): TreeIndex => {
  const nodes: Array<IndexedNode> = []
  const byNode = new Map<ObservedNode, IndexedNode>()

  const visit = (
    node: ObservedNode,
    parent: ObservedNode | undefined,
    depth: number,
    path: ReadonlyArray<string>,
    frame: string
  ): void => {
    const entry: IndexedNode = { node, parent, depth, path, order: nodes.length, frame }
    nodes.push(entry)
    byNode.set(node, entry)
    // Descending through an iframe node changes which document we are in. That
    // is the only place frame identity enters, and callers never see it.
    const childFrame = node.role === "iframe" && node.frame !== undefined ? node.frame : frame
    const childPath = [...path, describeNode(node)]
    for (const child of node.children) visit(child, node, depth + 1, childPath, childFrame)
  }

  visit(root, undefined, 0, [], mainFrameName)

  return {
    root,
    nodes,
    of: (node) => {
      const entry = byNode.get(node)
      if (entry === undefined) throw new Error("node does not belong to this tree")
      return entry
    }
  }
}

/** Tree distance: edges from `a` up to the lowest common ancestor and back down. */
export const treeDistance = (index: TreeIndex, a: ObservedNode, b: ObservedNode): number => {
  const ancestorsOf = (node: ObservedNode): Array<ObservedNode> => {
    const chain: Array<ObservedNode> = []
    let current: ObservedNode | undefined = node
    while (current !== undefined) {
      chain.push(current)
      current = index.of(current).parent
    }
    return chain
  }

  const chainA = ancestorsOf(a)
  const chainB = ancestorsOf(b)
  const setB = new Map(chainB.map((node, depth) => [node, depth]))
  for (const [stepsUp, node] of chainA.entries()) {
    const stepsDown = setB.get(node)
    if (stepsDown !== undefined) return stepsUp + stepsDown
  }
  return chainA.length + chainB.length
}

/** True when `ancestor` encloses `node`. Used to discard enclosing duplicates. */
export const isAncestorOf = (
  index: TreeIndex,
  ancestor: ObservedNode,
  node: ObservedNode
): boolean => {
  let current = index.of(node).parent
  while (current !== undefined) {
    if (current === ancestor) return true
    current = index.of(current).parent
  }
  return false
}
