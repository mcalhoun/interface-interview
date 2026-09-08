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
  noMatchCode,
  parseArtifact,
  parseOutput,
  recoverableConditions
} from "@cua/artifact"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const shippedPath = (version: string) =>
  join(ARTIFACTS_DIRECTORY, "member.account-balance", `${version}.yaml`)

/**
 * Assertions here name a version rather than following `latest` around.
 *
 * An immutable store means 1.0.0 has to keep parsing and keep meaning what it
 * meant after every later version lands beside it, and a test that always reads
 * the newest file cannot notice when it stops. The version-blind loops below say
 * "every stored version" on purpose, so they widen on their own as the learning
 * tickets add files.
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
    "open-account",
    "read-available-balance",
    "read-current-balance"
  ])

  // The reviewer's contract: inputs typed and classified, outputs typed, every
  // step explained, every step verified, every target argued for.
  expect(Object.keys(artifact.inputs)).toEqual(["memberId", "accountType", "operatorPassword"])
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
  const artifact = expectSuccess(parseShipped())
  const selections = artifact.steps.flatMap((step) =>
    step.action.type === "selectFromList" ? [step.action] : []
  )

  expect(selections).toHaveLength(1)
  for (const selection of selections) {
    expect(selection.robustness.length).toBeGreaterThan(80)
    expect(selection.match.strategy).toBe("tokenSubset")
    // Both ways it can fail to land on exactly one item are declared up front,
    // and under different codes, because they mean different things.
    //
    // At 1.0.0 both are still `escalate:` — the author knew a selection could
    // match nothing or several things, and did not know what either would
    // *mean* at an institution they had never seen. Ticket 13 promotes the
    // no-match half to `outcome:` at 1.1.0, after a person met the state and
    // said what it was; see the amendment test for that direction. `onMultiple`
    // has no such form and never will (SPEC: never a coin flip).
    expect(selection.onNoMatch).toEqual({ escalate: "NO_MATCHING_ITEM" })
    expect(selection.onMultiple).toEqual({ escalate: "AMBIGUOUS_MATCH" })
    expect(noMatchCode(selection.onNoMatch)).not.toBe(selection.onMultiple.escalate)
  }
})

it("the selection's legal values come from the page, and its default from the goal", () => {
  const artifact = expectSuccess(parseShipped())
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

/**
 * A regular expression that does not compile is not a schema problem — it is a
 * perfectly well-shaped string. So it decodes, and then throws.
 *
 * Where it throws is what makes it worth refusing here. An input `pattern` is
 * compiled inside `prepareInputs`, whose whole guarantee is that a bad call is a
 * `Result` costing nothing; a `SyntaxError` out of it is not a `Result` and no
 * caller catches one. A `stepRead` pattern is compiled inside a Checkpoint,
 * where the throw becomes a defect on a channel typed `never` — it bypasses
 * replay's failure reporting altogether, so the run has no result and its final
 * Evidence event is never written. Both are free to catch when the document is
 * read.
 */
it("refuses a pattern that is not a regular expression, wherever it is written", () => {
  const withPattern = (pattern: string) => `
capability: broken
version: 1.0.0
title: Broken
summary: Declares a pattern that does not compile.
authored: hand-written
surface: { kind: web, product: Test, entry: / }
inputs:
  memberId:
    type: string
    description: A member number.
    pattern: "${pattern}"
outputs: {}
steps:
  - id: only
    intent: Type it.
    action:
      type: fill
      target: { role: textbox, name: Thing, strategy: name, robustness: because }
      value: { from: parameter, name: memberId }
    checkpoint:
      description: It happened.
      expect: [{ assert: textPresent, text: anything }]
`

  // The good one still parses, so this is a check and not a ban.
  expectSuccess(parseArtifact("fine", withPattern("^[0-9]{4,10}$")))

  const problems = expectProblems(parseArtifact("broken", withPattern("^[0-9")))
  expect(problems.join(" ")).toContain("input memberId's pattern")
  expect(problems.join(" ")).toContain("not a valid regular expression")

  const inAssertion = expectProblems(
    parseArtifact(
      "broken",
      `
capability: broken
version: 1.0.0
title: Broken
summary: Asserts with a pattern that does not compile.
authored: hand-written
surface: { kind: web, product: Test, entry: / }
inputs: {}
outputs: {}
steps:
  - id: read-it
    intent: Read something.
    action:
      type: extract
      target: { role: cell, name: Balance, strategy: name, robustness: because }
    checkpoint:
      description: It read a figure.
      expect: [{ assert: stepRead, step: read-it, matches: "([0-9]+" }]
`
    )
  )
  expect(inAssertion.join(" ")).toContain("not a valid regular expression")
})

it("refuses an enum input with no values, which would reject everything", () => {
  const problems = expectProblems(
    parseArtifact(
      "broken",
      `
capability: broken
version: 1.0.0
title: Broken
summary: Declares an enum nothing can satisfy.
authored: hand-written
surface: { kind: web, product: Test, entry: / }
inputs:
  accountType:
    type: enum
    description: Which account.
outputs: {}
steps:
  - id: only
    intent: Type it.
    action:
      type: fill
      target: { role: textbox, name: Thing, strategy: name, robustness: because }
      value: { from: parameter, name: accountType }
    checkpoint:
      description: It happened.
      expect: [{ assert: textPresent, text: anything }]
`
    )
  )
  // Legality is decided against `values`, so an empty one is a capability that
  // parses, publishes a parameter, and then refuses every value a caller could
  // pass — with a message listing nothing.
  expect(problems.join(" ")).toContain("accountType is an enum and declares no values")
})

