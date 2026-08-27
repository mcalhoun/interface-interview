/**
 * Replacing known sensitive values with a labelled placeholder.
 *
 * SPEC: "Text evidence, meaning accessibility snapshots and event logs, passes a
 * scrub replacing known sensitive parameter values with a labelled placeholder,
 * at the single point where evidence gets serialized." This is the replacement;
 * `EvidenceWriter.record` is the single point.
 *
 * ## Why a text scrub at all, when the values are `Redacted`
 *
 * The two mechanisms defend against different things and neither subsumes the
 * other.
 *
 * `Redacted<string>` stops a *value we are holding* from being printed. Nothing
 * we hold ever reaches Evidence in the clear, and if some future call site tries,
 * it writes `<redacted:memberId>` and the leak announces itself.
 *
 * The scrubber stops a value the *application rendered back at us* from being
 * written down. `observe` events carry the accessibility YAML of a Heritage Core
 * screen, and after the member number is typed into the search field that YAML
 * contains it — as text we read off a page, with no wrapper on it and no field
 * name that would tell you it is there. A checkpoint failure quotes what a
 * control reads. A URL carries `?memberNumber=12345`. Every one of those is a
 * plain string by the time it reaches the writer, so the only thing that catches
 * them is knowing what to look for.
 *
 * ## The two placeholders mean different things
 *
 * - `<redacted:memberId>` is Effect's own rendering of a `Redacted` wrapper. It
 *   means a value we were holding was serialised and the type stopped it.
 * - `[redacted:memberId]` is this module. It means the literal characters were
 *   found in text that came back off the screen and were taken out.
 *
 * Keeping them distinguishable costs nothing and tells a reviewer which of the
 * two mechanisms did the work.
 */

/** One value to take out of text evidence, and what to call it in its place. */
export interface SensitiveText {
  /** The parameter name. Appears in the placeholder, so it stays greppable. */
  readonly label: string
  /** The literal characters, already unwrapped. */
  readonly text: string
}

export const placeholderFor = (label: string): string => `[redacted:${label}]`

/**
 * Rewrites one string before it is written to Evidence.
 *
 * Applied to *every* string in an event, field-blind. See `scrubDeeply` in
 * `EvidenceWriter.ts` for why that matters.
 */
export type Scrubber = (text: string) => string

/**
 * No redaction at all.
 *
 * Named rather than defaulted, because `EvidenceOptions.scrubber` is required:
 * an Evidence directory with redaction switched off is a decision somebody has
 * to write down, and `grep -rn noScrubbing` lists every place it was made.
 */
export const noScrubbing: Scrubber = (text) => text

/**
 * A scrubber that replaces every occurrence of every given value.
 *
 * Three details are load-bearing.
 *
 * **Longest first.** If one sensitive value is a substring of another, replacing
 * the shorter one first leaves the tail of the longer one behind in the clear.
 * Sorting by descending length removes that whole class of near-miss.
 *
 * **Percent-encoded forms too.** Heritage Core puts the member number in a query
 * string, and a value containing a space or an `&` would appear there encoded and
 * survive a literal search. The encoded spelling is added as a second needle
 * whenever it differs from the first.
 *
 * **No minimum length.** A one-character sensitive value will replace every
 * occurrence of that character in the log and make it close to unreadable. That
 * is the correct failure: illegible evidence is recoverable, a leaked identifier
 * is not, and a length threshold is a hole with a number on it.
 */
export const scrubbing = (values: Iterable<SensitiveText>): Scrubber => {
  const needles: Array<{ readonly find: string; readonly replace: string }> = []
  for (const value of values) {
    if (value.text.length === 0) continue
    const replace = placeholderFor(value.label)
    needles.push({ find: value.text, replace })
    const encoded = encodeURIComponent(value.text)
    if (encoded !== value.text) needles.push({ find: encoded, replace })
  }
  needles.sort((left, right) => right.find.length - left.find.length)

  if (needles.length === 0) return noScrubbing
  return (text) => {
    let scrubbed = text
    for (const needle of needles) scrubbed = scrubbed.replaceAll(needle.find, needle.replace)
    return scrubbed
  }
}
