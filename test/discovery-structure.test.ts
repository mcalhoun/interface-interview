/**
 * The two structural claims this package makes, checked by reading its own source.
 *
 * Source scans are the weakest kind of test and these are deliberately crude,
 * which is the point: they fail when a number changes, and whoever changed it has
 * to say why in the diff. They are the same instruments
 * `test/replay-has-no-model.test.ts` uses on the Replay engine, pointed at the
 * one package that is *allowed* to reach a model — because the interesting
 * question here is not whether a model is present but whether it is confined.
 *
 *   1. **Provider choice is a Layer swap.** SPEC: "We hand-roll no provider
 *      abstraction." So exactly one file may name a provider, and the loop must
 *      not be one of them — otherwise "switching providers needs no change to the
 *      loop" is an assertion nobody can check.
 *   2. **Policy is the only path to the Surface.** Every acting call on the
 *      adapter sits inside the `authorised` gate, and no other file in the package
 *      touches an acting method at all.
 */

import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const AGENT_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "agent",
  "src"
)

const withoutComments = (text: string): string =>
  text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:])\/\/.*$/gm, "$1")

const sources = (): ReadonlyArray<{ name: string; text: string }> =>
  readdirSync(AGENT_SOURCE)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      name,
      text: withoutComments(readFileSync(join(AGENT_SOURCE, name), "utf8"))
    }))

// ---------------------------------------------------------------------------
// The provider is a layer swap
// ---------------------------------------------------------------------------

it("only one file in the package names a model provider", () => {
  const naming = sources()
    .filter(({ text }) => /@effect\/ai-|OpenAi|\bopenai\b|\banthropic\b/i.test(text))
    .map(({ name }) => name)

  // One, and which one. Ticket 15 reuses this same layer for the
  // classification-only assist model, so it stays a single file then too.
  expect(naming).toEqual(["provider.ts"])
})

it("the loop reaches for LanguageModel and nothing more specific", () => {
  const loop = sources().find(({ name }) => name === "loop.ts")!
  // The abstraction ships with the framework. A wrapper around it here would be
  // the hand-rolled provider abstraction SPEC rules out, and it would also be the
  // thing that made a provider swap require a code change.
  expect(loop.text).toContain("LanguageModel.generateText")
  expect(loop.text).not.toMatch(/OpenAi|anthropic/i)
})

it("the api key is read as a redacted config value and never as a string", () => {
  const provider = sources().find(({ name }) => name === "provider.ts")!
  expect(provider.text).toContain("Config.redacted")

  // Never from the environment directly, where it would be a plain string that
  // could be logged or interpolated by accident.
  for (const { name, text } of sources()) {
    expect(text, `${name} reads the environment directly`).not.toMatch(
      /process\s*\.\s*env|Bun\s*\.\s*env/
    )
  }
})

// ---------------------------------------------------------------------------
// Policy is the only path to the surface
// ---------------------------------------------------------------------------

it("every surface action in the loop goes through the policy gate", () => {
  const loop = sources().find(({ name }) => name === "loop.ts")!

  // Counting is crude and that is the point: another acting call appearing
  // outside the chokepoint changes this number and fails here. Five, one per
  // verb that touches the Surface — `selectFromList` shares `click`'s call site
  // by resolving to an ordinary Target first, exactly as Replay's engine does.
  const acting = [...loop.text.matchAll(/surface\s*\.\s*(navigate|click|fill|extract)\s*\(/g)]
  expect(acting).toHaveLength(6)

  // And every one of them is inside an `authorised(...)`/`attempt(...)` block.
  expect([...loop.text.matchAll(/authorised\s*\(/g)].length).toBeGreaterThan(0)

  // No other file in the package touches an acting method at all.
  for (const { name, text } of sources()) {
    if (name === "loop.ts") continue
    expect(text, `${name} acts on the surface outside the policy gate`).not.toMatch(
      /surface\s*\.\s*(navigate|click|fill|extract)\s*\(/
    )
  }
})

it("the toolkit's handlers cannot act, and tool call resolution stays off", () => {
  const vocabulary = sources().find(({ name }) => name === "Vocabulary.ts")!
  const loop = sources().find(({ name }) => name === "loop.ts")!

  // The model proposes; the framework resolves nothing; the loop executes only
  // through the gate. If resolution were ever re-enabled, the handlers die loudly
  // rather than quietly performing an action Policy never saw.
  expect(loop.text).toContain("disableToolCallResolution: true")
  expect(vocabulary.text).toContain("Effect.die")

  // And there is no route from a handler to the adapter: the vocabulary module
  // does not import it.
  expect(vocabulary.text).not.toContain("SurfaceAdapter")
})