it("a file whose name is not a version is not listed as one", () => {
  // `latest` is resolved by sorting the directory, and the comparator used to
  // return `NaN` for a component like `0-rc` — which is not an ordering, so
  // `Array.prototype.sort` was free to leave the list in any arrangement and
  // `latest` could resolve to an older document than the one beside it.
  const directory = mkdtempSync(join(tmpdir(), "artifact-store-"))
  mkdirSync(join(directory, "test.capability"))
  for (const name of ["1.0.0.yaml", "1.2.0.yaml", "1.10.0.yaml", "1.0.0-rc.1.yaml", "notes.yaml"]) {
    writeFileSync(join(directory, "test.capability", name), "capability: test.capability\n")
  }

  const versions = listVersions(directory, "test.capability")

  expect(versions).toEqual(["1.10.0", "1.2.0", "1.0.0"])
  expect(versions).not.toContain("1.0.0-rc.1")
  // Newest first, and numerically: the ordering `latest` depends on.
  expect(versions[0]).toBe("1.10.0")
})

it("rejects text that is not an artifact at all", () => {
  expect(expectProblems(parseArtifact("junk", ": : not yaml : :")).length).toBeGreaterThan(0)
  expect(expectProblems(parseArtifact("empty", "capability: only-this")).length).toBeGreaterThan(0)
})

it("resolves the latest stored version, and lists what is callable", () => {
  expect(listCapabilities(ARTIFACTS_DIRECTORY)).toContain("member.account-balance")

  const versions = listVersions(ARTIFACTS_DIRECTORY, "member.account-balance")
  expect(versions).toContain("1.0.0")

  // 1.2.0 since ticket 14, 1.1.0 since ticket 13: `latest` follows the
  // amendments, which is the point of amending rather than editing. A caller who
  // wants the version from before an intervention asks for it by name, below.
  expect(expectSuccess(loadArtifact(ARTIFACTS_DIRECTORY, "member.account-balance")).version).toBe(
    "1.2.0"
  )
  // A pinned version still resolves to itself; `latest` is a convenience, not
  // the only way in.
  expect(
    expectSuccess(loadArtifact(ARTIFACTS_DIRECTORY, "member.account-balance", "1.0.0")).version
  ).toBe("1.0.0")
})

it("the shipped artifact declares the recovery rules it can get past unattended", () => {
  // Ticket 06's rules live in 1.0.0 rather than in a version of their own, for
  // the reason the next test spells out: rules written by hand are a correction
  // to a hand-written document, not something an Intervention taught.
  const artifact = expectSuccess(loadArtifact(ARTIFACTS_DIRECTORY, "member.account-balance"))
  expect(recoverableConditions(artifact).map((rule) => rule.condition)).toEqual([
    "TRANSIENT_OVERLAY",
    "SESSION_EXPIRED"
  ])
})

it("both versions SPEC reserved were claimed by interventions, and by nothing else", () => {
  // SPEC's scenario table reserves exactly two versions for changes a human
  // confirmed, each landing in its own file beside the intervention record that
  // justified it. Both are now claimed, and claimed the way they were meant to
  // be: not by hand, but by an Operator meeting a state and answering the one
  // question at return-of-control. Ticket 09's selection and ticket 06's recovery
  // rules stayed in 1.0.0 precisely so these two slots would be free for that,
  // and this is what the two of them were protecting.
  const versions = listVersions(ARTIFACTS_DIRECTORY, "member.account-balance")
  expect(versions).toEqual(["1.2.0", "1.1.0", "1.0.0"])

  // v1.1.0: `88888`, an operator who changed nothing, and a business outcome.
  const outcome = expectSuccess(
    loadArtifact(ARTIFACTS_DIRECTORY, "member.account-balance", "1.1.0")
  )
  const selection = outcome.steps.flatMap((step) =>
    step.action.type === "selectFromList" ? [step.action] : []
  )[0]!
  expect(selection.onNoMatch).toEqual({ outcome: "NO_MATCHING_ITEM" })

  const declaration = outcome.outcomes?.["NO_MATCHING_ITEM"]
  expect(declaration?.discoveredFrom).toContain("Learned from intervention")
  expect(declaration?.discoveredFrom).toContain("recorded no actions on the live session")
  expect(declaration?.discoveredFrom).toContain("ADR-0004")

  // v1.2.0: `77777`, an operator who had to *act* with authority, and a state
  // this capability will never handle itself. The two versions are the same
  // mechanism reaching opposite conclusions, and the fields that make them
  // opposite are both about what the person did rather than what they answered.
  const human = expectSuccess(loadArtifact(ARTIFACTS_DIRECTORY, "member.account-balance", "1.2.0"))
  const entry = human.requiresHuman?.["OPEN_ACCOUNT_REQUIRES_HUMAN"]
  expect(entry?.step).toBe("open-account")
  expect(entry?.discoveredFrom).toContain("Learned from intervention")
  expect(entry?.discoveredFrom).toContain("action(s) on the live session")
  expect(entry?.discoveredFrom).toContain("they answered no")

  // And it declared nothing a caller can be *returned*. Learning that a state
  // needs a person adds no business outcome, changes no step, and leaves the
  // capability's answers exactly as they were at 1.1.0.
  expect(human.outcomes).toEqual(outcome.outcomes)
  expect(human.steps).toEqual(outcome.steps)
  expect(human.recoverable).toEqual(outcome.recoverable)

  // 1.0.0 is untouched, and knows about neither. An amendment is a new file,
  // never an edit, which is the whole reason the diffs are worth anything.
  const before = expectSuccess(loadArtifact(ARTIFACTS_DIRECTORY, "member.account-balance", "1.0.0"))
  expect(before.outcomes?.["NO_MATCHING_ITEM"]).toBeUndefined()
  expect(before.requiresHuman).toBeUndefined()
  expect(outcome.requiresHuman).toBeUndefined()
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
