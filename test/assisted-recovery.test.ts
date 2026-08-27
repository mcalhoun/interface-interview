/**
 * Assisted Recovery: the middle rung, and the boundary that makes it safe.
 *
 * Every browser test here runs the real Heritage Core fixture in a real Chromium
 * under the real shipped Policy. The one thing standing in for something is the
 * model, and it stands in at the same seam a provider fills — `LanguageModel.make`
 * — so the toolkit, the JSON Schema the model is sent, and the decoding of what
 * it returns are all the production code path. SPEC records the deliberate cut:
 * no automated test calls a live model, because a failure would not say whether
 * the code broke or the model had an off day.
 *
 * The suite is in five parts, and the first is the one that matters most.
 *
 *   1. **The consulted model cannot act.** Not "is not allowed to": cannot. Its
 *      whole vocabulary is enumerated, every tool's JSON Schema is rendered, and
 *      there is nowhere in any of them to name a control.
 *   2. **Off by default, on with a flag**, demonstrated on the same member with
 *      the same artifact and two different, correct results.
 *   3. **Bounded**: one step, one attempt, one turn, one consultation per run.
 *   4. **Marked**: assisted, with a confidence and a pointer into Evidence, and
 *      never confusable with the deterministic answer to the same question.
 *   5. **Policy, and the one-way rule**: a deployment that has not permitted a
 *      consultation does not get one, and no proposal reaches `artifacts/`.
 */

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { Effect, Ref, Result, Schema } from "effect"
import { describe, expect } from "vitest"
import { ASSIST_VERBS, assistTools, modelAdvisor } from "@cua/agent"
import { DISCOVERY_VERBS } from "@cua/agent"
import { classificationOf } from "@cua/artifact"
import { ACTION_TYPES, compilePolicy, decideAssist } from "@cua/policy"
import {
  type AssistCandidate,
  type AssistConsultation,
  type Advisor,
  ASSIST_CONFIDENCE_FLOOR,
  AssistUnavailable,
  consultAssist,
  isProposable,
  proposableOutcomes
} from "@cua/replay"
import { recordingModel, scriptedModel } from "./support/scripted-model.ts"
import { ACCOUNT_BALANCE, replay, shippedArtifact, shippedPolicy } from "./support/replay-harness.ts"

/**
 * The version whose `open-account` step still *escalates* a selection that
 * matches nothing.
 *
 * Pinned deliberately. At 1.1.0 the same state is a declared Business Outcome —
 * ticket 13 taught it by pausing for a person — so running this suite against
 * `latest` would be running it against a capability that no longer stalls, and
 * the rung would never fire. The two versions side by side are the point: the
 * same state, reached by an intervention at 1.1.0 and by a consultation at
 * 1.0.0, and the results are distinguishable.
 */
const BEFORE_LEARNING = "1.0.0"

/** Member 88888 holds a Checking account and no savings. Nothing on the page says so. */
const CHECKING_ONLY = "88888"

/** The code the 1.0.0 artifact names for the state, without saying what it means. */
const NO_MATCHING_ITEM = "NO_MATCHING_ITEM"

const artifactBeforeLearning = () => shippedArtifact(ACCOUNT_BALANCE, BEFORE_LEARNING)

const withoutComments = (text: string): string =>
  text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:])\/\/.*$/gm, "$1")

/**
 * An advisor that classifies confidently, over a scripted model.
 *
 * Built exactly as the CLI builds the real one — `modelAdvisor({ model })` — with
 * a `LanguageModel` layer that answers from a script instead of a provider. When
 * a working key exists, the only thing that changes at this call site is which
 * Layer goes in.
 */
const confidentAdvisor = (
  code = NO_MATCHING_ITEM,
  confidence = 0.92,
  rationale = "the account list on this screen offers only Checking; there is no savings account to open"
): Advisor =>
  modelAdvisor({
    model: scriptedModel([
      { name: "classify", params: { proposedOutcome: code, confidence, rationale } }
    ])
  })

// ---------------------------------------------------------------------------
// 1. The consulted model cannot act
// ---------------------------------------------------------------------------

