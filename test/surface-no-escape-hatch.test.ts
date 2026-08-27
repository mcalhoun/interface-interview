/**
 * The constraint that defines the Surface Adapter, asserted rather than asserted
 * about.
 *
 * ADR-0001 says a caller who wants the DOM has nowhere to put the request. That
 * is only worth writing down if something checks it, because the failure mode is
 * not a bug report — it is a selector quietly appearing in one method six months
 * from now and the whole design argument silently becoming untrue.
 *
 * Three things are checked, at three different levels:
 *
 *   1. The type of every method. `@ts-expect-error` below fails the build if a
 *      Target ever gains somewhere to put a selector, and passes only while
 *      there is nowhere.
 *   2. The runtime shape of a decoded Target: an excess `selector` is not
 *      carried through, it is dropped.
 *   3. The implementation. The package may reach a browser node only through an
 *      accessibility ref, and may not read markup at all.
 */

import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "@cua/legacy-core"
import { SurfaceAdapter, TargetSchema, playwrightSurface } from "@cua/surface"

const SOURCE_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "surface",
  "src"
)

/** Comments in this package discuss selectors at length; code must not use them. */
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

const sourceFiles = (): ReadonlyArray<{ name: string; text: string }> =>
  readdirSync(SOURCE_DIRECTORY)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      name,
      text: withoutComments(readFileSync(join(SOURCE_DIRECTORY, name), "utf8"))
    }))

it.live("the adapter exposes exactly the seven Surface methods and nothing else", () =>
  Effect.gen(function* () {
    const core = yield* serve({ port: 0 })
    const methods = yield* Effect.gen(function* () {
      const surface = yield* SurfaceAdapter
      return Object.keys(surface).sort()
    }).pipe(Effect.provide(playwrightSurface({ startUrl: core.origin + "/" })))

    // `navigate` is the eighth: opening a location. A URL is a place, not a
    // description of markup, so it does not weaken the constraint.
    expect(methods).toEqual([
      "captureEvidence",
      "click",
      "extract",
      "fill",
      "navigate",
      "observe",
      "resolveTarget",
      "waitFor"
    ])
  }).pipe(Effect.scoped)
)

it("a Target has nowhere to put a selector", () => {
  const target = { role: "textbox", name: "Member Number" }

  // Each of these is a way a caller might try to smuggle markup coupling in.
  // Every one of them has to be a type error for the ADR's claim to hold.

  // @ts-expect-error a Target has no `selector`
  void ({ ...target, selector: "input[name=memberNumber]" } satisfies typeof TargetSchema.Type)
  // @ts-expect-error a Target has no `css`
  void ({ ...target, css: "#memberNumber" } satisfies typeof TargetSchema.Type)
  // @ts-expect-error a Target has no `xpath`
  void ({ ...target, xpath: "//input[1]" } satisfies typeof TargetSchema.Type)
  // @ts-expect-error a Target has no `testId`
  void ({ ...target, testId: "member-number" } satisfies typeof TargetSchema.Type)
  // @ts-expect-error a Target has no frame, because frame traversal is the adapter's job
  void ({ ...target, frame: "acctdetail" } satisfies typeof TargetSchema.Type)

  // And at runtime, an untrusted Target with a selector on it loses the selector
  // rather than carrying it anywhere useful.
  const decoded = Schema.decodeUnknownSync(TargetSchema)({
    role: "textbox",
    name: "Member Number",
    selector: "input[name=memberNumber]"
  })
  expect(decoded).toEqual({ role: "textbox", name: "Member Number" })
  expect(Object.keys(decoded)).not.toContain("selector")
})

it("the package reaches the browser only through an accessibility ref", () => {
  const calls = sourceFiles().flatMap(({ name, text }) =>
    [...text.matchAll(/\.locator\(([^)]*)/g)].map((match) => ({ name, argument: match[1] ?? "" }))
  )

  // Exactly one construction site, and it can only be handed an `aria-ref`.
  expect(calls).toHaveLength(1)
  expect(calls[0]!.argument).toBe("`aria-ref=${ref}`")
})

it("no source in the package can read markup", () => {
  // Playwright's ways back to the document. If one of these ever appears, the
  // accessibility tree has stopped being the only observation channel.
  const forbidden = [
    /\.innerHTML/,
    /\.outerHTML/,
    /page\.content\(/,
    /\.\$\$?eval\(/,
    /\.evaluate(Handle)?\(/,
    /\.textContent\(/,
    /\.innerText\(/,
    /getBy(Role|Text|Label|TestId|Placeholder|AltText|Title)\(/,
    /page\.\$\$?\(/,
    /elementHandle/i,
    /querySelector/i,
    /\bxpath\b/i,
    /["'`]css=/
  ]

  for (const { name, text } of sourceFiles()) {
    for (const pattern of forbidden) {
      expect(text, `${name} reaches for the document with ${pattern}`).not.toMatch(pattern)
    }
  }
})

it("nothing the adapter hands back is markup", () => {
  // The surface of the returned types, read off the source: no field anywhere
  // is called `html`, `markup`, `dom` or `selector`.
  const declarations = sourceFiles()
    .flatMap(({ text }) => text.split("\n"))
    .filter((line) => /^\s+readonly\s+\w+\??:/.test(line))
    .map((line) => /^\s+readonly\s+(\w+)/.exec(line)![1]!)

  expect(declarations.length).toBeGreaterThan(20)
  for (const field of declarations) {
    expect(field.toLowerCase()).not.toMatch(/html|markup|\bdom\b|selector|xpath|locator|element/)
  }
})
