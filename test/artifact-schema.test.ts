/**
 * The Capability Artifact schema, which is the focal point of this system.
 *
 * Two kinds of assertion live here. Round-tripping, because an Artifact is a
 * document that gets written by a compiler, read by a reviewer and executed by an
 * engine, and those three have to agree about what it says. And rejection, because
 * a schema that accepts a broken Artifact has not validated anything — a
 * reference to a step that does not exist is exactly the mistake ticket 11's
 * compiler will make, and it should be caught when the file is read rather than
 * three steps into a live run against a banking system.
 */

import { expect, it } from "vitest"
import { Result, Schema } from "effect"
import {
  ARTIFACTS_DIRECTORY,
  CapabilityArtifactSchema,
  formatArtifact,
  isSensitive,
  listCapabilities,
  listVersions,
  loadArtifact,
  parseArtifact,
  parseOutput
} from "@cua/artifact"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SHIPPED = join(ARTIFACTS_DIRECTORY, "member.account-balance", "1.0.0.yaml")

const parseShipped = () => parseArtifact(SHIPPED, readFileSync(SHIPPED, "utf8"))

const expectSuccess = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`expected success, got ${String(result.failure)}`)
  return result.success
}

const expectProblems = <A, E extends { readonly problems: ReadonlyArray<string> }>(
  result: Result.Result<A, E>
): ReadonlyArray<string> => {
  if (!Result.isFailure(result)) throw new Error("expected the artifact to be rejected")
  return result.failure.problems
}

it("the shipped artifact parses, and says what it does without any code being read", () => {
  const artifact = expectSuccess(parseShipped())

  expect(artifact.capability).toBe("member.account-balance")
  expect(artifact.version).toBe("1.0.0")
  expect(artifact.steps.map((step) => step.id)).toEqual([
    "open-member-search",
    "enter-member-number",
    "run-member-search",
    "open-savings-account",
    "read-available-balance",
    "read-current-balance"
  ])

  // The reviewer's contract: inputs typed and classified, outputs typed, every
  // step explained, every step verified, every target argued for.
  expect(Object.keys(artifact.inputs)).toEqual(["memberId"])
  expect(Object.keys(artifact.outputs)).toEqual(["availableBalance", "currentBalance"])
  expect(artifact.outputs["availableBalance"]?.currency).toBe("USD")
  for (const step of artifact.steps) {
    expect(step.intent.length, `${step.id} has no intent`).toBeGreaterThan(10)
    expect(step.checkpoint.expect.length, `${step.id} asserts nothing`).toBeGreaterThan(0)
  }
})

