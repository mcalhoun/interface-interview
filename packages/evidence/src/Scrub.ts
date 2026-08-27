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
 * **Encoded forms too, and there are two of them.** Heritage Core puts values in
 * query strings, so a value containing a space or an `&` arrives there encoded
 * and survives a literal search. `encodeURIComponent` is one spelling; the other
 * is `application/x-www-form-urlencoded`, which is what a browser submits a GET
 * form as — and it differs in exactly one place, writing a space as `+` where
 * percent-encoding writes `%20`. Every Heritage Core screen this system drives
 * is a GET form, so that is the spelling the URL bar actually shows. Both are
 * added as needles whenever they differ from the plain text.
 *
 * Today's member numbers have no spaces and the two spellings coincide for them.
 * `operatorPassword` is the value where it already matters, and the next
 * sensitive parameter somebody declares is not going to be checked against this
 * list first.
 *
 * **No minimum length.** A one-character sensitive value will replace every
 * occurrence of that character in the log and make it close to unreadable. That
 * is the correct failure: illegible evidence is recoverable, a leaked identifier
 * is not, and a length threshold is a hole with a number on it.
 */
export const scrubbing = (values: Iterable<SensitiveText>): Scrubber => {
  const needles: Array<{ readonly find: string; readonly replace: string }> = []
  const seen = new Set<string>()
  for (const value of values) {
    if (value.text.length === 0) continue
    const replace = placeholderFor(value.label)
    const percentEncoded = encodeURIComponent(value.text)
    for (const find of [
      value.text,
      percentEncoded,
      // The form-encoded spelling: identical to the percent-encoded one except
      // that a space is `+`. This is what a GET form submission puts in the URL,
      // and therefore what the accessibility snapshot's `url` carries.
      percentEncoded.replaceAll("%20", "+")
    ]) {
      if (seen.has(find)) continue
      seen.add(find)
      needles.push({ find, replace })
    }
  }
  needles.sort((left, right) => right.find.length - left.find.length)

  if (needles.length === 0) return noScrubbing
  return (text) => {
    let scrubbed = text
    for (const needle of needles) scrubbed = scrubbed.replaceAll(needle.find, needle.replace)
    return scrubbed
  }
}

// ---------------------------------------------------------------------------
// A scrubber that can still learn
// ---------------------------------------------------------------------------

/**
 * The set of values one run redacts, and the `Scrubber` that reads it.
 *
 * `scrubbing()` above builds a scrubber from a list known up front, which is all
 * a Replay run's *declared* inputs need. It is not all a run meets. Three kinds
 * of sensitive text only exist once the run is under way:
 *
 *   - what a **person types** into the live application during an Intervention.
 *     A supervisor id and an override code are exactly the class of value this
 *     system claims to protect, and no Artifact declared them because no
 *     Artifact knew a person would be involved;
 *   - what the **application renders back**: a member's name, a tax id. Text
 *     that is nobody's parameter, arrives off a screen, and is personal data the
 *     moment it is written down;
 *   - what a **model is about to be sent**, which has to be scrubbed against the
 *     same set the log is, or a consultation becomes a way around the log.
 *
 * So the set grows, and the `Scrubber` handed to the Evidence writer is a stable
 * function that consults it rather than a snapshot of it. The Evidence Layer is
 * built once, at the start of a run, and cannot be swapped afterwards;
 * `packages/agent/src/redaction.ts` reached the same conclusion for Discovery
 * first, and this is that idea moved down to where every mode can use it.
 *
 * **Registration must precede the first mention.** `EvidenceWriter.record`
 * scrubs on write, so a value registered before the event that would first name
 * it is redacted in that event too. That is why the engine registers what a
 * screen shows *before* recording the `observe` event carrying that screen, and
 * why `SessionControl` registers what an Operator says they typed at the moment
 * they say it. Tests assert the ordering rather than trusting the order of
 * statements in a function.
 */
export interface SecretRegistry {
  /**
   * The `Scrubber` to hand to the Evidence writer.
   *
   * Stable identity: it consults the growing set on every call. Holding onto it
   * is safe, and holding onto it is exactly what the writer does.
   */
  readonly scrub: Scrubber
  /** Adds values to the set. Idempotent per (label, text) pair. */
  readonly remember: (values: Iterable<SensitiveText>) => void
  /** Which labels have been registered. Never their values. */
  readonly labels: () => ReadonlyArray<string>
}

export const secretRegistry = (initial: Iterable<SensitiveText> = []): SecretRegistry => {
  const values: Array<SensitiveText> = []
  const registered = new Set<string>()
  // Rebuilt on registration rather than recomputed on every call: registration
  // happens a handful of times per run and scrubbing happens on every string of
  // every event, so the work belongs on the rare side.
  let current: Scrubber = noScrubbing

  const remember = (added: Iterable<SensitiveText>): void => {
    let changed = false
    for (const value of added) {
      if (value.text.length === 0) continue
      const key = `${value.label} ${value.text}`
      if (registered.has(key)) continue
      registered.add(key)
      values.push(value)
      changed = true
    }
    if (changed) current = scrubbing(values)
  }

  remember(initial)

  return {
    scrub: (text) => current(text),
    remember,
    labels: () => [...new Set(values.map((value) => value.label))]
  }
}

/**
 * A registry that starts empty.
 *
 * The explicit way to say "this run declares nothing sensitive up front", and
 * the spelling `grep -rn noSecrets` finds every instance of. It is *not* the
 * same as switching redaction off: the registry is live, so anything the run
 * learns is sensitive on the way — an Operator's keystrokes, a personal field
 * read off a screen — is still redacted. There is deliberately no way to switch
 * that off.
 */
export const noSecrets = (): SecretRegistry => secretRegistry([])
