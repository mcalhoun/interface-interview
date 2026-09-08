/** Inspect document text before JSON or YAML serialization can escape its characters. */
export const carriesSensitiveText = (
  document: unknown,
  scrub: (text: string) => string
): boolean => {
  const pending: unknown[] = [document]
  const checked = new Set<string>()
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value === "string") {
      if (checked.has(value)) continue
      checked.add(value)
      if (scrub(value) !== value) return true
      // Generated provenance quotes Operator and model prose with JSON.stringify.
      // Try every quote start so an unmatched prose quote cannot hide a later
      // valid literal. Decoding nested quotations always shortens the text.
      for (const match of value.matchAll(/(?=("(?:\\[\s\S]|[^"\\])*"))/gu)) {
        const literal = match[1]
        if (literal === undefined) continue
        try {
          const decoded: unknown = JSON.parse(literal)
          if (typeof decoded === "string") pending.push(decoded)
        } catch {
          // Ordinary prose may contain quotation marks without JSON string syntax.
        }
      }
    } else if (Array.isArray(value)) {
      pending.push(...value)
    } else if (typeof value === "object" && value !== null) {
      for (const [key, text] of Object.entries(value)) pending.push(key, text)
    }
  }
  return false
}