describe("the boundary: acting is not representable", () => {
  it("the assist vocabulary contains no verb that touches a surface", () => {
    // Two words, and neither is an action. Compare `DISCOVERY_VERBS`, which has
    // five that are.
    expect([...ASSIST_VERBS]).toEqual(["classify", "cannotClassify"])

    // Disjoint from both other vocabularies in the system. A verb copied here
    // from either fails this before it fails anything else.
    for (const verb of ASSIST_VERBS) {
      expect(ACTION_TYPES, `${verb} is an action type`).not.toContain(verb)
      expect(DISCOVERY_VERBS, `${verb} is a discovery verb`).not.toContain(verb)
    }
  })

  it("no tool the model is given has anywhere to name a control", () => {
    const candidates: ReadonlyArray<AssistCandidate> = [
      { code: "MEMBER_NOT_FOUND", meaning: "no member record exists" },
      { code: NO_MATCHING_ITEM, meaning: "nothing on offer matched" }
    ]

    const tools = assistTools(candidates)
    expect(Object.keys(tools.tools).sort()).toEqual(["cannotClassify", "classify"])

    // The JSON Schema is what actually reaches the model, so that is what is
    // asserted rather than the TypeScript type. Every word a control could be
    // named with is checked, including the ones ADR-0001 has already ruled out
    // everywhere else: a model that cannot see markup has nowhere to put a
    // selector even if it invented one.
    const forbidden = [
      "target",
      "selector",
      "css",
      "xpath",
      "path",
      "url",
      "value",
      "role",
      "label",
      "click",
      "action",
      "coordinates",
      "x",
      "y"
    ]

    for (const [name, tool] of Object.entries(tools.tools)) {
      const rendered = JSON.stringify(
        Schema.toJsonSchemaDocument(tool.parametersSchema as never)
      )
      for (const word of forbidden) {
        expect(
          rendered,
          `the ${name} tool's parameters mention "${word}"`
        ).not.toMatch(new RegExp(`"${word}"`, "i"))
      }
    }
  })

  it("the outcome a model may propose is a closed list from the artifact", () => {
    const candidates: ReadonlyArray<AssistCandidate> = [
      { code: "MEMBER_NOT_FOUND", meaning: "no member record exists" },
      { code: NO_MATCHING_ITEM, meaning: "nothing on offer matched" }
    ]
    const rendered = JSON.stringify(
      Schema.toJsonSchemaDocument(
        assistTools(candidates).tools["classify"]!.parametersSchema as never
      )
    )

    // An enumeration, not a string. A model cannot invent an outcome code
    // because the schema it is sent does not have a shape an invented one fits.
    expect(rendered).toContain("MEMBER_NOT_FOUND")
    expect(rendered).toContain(NO_MATCHING_ITEM)
    expect(rendered).toContain("enum")

    // And confidence is bounded, so a model returning 95 fails validation rather
    // than sailing past every threshold in the system.
    expect(rendered).toMatch(/"maximum":\s*1/)
  })

  it("the assist module's handlers refuse to run, and resolution stays off", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "agent", "src", "assist.ts"),
      "utf8"
    )
    // Belt and braces, exactly as the discovery toolkit does it: if a later
    // change re-enabled resolution, the handlers die loudly rather than quietly
    // doing something.
    expect(source).toContain("disableToolCallResolution: true")
    expect(source).toContain("Effect.die")

    // No route from this module to a browser. It does not import the adapter.
    expect(source).not.toContain("SurfaceAdapter")
  })

  it("nothing in the replay package can reach a model, and the engine's ladder is unchanged", () => {
    // The engine is where the rung is wired, so it is the file that would have
    // reached for a model if the port had not been used. It does not, and the
    // port is why: `assist.ts` in the replay package names no provider, no
    // framework AI module and no key.
    const replaySource = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "packages",
      "replay",
      "src"
    )
    const forbidden = [/LanguageModel/, /@effect\/ai-/, /effect\/unstable\/ai/]
    for (const file of ["assist.ts", "engine.ts"]) {
      // Comments stripped first, the same way `test/replay-has-no-model.test.ts`
      // does it: these modules discuss what they cannot reach, at length, and a
      // scan that could not tell prose from code would make explaining the
      // guarantee the thing that breaks it.
      const text = withoutComments(readFileSync(join(replaySource, file), "utf8"))
      for (const pattern of forbidden) {
        expect(text, `${file} reaches for a model with ${pattern}`).not.toMatch(pattern)
      }
    }

    // And the only module in the package that knows a model exists at all is the
    // CLI, which is the composition root: it builds an `Advisor` and hands it in
    // as a value. `test/replay-has-no-model.test.ts` holds the primary proof —
    // the engine's requirement set is still exactly four services.
    const reaching = readdirSync(replaySource)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) =>
        /modelAdvisor|providerFor/.test(
          withoutComments(readFileSync(join(replaySource, name), "utf8"))
        )
      )
    expect(reaching).toEqual(["cli.ts"])
  })
})

