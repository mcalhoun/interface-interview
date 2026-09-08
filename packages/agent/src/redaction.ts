/**
 * Discovery keeps its goal and parameter literals in Redacted wrappers. Before
 * the first proposal, diagnostic text is scrubbed against every undeclassified
 * goal term. As values are discovered, the shared registry also protects their
 * rendered and encoded forms. Only caller policy and validated public account
 * selections can declassify text; the model never classifies sensitive data.
 *
 * This file owns the package's unwrap sites. Plaintext is consumed only by
 * prompts, actions, scrubber registration and the in-memory compiler guards.
 */

import type { SecretRegistry, Scrubber } from "@cua/evidence"
import { secretRegistry } from "@cua/evidence"
import { Redacted } from "effect"

export interface DiscoveredSecrets {
  /**
   * The registry to hand to the Evidence writer.
   *
   * A stable object whose `scrub` consults the growing set on every call, rather
   * than a scrubber rebuilt on each registration. The Evidence Layer is
   * constructed once, at the start of the run, and cannot be swapped afterwards.
   */
  readonly registry: SecretRegistry
  /** The `Scrubber` itself, for the text a consultation sends off the machine. */
  readonly scrubber: Scrubber
  /**
   * Registers a value discovered mid-run. Idempotent per name.
   *
   * UNWRAP SITE. The characters become a needle in the scrubbing table and go
   * nowhere else.
   */
  readonly remember: (label: string, value: Redacted.Redacted<string>) => void
  /** The parameter names registered so far. Never their values. */
  readonly names: () => ReadonlyArray<string>
}

export const discoveredSecrets = (): DiscoveredSecrets => {
  // The growing set, and the rebuild-on-registration behaviour, now live in
  // `@cua/evidence`'s `SecretRegistry`. Replay needs exactly the same thing --
  // an Operator types values no Artifact declared, and a screen renders back
  // values nobody parameterised -- and two implementations of "the scrubber can
  // still learn" would be two places for it to stop being true.
  const registry = secretRegistry()

  return {
    registry,
    scrubber: registry.scrub,
    remember: (label, value) => registry.remember([{ label, text: Redacted.value(value) }]),
    names: registry.labels
  }
}

/**
 * The characters to type into a field.
 *
 * UNWRAP SITE. Called at exactly one place in the loop, immediately before
 * `surface.fill`, and the result is not held afterwards.
 */
export const charactersToType = (value: Redacted.Redacted<string>): string =>
  Redacted.value(value)

/**
 * The characters of a discovered value, as a needle for the baked-in-literal
 * check.
 *
 * UNWRAP SITE. The compiler has to be able to ask "does this Artifact
 * contain the member number this run typed", and a check that cannot see the
 * characters cannot answer it — the same unavoidable reason the scrubber above
 * unwraps. `bakedInLiterals` compares and discards; nothing keeps what it is
 * given, and nothing it returns quotes the value it found.
 *
 * It lives here rather than in `compile.ts` so that this file stays the one place
 * in the package where a literal is unwrapped, which is what
 * `test/sensitive-data.test.ts` pins.
 */
export const literalToCheck = (value: Redacted.Redacted<string>): string =>
  Redacted.value(value)

/**
 * Wraps a literal the model supplied, labelled with the parameter it named.
 *
 * The label is what a leak would announce itself as: an accidental serialisation
 * renders `<redacted:memberId>`, which names the parameter that did not escape
 * rather than merely saying something was hidden.
 */
export const asSecret = (label: string, literal: string): Redacted.Redacted<string> =>
  Redacted.make(literal, { label })


/**
 * Discovery cannot classify arbitrary goal text as public. This scrubber is for
 * diagnostic prose only; it must never rewrite executable targets or schema tags.
 * Public words come only from caller policy. Unknown terms are removed even
 * inside longer text, because URLs and account references can embed a value.
 */
export const goalDiagnosticScrubber = (goal: string, publicTerms: ReadonlyArray<string> = []): Scrubber => {
  const terms = [...new Set([
    ...goal.split(/\s+/u),
    ...(goal.match(/[\p{L}\p{N}]+/gu) ?? [])
  ].filter((term) => term !== "" && !publicTerms.includes(term.toLowerCase())))].flatMap((term) => [term, encodeURIComponent(term)])
  const escaped = terms.sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  if (escaped.length === 0) return (text) => text
  const pattern = new RegExp(`(?:${escaped.join("|")})`, "giu")
  return (text) => text.replace(pattern, "[redacted:goal]")
}

/** Model prompts and the compiler consume the goal only in memory. */
export const goalToUse = (goal: string | Redacted.Redacted<string>): string =>
  typeof goal === "string" ? goal : Redacted.value(goal)

export { privateUrlValues } from "@cua/evidence"

/** A compiler gate and diagnostic scrubber share the URL runtime-value spellings. */
export const runtimeUrlScrubber = (values: ReadonlyArray<Redacted.Redacted<string>>): Scrubber => {
  const registry = secretRegistry(values.map((value) => ({ label: "url", text: literalToCheck(value) })))
  return registry.scrub
}