it("no origin appears anywhere in the artifact, so one document serves every tenant", () => {
  // A capability is a property of the vendor product; which institution's
  // installation it runs against is environment. Baking a URL in is how one
  // artifact per tenant starts.
  expect(readFileSync(SHIPPED, "utf8")).not.toMatch(/https?:\/\//)
})

it("every target records how it is identified and why that strategy was chosen", () => {
  const artifact = expectSuccess(parseShipped())
  const targets = artifact.steps.flatMap((step) => [
    ...(step.action.type === "navigate" ? [] : [step.action.target]),
    ...step.checkpoint.expect.flatMap((assertion) =>
      "target" in assertion ? [assertion.target] : []
    )
  ])

  expect(targets.length).toBeGreaterThan(5)
  for (const target of targets) {
    expect(target.strategy).toMatch(/\S/)
    // SPEC user story 16 wants a reviewer able to judge whether a target still
    // works next month. Two words of prose cannot support that judgement.
    expect(target.robustness.length).toBeGreaterThan(80)
  }
})

it("parameters are sensitive unless the artifact says otherwise in writing", () => {
  const artifact = expectSuccess(parseShipped())
  expect(isSensitive(artifact.inputs["memberId"]!)).toBe(true)

  // And the default, which is the half that matters — ADR-0008 is about what
  // happens when nobody thought about it.
  const undeclared = Schema.decodeUnknownSync(CapabilityArtifactSchema.fields.inputs)({
    somethingNew: { type: "string", description: "an input nobody classified" }
  })
  expect(isSensitive(undeclared["somethingNew"]!)).toBe(true)
})

it("round-trips through YAML unchanged", () => {
  const artifact = expectSuccess(parseShipped())
  const again = expectSuccess(parseArtifact("round-trip", formatArtifact(artifact)))
  expect(again).toEqual(artifact)
})

it("rejects a value referring to an input that is not declared", () => {
  const problems = expectProblems(
    parseArtifact(
      "broken",
      `
capability: broken
version: 1.0.0
title: Broken
summary: Refers to a parameter nobody declared.
authored: hand-written
surface: { kind: web, product: Test, entry: / }
inputs: {}
outputs: {}
steps:
  - id: only
    intent: Type something nobody declared.
    action:
      type: fill
      target: { role: textbox, name: Thing, strategy: name, robustness: because }
      value: { from: parameter, name: notDeclared }
    checkpoint:
      description: It happened.
      expect: [{ assert: textPresent, text: anything }]
`
    )
  )
  expect(problems.join(" ")).toContain("notDeclared")
})

it("rejects an output built from a step that reads nothing", () => {
  const problems = expectProblems(
    parseArtifact(
      "broken",
      `
capability: broken
version: 1.0.0
title: Broken
summary: Declares an output no step produces.
authored: hand-written
surface: { kind: web, product: Test, entry: / }
inputs: {}
outputs:
  balance:
    type: money
    currency: USD
    description: A balance nothing reads.
    from: { step: click-it }
steps:
  - id: click-it
    intent: Press a button that reads nothing.
    action:
      type: click
      target: { role: button, name: Go, strategy: name, robustness: because }
    checkpoint:
      description: It happened.
      expect: [{ assert: textPresent, text: anything }]
`
    )
  )
  expect(problems.join(" ")).toContain("click-it")
})

it("rejects a step with no checkpoint, because that is the whole design", () => {
  const problems = expectProblems(
    parseArtifact(
      "broken",
      `
capability: broken
version: 1.0.0
title: Broken
summary: A step that believes itself.
authored: hand-written
surface: { kind: web, product: Test, entry: / }
inputs: {}
outputs: {}
steps:
  - id: unverified
    intent: Do something and assume it worked.
    action:
      type: click
      target: { role: button, name: Go, strategy: name, robustness: because }
`
    )
  )
  expect(problems.length).toBeGreaterThan(0)
})

it("checks a recovery rule's references the same way it checks a step's", () => {
  const withRules = (recoverable: string) => `
capability: broken
version: 1.0.0
title: Broken
summary: A recovery rule that does not hang together.
authored: hand-written
surface: { kind: web, product: Test, entry: / }
inputs: {}
outputs: {}
steps:
  - id: read-it
    intent: Read something.
    action:
      type: extract
      target: { role: cell, label: Thing, strategy: label, robustness: because }
    checkpoint:
      description: It happened.
      expect: [{ assert: textPresent, text: anything }]
recoverable:
${recoverable}`

  const remedy = (value: string) => `
    remedy:
      - intent: Type it.
        action:
          type: fill
          target: { role: textbox, name: Thing, strategy: name, robustness: because }
          value: ${value}
    resume: here
    attempts: 2
    backoffMillis: 100`

  // A remedy value naming an input nobody declared is the same bug as a step's.
  expect(
    expectProblems(
      parseArtifact(
        "broken",
        withRules(
          `  - condition: NO_SUCH_INPUT
    description: Refers to a parameter nobody declared.
    detect: [{ assert: textPresent, text: Busy }]${remedy("{ from: parameter, name: notDeclared }")}`
        )
      )
    ).join(" ")
  ).toContain("notDeclared")

  // A remedy may not depend on what a step read. A rule can fire at any step, so
  // that reference would mean something different depending on where it fired,
  // and a rule whose meaning depends on when it runs is not reviewable.
  expect(
    expectProblems(
      parseArtifact(
        "broken",
        withRules(
          `  - condition: READS_A_STEP
    description: Depends on a reading that may not have happened yet.
    detect: [{ assert: textPresent, text: Busy }]${remedy("{ from: step, step: read-it }")}`
        )
      )
    ).join(" ")
  ).toContain("may not depend on")

  // Two rules under one code would make evidence ambiguous about which fired.
  expect(
    expectProblems(
      parseArtifact(
        "broken",
        withRules(
          `  - condition: SAME_CODE
    description: The first one.
    detect: [{ assert: textPresent, text: Busy }]
    remedy: []
    resume: here
    attempts: 1
    backoffMillis: 100
  - condition: SAME_CODE
    description: The second one.
    detect: [{ assert: textPresent, text: Busier }]
    remedy: []
    resume: here
    attempts: 1
    backoffMillis: 100`
        )
      )
    ).join(" ")
  ).toContain("more than once")

  // A bound of zero attempts is not a bound, it is a rule that never runs.
  expect(
    expectProblems(
      parseArtifact(
        "broken",
        withRules(
          `  - condition: NO_ATTEMPTS
    description: Declares a remedy it will never try.
    detect: [{ assert: textPresent, text: Busy }]
    remedy: []
    resume: here
    attempts: 0
    backoffMillis: 100`
        )
      )
    ).length
  ).toBeGreaterThan(0)
})

it("rejects text that is not an artifact at all", () => {
  expect(expectProblems(parseArtifact("junk", ": : not yaml : :")).length).toBeGreaterThan(0)
  expect(expectProblems(parseArtifact("empty", "capability: only-this")).length).toBeGreaterThan(0)
})

it("resolves the latest stored version, and lists what is callable", () => {
  expect(listCapabilities(ARTIFACTS_DIRECTORY)).toContain("member.account-balance")

  // Both versions are on disk and neither was rewritten, which is the whole
  // claim immutability makes: 1.0.0 still says exactly what it said when it was
  // approved, and what 1.1.0 added is readable as a diff against it.
  const versions = listVersions(ARTIFACTS_DIRECTORY, "member.account-balance")
  expect(versions).toContain("1.0.0")
  expect(versions).toContain("1.1.0")

  expect(expectSuccess(loadArtifact(ARTIFACTS_DIRECTORY, "member.account-balance")).version).toBe(
    "1.1.0"
  )
  // A pinned version still resolves to itself; `latest` is a convenience, not
  // the only way in.
  expect(
    expectSuccess(loadArtifact(ARTIFACTS_DIRECTORY, "member.account-balance", "1.0.0")).version
  ).toBe("1.0.0")
  expect(
    expectSuccess(loadArtifact(ARTIFACTS_DIRECTORY, "member.account-balance", "1.0.0")).recoverable
  ).toBeUndefined()
})

it("turns a scraped amount into money, and refuses one in the wrong currency", () => {
  const declaration = {
    type: "money",
    currency: "USD",
    description: "a balance",
    from: { step: "read-it" }
  } as const

  expect(expectSuccess(parseOutput("balance", declaration, "$4,182.55"))).toEqual({
    type: "money",
    value: { amount: 4182.55, currency: "USD" }
  })

  // Silently-wrong money is the worst thing this system could return, so a
  // rendering that does not mean USD stops the run rather than being coerced.
  const wrong = parseOutput("balance", declaration, "€4.182,55")
  expect(Result.isFailure(wrong)).toBe(true)

  const empty = parseOutput("balance", declaration, "   ")
  expect(Result.isFailure(empty)).toBe(true)
})
