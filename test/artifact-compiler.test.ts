/**
 * The Artifact compiler: a discovery run turned into a Capability a reviewer can
 * approve and an agent can call.
 *
 * Two kinds of test, and the split is the point.
 *
 * Most of these are **pure**. `compileArtifact` is a function of a `Trajectory`,
 * so refusing a baked-in literal or deriving an enum input takes no browser, no
 * model and no clock, and each case is a value written out in full where a reader
 * can see exactly what was fed in. A compiler whose tests needed a browser would
 * be a compiler nobody could add a case to.
 *
 * The last one is **the acceptance bar** and is deliberately end to end: a real
 * discovery run against a real Chromium, compiled, and the compiled document
 * replayed against the application in another real browser, with the balance
 * checked. SPEC's bar for this ticket is "the emitted artifact replays
 * successfully without editing", and nothing short of running it proves that.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect, Redacted, Result } from "effect"
import { describe, expect } from "vitest"
import type { Trajectory } from "@cua/agent"
import { compileArtifact, shapeOf, strategyFor } from "@cua/agent"
import {
  ARTIFACTS_DIRECTORY,
  formatArtifact,
  isSensitive,
  listVersions,
  loadArtifact,
  parseArtifact,
  writeArtifact
} from "@cua/artifact"
import type { CapabilityArtifact } from "@cua/artifact"
import { respondingModel } from "./support/scripted-model.ts"
import { GOAL, readsTheScreen } from "./support/discovery-script.ts"
import { runDiscovery } from "./support/discovery-harness.ts"
import { replay } from "./support/replay-harness.ts"

const MEMBER_ID = "12345"

/** The name the compiled capability is stored under. See the note on versions below. */
const DISCOVERED = "member.account-balance.discovered"

const secret = (label: string, value: string) => Redacted.make(value, { label })

/**
 * A Trajectory in the shape the loop produces one.
 *
 * Written out rather than captured from a run, so that a test about a refusal can
 * change one field and nothing else. The step values carry `[redacted:memberId]`
 * exactly as a real Trajectory does — the loop takes the literal out of the step
 * record on the way in, and keeps it only on the parameter, as a `Redacted`.
 */
const trajectory = (overrides: Partial<Trajectory> = {}): Trajectory => ({
  goal: GOAL,
  runId: "test-run",
  sessionId: "test-session",
  entry: "/",
  evidenceDirectory: "evidence/discovery/test-run",
  conclusion: {
    conclusion: "reached",
    summary: "Reads the available balance of a member's savings account"
  },
  steps: [
    {
      id: "fill-1",
      intent: "enter the member number",
      rationale: "the goal names a member and the search panel takes a member number",
      verb: "fill",
      action: {
        type: "fill",
        target: { role: "textbox", name: "Member Number", within: { name: "Member Number Search" } },
        value: { kind: "goalDerived", name: "memberId", literal: "[redacted:memberId]" }
      },
      value: { kind: "goalDerived", name: "memberId", literal: "[redacted:memberId]" },
      outcome: {
        url: "http://tenant.example/",
        resolvedBy: ["within", "role", "name"],
        rationale:
          "scoped to the table headed \"Member Number Search\"; 2 node(s) with role textbox; " +
          "1 named exactly \"Member Number\"",
        alternatives: 0
      },
      authorisedBy: { policy: "heritage-core-default", risk: "risky" }
    },
    {
      id: "click-2",
      intent: "run the member search",
      rationale: "the member number is entered, so submit the search",
      verb: "click",
      action: {
        type: "click",
        target: { role: "button", name: "Search", within: { name: "Member Number Search" } }
      },
      outcome: {
        url: "http://tenant.example/member",
        resolvedBy: ["within", "role", "name"],
        rationale: "1 node(s) with role button; 1 named exactly \"Search\"",
        alternatives: 0
      },
      authorisedBy: { policy: "heritage-core-default", risk: "risky" }
    },
    {
      id: "selectFromList-3",
      intent: "open the savings account",
      rationale: "the goal names an account type and one label carries that word",
      verb: "selectFromList",
      action: {
        type: "selectFromList",
        list: { within: { name: "Share and Deposit Accounts" }, itemRole: "link" },
        match: {
          against: { kind: "goalDerived", name: "accountType", literal: "[redacted:accountType]" },
          strategy: "tokenSubset"
        },
        robustness: "The account list is the only table of links on Member Detail."
      },
      value: { kind: "goalDerived", name: "accountType", literal: "[redacted:accountType]" },
      outcome: {
        url: "http://tenant.example/account",
        resolvedBy: ["within", "role", "name"],
        rationale: "2 link(s) on offer; 1 named exactly \"Primary Savings\"",
        alternatives: 0
      },
      authorisedBy: { policy: "heritage-core-default", risk: "risky" }
    },
    {
      id: "read-available-balance",
      intent: "read the available balance",
      rationale: "the figure sits in the cell beside the Available Balance caption",
      verb: "extract",
      action: { type: "extract", target: { role: "cell", label: "Available Balance" } },
      outcome: {
        url: "http://tenant.example/account",
        resolvedBy: ["role", "label"],
        rationale: "24 node(s) with role cell; 1 captioned \"Available Balance\"",
        alternatives: 0,
        read: "$4,182.55"
      },
      authorisedBy: { policy: "heritage-core-default", risk: "safe" }
    }
  ],
  parameters: [
    { name: "memberId", usedBy: ["fill-1"], sensitive: true, literal: secret("memberId", MEMBER_ID) },
    {
      name: "accountType",
      usedBy: ["selectFromList-3"],
      sensitive: true,
      literal: secret("accountType", "savings")
    }
  ],
  selections: [
    {
      stepId: "selectFromList-3",
      parameter: "accountType",
      values: ["Primary Savings", "Checking"],
      default: "savings",
      matched: "Primary Savings",
      discoveredFrom: "goal term 'savings' matched label 'Primary Savings'",
      robustness: "The account list is the only table of links on Member Detail."
    }
  ],
  outputs: [
    {
      name: "availableBalance",
      fromStep: "read-available-balance",
      description: "the account's available balance",
      value: "$4,182.55"
    }
  ],
  signatures: ["a", "b", "c"],
  steps_attempted: 5,
  durationMillis: 200,
  ...overrides
})

