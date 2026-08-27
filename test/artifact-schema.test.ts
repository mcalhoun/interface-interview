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

const shippedPath = (version: string) =>
  join(ARTIFACTS_DIRECTORY, "member.account-balance", `${version}.yaml`)

/**
 * Assertions here name a version rather than following `latest` around.
 *
 * An immutable store means 1.0.0 has to keep parsing and keep meaning what it
 * meant after every later version lands beside it, and a test that always reads
 * the newest file cannot notice when it stops.
 */
const parseShipped = (version = "1.0.0") =>
  parseArtifact(shippedPath(version), readFileSync(shippedPath(version), "utf8"))

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

it("no origin appears anywhere in any stored version, so one document serves every tenant", () => {
  // A capability is a property of the vendor product; which institution's
  // installation it runs against is environment. Baking a URL in is how one
  // artifact per tenant starts.
  for (const version of listVersions(ARTIFACTS_DIRECTORY, "member.account-balance")) {
    expect(readFileSync(shippedPath(version), "utf8"), version).not.toMatch(/https?:\/\//)
  }
})

it("every target records how it is identified and why that strategy was chosen", () => {
  const artifact = expectSuccess(parseShipped())
  const targets = artifact.steps.flatMap((step) => [
    ...(step.action.type === "navigate" || step.action.type === "selectFromList"
      ? []
      : [step.action.target]),
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

it("an action that names no single control still argues for how it picks one", () => {
  // A `selectFromList` has no Target to hang the reviewer's contract on, so it
  // carries the argument itself. Without this, generalising the step would have
  // been a way to quietly opt out of explaining it.
  const artifact = expectSuccess(parseShipped("1.1.0"))
  const selections = artifact.steps.flatMap((step) =>
    step.action.type === "selectFromList" ? [step.action] : []
  )

  expect(selections).toHaveLength(1)
  for (const selection of selections) {
    expect(selection.robustness.length).toBeGreaterThan(80)
    expect(selection.match.strategy).toBe("tokenSubset")
    // Both ways it can fail to land on exactly one item are declared up front,
    // and under different codes, because they mean different things.
    expect(selection.onNoMatch.escalate).toBe("NO_MATCHING_ITEM")
    expect(selection.onMultiple.escalate).toBe("AMBIGUOUS_MATCH")
    expect(selection.onNoMatch.escalate).not.toBe(selection.onMultiple.escalate)
  }
})

it("the selection's legal values come from the page, and its default from the goal", () => {
  const artifact = expectSuccess(parseShipped("1.1.0"))
  const accountType = artifact.inputs["accountType"]!

  // ADR-0007: the enum was read off the account list, not written into source.
  expect(accountType.type).toBe("enum")
  expect(accountType.values).toEqual(["Primary Savings", "Checking"])
  expect(accountType.discoveredFrom).toContain("goal term 'savings'")

  // And the default is the goal's own word rather than the label it matched
  // here, which is what makes it survive a tenant that labels the account
  // differently. Recording "Primary Savings" would have made one institution's
  // vocabulary the contract.
  expect(accountType.default).toBe("Savings")
  expect(accountType.values).not.toContain(accountType.default)
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

it("every stored version round-trips through YAML unchanged", () => {
  // Ticket 11's compiler writes these files, a reviewer reads them and the
  // engine executes them. All three have to agree about what the document says,
  // including for the nested shape of a `selectFromList`.
  for (const version of listVersions(ARTIFACTS_DIRECTORY, "member.account-balance")) {
    const artifact = expectSuccess(parseShipped(version))
    const again = expectSuccess(parseArtifact("round-trip", formatArtifact(artifact)))
    expect(again, version).toEqual(artifact)
  }
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

it("rejects a selection that matches against an input nobody declared", () => {
  // Selection is the one action whose subject is not written down, so the thing
  // it matches against had better exist. Caught when the file is read rather
  // than four steps into a live run.
  const problems = expectProblems(
    parseArtifact(
      "broken",
      `
capability: broken
version: 1.0.0
title: Broken
summary: Selects by a parameter nobody declared, and escalates under nothing.
authored: hand-written
surface: { kind: web, product: Test, entry: / }
inputs: {}
outputs: {}
steps:
  - id: pick-one
    intent: Choose from a list using a parameter that does not exist.
    action:
      type: selectFromList
      list: { within: { name: Accounts }, itemRole: link }
      match: { against: { from: parameter, name: notDeclared }, strategy: tokenSubset }
      onNoMatch: { escalate: "" }
      onMultiple: { escalate: AMBIGUOUS_MATCH }
      robustness: because
    checkpoint:
      description: It happened.
      expect: [{ assert: textPresent, text: anything }]
`
    )
  )
  expect(problems.join(" ")).toContain("notDeclared")
  expect(problems.join(" ")).toContain("nothing matches")
})

it("rejects text that is not an artifact at all", () => {
  expect(expectProblems(parseArtifact("junk", ": : not yaml : :")).length).toBeGreaterThan(0)
  expect(expectProblems(parseArtifact("empty", "capability: only-this")).length).toBeGreaterThan(0)
})

it("resolves the latest stored version, and lists what is callable", () => {
  expect(listCapabilities(ARTIFACTS_DIRECTORY)).toContain("member.account-balance")

  const versions = listVersions(ARTIFACTS_DIRECTORY, "member.account-balance")
  expect(versions).toContain("1.0.0")
  expect(versions).toContain("1.1.0")

  // Newest first, and "latest" means the newest rather than the last one
  // written. There is no index file saying so; the directory listing is the only
  // source of truth for the question.
  expect(versions[0]).toBe("1.1.0")
  expect(expectSuccess(loadArtifact(ARTIFACTS_DIRECTORY, "member.account-balance")).version).toBe(
    "1.1.0"
  )

  // And every superseded version still loads by name. Immutability is only worth
  // claiming if the old document is still executable, not merely still on disk.
  expect(
    expectSuccess(loadArtifact(ARTIFACTS_DIRECTORY, "member.account-balance", "1.0.0")).version
  ).toBe("1.0.0")
})

it("1.1.0 differs from 1.0.0 in exactly one step and one input", () => {
  // The reviewer's case for the immutable store: two files, diffed, and the
  // difference readable. If a later version ever quietly rewrites the flow, this
  // stops being one step.
  const before = expectSuccess(parseShipped("1.0.0"))
  const after = expectSuccess(parseShipped("1.1.0"))

  const changed = after.steps.filter((step, index) => {
    const original = before.steps[index]
    return original === undefined || JSON.stringify(original) !== JSON.stringify(step)
  })
  expect(changed.map((step) => step.id)).toEqual(["open-account"])
  expect(before.steps).toHaveLength(after.steps.length)

  expect(Object.keys(before.inputs)).toEqual(["memberId"])
  expect(Object.keys(after.inputs)).toEqual(["memberId", "accountType"])
  expect(after.outputs).toEqual(before.outputs)
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