// ---------------------------------------------------------------------------
// 2. Off by default, on with a flag: the same input, two behaviours
// ---------------------------------------------------------------------------

describe("off by default", () => {
  it.live("the same member and artifact fail unattended with no assist", () =>
    Effect.gen(function* () {
      const outcome = yield* replay({
        artifact: artifactBeforeLearning(),
        inputs: { memberId: CHECKING_ONLY }
      })

      // The behaviour every test written before this ticket asserts, unchanged.
      expect(outcome.result.result).toBe("failure")
      if (outcome.result.result !== "failure") return
      expect(outcome.result.failure.reason).toBe("no_matching_item")

      // And nothing was consulted, because there was nothing to consult.
      expect(outcome.events.filter((event) => event.kind.startsWith("assist."))).toEqual([])
      expect(outcome.events.map((event) => event.kind)).not.toContain("decide")
    })
  )

  it.live("with assist enabled the same run resolves, with nobody involved", () =>
    Effect.gen(function* () {
      const outcome = yield* replay({
        artifact: artifactBeforeLearning(),
        inputs: { memberId: CHECKING_ONLY },
        assist: confidentAdvisor()
      })

      // Same member, same document, same policy, same browser: a business
      // outcome instead of a hard failure.
      expect(outcome.result.result).toBe("business_outcome")
      if (outcome.result.result !== "business_outcome") return
      expect(outcome.result.code).toBe(NO_MATCHING_ITEM)

      // Nobody was paged and nobody was asked. This is the whole point of the
      // rung: the session was never paused, and no intervention was raised.
      const kinds = outcome.events.map((event) => event.kind)
      expect(kinds).not.toContain("intervention.raise")
      expect(kinds).not.toContain("intervention.resolve")

      // It is the same state ticket 13 taught by escalation, reached one rung
      // lower. At 1.1.0 the artifact answers this deterministically; here the
      // 1.0.0 document only *names* the code, and a classification supplied the
      // rest for this run alone.
      expect(artifactBeforeLearning().outcomes?.[NO_MATCHING_ITEM]).toBeUndefined()
    })
  )
})

// ---------------------------------------------------------------------------
// 3. Bounded
// ---------------------------------------------------------------------------