const options = { capability: DISCOVERED, version: "1.0.0", product: "Heritage Core (MSS 4.02.11)" }

const compiled = (input: Trajectory = trajectory()): CapabilityArtifact => {
  const result = compileArtifact(input, options)
  if (Result.isFailure(result)) throw new Error(result.failure.message)
  return result.success
}

const refusal = (input: Trajectory): ReadonlyArray<string> => {
  const result = compileArtifact(input, options)
  if (Result.isSuccess(result)) throw new Error("expected compilation to be refused")
  return result.failure.reasons
}

// ---------------------------------------------------------------------------
// Inputs are derived, not declared
// ---------------------------------------------------------------------------

describe("the contract is derived from recorded provenance", () => {
  it("turns each goal-derived value into a declared input and throws the literal away", () => {
    const artifact = compiled()

    // Nobody wrote an input schema. These names are the semantic roles the model
    // recorded against the values it used, and the uses became references.
    expect(Object.keys(artifact.inputs).sort()).toEqual(["accountType", "memberId"])

    const fill = artifact.steps.find((step) => step.id === "fill-1")
    expect(fill?.action).toMatchObject({
      type: "fill",
      value: { from: "parameter", name: "memberId" }
    })

    // And the reference is checkable: `parseArtifact` rejects a document naming
    // an input it does not declare, which is what makes "derived" more than a
    // description of how the file was produced.
    expect(Result.isSuccess(parseArtifact("compiled", formatArtifact(artifact)))).toBe(true)
  })

  it("declares every discovered parameter sensitive, in writing", () => {
    const artifact = compiled()

    // ADR-0008, deny-first. Not "unless the model thought otherwise": nothing in
    // the trajectory asks for this and nothing could. Note `accountType` too —
    // it is a screen label and a reviewer might well declassify it, but doing so
    // takes a policy allowlist entry and a version somebody approved, and the
    // compiler is neither.
    expect(isSensitive(artifact.inputs["memberId"]!)).toBe(true)
    expect(isSensitive(artifact.inputs["accountType"]!)).toBe(true)
    expect(artifact.inputs["memberId"]?.sensitive).toBe(true)
  })

  it("declares no pattern, because one run saw one value", () => {
    // The hand-written artifact's `^[0-9]{4,10}$` is a person's claim about
    // Heritage Core's member numbers. Inferring `^[0-9]{5}$` from `12345` would
    // look like the same thing and would reject the first six-digit member.
    expect(compiled().inputs["memberId"]?.pattern).toBeUndefined()
  })

  it("makes a selection an enum whose values came off the screen and whose default is the goal's word", () => {
    const accountType = compiled().inputs["accountType"]

    expect(accountType?.type).toBe("enum")
    expect(accountType?.values).toEqual(["Primary Savings", "Checking"])

    // Ticket 09's warning, at the last place it could still be got wrong.
    // "Primary Savings" is not a token subset of another tenant's "Regular
    // Savings"; "savings" is. Recording the label would produce a document that
    // works at exactly one institution and looks perfectly correct doing it.
    expect(accountType?.default).toBe("savings")
    expect(accountType?.default).not.toBe("Primary Savings")

    // The matched label is still written down — as provenance a reviewer checks
    // the inference against, never as the contract.
    expect(accountType?.discoveredFrom).toContain("Primary Savings")
    expect(accountType?.required).toBe(false)
  })

  it("declares the outputs and their shape", () => {
    const output = compiled().outputs["availableBalance"]
    expect(output).toMatchObject({
      type: "money",
      currency: "USD",
      from: { step: "read-available-balance" }
    })
  })

  it("records a discovered document as discovered", () => {
    expect(compiled().authored).toBe("discovered")
    // No origin, ever: which institution's installation this runs against is a
    // replay parameter, which is what lets one document serve every tenant.
    expect(formatArtifact(compiled())).not.toContain("tenant.example")
  })
})

