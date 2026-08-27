/**
 * One capability, two institutions running the same vendor product.
 *
 * SPEC's second-tenant table has four rows and the interesting thing about it is
 * the ratio: three of the four differences cost nothing at all, and the fourth
 * costs one confirmed override that nobody wrote by hand. This suite is arranged
 * to make that visible rather than to spread it evenly.
 *
 *   1. **What costs nothing.** A shortened field caption, differently named
 *      products, and an account panel with no iframe, all absorbed by matching
 *      rules that were already there. No configuration, no file, no flag.
 *   2. **The one that does not.** `Find` and `Search` share no token in either
 *      direction, so the run fails — as an ordinary `target_missing` replay
 *      failure, which is the only tenant-drift detector this system has
 *      (ADR-0006).
 *   3. **The ladder adapts it.** Assisted recovery proposes the correspondent, a
 *      person confirms once, and the confirmation is written as a scoped delta.
 *      Nothing is pressed on a model's say-so at any point.
 *   4. **A delta, not a copy.** The stored override changes one field of one
 *      step, records how it was discovered and who confirmed it, and leaves
 *      `artifacts/` untouched.
 *   5. **Both institutions, afterwards.** The same capability, the same version,
 *      the same two balances.
 *
 * Everything below the model is real: two installations of the mock core, a real
 * Chromium, the shipped Policy, the real operator interface over HTTP, the real
 * Evidence writer. The model's judgement is scripted at `LanguageModel.make`,
 * the seam a provider fills, because the key in this environment is revoked —
 * see `evidence/tenant/community-cu/NO-MODEL-DROVE-THIS.txt`.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect, Ref, Result } from "effect"
import { describe, expect } from "vitest"
import { modelAdvisor } from "@cua/agent"
import {
  type CapabilityArtifact,
  type TenantOverride,
  ARTIFACTS_DIRECTORY,
  OVERRIDES_DIRECTORY,
  applyOverride,
  declareTargetOverride,
  listVersions,
  loadOverride,
  parseOverride
} from "@cua/artifact"
import { noScrubbing } from "@cua/evidence"
import type { ProposalAnswer } from "@cua/session"
import { COMMUNITY_CU, HERITAGE_CORE, serve } from "@cua/legacy-core"
import {
  type Advisor,
  type AssistConsultation,
  ASSIST_TARGET_QUESTION,
  consultAssist,
  proposeAmendment,
  proposeOverride
} from "@cua/replay"
import {
  SurfaceAdapter,
  TargetNotFound,
  isTokenSubsetOf,
  playwrightSurface,
  selectFromTree
} from "@cua/surface"
import { attendedReplay } from "./support/handoff-harness.ts"
import { replay, shippedArtifact } from "./support/replay-harness.ts"
import { scriptedModel } from "./support/scripted-model.ts"

const TENANT = COMMUNITY_CU.key
const CAPABILITY = "member.account-balance"
const MEMBER = "12345"
const SUBMIT_STEP = "run-member-search"

/**
 * The version this ticket runs against, pinned.
 *
 * `latest` is 1.2.0 today and a later ticket may cut another. What this suite is
 * about is a *tenant* difference against a fixed vendor document, and the stored
 * override names the version it was confirmed against — so pinning is not
 * caution, it is the same fact the override file records.
 */
const BASE_VERSION = "1.2.0"

const base = (): CapabilityArtifact => shippedArtifact(CAPABILITY, BASE_VERSION)

/** The delta this repository ships, produced by a run. See the driver. */
const storedOverride = (): TenantOverride => {
  const loaded = loadOverride(OVERRIDES_DIRECTORY, TENANT, CAPABILITY)
  if (Result.isFailure(loaded)) throw new Error(loaded.failure.message)
  if (loaded.success === undefined) {
    throw new Error(
      `no override is stored for ${TENANT}. Run bun run test/support/drive-the-tenant-override.ts`
    )
  }
  return loaded.success
}

const effectiveFor = (tenant: TenantOverride): CapabilityArtifact => {
  const applied = applyOverride(base(), tenant)
  if (Result.isFailure(applied)) throw new Error(applied.failure.message)
  return applied.success
}

/**
 * One browser on one tenant's installation.
 *
 * `tenant` is a server option, not a URL parameter, because two institutions are
 * two installations — and because Policy judges the origin a run is on.
 */