describe("bounded to one step and one attempt", () => {
  it.live("the model is asked exactly once, about one screen", () =>
    Effect.gen(function* () {
      const recorder = recordingModel(() => ({
        name: "classify",
        params: {
          proposedOutcome: NO_MATCHING_ITEM,
          confidence: 0.9,
          rationale: "only Checking is on offer"
        }
      }))

      const outcome = yield* replay({
        artifact: artifactBeforeLearning(),
        inputs: { memberId: CHECKING_ONLY },
        assist: modelAdvisor({ model: recorder.layer })
      })

      expect(outcome.result.result).toBe("business_outcome")

      // One turn. Not "one turn per step" and not "one turn unless it needs
      // another": the rung has no expression that consults twice.
      expect(recorder.prompts()).toHaveLength(1)

      // One request, one proposal, and both about the step that stalled.
      const requests = outcome.events.filter((event) => event.kind === "assist.request")
      const proposals = outcome.events.filter((event) => event.kind === "assist.proposal")
      expect(requests).toHaveLength(1)
      expect(proposals).toHaveLength(1)
      expect(requests[0]?.stepId).toBe("open-account")
      expect(proposals[0]?.stepId).toBe("open-account")
    })
  )

  it.live("the prompt carries text only, and no sensitive value", () =>
    Effect.gen(function* () {
      const recorder = recordingModel(() => ({
        name: "cannotClassify",
        params: { rationale: "the screen does not say" }
      }))

      yield* replay({
        artifact: artifactBeforeLearning(),
        inputs: { memberId: CHECKING_ONLY },
        assist: modelAdvisor({ model: recorder.layer })
      })

      const prompt = recorder.prompts()[0]!
      for (const message of prompt.content) {
        const parts = typeof message.content === "string" ? [] : message.content
        for (const part of parts) {
          // ADR-0001 in the assisted rung too: the model is shown the
          // accessibility structure and nothing else. No screenshot, ever.
          expect(part.type).toBe("text")
        }
      }

      // The one text this engine sends outside itself goes through the run's own
      // evidence scrubber first, so the member number is not in it.
      const rendered = JSON.stringify(prompt)
      expect(rendered).not.toContain(CHECKING_ONLY)
      expect(rendered).toContain("[redacted:memberId]")
    })
  )

  it.effect("a second consultation in one run is refused whatever it would have said", () =>
    Effect.gen(function* () {
      const budget = yield* Ref.make(1)
      let consulted = 0
      const advisor: Advisor = {
        consult: () =>
          Effect.sync(() => {
            consulted += 1
            return { _tag: "Classified", proposedOutcome: "A", confidence: 1, rationale: "sure" }
          })
      }

      const gate = {
        authorise: () =>
          Effect.succeed({
            verdict: "allow" as const,
            reason: "permitted",
            policy: "test",
            risk: "risky" as const
          }),
        record: () => Effect.void
      }

      const consultation: AssistConsultation = {
        capability: "x@1.0.0",
        stepId: "s",
        stepIntent: "do a thing",
        stalled: "it stalled",
        question: "what does this mean",
        url: "http://127.0.0.1:1/",
        accessibility: "- table",
        candidates: [{ code: "A", meaning: "the only answer" }]
      }

      const rung = { advisor, gate, budget, page: "http://127.0.0.1:1/" }
      const first = yield* consultAssist(rung, consultation)
      const second = yield* consultAssist(rung, consultation)

      expect(first._tag).toBe("Proposed")
      expect(second._tag).toBe("NotProposed")
      if (second._tag === "NotProposed") {
        expect(second.why).toContain("bounded to 1 consultation per run")
      }

      // The budget is spent before the advisor is called, so a second stall does
      // not even reach it.
      expect(consulted).toBe(1)
    })
  )
})

// ---------------------------------------------------------------------------
// 4. Marked as assisted, and never deterministic
// ---------------------------------------------------------------------------