// ---------------------------------------------------------------------------
// No runtime value survives
// ---------------------------------------------------------------------------

describe("no value from the run survives into the document", () => {
  it("writes no literal from the goal anywhere in the emitted artifact", () => {
    const yaml = formatArtifact(compiled())
    expect(yaml).not.toContain(MEMBER_ID)
    expect(yaml).toContain("from: parameter")
  })

  it("refuses a fixed value that echoes the goal, and says so without quoting it", () => {
    const echoed = trajectory()
    const steps = [...echoed.steps]
    steps[0] = {
      ...steps[0]!,
      action: {
        type: "fill",
        target: { role: "textbox", name: "Member Number", within: { name: "Member Number Search" } },
        // The lazy tag: a value out of the goal, called fixed. This is how a
        // member number quietly ends up in a stored capability.
        value: { kind: "constant", literal: MEMBER_ID }
      },
      value: { kind: "constant", literal: MEMBER_ID }
    }
    const reasons = refusal({
      ...echoed,
      steps,
      parameters: echoed.parameters.filter((parameter) => parameter.name !== "memberId")
    })

    // Both positions the mis-tag reached: the value that gets typed, and the
    // checkpoint that reads it back. A refusal names every one of them, because
    // whoever has to fix this wants the whole set.
    expect(reasons).toHaveLength(2)
    expect(reasons[0]).toContain("step fill-1's value")
    expect(reasons[1]).toContain("step fill-1's checkpoint assertion 0")
    expect(reasons[0]).toContain("echoes the goal")
    expect(reasons[0]).toContain("ADR-0008")

    // The refusal is a message a person reads, in a terminal that scrolls into a
    // log. A check against leaking a member number must not leak it while
    // complaining.
    expect(reasons.join(" ")).not.toContain(MEMBER_ID)
  })

  it("refuses a fixed value that carries the run's own value without echoing the goal", () => {
    // `bakedInLiterals`, ticket 08's backstop. This entry path is not a token
    // subset of the goal — "memberNumber" appears nowhere in it — so the
    // goal-echo gate passes it, and the member number is in there all the same.
    const reasons = refusal(trajectory({ entry: `/member?memberNumber=${MEMBER_ID}` }))

    expect(reasons.some((reason) => reason.includes("step open's path"))).toBe(true)
    expect(reasons.some((reason) => reason.includes("memberId"))).toBe(true)
    expect(reasons.join(" ")).not.toContain(MEMBER_ID)
  })

  it("builds the refusal from the finding's position, not by splitting its sentence", () => {
    // The reason is assembled from `BakedInLiteral.where`. It used to be
    // recovered by splitting the finding's sentence on a fixed phrase, which made
    // a message that must never carry a member number depend on the wording of a
    // function in another package: reword it there and `split` hands back the
    // whole finding, value included, straight into a terminal and a CI log.
    //
    // Asserted as an exact string rather than a `toContain`, because the failure
    // this guards against is extra text on the front of the reason.
    const reasons = refusal(trajectory({ entry: `/member?memberNumber=${MEMBER_ID}` }))

    expect(reasons).toContain(
      "step open's path's constant contains the value this run supplied for memberId. No " +
        "runtime value survives into a stored capability (ADR-0008): reference the parameter " +
        "instead."
    )
    expect(reasons).toContain(
      "the surface entry path contains the value this run supplied for memberId. No runtime " +
        "value survives into a stored capability (ADR-0008): reference the parameter instead."
    )
    expect(reasons.join(" ")).not.toContain(MEMBER_ID)
  })

  it("refuses a value that reached the prose rather than a field", () => {
    // A summary is free text a model wrote, and "the balance of member 12345" is
    // exactly the sentence a model writes. No schema field catches this one.
    const reasons = refusal(
      trajectory({
        conclusion: { conclusion: "reached", summary: `Reads the balance of member ${MEMBER_ID}` }
      })
    )

    expect(reasons.some((reason) => reason.includes("in prose"))).toBe(true)
    expect(reasons.join(" ")).not.toContain(MEMBER_ID)
  })

  it("keeps the selection's own default, which is a declared parameter rather than a baked-in value", () => {
    // `savings` is a value the run matched on, and it is recorded on purpose as
    // the default of a declared enum input — the opposite of baking a value into
    // an action. The exemption is narrow: the same word in a constant or a text
    // assertion is still refused by the gate above.
    expect(formatArtifact(compiled())).toContain("default: savings")
  })
})