const withTenant = <A, E>(
  tenant: string,
  path: string,
  body: (surface: SurfaceAdapter["Service"]) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const core = yield* serve({ port: 0, tenant })
    const layer = playwrightSurface({ startUrl: core.origin + path })
    return yield* Effect.gen(function* () {
      const surface = yield* SurfaceAdapter
      return yield* body(surface)
    }).pipe(Effect.provide(layer))
  }).pipe(Effect.scoped)

/**
 * The consultation's answer, scripted, built exactly as the CLI builds the real
 * one. When a key works, the only thing that changes here is which Layer goes in.
 */
const proposingAdvisor = (control = "Find", confidence = 0.9): Advisor =>
  modelAdvisor({
    model: scriptedModel([
      {
        name: "proposeTarget",
        params: {
          control,
          confidence,
          rationale: "the search panel's only submit control reads Find"
        }
      }
    ])
  })

// ---------------------------------------------------------------------------
// 1. What costs nothing
// ---------------------------------------------------------------------------

describe("three of the four differences are absorbed with no override at all", () => {
  it.live("a field labelled Member # answers to a target asking for Member Number", () =>
    withTenant(TENANT, "/", (surface) =>
      Effect.gen(function* () {
        const resolution = yield* surface.resolveTarget({
          role: "textbox",
          name: "Member Number",
          within: { name: "Member Number Search" }
        })

        // The tenant's own caption, reached by the target the vendor document
        // ships. Nothing was configured to make this happen.
        expect(resolution.match.text).toBe("Member #")
        expect(resolution.strategies).toContain("nameTokens")
        // And it names exactly one control, which is the claim that matters: the
        // Branch box is in the same panel and does not answer.
        expect(resolution.alternatives).toBe(0)
      })
    )
  )

  it.live("the same target still resolves exactly, and by exact name, at the first tenant", () =>
    withTenant(HERITAGE_CORE.key, "/", (surface) =>
      Effect.gen(function* () {
        const resolution = yield* surface.resolveTarget({
          role: "textbox",
          name: "Member Number",
          within: { name: "Member Number Search" }
        })
        expect(resolution.match.text).toBe("Member Number")
        // The token rung is a *fallback*. Where an exact match exists it is the
        // answer, which is what keeps this change from moving any existing
        // resolution.
        expect(resolution.strategies).toContain("name")
        expect(resolution.strategies).not.toContain("nameTokens")
      })
    )
  )

  it.live("the parameter savings selects Regular Savings, as it selects Primary Savings", () =>
    withTenant(TENANT, `/member?memberNumber=${MEMBER}`, (surface) =>
      Effect.gen(function* () {
        const state = yield* surface.observe
        const chosen = selectFromTree(state.tree, {
          list: { within: { name: "Share and Deposit Accounts" }, itemRole: "link" },
          wanted: "Savings"
        })
        if (chosen._tag !== "Selected") throw new Error(`expected a selection, got ${chosen._tag}`)

        expect(chosen.item.label).toBe("Regular Savings")
        // The whole list, so the assertion is about a choice rather than about
        // there being only one thing to choose.
        expect(chosen.items.map((item) => item.label)).toEqual(["Regular Savings", "Share Draft"])
      })
    )
  )

  it.live("the balance cell resolves whether or not the panel is in a frame", () =>
    Effect.gen(function* () {
      const target = { role: "cell", label: "Available Balance" } as const
      const path = `/account?memberNumber=${MEMBER}&accountNumber=0000012345-S01`

      const framed = yield* withTenant(HERITAGE_CORE.key, path, (surface) =>
        Effect.gen(function* () {
          const state = yield* surface.observe
          return { frames: state.frames.map((frame) => frame.name), read: yield* surface.extract(target) }
        })
      )
      const inline = yield* withTenant(TENANT, path, (surface) =>
        Effect.gen(function* () {
          const state = yield* surface.observe
          return { frames: state.frames.map((frame) => frame.name), read: yield* surface.extract(target) }
        })
      )

      // The layouts really are different: one screen has a child document and
      // the other does not.
      expect(framed.frames).toEqual(["main", "acctdetail"])
      expect(inline.frames).toEqual(["main"])

      // And the same Target reads the same figure off both, because a Target has
      // no field in which a frame could be named (ADR-0001).
      expect(framed.read).toBe("$4,182.55")
      expect(inline.read).toBe(framed.read)
    })
  )

  it("the stored override says nothing about labels, accounts or frames", () => {
    const override = storedOverride()

    // The strongest form of "three of the four cost nothing": the file that
    // exists to record differences records exactly one, and it is the button.
    expect(override.targets).toHaveLength(1)
    expect(override.targets[0]!.step).toBe(SUBMIT_STEP)
    expect(override.targets[0]!.was).toBe("Search")
    expect(override.targets[0]!.name).toBe("Find")

    const written = readFileSync(
      join(OVERRIDES_DIRECTORY, TENANT, `${CAPABILITY}.yaml`),
      "utf8"
    )
    for (const absent of ["Member #", "Regular Savings", "Share Draft", "iframe", "acctdetail"]) {
      expect(written, `the override mentions ${absent}`).not.toContain(absent)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. The one that does not
// ---------------------------------------------------------------------------

describe("the submit control is a real incompatibility, and it surfaces as a replay failure", () => {
  it("Find and Search share no token, in either direction", () => {
    // Not an opinion about the two words: the rule this system matches by says
    // so, and there is no reading of it under which they correspond. That is why
    // this one needs a person and the other three do not.
    expect(isTokenSubsetOf("Search", "Find")).toBe(false)
    expect(isTokenSubsetOf("Find", "Search")).toBe(false)
    expect("Find".toLowerCase().includes("search")).toBe(false)
    expect("Search".toLowerCase().includes("find")).toBe(false)
  })

  it.live("a target asking for the Search button finds nothing on the second tenant", () =>
    withTenant(TENANT, "/", (surface) =>
      Effect.gen(function* () {
        const failure = yield* surface
          .resolveTarget({ role: "button", name: "Search" })
          .pipe(Effect.flip)
        expect(failure).toBeInstanceOf(TargetNotFound)
        // Not ambiguity, and not a wrong screen: the screen is right and the
        // control is named something else.
        expect((failure as TargetNotFound).narrowedBy).toBe("nameContains")
      })
    )
  )

  it.live("the unmodified capability fails against the second tenant, at that step and no earlier", () =>
    Effect.gen(function* () {
      const outcome = yield* replay({
        artifact: base(),
        inputs: { memberId: MEMBER },
        runId: "tenant-before",
        core: { tenant: TENANT }
      })

      if (outcome.result.result !== "failure") {
        throw new Error(`expected a failure, got ${outcome.result.result}`)
      }
      expect(outcome.result.failure.reason).toBe("target_missing")
      expect(outcome.result.failure.stepId).toBe(SUBMIT_STEP)

      // The two steps before it held, which is the absorbed label difference
      // being demonstrated by the capability itself rather than by a unit test:
      // the run typed a member number into a field this institution calls
      // something else, and verified it by reading it back.
      //
      // A run abandoned by a blocked Action reports the steps that ran, and the
      // step that could not act is named on the failure rather than added to the
      // list as a fourth entry that never happened.
      expect(outcome.result.steps.map((step) => [step.id, step.checkpoint])).toEqual([
        ["open-member-search", "held"],
        ["enter-member-number", "held"]
      ])

      // Tenant drift has no detector of its own. This is it.
      expect(outcome.events.some((event) => event.kind === "override.applied")).toBe(false)
    })
  )
})

// ---------------------------------------------------------------------------
// 3. The ladder adapts it, and nothing is pressed on a model's say-so
// ---------------------------------------------------------------------------

describe("the recovery ladder proposes, and a person confirms", () => {
  it.live("the consultation proposes a control, the run stops anyway, and the person is shown it", () =>
    Effect.gen(function* () {
      const episode = yield* attendedReplay({
        artifact: base(),
        inputs: { memberId: MEMBER },
        runId: "tenant-onboarding",
        core: { tenant: TENANT },
        assist: proposingAdvisor(),
        operate: (desk) =>
          Effect.gen(function* () {
            yield* desk.awaitPause
            yield* desk.post("/take", { operator: "a.reyes" })
            yield* desk.post("/return", {
              operator: "a.reyes",
              classification: "unresolved",
              detail: "this installation labels the submit control Find",
              nextTime: "not_asked",
              confirmProposal: "confirmed"
            })
          })
      })

      const record = episode.snapshot.resolved[0]!
      const proposal = record.intervention.proposal
      expect(proposal?.control).toBe("Find")
      expect(proposal?.forTarget).toBe('button "Search"')
      expect(proposal?.confidence).toBe(0.9)
      expect(proposal?.proposalRef).toBe("events.jsonl#assist-1")

      // The proposal is recorded as its own kind, with what it was about.
      const proposed = episode.events.find((event) => event.kind === "assist.target_proposal")
      expect(proposed).toBeDefined()

      // **Nothing was pressed.** The rung named a control and the run did not
      // touch it: the step's click never happened, there is no policy check for
      // one, and the run ended asking for a person. A proposal that could act
      // would show up here as an action event on the stalled step.
      const clicks = episode.events.filter(
        (event) => event.kind === "action" && event.action === "click"
      )
      expect(clicks).toHaveLength(0)
      expect(episode.result.result).toBe("intervention_required")
    })
  )

  it.live("the same run without assist reaches the same person, with nothing proposed", () =>
    Effect.gen(function* () {
      const episode = yield* attendedReplay({
        artifact: base(),
        inputs: { memberId: MEMBER },
        runId: "tenant-onboarding-unassisted",
        core: { tenant: TENANT },
        operate: (desk) =>
          Effect.gen(function* () {
            yield* desk.awaitPause
            yield* desk.post("/take", { operator: "a.reyes" })
            yield* desk.post("/return", {
              operator: "a.reyes",
              classification: "unresolved",
              detail: "no idea",
              nextTime: "not_asked"
            })
          })
      })

      const record = episode.snapshot.resolved[0]!
      expect(record.intervention.proposal).toBeUndefined()
      expect(record.confirmProposal).toBe("not_asked")
      expect(episode.events.some((event) => event.kind.startsWith("assist."))).toBe(false)

      // The ladder has one shape whether or not the rung is on: same step, same
      // reason, same result class.
      expect(record.intervention.stepId).toBe(SUBMIT_STEP)
      expect(episode.result.result).toBe("intervention_required")
    })
  )

  it("a proposal nobody confirmed writes nothing", () => {
    const asked = confirmedRecord("not_asked")
    const proposal = proposeOverride({ artifact: base(), tenant: TENANT, record: asked, scrub: noScrubbing })
    expect(proposal._tag).toBe("Unchanged")
    if (proposal._tag === "Unchanged") {
      expect(proposal.why).toContain("stays a proposal")
    }
  })

  it("a proposal a person rejected writes nothing, and says so differently", () => {
    const rejected = proposeOverride({
      artifact: base(),
      tenant: TENANT,
      record: confirmedRecord("rejected"),
      scrub: noScrubbing
    })
    expect(rejected._tag).toBe("Unchanged")
    if (rejected._tag === "Unchanged") {
      // A rejection is a result, not an absence. It has to be distinguishable
      // from nobody having been asked, because only one of the two means the
      // system learned something.
      expect(rejected.why).toContain("is not the control this step needs")
    }
  })

  it("an answer that is not a confirmation writes nothing, whatever it says", () => {
    // `ProposalAnswer` has one affirmative spelling, and the two tests above name
    // the other two — but `SessionControl.returnControl` copies
    // `ControlReturn.confirmProposal` onto the record without re-validating it,
    // so a second operator interface, a harness or a `curl` can put any string
    // there. A gate that refuses two known negatives lets every *unknown* answer
    // through, and what it lets through is a durable, append-only Tenant
    // Override whose entire justification is that a person said yes (ADR-0006).
    //
    // The cast is the point of the test: it is how a runtime string that the type
    // says cannot exist reaches the gate.
    const record = {
      ...confirmedRecord("confirmed"),
      confirmProposal: "yes" as unknown as ProposalAnswer
    }
    const odd = proposeOverride({
      artifact: base(),
      tenant: TENANT,
      record,
      scrub: noScrubbing
    })
    expect(odd._tag).toBe("Unchanged")
    if (odd._tag !== "Unchanged") throw new Error("unreachable")
    expect(odd.why).toContain('Only "confirmed" writes an override')

    // And the affirmative still works, so what was refused was the answer and
    // not the episode.
    const confirmed = proposeOverride({
      artifact: base(),
      tenant: TENANT,
      record: confirmedRecord("confirmed"),
      scrub: noScrubbing
    })
    expect(confirmed._tag).toBe("Confirmed")
  })

  it("an episode with no proposal on it can never produce an override", () => {
    const { intervention, ...rest } = confirmedRecord("confirmed")
    const { proposal: _dropped, ...withoutProposal } = intervention
    const nothing = proposeOverride({
      artifact: base(),
      tenant: TENANT,
      record: { ...rest, intervention: withoutProposal },
      scrub: noScrubbing
    })
    // Even with a confirmation on it. Both halves are required: a person typing
    // a control name into a box would be hand-writing an override, which is what
    // ADR-0006 refuses.
    expect(nothing._tag).toBe("Unchanged")
  })

  it("the same episode teaches the capability nothing", () => {
    // Two independent readings of one episode, each with its own gate. Confirming
    // a tenant's label is not a Business Outcome and not an authority-class
    // state, and `classify` says so without being told about tenants at all.
    const amendment = proposeAmendment({
      artifact: base(),
      record: confirmedRecord("confirmed"),
      scrub: noScrubbing
    })
    expect(amendment._tag).toBe("Unchanged")
  })
})

// ---------------------------------------------------------------------------
// 4. A delta, not a copy
// ---------------------------------------------------------------------------

describe("the override is a scoped delta against the base capability", () => {
  it("it changes exactly one field of one step, and nothing else about the document", () => {
    const before = base()
    const after = effectiveFor(storedOverride())

    // Everything except `steps` is identical by value.
    const { steps: beforeSteps, ...beforeRest } = before
    const { steps: afterSteps, ...afterRest } = after
    expect(afterRest).toEqual(beforeRest)

    // And every step except the one is identical too.
    expect(afterSteps).toHaveLength(beforeSteps.length)
    for (let index = 0; index < beforeSteps.length; index += 1) {
      const left = beforeSteps[index]!
      const right = afterSteps[index]!
      if (left.id === SUBMIT_STEP) continue
      expect(right).toEqual(left)
    }

    const changed = afterSteps.find((step) => step.id === SUBMIT_STEP)!
    const original = beforeSteps.find((step) => step.id === SUBMIT_STEP)!
    if (changed.action.type !== "click" || original.action.type !== "click") {
      throw new Error("the submit step is expected to be a click")
    }
    expect(original.action.target.name).toBe("Search")
    expect(changed.action.target.name).toBe("Find")
    // The rest of the Target — its role, its strategy, the reviewer's argument
    // for it — is untouched, so a delta cannot quietly re-scope a control.
    expect({ ...changed.action.target, name: "Search" }).toEqual(original.action.target)
  })

  it("it records how it was discovered and who confirmed it", () => {
    const entry = storedOverride().targets[0]!

    // How: the run that failed, the consultation, and where the proposal is.
    expect(entry.discoveredFrom).toContain("Discovered by replay failing")
    expect(entry.discoveredFrom).toContain("events.jsonl#assist-1")
    expect(entry.discoveredFrom).toContain("confidence 0.90")

    // Who: a named person, the question they were asked, and their own words.
    expect(entry.confirmedBy).toContain("a.reyes")
    expect(entry.confirmedBy).toContain("they answered yes")

    // Both are required by the schema, so a delta with either missing is not a
    // document this system can read.
    const missing = parseOverride("test", [
      "tenant: community-cu",
      "capability: member.account-balance",
      "baseVersion: 1.2.0",
      "targets:",
      "- step: run-member-search",
      "  was: Search",
      "  name: Find",
      "  discoveredFrom: somewhere"
    ].join("\n"))
    expect(Result.isFailure(missing)).toBe(true)
  })

  it("nothing under artifacts/ was written by any of this", () => {
    // The vendor-level capability stays single-sourced (SPEC user story 55), and
    // the cheapest way to check it is to look.
    expect(listVersions(ARTIFACTS_DIRECTORY, CAPABILITY)).toEqual(["1.2.0", "1.1.0", "1.0.0"])
    const submit = base().steps.find((step) => step.id === SUBMIT_STEP)!
    if (submit.action.type !== "click") throw new Error("expected a click")
    expect(submit.action.target.name).toBe("Search")
  })

  it("a delta whose `was` no longer matches is refused rather than applied", () => {
    const stale: TenantOverride = {
      ...storedOverride(),
      targets: [{ ...storedOverride().targets[0]!, was: "Look Up" }]
    }
    const applied = applyOverride(base(), stale)
    expect(Result.isFailure(applied)).toBe(true)
    if (Result.isFailure(applied)) {
      // A delta that could not go stale would be a delta nobody had to
      // re-confirm after the base document changed.
      expect(applied.failure.message).toContain("Re-confirm it")
    }
  })

  it("a second confirmation for the same step is refused, not silently replaced", () => {
    const again = declareTargetOverride(storedOverride(), TENANT, base(), {
      stepId: SUBMIT_STEP,
      was: "Search",
      name: "Go",
      discoveredFrom: "somewhere else",
      confirmedBy: "somebody else"
    }, { scrub: noScrubbing })
    expect(Result.isFailure(again)).toBe(true)
    if (Result.isFailure(again)) {
      expect(again.failure.message).toContain("append-only")
    }
  })

  it("a delta that changes nothing is refused", () => {
    const pointless = declareTargetOverride(undefined, TENANT, base(), {
      stepId: SUBMIT_STEP,
      was: "Search",
      name: "Search",
      discoveredFrom: "d",
      confirmedBy: "c"
    }, { scrub: noScrubbing })
    expect(Result.isFailure(pointless)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. The same capability, both institutions
// ---------------------------------------------------------------------------

describe("the same capability then replays successfully against both", () => {
  it.live("the second tenant, with the confirmed delta in force", () =>
    Effect.gen(function* () {
      const override = storedOverride()
      const outcome = yield* replay({
        artifact: effectiveFor(override),
        inputs: { memberId: MEMBER },
        runId: "tenant-after",
        core: { tenant: TENANT },
        appliedOverride: {
          tenant: TENANT,
          baseVersion: BASE_VERSION,
          source: `${OVERRIDES_DIRECTORY}/${TENANT}/${CAPABILITY}.yaml`,
          entries: override.targets.map((entry) => ({ was: entry.was, name: entry.name }))
        }
      })

      if (outcome.result.result !== "success") {
        throw new Error(`expected success, got ${JSON.stringify(outcome.result)}`)
      }
      expect(outcome.result.outputs["availableBalance"]).toEqual({
        type: "money",
        value: { amount: 4182.55, currency: "USD" }
      })
      // The version is the vendor's, because that is what ran. The delta is
      // recorded beside it rather than folded into the identity of the document.
      expect(outcome.result.version).toBe(BASE_VERSION)

      const applied = outcome.events.find((event) => event.kind === "override.applied")
      expect(applied).toMatchObject({ tenant: TENANT, was: "Search", name: "Find" })
    })
  )

  it.live("the first tenant, with the base document unchanged", () =>
    Effect.gen(function* () {
      const outcome = yield* replay({
        artifact: base(),
        inputs: { memberId: MEMBER },
        runId: "vendor-after",
        core: { tenant: HERITAGE_CORE.key }
      })

      if (outcome.result.result !== "success") {
        throw new Error(`expected success, got ${JSON.stringify(outcome.result)}`)
      }
      // The same two figures, off a screen that labels everything differently
      // and puts them in a frame. Onboarding the second institution changed
      // nothing about the first: no delta, and no `override.applied` event.
      expect(outcome.result.outputs["availableBalance"]).toEqual({
        type: "money",
        value: { amount: 4182.55, currency: "USD" }
      })
      expect(outcome.events.some((event) => event.kind === "override.applied")).toBe(false)
    })
  )
})

// ---------------------------------------------------------------------------
// 6. The boundary the proposal has to stay behind
// ---------------------------------------------------------------------------

describe("a proposed control is data, and the closed list is checked twice", () => {
  const consultation = (
    controls: AssistConsultation["controls"]
  ): AssistConsultation => ({
    capability: `${CAPABILITY}@${BASE_VERSION}`,
    stepId: SUBMIT_STEP,
    stepIntent: "Submit the search and arrive at the member's record.",
    stalled: 'this step could not act: button "Search" was not on the screen',
    question: ASSIST_TARGET_QUESTION,
    url: "http://tenant.invalid/",
    accessibility: "- button \"Find\"",
    candidates: [{ code: "MEMBER_NOT_FOUND", meaning: "no member record exists" }],
    missing: 'button "Search"',
    controls
  })

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

  it.effect("a control the screen does not offer does not get past the schema", () =>
    Effect.gen(function* () {
      const budget = yield* Ref.make(1)
      const outcome = yield* consultAssist(
        {
          advisor: proposingAdvisor("Authorize"),
          gate,
          budget,
          page: "http://tenant.invalid/"
        },
        consultation([{ name: "Find", role: "button", region: "Member Number Search" }])
      )

      // `control` is a `Schema.Literals` over the names read off this screen, so
      // an invented one fails validation inside `generateText` — before this
      // module, and before anybody could be shown it.
      expect(outcome._tag).toBe("NotProposed")
      if (outcome._tag === "NotProposed") {
        expect(outcome.why).toContain("could not classify")
      }
    })
  )

  it.effect("and an advisor that is not a model is checked again on arrival", () =>
    Effect.gen(function* () {
      // The second of the two independent checks, and the one the schema cannot
      // make: an `Advisor` is a port, and an implementation that is not built out
      // of a toolkit can return whatever its type allows. `Selection.ts`
      // duplicates its rule for the same reason — the mistake this prevents is
      // the expensive one, and a person must never be asked to confirm a control
      // nobody can see on the screen.
      const inventing: Advisor = {
        consult: () =>
          Effect.succeed({
            _tag: "TargetProposed",
            proposedControl: "Authorize",
            confidence: 0.99,
            rationale: "invented"
          })
      }
      const budget = yield* Ref.make(1)
      const outcome = yield* consultAssist(
        { advisor: inventing, gate, budget, page: "http://tenant.invalid/" },
        consultation([{ name: "Find", role: "button", region: "Member Number Search" }])
      )

      expect(outcome._tag).toBe("NotProposed")
      if (outcome._tag === "NotProposed") {
        expect(outcome.why).toContain("this screen does not offer")
      }
    })
  )

  it.effect("a consultation with no controls on offer cannot receive a proposed control", () =>
    Effect.gen(function* () {
      const budget = yield* Ref.make(1)
      const outcome = yield* consultAssist(
        { advisor: proposingAdvisor(), gate, budget, page: "http://tenant.invalid/" },
        consultation([])
      )
      // This is the shape of every consultation about a Checkpoint that would not
      // hold: no control was named, so no correspondent can be proposed, and the
      // `proposeTarget` tool is not in the toolkit that consultation is sent.
      expect(outcome._tag).toBe("NotProposed")
    })
  )

  it.effect("a proposal below the confidence floor is recorded and refused", () =>
    Effect.gen(function* () {
      const budget = yield* Ref.make(1)
      const recorded: Array<string> = []
      const outcome = yield* consultAssist(
        {
          advisor: proposingAdvisor("Find", 0.4),
          gate: { ...gate, record: (body) => Effect.sync(() => void recorded.push(body.kind)) },
          budget,
          page: "http://tenant.invalid/"
        },
        consultation([{ name: "Find", role: "button", region: "Member Number Search" }])
      )

      expect(outcome._tag).toBe("NotProposed")
      // Recorded *and* visibly refused. A log that kept only the proposals that
      // cleared the floor would make the floor invisible.
      expect(recorded).toContain("assist.target_proposal")
    })
  )
})

// ---------------------------------------------------------------------------

/**
 * A closed episode of exactly the shape the second tenant produces, for the
 * table tests that need no browser.
 */
const confirmedRecord = (confirmProposal: "confirmed" | "rejected" | "not_asked") => ({
  intervention: {
    capability: CAPABILITY,
    version: BASE_VERSION,
    runId: "run",
    stepId: SUBMIT_STEP,
    stepIntent: "Submit the search and arrive at the member's record.",
    reason: 'this step could not act: button "Search" was not on the screen',
    detail: "nothing matched",
    url: "http://tenant.invalid/",
    accessibility: "- button \"Find\"",
    proposal: {
      forTarget: 'button "Search"',
      control: "Find",
      confidence: 0.9,
      rationale: "the search panel's only submit control reads Find",
      proposalRef: "events.jsonl#assist-1"
    },
    interventionId: "session-intervention-1",
    sessionId: "session",
    raisedAt: "2026-08-27T00:00:00.000Z"
  },
  operator: "a.reyes",
  tookControlAt: "2026-08-27T00:00:10.000Z",
  actions: [],
  returnedAt: "2026-08-27T00:00:20.000Z",
  classification: "unresolved" as const,
  detail: "this installation labels the submit control Find",
  nextTime: "not_asked" as const,
  confirmProposal
})