describe("an assisted result is never a deterministic one", () => {
  it.live("it carries assisted, the confidence and a pointer to the proposal", () =>
    Effect.gen(function* () {
      const outcome = yield* replay({
        artifact: artifactBeforeLearning(),
        inputs: { memberId: CHECKING_ONLY },
        assist: confidentAdvisor(NO_MATCHING_ITEM, 0.92)
      })

      expect(outcome.result.result).toBe("business_outcome")
      if (outcome.result.result !== "business_outcome") return

      expect(outcome.result.assisted).toBe(true)
      expect(outcome.result.confidence).toBe(0.92)

      // The pointer resolves: the id it names is in the run's own event log,
      // beside the rationale and the request that produced it.
      const proposal = outcome.events.find((event) => event.kind === "assist.proposal")
      expect(proposal).toBeDefined()
      if (proposal === undefined || proposal.kind !== "assist.proposal") return
      expect(outcome.result.proposalRef).toBe(`events.jsonl#${proposal.assistId}`)
      expect(proposal.proposedOutcome).toBe(NO_MATCHING_ITEM)
      expect(proposal.confidence).toBe(0.92)
      expect(proposal.accepted).toBe(true)
      expect(proposal.rationale).toContain("Checking")

      // The step list says so too, so a caller printing steps can see which one
      // was proposed rather than observed.
      const step = outcome.result.steps.find((record) => record.id === "open-account")
      expect(step?.assisted).toBe(true)
      expect(step?.checkpoint).toBe("outcome")
    })
  )

  it.live("the deterministic answer to the same question is not marked", () =>
    Effect.gen(function* () {
      // 1.1.0 is the version an intervention taught. The same member, the same
      // state, no consultation — and the result carries no marker at all.
      const outcome = yield* replay({
        artifact: shippedArtifact(ACCOUNT_BALANCE, "1.1.0"),
        inputs: { memberId: CHECKING_ONLY },
        assist: confidentAdvisor()
      })

      expect(outcome.result.result).toBe("business_outcome")
      if (outcome.result.result !== "business_outcome") return
      expect(outcome.result.code).toBe(NO_MATCHING_ITEM)
      expect(outcome.result.assisted).toBeUndefined()
      expect(outcome.result.confidence).toBeUndefined()
      expect(outcome.result.proposalRef).toBeUndefined()

      // The rung was enabled and was never reached: the artifact answered first.
      // A declared outcome always beats every rung below it, and that ordering is
      // what stops a model being asked about states somebody already classified.
      expect(outcome.events.filter((event) => event.kind.startsWith("assist."))).toEqual([])
    })
  )

  it.live("a proposal below the confidence floor is recorded and refused", () =>
    Effect.gen(function* () {
      const outcome = yield* replay({
        artifact: artifactBeforeLearning(),
        inputs: { memberId: CHECKING_ONLY },
        assist: confidentAdvisor(NO_MATCHING_ITEM, 0.4, "it might be that, or the page may be broken")
      })

      // Unattended, so the run reports the hard failure it always did. The rung
      // makes escalations rarer; it never makes one that would not have happened.
      expect(outcome.result.result).toBe("failure")

      // And the proposal is in the log anyway, marked as not acted on. A log
      // that kept only the accepted ones would make the floor invisible.
      const proposal = outcome.events.find((event) => event.kind === "assist.proposal")
      expect(proposal).toBeDefined()
      if (proposal === undefined || proposal.kind !== "assist.proposal") return
      expect(proposal.confidence).toBe(0.4)
      expect(proposal.accepted).toBe(false)
      expect(0.4).toBeLessThan(ASSIST_CONFIDENCE_FLOOR)
    })
  )

  it.live("an unreachable model is not an escalation the rung caused", () =>
    Effect.gen(function* () {
      const outcome = yield* replay({
        artifact: artifactBeforeLearning(),
        inputs: { memberId: CHECKING_ONLY },
        assist: {
          consult: () =>
            Effect.fail(new AssistUnavailable({ reason: "401 from the provider" }))
        }
      })

      // Exactly what the run does with no rung at all. A missing or rejected API
      // key costs a consultation, never a run.
      expect(outcome.result.result).toBe("failure")
      if (outcome.result.result !== "failure") return
      expect(outcome.result.failure.reason).toBe("no_matching_item")

      // The request is recorded, there is no proposal because there was none,
      // and the log says why rather than trailing off. This is the shape a real
      // run with a rejected API key takes, and somebody reading it afterwards
      // has to be able to tell it from a rung that silently did nothing.
      expect(outcome.events.filter((event) => event.kind === "assist.request")).toHaveLength(1)
      expect(outcome.events.filter((event) => event.kind === "assist.proposal")).toEqual([])
      const declined = outcome.events.find((event) => event.kind === "assist.declined")
      expect(declined).toBeDefined()
      if (declined === undefined || declined.kind !== "assist.declined") return
      expect(declined.reason).toContain("401 from the provider")
    })
  )
})

// ---------------------------------------------------------------------------
// 5. Policy, the closed candidate set, and the one-way rule
// ---------------------------------------------------------------------------

