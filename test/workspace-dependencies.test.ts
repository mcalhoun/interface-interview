/**
 * Every workspace package declares what its own source imports.
 *
 * ## The bug this exists to keep out
 *
 * `packages/agent/package.json` declared no dependencies at all while
 * `packages/agent/src/provider.ts` imported `@effect/ai-openai` and `effect`,
 * and five other `@cua/*` packages besides. It worked, and it worked for the
 * worst possible reason: Bun hoists every workspace dependency to the root
 * `node_modules`, so a package that declares nothing resolves exactly as well as
 * a package that declares everything — inside this workspace. Outside it, an
 * install of `@cua/agent` on its own could not resolve a single one of those
 * imports.
 *
 * A missing declaration is therefore invisible to `bun install`, invisible to
 * `tsc`, and invisible to the test suite. This is the instrument that makes it
 * visible: read each package's own source, work out what it reaches for, and
 * require the manifest to say so.
 *
 * ## The rule
 *
 * For every workspace package: every bare import specifier appearing in its
 * `src/` must name a package listed in that manifest's `dependencies` or
 * `devDependencies`. Node builtins (`node:*`) and relative paths are not
 * packages and are skipped.
 *
 * Third-party versions are checked against the root manifest as well. One pin
 * per dependency across the workspace is the reason a single `bun install`
 * produces one copy of `effect`, and two packages disagreeing about an RC
 * version is the kind of thing that presents as an inexplicable type error
 * rather than as a version conflict.
 *
 * ## Deliberately crude
 *
 * A regex over comment-stripped source, in the same spirit as
 * `test/discovery-structure.test.ts` and `test/replay-has-no-model.test.ts`.
 * Comments are stripped because several modules discuss imports in prose, and a
 * sentence is not a dependency.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

interface Manifest {
  readonly name: string
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
}

const manifestAt = (directory: string): Manifest =>
  JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Manifest

/** Every workspace member, by directory. The root globs are `packages/*` and `apps/*`. */
const members = (): ReadonlyArray<{ directory: string; manifest: Manifest }> =>
  ["packages", "apps"].flatMap((group) =>
    readdirSync(join(ROOT, group))
      .map((name) => join(ROOT, group, name))
      .filter((directory) => statSync(directory).isDirectory())
      .map((directory) => ({ directory, manifest: manifestAt(directory) }))
  )

const withoutComments = (text: string): string =>
  text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:])\/\/.*$/gm, "$1")

const sourcesUnder = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourcesUnder(join(directory, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(directory, entry.name)]
        : []
  )

/**
 * The package a specifier names, or `undefined` for the things that are not
 * packages.
 *
 * `effect/unstable/ai` is a subpath of `effect`; `@effect/ai-openai` is its own
 * name. A relative path and a `node:` builtin are neither.
 */
const packageOf = (specifier: string): string | undefined => {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined
  if (specifier.startsWith("node:")) return undefined
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]
}

/** Every package a directory's TypeScript reaches for, by import or re-export. */
const imported = (directory: string): ReadonlyArray<string> => {
  const found = new Set<string>()
  for (const file of sourcesUnder(directory)) {
    const text = withoutComments(readFileSync(file, "utf8"))
    // Anchored at the start of a line, so a sentence in a rationale string that
    // happens to contain the word `from` before a quote is not a dependency.
    const specifiers = [
      ...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm),
      ...text.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
      ...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)
    ]
    for (const match of specifiers) {
      const name = packageOf(match[1]!)
      if (name !== undefined) found.add(name)
    }
  }
  return [...found].sort()
}

it("every workspace package declares the packages its own source imports", () => {
  const undeclared: Array<string> = []

  for (const { directory, manifest } of members()) {
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {})
    ])
    for (const name of imported(join(directory, "src"))) {
      if (!declared.has(name)) undeclared.push(`${manifest.name} imports ${name}`)
    }
  }

  // Named rather than counted, so a failure says which manifest to edit.
  expect(undeclared).toEqual([])
})

it("a workspace package pins a third-party version to the same value the root does", () => {
  const root = manifestAt(ROOT)
  const rootPins = { ...root.dependencies, ...root.devDependencies }
  const disagreements: Array<string> = []

  for (const { manifest } of members()) {
    const pins = { ...manifest.dependencies, ...manifest.devDependencies }
    for (const [name, version] of Object.entries(pins)) {
      // A workspace sibling is a symlink, not a version.
      if (version.startsWith("workspace:")) continue
      const atRoot = rootPins[name]
      if (atRoot !== undefined && atRoot !== version) {
        disagreements.push(`${manifest.name} pins ${name}@${version}, the root pins ${atRoot}`)
      }
    }
  }

  expect(disagreements).toEqual([])
})

it("a workspace sibling is depended on as a workspace protocol, never a version range", () => {
  const names = new Set(members().map(({ manifest }) => manifest.name))
  const wrong: Array<string> = []

  for (const { manifest } of members()) {
    const pins = { ...manifest.dependencies, ...manifest.devDependencies }
    for (const [name, version] of Object.entries(pins)) {
      if (names.has(name) && !version.startsWith("workspace:")) {
        wrong.push(`${manifest.name} depends on ${name}@${version}`)
      }
    }
  }

  expect(wrong).toEqual([])
})
