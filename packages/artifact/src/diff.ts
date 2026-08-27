/**
 * The diff between two versions of a Capability.
 *
 * SPEC's reason for storing Artifacts as immutable per-version files is that "a
 * reviewer can diff `1.0.0` against `1.1.0` and see one outcome entry added".
 * That claim is only worth making if something actually renders the diff, so
 * this does — with no dependency on git, on a checkout, or on the two versions
 * being on disk at all, because the most useful moment to show one is *before*
 * the new version has been written.
 *
 * ## Both sides are normalised first
 *
 * `formatArtifact` is applied to both. That is the load-bearing decision here.
 *
 * The stored `1.0.0` of a hand-written Capability carries a great deal of
 * comment prose, and `Bun.YAML.parse` drops comments — so diffing the file on
 * disk against a document an Amendment produced would show every one of those
 * comments being deleted, and bury the two lines that actually changed. Diffing
 * the two *documents*, each rendered by the same emitter, shows the change and
 * nothing but the change.
 *
 * The honesty cost is stated rather than hidden: this is a diff of what the two
 * versions *mean*, not of the bytes in the two files. `formatArtifact` is
 * lossless over everything the schema encodes and lossy over comments alone, and
 * `test/artifact-schema.test.ts` pins the round trip that makes the first half
 * of that true.
 *
 * ## Unified format, because everyone already reads it
 *
 * Three lines of context either side, `@@` hunk headers, `-`/`+` markers. Not a
 * new notation for an audience that reviews code all day.
 */

import type { CapabilityArtifact } from "./CapabilityArtifact.ts"
import { formatArtifact } from "./parse.ts"

export interface DiffOptions {
  /** Lines of unchanged context to keep either side of a change. */
  readonly context?: number
}

/**
 * A unified diff of two Artifacts, normalised through the same emitter.
 *
 * The empty string when they are the same document, so a caller can print it
 * unconditionally and say nothing when there is nothing to say.
 */
export const diffArtifacts = (
  before: CapabilityArtifact,
  after: CapabilityArtifact,
  options: DiffOptions = {}
): string => {
  const left = formatArtifact(before).split("\n")
  const right = formatArtifact(after).split("\n")
  const header = [
    `--- ${before.capability}@${before.version}`,
    `+++ ${after.capability}@${after.version}`
  ]
  const body = unified(left, right, options.context ?? 3)
  return body === "" ? "" : [...header, body].join("\n")
}

/** How many lines the diff touches. For "one outcome entry added" in a sentence. */
export const diffSize = (
  before: CapabilityArtifact,
  after: CapabilityArtifact
): { readonly added: number; readonly removed: number } => {
  const edits = diffLines(formatArtifact(before).split("\n"), formatArtifact(after).split("\n"))
  return {
    added: edits.filter((edit) => edit.op === "+").length,
    removed: edits.filter((edit) => edit.op === "-").length
  }
}

// ---------------------------------------------------------------------------
// A line diff, from scratch
// ---------------------------------------------------------------------------

interface Edit {
  readonly op: " " | "-" | "+"
  readonly text: string
}

/**
 * Longest common subsequence over lines, as a table.
 *
 * Quadratic, and that is fine: the documents are a few hundred lines and this
 * runs once at the end of a run that just drove a browser. A cleverer algorithm
 * would be a second thing to be right about for no gain anybody could measure.
 *
 * The two ends are trimmed first, which is what keeps the table small in the
 * case this exists for — two versions that share almost everything.
 */
const diffLines = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>
): ReadonlyArray<Edit> => {
  let head = 0
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1

  let tail = 0
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tail += 1
  }

  const a = left.slice(head, left.length - tail)
  const b = right.slice(head, right.length - tail)

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: Array<Array<number>> = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  )
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j]
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const edits: Array<Edit> = left.slice(0, head).map((text) => ({ op: " " as const, text }))
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      edits.push({ op: " ", text: a[i]! })
      i += 1
      j += 1
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      edits.push({ op: "-", text: a[i]! })
      i += 1
    } else {
      edits.push({ op: "+", text: b[j]! })
      j += 1
    }
  }
  while (i < a.length) edits.push({ op: "-", text: a[i++]! })
  while (j < b.length) edits.push({ op: "+", text: b[j++]! })
  for (const text of left.slice(left.length - tail)) edits.push({ op: " ", text })

  return edits
}

/** Unified hunks over an edit script. Empty when nothing changed. */
const unified = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
  context: number
): string => {
  const edits = diffLines(left, right)
  if (edits.every((edit) => edit.op === " ")) return ""

  // Which edits are near enough a change to be worth printing.
  const keep = new Array<boolean>(edits.length).fill(false)
  edits.forEach((edit, index) => {
    if (edit.op === " ") return
    for (
      let near = Math.max(0, index - context);
      near <= Math.min(edits.length - 1, index + context);
      near += 1
    ) {
      keep[near] = true
    }
  })

  const lines: Array<string> = []
  let leftLine = 1
  let rightLine = 1
  let index = 0
  while (index < edits.length) {
    if (!keep[index]) {
      if (edits[index]!.op !== "+") leftLine += 1
      if (edits[index]!.op !== "-") rightLine += 1
      index += 1
      continue
    }

    const startLeft = leftLine
    const startRight = rightLine
    const hunk: Array<string> = []
    let spannedLeft = 0
    let spannedRight = 0
    while (index < edits.length && keep[index]) {
      const edit = edits[index]!
      hunk.push(`${edit.op}${edit.text}`)
      if (edit.op !== "+") {
        leftLine += 1
        spannedLeft += 1
      }
      if (edit.op !== "-") {
        rightLine += 1
        spannedRight += 1
      }
      index += 1
    }
    lines.push(`@@ -${startLeft},${spannedLeft} +${startRight},${spannedRight} @@`, ...hunk)
  }

  return lines.join("\n")
}
