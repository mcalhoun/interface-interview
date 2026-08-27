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
  AssertionSchema,
  CapabilityArtifactSchema,
  declaredOutcome,
  declaredOutcomeCodes,
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

it("rejects text that is not an artifact at all", () => {
  expect(expectProblems(parseArtifact("junk", ": : not yaml : :")).length).toBeGreaterThan(0)
  expect(expectProblems(parseArtifact("empty", "capability: only-this")).length).toBeGreaterThan(0)
})

it("resolves the latest stored version, and lists what is callable", () => {
  expect(listCapabilities(ARTIFACTS_DIRECTORY)).toContain("member.account-balance")
  expect(listVersions(ARTIFACTS_DIRECTORY, "member.account-balance")).toContain("1.0.0")
  expect(expectSuccess(loadArtifact(ARTIFACTS_DIRECTORY, "member.account-balance")).version).toBe(
    "1.0.0"
  )
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

// ---------------------------------------------------------------------------
// Declared Business Outcomes
//
// The artifact is where a capability's domain contract lives, and `outcomes` is
// the half of it that is not the happy path. What is pinned here is that the
// contract is complete in both directions: a caller cannot receive a code the
// document does not explain, and the document cannot claim a code no run can
// produce. A one-directional check would leave the more embarrassing half open.
// ---------------------------------------------------------------------------

it("the shipped artifact declares its business outcomes, so a reviewer sees every answer it can give", () => {
  const artifact = expectSuccess(parseShipped())

  expect(declaredOutcomeCodes(artifact)).toEqual(["MEMBER_NOT_FOUND"])

  const notFound = declaredOutcome(artifact, "MEMBER_NOT_FOUND")
  expect(notFound).toBeDefined()
  // `title` is what the caller reads back as `detail`, so it has to be a sentence
  // about the domain rather than a status word.
  expect(notFound?.title).toMatch(/member/i)
  // And the prose has to make the case that this is an answer, not a fault. A
  // code with a one-word gloss is not a reviewable contract.
  expect(notFound?.summary.length).toBeGreaterThan(200)
  expect(notFound?.discoveredFrom).toBeDefined()
})

it("a declared outcome is reachable from a checkpoint branch written in the ordinary assertion vocabulary", () => {
  const artifact = expectSuccess(parseShipped())
  const branches = artifact.steps.flatMap((step) => step.checkpoint.orOutcome ?? [])

  expect(branches.map((branch) => branch.code)).toEqual(["MEMBER_NOT_FOUND"])

  const branch = branches[0]!
  expect(branch.when.length).toBeGreaterThan(0)
  // Nothing about recognising a domain answer is privileged. Every branch
  // condition decodes as an ordinary Assertion — the same vocabulary, evaluated
  // against the same accessibility tree, as the intended state it stands beside.
  for (const assertion of branch.when) {
    expect(Result.isSuccess(Schema.decodeUnknownResult(AssertionSchema)(assertion))).toBe(true)
  }
  // And it asserts only on screen text, never on this run's input. An artifact
  // carries no runtime data.
  expect(JSON.stringify(branch)).not.toContain("99999")
})

it("rejects a checkpoint branch returning a code the artifact does not declare", () => {
  const problems = expectProblems(
    parseArtifact(
      "broken",
      `
capability: broken
version: 1.0.0
title: Broken
summary: Returns a code with nothing saying what it means.
authored: hand-written
surface: { kind: web, product: Test, entry: / }
inputs: {}
outputs: {}
steps:
  - id: only
    intent: Press a button and hope.
    action:
      type: click
      target: { role: button, name: Go, strategy: name, robustness: because }
    checkpoint:
      description: It happened.
      expect: [{ assert: textPresent, text: anything }]
      orOutcome:
        - code: UNDOCUMENTED_STATE
          when: [{ assert: textPresent, text: something else }]
`
    )
  )
  expect(problems.join(" ")).toContain("UNDOCUMENTED_STATE")
})

it("rejects a declared outcome no checkpoint branch can reach", () => {
  const problems = expectProblems(
    parseArtifact(
      "broken",
      `
capability: broken
version: 1.0.0
title: Broken
summary: Advertises a behaviour it does not have.
authored: hand-written
surface: { kind: web, product: Test, entry: / }
inputs: {}
outputs: {}
outcomes:
  NEVER_HAPPENS:
    title: Something that cannot occur.
    summary: A promise to a caller that no run can keep.
steps:
  - id: only
    intent: Press a button.
    action:
      type: click
      target: { role: button, name: Go, strategy: name, robustness: because }
    checkpoint:
      description: It happened.
      expect: [{ assert: textPresent, text: anything }]
`
    )
  )
  expect(problems.join(" ")).toContain("NEVER_HAPPENS")
})

it("rejects an outcome code that is not something a caller can switch on", () => {
  const problems = expectProblems(
    parseArtifact(
      "broken",
      `
capability: broken
version: 1.0.0
title: Broken
summary: Uses a sentence where an identifier belongs.
authored: hand-written
surface: { kind: web, product: Test, entry: / }
inputs: {}
outputs: {}
outcomes:
  "member not found":
    title: A code that is really a message.
    summary: Prose belongs in title and summary, not in the identifier.
steps:
  - id: only
    intent: Press a button.
    action:
      type: click
      target: { role: button, name: Go, strategy: name, robustness: because }
    checkpoint:
      description: It happened.
      expect: [{ assert: textPresent, text: anything }]
      orOutcome:
        - code: "member not found"
          when: [{ assert: textPresent, text: nothing here }]
`
    )
  )
  expect(problems.length).toBeGreaterThan(0)
})
