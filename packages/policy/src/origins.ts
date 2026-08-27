/**
 * What "an allowed origin" means, precisely.
 *
 * This is the smallest module in the system and the one most worth reading
 * closely, because an origin allowlist that is subtly wrong is worse than none:
 * it reads like a control in a review and is not one.
 *
 * Two rules make it hard to get past.
 *
 * 1. **Nothing is ever matched against a URL as a string.** Every comparison
 *    happens on the scheme, host and port that `URL` parsed out. That is what
 *    makes `http://evil.test/?next=http://127.0.0.1:4173` and
 *    `http://127.0.0.1@evil.test/` fail: their hosts are `evil.test`, whatever
 *    the text looks like. A `includes()` allowlist would have passed both.
 * 2. **A pattern that cannot be parsed is refused at load, not ignored.** An
 *    unparseable entry means the reviewer wrote something the engine does not
 *    understand, and quietly dropping it turns a typo into a widened allowlist.
 *
 * The pattern language is deliberately tiny — scheme, host, port, with `*` for
 * "any port" and a `*.` host prefix for "any subdomain" — because every feature
 * added here is another way for an allowlist to mean more than it appears to.
 */

/** One entry from a Policy's `origins:` list, parsed. */
export interface OriginPattern {
  /** The line as written, so a denial can quote the file back at the reader. */
  readonly source: string
  readonly scheme: "http" | "https"
  /** Lowercased. With `subdomains`, this is the base the wildcard sits under. */
  readonly host: string
  /** `any` only from a literal `*` in the port position. */
  readonly port: number | "any"
  /** Written as `*.example.test`: any host under `example.test`, but not it. */
  readonly subdomains: boolean
}

const PATTERN = /^(https?):\/\/(\*\.)?([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::(\d+|\*))?$/

const DEFAULT_PORT = { http: 80, https: 443 } as const

/**
 * Parses one allowlist entry.
 *
 * Returns the problem rather than throwing, because a Policy reports every
 * problem in the file at once — an author fixing an allowlist wants the whole
 * set, the same way `prepareInputs` reports every bad input at once.
 */
export const parseOriginPattern = (
  source: string
): { readonly pattern: OriginPattern } | { readonly problem: string } => {
  const trimmed = source.trim()
  const match = PATTERN.exec(trimmed)
  if (match === null) {
    return {
      problem:
        `origin "${source}" is not a pattern this policy engine understands. ` +
        `Write scheme://host, optionally :port or :*, optionally with a *. host prefix ` +
        `(for example http://127.0.0.1:* or https://*.heritagecu.example)`
    }
  }

  const [, scheme, wildcard, host, port] = match
  return {
    pattern: {
      source: trimmed,
      scheme: scheme as "http" | "https",
      host: host!.toLowerCase(),
      port: port === undefined
        ? DEFAULT_PORT[scheme as "http" | "https"]
        : port === "*"
          ? "any"
          : Number(port),
      subdomains: wildcard !== undefined
    }
  }
}

/**
 * The origin an Action would happen on, or `undefined` if there is not one.
 *
 * `about:blank` — the page a freshly launched browser sits on before the first
 * navigation — has no origin, and neither does `file:` or `data:`. Returning
 * `undefined` rather than the string `"null"` forces the caller to decide what an
 * origin-less page means for the Action it is judging, which is a different
 * question for `navigate` than for anything else.
 */
export const originOf = (url: string): string | undefined => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined
}

/** Does this URL sit on an origin this pattern allows? */
export const originMatches = (pattern: OriginPattern, url: string): boolean => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (parsed.protocol !== `${pattern.scheme}:`) return false

  const host = parsed.hostname.toLowerCase()
  const hostAllowed = pattern.subdomains
    ? host.endsWith(`.${pattern.host}`)
    : host === pattern.host
  if (!hostAllowed) return false

  if (pattern.port === "any") return true
  const port = parsed.port === ""
    ? DEFAULT_PORT[parsed.protocol === "https:" ? "https" : "http"]
    : Number(parsed.port)
  return port === pattern.port
}

/** The first pattern that allows this URL, or `undefined` if none does. */
export const allowedBy = (
  patterns: ReadonlyArray<OriginPattern>,
  url: string
): OriginPattern | undefined => patterns.find((pattern) => originMatches(pattern, url))
