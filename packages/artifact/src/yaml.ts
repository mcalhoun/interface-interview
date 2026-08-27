/**
 * Writing a Capability Artifact out as YAML somebody would want to read.
 *
 * `Bun.YAML.parse` is the reader and stays the reader — the format an Artifact is
 * written in has to be the format the runtime understands, and there is no second
 * parser here. But `Bun.YAML.stringify` emits **flow style**: the whole document
 * arrives as one line of `{capability: x, steps: [{id: a, ...}]}`. That is valid
 * YAML and it is useless for the thing an Artifact is for.
 *
 * The Artifact schema's own header says why the format is YAML at all: "an
 * Artifact is a review document: `robustness` is a paragraph of prose, and a diff
 * between `1.0.0` and `1.1.0` has to be readable by the person approving it".
 * A single-line document has no diff worth reading, and a compiler that emitted
 * one would quietly cost this system the property SPEC's Artifact storage section
 * is built on.
 *
 * So: block style, one key per line, and prose as a block scalar the way a person
 * writes it by hand. Nothing here is general-purpose YAML — it serialises exactly
 * the shapes `Schema.encodeSync(CapabilityArtifact)` produces (records, arrays,
 * strings, finite numbers, booleans) and refuses anything else rather than
 * guessing.
 *
 * ## The safety rule
 *
 * Every scalar is quoted unless it is *obviously* safe unquoted. The test that
 * matters is `test/artifact-schema.test.ts`'s round trip — every stored version is
 * formatted, re-parsed by `Bun.YAML.parse`, and required to come back identical —
 * so a scalar this module gets wrong fails the suite rather than becoming a
 * document that reads differently than it was written. Erring towards quoting
 * costs a few quotation marks; erring the other way turns `pattern: ^\$[0-9,]+$`
 * into something the parser reads as a flow mapping.
 */

/** How wide a folded prose line is allowed to get before it wraps. */
const WRAP_AT = 88

/**
 * A scalar that can be written with no quotes at all.
 *
 * Deliberately narrow: letters, digits, spaces and a handful of punctuation that
 * carries no meaning in YAML, starting with an alphanumeric so no indicator
 * character can lead. Anything else — a leading `-`, a `{`, a backslash, a colon
 * followed by a space, a trailing space, something that reads as a number or a
 * boolean — gets quoted.
 */
const isPlainSafe = (text: string): boolean => {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _().,'/@+-]*$/.test(text)) return false
  if (text.endsWith(" ")) return false
  if (text.includes(": ") || text.includes(" #")) return false
  // `1.0.0` is fine; `1.0`, `true` and `null` would come back as a number, a
  // boolean and a null, so they have to be quoted to stay strings.
  if (/^(?:true|false|null|yes|no|on|off|~)$/i.test(text)) return false
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return false
  return true
}

/** YAML's double-quoted style accepts JSON's escaping, so this is exact. */
const quoted = (text: string): string => JSON.stringify(text)

/**
 * Whether prose can be folded across several lines and still read back the same.
 *
 * Folding replaces each line break with a single space, so it is faithful only
 * when the original has nothing that a single space could be confused with: no
 * runs of whitespace, no tabs, no leading or trailing space, and no line break
 * already in the text.
 */
const isFoldable = (text: string): boolean =>
  text.length > WRAP_AT &&
  !text.includes("\n") &&
  !text.includes("\t") &&
  !/ {2}/.test(text) &&
  text.trim() === text &&
  // A folded line that begins with a space is "more indented" and stops folding.
  // Nothing here produces one, but a word longer than the wrap width could make
  // the wrapper emit something surprising, so the cheap guard stays.
  text.split(" ").every((word) => word.length > 0 && word.length <= WRAP_AT)

