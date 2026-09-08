/**
 * Walking a directory tree and reporting every appearance of a literal.
 *
 * This is the machine underneath the highest value-per-line test in the suite.
 * Its whole job is to make the redaction claim falsifiable: rather than asserting
 * that the scrubber was called, `test/sensitive-data.test.ts` reads back every
 * file a run actually produced and every Artifact on disk, and looks for the
 * member number in them.
 *
 * It lives in its own module for one reason. A scan that only ever runs against
 * a passing tree proves nothing — it could be scanning an empty list of files, or
 * matching nothing, and it would look exactly as green. So the same function is
 * pointed at a deliberately planted secret and required to find it. That only
 * demonstrates anything if it is literally the same function, which is what
 * having one exported copy guarantees.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { extname, join, relative } from "node:path"

/**
 * File types the scan does not read.
 *
 * `.png` is the stated exception, not an oversight: ADR-0010 says screenshots
 * are stored as captured and contain rendered member identifiers. Excluding them
 * *by extension, here, in one place* is what keeps that exception honest — the
 * exception is a line of code a reviewer can find rather than a silent absence.
 * Every other file in an evidence directory is read as text.
 */
export const UNSCANNED_EXTENSIONS: ReadonlyArray<string> = [".png", ".jpg", ".jpeg", ".webm"]

export interface Appearance {
  /** Path relative to the scanned root, so failures read the same everywhere. */
  readonly file: string
  readonly line: number
  readonly secret: string
  /** The offending line, truncated. Printed so a failure is actionable. */
  readonly excerpt: string
}

/**
 * Directories the walk does not descend into.
 *
 * Not a redaction exception — no Evidence is ever written inside one of these.
 * It is that `packages/<name>/node_modules` is a tree of Bun's workspace
 * symlinks, and following them walks the entire dependency graph, which turns a
 * scan of eight source directories into a scan of several thousand files
 * belonging to somebody else.
 */
const NOT_A_PLACE_EVIDENCE_LIVES = new Set(["node_modules", ".git"])

export const filesUnder = (root: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (NOT_A_PLACE_EVIDENCE_LIVES.has(entry)) continue
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else found.push(path)
    }
  }
  walk(root)
  return found
}

/**
 * Every line under `root` containing any of `secrets`.
 *
 * Reports rather than throws, so the caller decides what an appearance means. The
 * planted-secret test wants a non-empty answer; the real one wants an empty one.
 */
export const scanForSecrets = (
  root: string,
  secrets: ReadonlyArray<string>
): ReadonlyArray<Appearance> => {
  const wanted = secrets.filter((secret) => secret.length > 0)
  const appearances: Array<Appearance> = []

  for (const path of filesUnder(root)) {
    if (UNSCANNED_EXTENSIONS.includes(extname(path).toLowerCase())) continue
    const text = readFileSync(path, "utf8")
    text.split("\n").forEach((line, index) => {
      for (const secret of wanted) {
        if (!line.includes(secret)) continue
        appearances.push({
          file: relative(root, path),
          line: index + 1,
          secret,
          excerpt: line.length > 200 ? `${line.slice(0, 200)}…` : line
        })
      }
    })
  }

  return appearances
}

/** A failure message a person can act on without opening a debugger. */
export const describeAppearances = (appearances: ReadonlyArray<Appearance>): string =>
  appearances
    .map(
      (appearance) =>
        `${appearance.file}:${appearance.line} leaks ${JSON.stringify(appearance.secret)}\n    ${appearance.excerpt}`
    )
    .join("\n")