describe("policy checks the request, and nothing is written", () => {
  const withoutAssist = () => {
    const shipped = shippedPolicy()
    const compiled = compilePolicy("test://no-assist", {
      ...shipped.document,
      assist: undefined
    })
    if (Result.isFailure(compiled)) throw new Error(compiled.failure.message)
    return compiled.success
  }

  it("a policy with no assist block denies the consultation", () => {
    const verdict = decideAssist(withoutAssist(), {
      stepId: "open-account",
      page: "http://127.0.0.1:4173/member",
      mode: "replay"
    })
    expect(verdict.verdict).toBe("deny")
    expect(verdict.reason).toContain("no assist: block")
    // Classified with the risky actions, because what is irreversible about it is
    // that the screen has left the building.
    expect(verdict.risk).toBe("risky")
  })

  it("the shipped policy permits it, and only on an allowed origin", () => {
    const policy = shippedPolicy()
    expect(
      decideAssist(policy, {
        stepId: "s",
        page: "http://127.0.0.1:4173/member",
        mode: "replay"
      }).verdict
    ).toBe("allow")

    // A run that has wandered off the allowlist must not have its screen read
    // out to anybody on the way to the escalation it is about to raise.
    expect(
      decideAssist(policy, { stepId: "s", page: "https://elsewhere.example/", mode: "replay" })
        .verdict
    ).toBe("deny")

    // And discovery does not come through this door. It reaches a model openly,
    // through its own requirement set.
    expect(
      decideAssist(policy, {
        stepId: "s",
        page: "http://127.0.0.1:4173/member",
        mode: "discovery"
      }).verdict
    ).toBe("deny")
  })

  it.live("a denied consultation falls through to the rung below", () =>
    Effect.gen(function* () {
      const outcome = yield* replay({
        artifact: artifactBeforeLearning(),
        inputs: { memberId: CHECKING_ONLY },
        policy: withoutAssist(),
        assist: confidentAdvisor()
      })

      // The model was never asked, even though a confident answer was available
      // and `--assist` was given. The deployment had not permitted it.
      expect(outcome.result.result).toBe("failure")
      expect(outcome.events.filter((event) => event.kind === "assist.proposal")).toEqual([])

      // The refusal is on the record, under the same kind every other policy
      // decision in the run uses.
      const check = outcome.events.find(
        (event) => event.kind === "policy.check" && event.action === "assist"
      )
      expect(check).toBeDefined()
      if (check === undefined || check.kind !== "policy.check") return
      expect(check.verdict).toBe("deny")
      expect(check.risk).toBe("risky")

      // And the rung says, in its own kinds, that it declined and why — so the
      // reason a person was reached sits in one place rather than having to be
      // assembled from a policy verdict and an absence.
      const declined = outcome.events.find((event) => event.kind === "assist.declined")
      expect(declined).toBeDefined()
      if (declined === undefined || declined.kind !== "assist.declined") return
      expect(declined.reason).toContain("refused the consultation")
    })
  )

  it("the codes on offer come from the artifact, and never include a state needing authority", () => {
    const artifact = artifactBeforeLearning()
    const offered = proposableOutcomes(artifact, NO_MATCHING_ITEM).map(
      (candidate) => candidate.code
    )

    // Exactly two: the one declared outcome, and the code the stalled step names
    // for the state it hit. Nothing else the document mentions is on offer — in
    // particular `AMBIGUOUS_MATCH`, which is never proposable because ambiguity
    // never enters the ladder in the first place (ADR-0007: never a coin flip).
    expect(offered.sort()).toEqual(["MEMBER_NOT_FOUND", NO_MATCHING_ITEM])

    // With no code named by the stall, only what the artifact has declared.
    expect(proposableOutcomes(artifact, undefined).map((c) => c.code)).toEqual([
      "MEMBER_NOT_FOUND"
    ])

    // The authority filter reads the artifact's own classification, which is the
    // single lookup ticket 14 extends with `requiresHuman:`. Today no code can
    // answer `requires_human`, so the filter removes nothing here — the rule
    // itself is asserted below, total over its domain, so that it is a tested
    // rule rather than an untested branch waiting for a schema.
    expect(classificationOf(artifact, "MEMBER_NOT_FOUND")).toBe("business_outcome")
  })

  it("a state learned to need a person is never proposable as automatable", () => {
    // SPEC: "Authority-class states are never proposable as automatable." The
    // predicate is total over `LearnedClass | undefined`, so when ticket 14's
    // `requiresHuman:` starts making `classificationOf` answer `requires_human`,
    // those codes drop out of the candidate list with no other change.
    expect(isProposable("business_outcome")).toBe(true)
    expect(isProposable("recoverable")).toBe(true)
    expect(isProposable(undefined)).toBe(true)
    expect(isProposable("requires_human")).toBe(false)
  })

  it.live("a proposal changes no capability on disk", () =>
    Effect.gen(function* () {
      const before = readdirSync(join(process.cwd(), "artifacts", ACCOUNT_BALANCE)).sort()

      const outcome = yield* replay({
        artifact: artifactBeforeLearning(),
        inputs: { memberId: CHECKING_ONLY },
        assist: confidentAdvisor()
      })
      expect(outcome.result.result).toBe("business_outcome")

      // Nothing was written. Promotion goes through `proposeAmendment`, which
      // takes an `InterventionRecord` — a value only a human handoff produces —
      // so there is no expression anywhere that turns a proposal into a stored
      // version. The write-once rule from ticket 14 holds because a model call
      // has no way to reach the store at all.
      expect(readdirSync(join(process.cwd(), "artifacts", ACCOUNT_BALANCE)).sort()).toEqual(before)

      // The 1.0.0 document is still the one that only names the code.
      expect(artifactBeforeLearning().outcomes?.[NO_MATCHING_ITEM]).toBeUndefined()
    })
  )
})