/** Greedy word wrap. Only ever called on text `isFoldable` has approved. */
const wrap = (text: string): ReadonlyArray<string> => {
  const lines: Array<string> = []
  let line = ""
  for (const word of text.split(" ")) {
    if (line === "") line = word
    else if (line.length + 1 + word.length <= WRAP_AT) line = `${line} ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  if (line !== "") lines.push(line)
  return lines
}

/**
 * A string as it appears after its key.
 *
 * Three shapes, in the order they are tried:
 *
 *   - `|-` for anything containing a line break, because a literal block keeps
 *     every character exactly and paragraph breaks survive a round trip. Folded
 *     style would eat one newline of each blank line and quietly rewrite the
 *     prose.
 *   - `>-` for a long single line, which is how the hand-written Artifact reads
 *     and the only reason a `summary` is legible in a diff.
 *   - a plain or double-quoted scalar for everything short.
 */
const scalarString = (text: string, indent: string): string => {
  // YAML's chomping indicators are the whole reason a block scalar can be exact.
  // `|-` and `>-` strip the trailing line break; bare `|` and `>` keep exactly
  // one. Prose that came *out* of a `>` block in a hand-written Artifact ends in
  // a newline, and without this it would have to be written back as a quoted
  // one-liner — turning every review document into a worse version of itself the
  // first time anything re-emitted it.
  const trailingNewline = text.endsWith("\n")
  const body = trailingNewline ? text.slice(0, -1) : text
  const chomp = trailingNewline ? "" : "-"

  // Anything a block scalar cannot represent exactly — leading whitespace, a
  // second trailing newline, a carriage return — is quoted instead of losing it.
  if (body !== "" && body.trim() === body && !body.includes("\r")) {
    if (body.includes("\n")) {
      const lines = body
        .split("\n")
        .map((line) => (line === "" ? "" : `${indent}  ${line}`))
        .join("\n")
      return `|${chomp}\n${lines}`
    }
    if (isFoldable(body)) {
      return `>${chomp}\n${wrap(body).map((line) => `${indent}  ${line}`).join("\n")}`
    }
  }

  if (trailingNewline || !isPlainSafe(body)) return quoted(text)
  return body
}

const scalar = (value: string | number | boolean, indent: string): string => {
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`cannot write ${value} to YAML`)
    return String(value)
  }
  return scalarString(value, indent)
}

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"

/** `undefined` is absence, and an absent key is how an optional field is omitted. */
const isPresent = (value: unknown): boolean => value !== undefined

const key = (name: string): string => (isPlainSafe(name) ? name : quoted(name))

const emit = (value: unknown, indent: string): string => {
  if (isScalar(value)) return scalar(value, indent)
  if (value === null) return "null"

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    return value
      .map((item) => {
        const rendered = emit(item, `${indent}  `)
        return isScalar(item) || item === null || (Array.isArray(item) && item.length === 0)
          ? `${indent}- ${rendered}`
          : `${indent}- ${rendered.slice(indent.length + 2)}`
      })
      .join("\n")
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) =>
      isPresent(item)
    )
    if (entries.length === 0) return "{}"
    return entries
      .map(([name, item]) => {
        if (isScalar(item) || item === null) return `${indent}${key(name)}: ${emit(item, indent)}`
        if (Array.isArray(item) && item.length === 0) return `${indent}${key(name)}: []`
        if (!Array.isArray(item) && Object.values(item as object).every((v) => !isPresent(v))) {
          return `${indent}${key(name)}: {}`
        }
        // A nested list sits at the parent's own indentation, which is legal YAML
        // and is how the hand-written documents read.
        const childIndent = Array.isArray(item) ? indent : `${indent}  `
        return `${indent}${key(name)}:\n${emit(item, childIndent)}`
      })
      .join("\n")
  }

  throw new Error(`cannot write a ${typeof value} to YAML`)
}

/**
 * A document as block-style YAML, ending in a newline.
 *
 * Key order is insertion order, which makes the emitted order a decision the
 * compiler makes rather than an accident of the serialiser.
 */
export const toYaml = (document: unknown): string => `${emit(document, "")}\n`
