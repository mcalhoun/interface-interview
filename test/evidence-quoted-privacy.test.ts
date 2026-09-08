import { expect, it } from "vitest"
import { scrubbing, secretRegistry } from "@cua/evidence"

const secret = 'private_"quote\\slash\nvalue_72'
for (const depth of [1, 2, 5]) {
  it(`scrubs a known value inside ${depth} JSON quotations and unmatched prose quotes`, () => {
    let encoded = secret
    let redacted = "[redacted:operator]"
    for (let level = 0; level < depth; level += 1) {
      encoded = JSON.stringify(encoded)
      redacted = JSON.stringify(redacted)
    }
    const scrub = scrubbing([{ label: "operator", text: secret }])
    expect(scrub(`Prose " unmatched before ${encoded}`)).toBe(`Prose " unmatched before ${redacted}`)
  })
}

it("keeps the captured scrubber live and labels the longest matching secret", () => {
  const registry = secretRegistry([{ label: "short", text: "private_" }])
  const scrub = registry.scrub
  registry.remember([{ label: "operator", text: secret }])
  expect(scrub(JSON.stringify(secret))).toBe(JSON.stringify("[redacted:operator]"))
})

it("scrubs alternate JSON escapes without changing harmless quoted prose", () => {
  const scrub = scrubbing([{ label: "member", text: "member/name" }])
  expect(scrub('Value "member\\/name"')).toBe('Value "[redacted:member]"')
  expect(scrub('Value "member\\u002fname"')).toBe('Value "[redacted:member]"')
  expect(scrub('Public "plain" and invalid "\\q" prose')).toBe('Public "plain" and invalid "\\q" prose')
})

it("removes a complete raw secret before a shorter quoted part can hide its tail", () => {
  const scrub = scrubbing([
    { label: "short", text: "short" },
    { label: "long", text: '"short"-private-tail' },
    { label: "middle", text: 'prefix"short"suffix' }
  ])
  expect(scrub('Before "short"-private-tail after')).toBe('Before [redacted:long] after')
  expect(scrub('Before prefix"short"suffix after')).toBe('Before [redacted:middle] after')
  expect(scrub(JSON.stringify('"short"-private-tail'))).toBe(JSON.stringify('[redacted:long]'))
})

it("lets an encoded complete secret cover a shorter raw opening-quote match", () => {
  for (const value of [secret, 'prefix"short"suffix']) {
    const scrub = scrubbing([
      { label: "short", text: JSON.stringify(value).slice(0, 8) },
      { label: "long", text: value }
    ])
    expect(scrub(JSON.stringify(value))).toBe(JSON.stringify("[redacted:long]"))
  }
})

it("merges changed overlapping quote candidates after an unmatched prose quote", () => {
  const scrub = scrubbing([{ label: "long", text: secret }, { label: "short", text: "short" }])
  expect(scrub(`Prose "short before ${JSON.stringify(secret)}`)).toBe('Prose [redacted:overlapping-values]')
})