// ---------------------------------------------------------------------------
// Steps, targets and checkpoints
// ---------------------------------------------------------------------------

describe("every step carries the reasoning a reviewer approves on", () => {
  it("records the strategy each target actually resolved by, and the argument for it", () => {
    const artifact = compiled()
    const fill = artifact.steps.find((step) => step.id === "fill-1")
    const read = artifact.steps.find((step) => step.id === "read-available-balance")

    if (fill?.action.type !== "fill" || read?.action.type !== "extract") {
      throw new Error("expected a fill and an extract")
    }

    // The strategy is a record of what the adapter did on the live screen, not
    // an intention: `within, role, name` is what scoped-accessible-name means.
    expect(fill.action.target.strategy).toBe("scoped-accessible-name")
    expect(read.action.target.strategy).toBe("caption-label")

    // And the argument names the narrowing, the confidence, and what would break
    // it — SPEC user story 16 is that a reviewer can judge whether it still works
    // next month.
    expect(fill.action.target.robustness).toContain("named exactly \"Member Number\"")
    expect(fill.action.target.robustness).toContain("no selector, id, class or coordinate")
    expect(fill.action.target.robustness).toContain("What would break it")
    expect(fill.action.target.robustness.length).toBeGreaterThan(200)
  })

  it("derives the strategy label from what did the narrowing", () => {
    expect(strategyFor(["within", "role", "name"])).toBe("scoped-accessible-name")
    expect(strategyFor(["role", "name"])).toBe("accessible-name")
    expect(strategyFor(["role", "label"])).toBe("caption-label")
    expect(strategyFor(["role", "textNear"])).toBe("text-near")
    expect(strategyFor([])).toBe("unrecorded")
  })

  it("checkpoints a reading on its shape and never on its value", () => {
    const read = compiled().steps.find((step) => step.id === "read-available-balance")
    const assertion = read?.checkpoint.expect[0]

    expect(assertion?.assert).toBe("stepRead")
    if (assertion?.assert !== "stepRead") return
    expect(assertion.matches).not.toContain("4,182")
    expect(new RegExp(assertion.matches).test("$4,182.55")).toBe(true)
    expect(new RegExp(assertion.matches).test("$0.00")).toBe(true)
    // The silent failure of screen reading, which is what the assertion is for.
    expect(new RegExp(assertion.matches).test("")).toBe(false)
    expect(new RegExp(assertion.matches).test("N/A")).toBe(false)
  })

  it("derives a shape from a reading without carrying its digits", () => {
    expect(shapeOf("$4,182.55")).not.toContain("4")
    expect(shapeOf("plain text")).toBe("^\\s*\\S[\\s\\S]*$")
  })

  it("gives every step a checkpoint that could actually fail", () => {
    for (const step of compiled().steps) {
      expect(step.checkpoint.expect.length, step.id).toBeGreaterThan(0)
      expect(step.checkpoint.description, step.id).not.toBe("(nothing observed)")
    }
  })

  it("refuses a step whose success nothing afterwards confirms", () => {
    // A run that ends on a click has demonstrated nothing about where it landed.
    // The alternative is a checkpoint that always passes, which is how "the
    // action did not throw" becomes the success criterion again.
    const trailing = trajectory()
    const reasons = refusal({
      ...trailing,
      steps: trailing.steps.slice(0, 2),
      outputs: [],
      selections: [],
      parameters: trailing.parameters.filter((parameter) => parameter.name === "memberId")
    })
    expect(reasons.some((reason) => reason.includes("nothing afterwards confirms"))).toBe(true)
  })

  it("compiles the opening navigation the loop performed before its first decision", () => {
    // Replay has no entry logic: it starts by doing what the first step says. The
    // navigation is the run's own opening action, not an invention.
    const first = compiled().steps[0]
    expect(first?.id).toBe("open")
    expect(first?.action).toMatchObject({ type: "navigate", path: { from: "constant", text: "/" } })
  })

  it("declares no outcomes and no recovery rules, because one run learned neither", () => {
    // Both are things learned from what a person had to do. Ticket 13 adds the
    // first of them, in its own version, next to the intervention that justified
    // it — which is the diff SPEC's storage rule exists to make readable.
    expect(compiled().outcomes).toBeUndefined()
    expect(compiled().recoverable).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// What is not compilable
// ---------------------------------------------------------------------------

describe("only a successful run becomes a capability", () => {
  it("refuses a run that got stuck", () => {
    const reasons = refusal(
      trajectory({
        conclusion: {
          conclusion: "stuck",
          trigger: {
            trigger: "cycle",
            detail: "went round twice",
            seen: 2,
            signature: "abc",
            between: ["/", "/m"]
          }
        }
      })
    )
    expect(reasons[0]).toContain("rather than reaching its goal")
  })

  it("refuses a run that answered nothing", () => {
    expect(refusal(trajectory({ outputs: [] }))[0]).toContain("would answer nothing")
  })
})

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

describe("artifacts are immutable, versioned and resolvable", () => {
  it("writes a version once and refuses to write it twice", () => {
    const directory = mkdtempSync(join(tmpdir(), "cua-artifacts-"))
    try {
      const artifact = compiled()
      const first = writeArtifact(directory, artifact)
      expect(Result.isSuccess(first)).toBe(true)

      // The second write is the one that matters. A compiler that could replace
      // a version would mean the document a reviewer approved and the document
      // that runs are the same file only by convention.
      const again = writeArtifact(directory, artifact)
      expect(Result.isFailure(again)).toBe(true)
      if (Result.isFailure(again)) expect(again.failure.message).toContain("immutable")

      // A second version sits beside the first, and `latest` resolves to it.
      const next = writeArtifact(directory, { ...artifact, version: "1.1.0" })
      expect(Result.isSuccess(next)).toBe(true)
      expect(listVersions(directory, DISCOVERED)).toEqual(["1.1.0", "1.0.0"])

      const loaded = loadArtifact(directory, DISCOVERED)
      if (Result.isFailure(loaded)) throw new Error(loaded.failure.message)
      expect(loaded.success.version).toBe("1.1.0")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("writes a document that reads back as what was compiled", () => {
    const directory = mkdtempSync(join(tmpdir(), "cua-artifacts-"))
    try {
      const artifact = compiled()
      const written = writeArtifact(directory, artifact)
      if (Result.isFailure(written)) throw new Error(written.failure.message)

      const yaml = readFileSync(written.success, "utf8")
      // Block style, because an artifact is a review document and a diff between
      // two versions has to be readable by the person approving it. Flow style
      // would put the whole capability on one line.
      expect(yaml.split("\n").length).toBeGreaterThan(50)
      expect(yaml).toContain("robustness: >-")

      const parsed = parseArtifact(written.success, yaml)
      if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
      expect(parsed.success).toEqual(artifact)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("takes none of the versions an intervention teaches", () => {
    // v1.1.0 and v1.2.0 of `member.account-balance` belong to tickets 13 and 14 —
    // outcomes a human confirmed, each landing beside the intervention record
    // that justified it. A compiled capability takes neither: it is a different
    // document with a different name, discovered rather than hand-written, and
    // storing it under the hand-written capability's name would also change what
    // `bun run replay member.account-balance` resolves to.
    //
    // v1.1.0 now exists, and this test still passes untouched apart from its
    // name, which is the thing worth noticing: it was cut by ticket 13's
    // intervention rather than by anything in this file. What the compiler
    // stores is unchanged, and that is what is being asserted.
    expect(listVersions(ARTIFACTS_DIRECTORY, DISCOVERED)).toEqual(["1.0.0"])
  })

  it("ships a compiled artifact that says it was discovered and hides nothing", () => {
    const loaded = loadArtifact(ARTIFACTS_DIRECTORY, DISCOVERED)
    if (Result.isFailure(loaded)) throw new Error(loaded.failure.message)

    expect(loaded.success.authored).toBe("discovered")
    expect(isSensitive(loaded.success.inputs["memberId"]!)).toBe(true)
    expect(readFileSync(join(ARTIFACTS_DIRECTORY, DISCOVERED, "1.0.0.yaml"), "utf8"))
      .not.toContain(MEMBER_ID)
  })
})

// ---------------------------------------------------------------------------
// The acceptance bar
// ---------------------------------------------------------------------------

it.live("a run is discovered, compiled and replayed, and the balance comes back", () =>
  Effect.gen(function*() {
    // A real Chromium against the real fixture under the shipped policy. The
    // model is the one substitution, and `scripted-model.ts` argues why.
    const { trajectory: discovered } = yield* runDiscovery({
      goal: GOAL,
      model: respondingModel(readsTheScreen)
    })
    expect(discovered.conclusion.conclusion).toBe("reached")

    // Compiled in the process that did the run, which is the only place the
    // values behind the parameters still exist — so all three gates have
    // something to look for.
    const artifact = compileArtifact(discovered, {
      capability: "test.discovered-capability",
      version: "1.0.0",
      product: "Heritage Core Member Services (MSS 4.02.11)"
    })
    if (Result.isFailure(artifact)) throw new Error(artifact.failure.message)
    expect(formatArtifact(artifact.success)).not.toContain(MEMBER_ID)

    // And now the bar: the document, unedited, run by the engine that has never
    // seen a model, in another real browser.
    const { result } = yield* replay({
      artifact: artifact.success,
      inputs: { memberId: MEMBER_ID }
    })

    expect(result.result).toBe("success")
    if (result.result !== "success") return
    expect(result.outputs["availableBalance"]).toEqual({
      type: "money",
      value: { amount: 4182.55, currency: "USD" }
    })

    // The steps the compiler wrote are the steps the run took, and every one of
    // them held its checkpoint.
    expect(result.steps.map((step) => step.id)).toEqual([
      "open",
      "fill-1",
      "click-2",
      "selectFromList-3",
      "read-available-balance"
    ])
  }))

it.live("the compiled capability serves the account a caller asks for, at a tenant that words it differently", () =>
  Effect.gen(function*() {
    // The payoff of recording the goal's word rather than the label: member 22222
    // is a tenant whose account labels differ, and nothing about the document
    // changes. Compiled from a discovery run that never saw either.
    const { trajectory: discovered } = yield* runDiscovery({
      goal: GOAL,
      model: respondingModel(readsTheScreen)
    })
    const artifact = compileArtifact(discovered, {
      capability: "test.discovered-capability",
      version: "1.0.0"
    })
    if (Result.isFailure(artifact)) throw new Error(artifact.failure.message)

    const elsewhere = yield* replay({ artifact: artifact.success, inputs: { memberId: "22222" } })
    expect(elsewhere.result.result).toBe("success")

    const checking = yield* replay({
      artifact: artifact.success,
      inputs: { memberId: MEMBER_ID, accountType: "Checking" }
    })
    expect(checking.result.result).toBe("success")
    if (checking.result.result !== "success") return
    expect(checking.result.outputs["availableBalance"]).toEqual({
      type: "money",
      value: { amount: 1204.18, currency: "USD" }
    })
  }))
