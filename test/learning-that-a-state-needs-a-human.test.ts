/**
 * A Capability learning that a state permanently needs a person.
 *
 * The other half of learning, and the half that must never go wrong. Member
 * `77777`'s savings account sits under a supervisor hold. Everything up to the
 * last screen behaves exactly as it does for a normal member; the panel inside
 * the iframe then refuses, correctly, and the figures the automation came for are
 * not on the page at all.
 *
 * Nothing about that is broken, and nothing about it is a domain answer either.
 * Getting past it takes **authority**, not perception — so no amount of waiting,
 * no cleverer target and no model reading the screen resolves it. That is what
 * separates it from a Recoverable Condition and from a Business Outcome, and it
 * is the reason the classification cannot come from the screen.
 *
 * The arc under test, end to end and in a real browser:
 *
 *   1. Before learning, the run escalates under a generic reason — a checkpoint
 *      that would not hold — and unattended it is a Hard Failure.
 *   2. An Operator takes control and resolves it by *acting*: a supervisor id, an
 *      authorization code, and Authorize, in the automation's own browser window.
 *   3. At return-of-control they answer the one question with "always stop here".
 *   4. That they had to act is what makes the class `requires_human`, and it is
 *      the half of the decision nobody can fake with a radio button (ADR-0004).
 *   5. Confirming emits a new version declaring the state as always-escalating.
 *   6. Replaying afterwards stops immediately, under a declared code, with the
 *      sentence somebody who already solved it wrote — and never proceeds.
 *   7. No later Intervention can downgrade it, however many times it is resolved.
 *
 * The stored `1.2.0` is that run's output. `test/support/drive-the-supervisor-hold.ts`
 * is what produced it, and `evidence/learning/77777-supervisor-hold/` is what it
 * wrote down.
 *
 * `it.live` for anything touching a browser: checkpoint evaluation polls with
 * `Effect.sleep`, and under `@effect/vitest`'s TestClock those never come back.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { expect } from "vitest"
import {
  type CapabilityArtifact,
  atLeastAsStrictAs,
  catalogEntry,
  classificationOf,
  declareLearnedNoMatch,
  declareRequiresHuman,
  describeCatalogEntry,
  diffArtifacts,
  formatArtifact,
  loadArtifact,
  parseArtifact,
  requiresHumanAtStep,
  requiresHumanCode,
  writeArtifact
} from "@cua/artifact"
import { type InterventionRecord, type NextTimeAnswer, classify } from "@cua/session"
import { proposeAmendment } from "@cua/replay"
import { attendedReplay } from "./support/handoff-harness.ts"
import { replay, shippedArtifact } from "./support/replay-harness.ts"

/** Ticket 14's member: a savings account held pending supervisor authorization. */
const RESTRICTED = "77777"
const HELD_STEP = "open-account"
const CODE = "OPEN_ACCOUNT_REQUIRES_HUMAN"

/** The version from before anybody had met this state. */
const beforeLearning = (): CapabilityArtifact => shippedArtifact(undefined, "1.1.0")
/** The version the intervention taught. */
const afterLearning = (): CapabilityArtifact => shippedArtifact(undefined, "1.2.0")

/** A minimal closed record, for the table tests that need no browser. */
const record = (over: Partial<InterventionRecord> = {}): InterventionRecord => ({
  intervention: {
    capability: "member.account-balance",
    version: "1.1.0",
    runId: "run",
    stepId: HELD_STEP,
    stepIntent: "Open the account the caller asked for.",
    reason: 'the checkpoint "account detail is showing" did not hold',
    detail: "expected the Available Balance cell; observed nothing matching",
    url: "http://example.invalid/account",
    accessibility: "- table:",
    interventionId: "session-intervention-1",
    sessionId: "session",
    raisedAt: "2026-08-27T00:00:00.000Z"
  },
  operator: "r.mensah",
  tookControlAt: "2026-08-27T00:00:10.000Z",
  actions: [{ at: "2026-08-27T00:00:15.000Z", detail: "entered supervisor override" }],
  returnedAt: "2026-08-27T00:00:20.000Z",
  classification: "resolved",
  detail: "released the hold as an authorized supervisor",
  nextTime: "always_stop_here",
  ...over
})

// ---------------------------------------------------------------------------
// The classification, and the half of it nobody can fake
// ---------------------------------------------------------------------------

it("derives requires-human from acting, not from the answer alone", () => {
  const acted = classify(record())
  expect(acted._tag === "Learned" && acted.learnedClass).toBe("requires_human")
  if (acted._tag !== "Learned") throw new Error("unreachable")
  expect(acted.because).toContain("acting on the live session")

  // Same answer, nothing done: not a finding. Having shown the state is
  // observational and then declining to let automation observe it is a
  // preference, and a requires-human entry can never be downgraded afterwards,
  // so it is not written on the strength of one.
  expect(classify(record({ actions: [] }))._tag).toBe("NothingLearned")
})

it("cannot be talked into a business outcome by anybody who had to act", () => {
  // The unfakeability claim, stated as a property rather than an example. With
  // the actions non-empty, *no* answer to the one question produces the class
  // that would let automation handle this state itself. The declarable half of
  // the classification comes from behaviour the system recorded without asking,
  // and the question only resolves the ambiguity behaviour leaves (ADR-0004).
  const answers: ReadonlyArray<NextTimeAnswer> = [
    "automation_handles_it",
    "always_stop_here",
    "not_asked"
  ]

  for (const nextTime of answers) {
    const learned = classify(record({ nextTime }))
    expect(learned._tag === "Learned" && learned.learnedClass).not.toBe("business_outcome")
  }

  // And the same over the whole product of the two inputs: exactly one cell of
  // ADR-0004's table is a business outcome, and it is the one where nothing was
  // done at all.
  const declarable = answers.flatMap((nextTime) =>
    [[], record().actions].flatMap((actions) => {
      const learned = classify(record({ nextTime, actions }))
      return learned._tag === "Learned" && learned.learnedClass === "business_outcome"
        ? [{ nextTime, acted: actions.length > 0 }]
        : []
    })
  )
  expect(declarable).toEqual([{ nextTime: "automation_handles_it", acted: false }])
})

// ---------------------------------------------------------------------------
// The one-way rule
// ---------------------------------------------------------------------------

it("reads the stored requires-human entry as the strictest classification there is", () => {
  const learned = afterLearning()

  expect(classificationOf(learned, CODE)).toBe("requires_human")
  expect(classificationOf(learned, "NO_MATCHING_ITEM")).toBe("business_outcome")
  expect(classificationOf(learned, "NOTHING_HAS_EVER_SAID_THIS")).toBeUndefined()

  // The ratchet, in the one direction SPEC actually names.
  expect(atLeastAsStrictAs("business_outcome", classificationOf(learned, CODE))).toBe(false)
  expect(atLeastAsStrictAs("recoverable", classificationOf(learned, CODE))).toBe(false)
  expect(atLeastAsStrictAs("requires_human", classificationOf(learned, CODE))).toBe(true)
})

/**
 * A readable document in which the state a selection escalates under is *also* a
 * state somebody has classified as needing a person.
 *
 * Contrived only in that both halves rarely land on one code. Nothing about it is
 * malformed — it parses, its references resolve — and that is the point: this is
 * the document a downgrade would have to be attempted against, so the attempt is
 * made against a real one rather than against an object built to fail.
 */
const alreadyRequiresAPerson = (): CapabilityArtifact => {
  const base = shippedArtifact(undefined, "1.0.0")
  const artifact: CapabilityArtifact = {
    ...base,
    version: "1.3.0",
    requiresHuman: {
      NO_MATCHING_ITEM: {
        step: HELD_STEP,
        title: "A person with authority is required.",
        summary: "somebody had to act to get past this",
        discoveredFrom: "an earlier intervention in which the operator acted"
      }
    }
  }

  // Round-tripped, so what the downgrade is attempted against is a document a
  // reviewer could have read off disk rather than a value held in memory.
  const reparsed = parseArtifact("downgrade-fixture", formatArtifact(artifact))
  if (Result.isFailure(reparsed)) throw new Error(reparsed.failure.message)
  return reparsed.success
}

it("refuses to downgrade a requires-human state into a business outcome", () => {
  const artifact = alreadyRequiresAPerson()
  expect(classificationOf(artifact, "NO_MATCHING_ITEM")).toBe("requires_human")

  const downgrade = declareLearnedNoMatch(artifact, {
    version: "1.4.0",
    stepId: HELD_STEP,
    title: "nothing on offer matched",
    summary: "a later operator saying this is just an answer",
    discoveredFrom: "a later episode"
  })

  expect(Result.isFailure(downgrade)).toBe(true)
  if (!Result.isFailure(downgrade)) throw new Error("unreachable")
  expect(downgrade.failure.message).toContain("already classified as requires_human")
  expect(downgrade.failure.message).toContain("can never be downgraded to a business outcome")

  // And the refusal changed nothing: the entry is still there and still says
  // what it said. An Amendment is a pure function, so this is true by
  // construction — asserting it is what stops that quietly stopping being true.
  expect(classificationOf(artifact, "NO_MATCHING_ITEM")).toBe("requires_human")
})

it("refuses the same downgrade however many times somebody resolves the state", () => {
  // SPEC: "no later intervention can downgrade one to `business_outcome`."
  // Frequency is not evidence of safety, so the hundredth episode reaches the
  // same refusal as the first — there is no counter, no threshold, and no
  // parameter anywhere that could be turned up to get past it.
  const artifact = alreadyRequiresAPerson()

  // An episode of exactly the shape that *did* teach `88888` a business outcome:
  // an operator who observed the screen, changed nothing, and said automation
  // should handle it. Against this document it is refused, and the reason is not
  // the episode — it is what the document already says.
  const observed = record({
    actions: [],
    nextTime: "automation_handles_it",
    classification: "unresolved"
  })
  expect(classify(observed)._tag === "Learned" && classify(observed)).toMatchObject({
    learnedClass: "business_outcome"
  })

  const refusals = Array.from({ length: 100 }, () =>
    proposeAmendment({ artifact, record: observed, version: "1.4.0" })
  )
  expect(refusals.every((proposal) => proposal._tag === "Refused")).toBe(true)
  const first = refusals[0]!
  if (first._tag !== "Refused") throw new Error("unreachable")
  expect(first.refusal.message).toContain("can never be downgraded")
})

it("refuses to write the same requires-human entry twice", () => {
  // Write-once, and the refusal says so rather than silently producing a version
  // identical to the one before it.
  const again = declareRequiresHuman(afterLearning(), {
    version: "1.9.0",
    stepId: HELD_STEP,
    title: "t",
    summary: "s",
    discoveredFrom: "d"
  })

  expect(Result.isFailure(again)).toBe(true)
  if (!Result.isFailure(again)) throw new Error("unreachable")
  expect(again.failure.message).toContain("write-once")
})

it("refuses to amend a version into itself, or to classify a step that is not there", () => {
  const before = beforeLearning()

  const sameVersion = declareRequiresHuman(before, {
    version: before.version,
    stepId: HELD_STEP,
    title: "t",
    summary: "s",
    discoveredFrom: "d"
  })
  expect(Result.isFailure(sameVersion)).toBe(true)
  if (!Result.isFailure(sameVersion)) throw new Error("unreachable")
  expect(sameVersion.failure.message).toContain("diffed")

  const noSuchStep = declareRequiresHuman(before, {
    version: "1.9.0",
    stepId: "a-step-nobody-wrote",
    title: "t",
    summary: "s",
    discoveredFrom: "d"
  })
  expect(Result.isFailure(noSuchStep)).toBe(true)
})

it("refuses an entry carrying a value the run treats as sensitive", () => {
  // Held to exactly the rule ticket 13's amendment is: what this run's evidence
  // would redact, its artifact refuses to carry (ADR-0008). An operator typing
  // the member number into the detail box is an entirely reasonable thing for
  // them to do and an entirely unacceptable thing to commit.
  const scrub = (text: string): string => text.replaceAll(RESTRICTED, "[redacted:memberId]")

  const refused = declareRequiresHuman(
    beforeLearning(),
    {
      version: "1.9.0",
      stepId: HELD_STEP,
      title: "a person is required",
      summary: `the operator wrote: released the hold on member ${RESTRICTED}`,
      discoveredFrom: "an episode"
    },
    { scrub }
  )

  expect(Result.isFailure(refused)).toBe(true)
  if (!Result.isFailure(refused)) throw new Error("unreachable")
  // The refusal does not repeat what it found.
  expect(refused.failure.message).not.toContain(RESTRICTED)
  expect(refused.failure.message).toContain("ADR-0008")

  const accepted = declareRequiresHuman(
    beforeLearning(),
    {
      version: "1.9.0",
      stepId: HELD_STEP,
      title: "a person is required",
      summary: "the operator wrote: released the hold on this member's account",
      discoveredFrom: "an episode"
    },
    { scrub }
  )
  expect(Result.isSuccess(accepted)).toBe(true)
})

// ---------------------------------------------------------------------------
// The document, and what a reviewer can check by reading it
// ---------------------------------------------------------------------------

it("refuses a document that classifies one code twice, or one step twice", () => {
  // The write-once rule is a property of the *artifact*, not of the mechanism
  // that happened to produce one, so a hand-edited document is held to it too.
  const base = shippedArtifact(undefined, "1.1.0")
  const entry = {
    step: HELD_STEP,
    title: "t",
    summary: "s",
    discoveredFrom: "d"
  }

  // A code in both sections is a downgrade half-performed.
  const bothWays = parseArtifact(
    "both-ways",
    formatArtifact({
      ...base,
      version: "1.9.0",
      requiresHuman: { NO_MATCHING_ITEM: entry }
    })
  )
  expect(Result.isFailure(bothWays)).toBe(true)
  if (!Result.isFailure(bothWays)) throw new Error("unreachable")
  expect(bothWays.failure.message).toContain("also declared as a business outcome")

  // Two entries for one step: which one applies would depend on key order.
  const twice = parseArtifact(
    "twice",
    formatArtifact({
      ...base,
      version: "1.9.0",
      requiresHuman: { FIRST_ONE: entry, SECOND_ONE: entry }
    })
  )
  expect(Result.isFailure(twice)).toBe(true)

  // An entry naming a step this capability does not have.
  const nowhere = parseArtifact(
    "nowhere",
    formatArtifact({
      ...base,
      version: "1.9.0",
      requiresHuman: { SOMEWHERE_REQUIRES_HUMAN: { ...entry, step: "not-a-step" } }
    })
  )
  expect(Result.isFailure(nowhere)).toBe(true)
})

it("names the state from the step, and from nothing anybody typed", () => {
  // Ticket 13's precedent taken to its limit. There was no authored code for a
  // checkpoint that fails, so one is derived — from the step id and the class,
  // both already in the document — rather than asked for. Whoever is on shift
  // does not get to rename a capability's vocabulary on the strength of ten
  // seconds at a terminal.
  expect(requiresHumanCode(HELD_STEP)).toBe(CODE)
  expect(requiresHumanCode("read-available-balance")).toBe("READ_AVAILABLE_BALANCE_REQUIRES_HUMAN")

  const entry = afterLearning().requiresHuman?.[CODE]
  expect(entry?.step).toBe(HELD_STEP)
  // The title is built from the step's own intent, which is the artifact
  // author's sentence about what this step is for.
  expect(entry?.title).toContain(
    afterLearning().steps.find((step) => step.id === HELD_STEP)!.intent.replace(/\.$/, "")
  )
})

it("tells a calling agent that this capability has a state it will never handle", () => {
  // The catalog is the agent-facing view of what exists, and an agent deciding
  // whether to invoke this unattended needs both halves of the contract: what it
  // may be *returned*, and where it may be stopped needing a person. Listing the
  // first without the second would be a contract with the expensive half missing.
  const entry = catalogEntry(afterLearning(), ["1.2.0", "1.1.0", "1.0.0"])

  expect(entry.escalations).toEqual([
    {
      code: CODE,
      title: afterLearning().requiresHuman?.[CODE]?.title,
      step: HELD_STEP
    }
  ])
  // And kept apart from the outcomes, which is where the write-once rule is
  // visible even from here: a code is in one list or the other, never in both.
  expect(entry.outcomes.map((outcome) => outcome.code)).toEqual([
    "MEMBER_NOT_FOUND",
    "NO_MATCHING_ITEM"
  ])

  const rendered = describeCatalogEntry(entry)
  expect(rendered).toContain("or, stopping for a person (learned, and never automated)")
  expect(rendered).toContain(CODE)

  // The version before it says nothing of the kind, because nobody had met it.
  expect(catalogEntry(beforeLearning(), ["1.1.0"]).escalations).toEqual([])
})

it("diffing the two versions shows an addition and nothing else at all", () => {
  const diff = diffArtifacts(beforeLearning(), afterLearning())

  expect(diff).toContain("+requiresHuman:")
  expect(diff).toContain(`+  ${CODE}:`)
  expect(diff).toContain("+    step: open-account")
  expect(diff).toContain("Learned from intervention")

  // The whole argument, in one assertion. Every *removed* line is the version
  // number and nothing else: learning that a state needs a person took no step,
  // no target, no bound and no declared outcome away, and added no way for the
  // capability to get past anything. Ticket 13's diff removed the escalation
  // that became an answer; this one removes nothing, because nothing became
  // anything — a state that already stopped the run now stops it by name.
  const removed = diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"))
  expect(removed).toEqual(["-version: 1.1.0"])

  // And no business outcome appeared. This is the assertion that would fail if
  // the two halves of learning were ever wired to the same section.
  expect(diff).not.toContain("+  NO_MATCHING_ITEM:")
})

// ---------------------------------------------------------------------------
// The arc, in a real browser
// ---------------------------------------------------------------------------

it.live("before learning, an unattended run reports a generic hard failure", () =>
  Effect.gen(function* () {
    // What this looks like to a caller with nobody watching: something broke,
    // page an engineer. It is the wrong answer, and it is the best answer
    // available before anybody has met the state.
    const { result } = yield* replay({
      artifact: beforeLearning(),
      inputs: { memberId: RESTRICTED }
    })

    if (result.result !== "failure") throw new Error(`expected a failure, got ${result.result}`)
    expect(result.failure.reason).toBe("checkpoint_failed")
    expect(result.failure.stepId).toBe(HELD_STEP)
    expect(result.failure.expected).toContain("Available Balance")
    // Nothing in it names the state. A person reading this has a diagnosis to
    // perform, which is exactly what the amendment removes.
    expect(JSON.stringify(result)).not.toContain(CODE)
  })
)

it.live(
  "an operator who resolves it with authority teaches the capability to always stop here",
  () =>
    Effect.gen(function* () {
      const before = beforeLearning()

      // ---------------------------------------------------------------
      // 1 and 2. The run escalates, and a person resolves it by acting.
      // ---------------------------------------------------------------
      const episode = yield* attendedReplay({
        artifact: before,
        inputs: { memberId: RESTRICTED },
        runId: "authority",
        operate: (desk) =>
          Effect.gen(function* () {
            const paused = yield* desk.awaitPause

            // Before learning, this is all the Operator is told: a checkpoint
            // that would not hold, and an expected/observed pair.
            expect(paused.pending?.intervention.stepId).toBe(HELD_STEP)
            expect(paused.pending?.intervention.reason).toContain("did not hold")
            expect(paused.pending?.intervention.accessibility).toContain(
              "SUPERVISOR AUTHORIZATION REQUIRED"
            )

            yield* desk.post("/take", { operator: "r.mensah" })

            // The authority, in the automation's own browser window. Three
            // gestures no capability has any business performing by itself.
            yield* desk.surface.fill({ role: "textbox", name: "Supervisor ID" }, "SUP7")
            yield* desk.surface.fill({ role: "textbox", name: "Authorization Code" }, "4417")
            yield* desk.surface.click({ role: "button", name: "Authorize" })
            yield* desk.post("/note", { detail: "entered supervisor override for SUP-HOLD-02" })

            // 3. The one question, and the answer that separates rows two and
            // three of ADR-0004's table. `resolved` and `always_stop_here`
            // together, which is the pair a single field could not express: this
            // run can carry on, *because a person acted*, and the state must
            // nevertheless always stop for one.
            yield* desk.post("/return", {
              operator: "r.mensah",
              classification: "resolved",
              detail: "released the supervisor hold as an authorized supervisor",
              nextTime: "always_stop_here"
            })
          })
      })

      // The run finished, and it finished because a person with authority was
      // there. That is what makes the lesson worth learning rather than obvious.
      expect(episode.result.result).toBe("success")

      const closed = episode.snapshot.resolved[0]
      if (closed === undefined) throw new Error("no closed intervention")
      expect(closed.nextTime).toBe("always_stop_here")
      // Non-empty, and this is the load-bearing fact: it was recorded because
      // they did something, not because they said something.
      expect(closed.actions).toHaveLength(1)

      // ---------------------------------------------------------------
      // 4 and 5. A new version, declaring the state as always-escalating.
      // ---------------------------------------------------------------
      const proposal = proposeAmendment({ artifact: before, record: closed })
      if (proposal._tag !== "Amended") {
        throw new Error(`expected an amendment, got ${proposal._tag}`)
      }
      expect(proposal.learnedClass).toBe("requires_human")
      expect(proposal.amended.version).toBe("1.2.0")

      // Nothing a caller can be *returned* was added. The capability learned
      // where it must stop, not a new answer it may give.
      expect(proposal.amended.outcomes).toEqual(before.outcomes)
      expect(proposal.amended.steps).toEqual(before.steps)

      const store = mkdtempSync(join(tmpdir(), "cua-requires-human-"))
      try {
        expect(Result.isSuccess(writeArtifact(store, before))).toBe(true)
        const written = writeArtifact(store, proposal.amended)
        if (Result.isFailure(written)) throw new Error(written.failure.message)
        // Immutable: the same version refuses to be written twice.
        expect(Result.isFailure(writeArtifact(store, proposal.amended))).toBe(true)

        const reloaded = loadArtifact(store, before.capability, proposal.amended.version)
        if (Result.isFailure(reloaded)) throw new Error(reloaded.failure.message)

        const declared = requiresHumanAtStep(reloaded.success, HELD_STEP)
        expect(declared?.code).toBe(CODE)
        expect(declared?.declaration.discoveredFrom).toContain(closed.intervention.interventionId)
        expect(declared?.declaration.discoveredFrom).toContain("r.mensah")
        expect(declared?.declaration.discoveredFrom).toContain("1 action(s) on the live session")
        expect(declared?.declaration.discoveredFrom).toContain("they answered no")

        // 1.1.0 in the store is untouched.
        const original = loadArtifact(store, before.capability, "1.1.0")
        if (Result.isFailure(original)) throw new Error(original.failure.message)
        expect(original.success.requiresHuman).toBeUndefined()

        // ---------------------------------------------------------------
        // 6. And the payoff: the same member, unattended, stopping at once
        //    under a name instead of reporting that something is broken.
        // ---------------------------------------------------------------
        const after = yield* replay({
          artifact: reloaded.success,
          inputs: { memberId: RESTRICTED },
          runId: "after-learning"
        })

        if (after.result.result !== "intervention_required") {
          throw new Error(`expected an intervention, got ${after.result.result}`)
        }
        // The routing. `intervention_required` means "a person is needed", and
        // that is now an answer the system knows rather than one it guesses —
        // so it is honest even with nobody watching. Before learning, the same
        // run said `failure`, which means "page an engineer".
        expect(after.result.code).toBe(CODE)
        expect(after.result.stepId).toBe(HELD_STEP)
        // The reason. Not "a checkpoint did not hold": the sentence somebody who
        // already solved this wrote down, under the code a caller routes on.
        expect(after.result.reason).toBe(declared?.declaration.title)
        expect(after.result.reason).toContain("A person with authority is required")
        expect(after.result.accessibility).toContain("SUPERVISOR AUTHORIZATION REQUIRED")

        // It never proceeds. No outputs, no business outcome, and the run
        // abandoned at the step that stopped it — the two reading steps were
        // never attempted at all.
        expect(after.result.steps.map((step) => `${step.id}:${step.checkpoint}`)).toEqual([
          "open-member-search:held",
          "enter-member-number:held",
          "run-member-search:held",
          "open-account:failed"
        ])
        expect(JSON.stringify(after.result)).not.toContain("availableBalance")

        // Nobody was paused and nobody was summoned: there was nobody there. An
        // Intervention is an episode in which a person takes the session, and no
        // episode happened — the run reported that one is required and stopped.
        expect(after.events.filter((event) => event.kind.startsWith("intervention."))).toEqual([])

        // And no remedy loop ran. Every declared rule looked once, recognised
        // nothing, and the classified entry answered instead of a person having
        // to. What the classification saves is the diagnosis.
        expect(after.events.filter((event) => event.kind.startsWith("recovery."))).toEqual([])

        const end = after.events.find((event) => event.kind === "run.end")
        expect(end && end.kind === "run.end" ? end.result : undefined).toBe(
          "intervention_required"
        )
      } finally {
        rmSync(store, { recursive: true, force: true })
      }
    }),
  90_000
)

it.live("at the learned version it still escalates to a person, and they can still resolve it", () =>
  Effect.gen(function* () {
    // Learning it did not take the person away. An Operator with authority who
    // is actually there gets the session, gets told what they are looking at
    // *by name*, and the run finishes because of them — which is the whole
    // difference between "escalate with a reason" and "give up".
    const outcome = yield* attendedReplay({
      artifact: afterLearning(),
      inputs: { memberId: RESTRICTED },
      runId: "learned-and-attended",
      operate: (desk) =>
        Effect.gen(function* () {
          const paused = yield* desk.awaitPause

          // The payoff at the operator interface: a code and a sentence somebody
          // wrote, rather than an expected/observed pair to interpret.
          const raised = paused.pending!.intervention
          expect(raised.reason).toBe(afterLearning().requiresHuman?.[CODE]?.title)
          expect(raised.detail).toContain("permissions problem")
          expect(raised.detail).toContain("The checkpoint that reached it")

          yield* desk.post("/take", { operator: "r.mensah" })
          yield* desk.surface.fill({ role: "textbox", name: "Supervisor ID" }, "SUP7")
          yield* desk.surface.fill({ role: "textbox", name: "Authorization Code" }, "4417")
          yield* desk.surface.click({ role: "button", name: "Authorize" })
          yield* desk.post("/note", { detail: "entered supervisor override again" })
          yield* desk.post("/return", {
            operator: "r.mensah",
            classification: "resolved",
            detail: "released the hold again",
            nextTime: "always_stop_here"
          })
        })
    })

    expect(outcome.result.result).toBe("success")

    // And the second episode teaches nothing new: the document already says it.
    const closed = outcome.snapshot.resolved[0]!
    const proposal = proposeAmendment({ artifact: afterLearning(), record: closed })
    expect(proposal._tag).toBe("Refused")
    if (proposal._tag !== "Refused") throw new Error("unreachable")
    expect(proposal.refusal.message).toContain("write-once")
  }),
  60_000
)

it.live("a declared recoverable condition met at the same step still recovers unattended", () =>
  Effect.gen(function* () {
    // The regression this classification could most easily have caused. The
    // requires-human entry is keyed by *step*, and `open-account` is also where
    // a mid-flow session expiry strands a run — so a rung placed above recovery
    // would have traded a real unattended recovery for the appearance of failing
    // faster. It sits below: every declared rule looks first, and one that
    // recognises the screen still clears it.
    const { result } = yield* replay({
      artifact: afterLearning(),
      // The same arrangement `test/recoverable-conditions.test.ts` uses: the
      // toggle fires on the second page request, which is the one that opens the
      // account, and the artifact's own SESSION_EXPIRED rule signs back on.
      inputs: { memberId: "12345", operatorPassword: "HERITAGE" },
      core: { expireSessionAfter: 2 }
    })

    if (result.result !== "success") throw new Error(`expected success, got ${result.result}`)
    const stranded = result.steps.find((step) => step.id === HELD_STEP)
    expect(stranded?.recovered).toBe("SESSION_EXPIRED")
    expect(stranded?.checkpoint).toBe("held")
  })
)

it.live("the capability still does its job for everybody else", () =>
  Effect.gen(function* () {
    // What was declared is a state, not a member and not a step. A normal member
    // still returns two balances at the learned version, and `77777`'s *checking*
    // account — which carries no hold — still returns its own.
    const normal = yield* replay({
      artifact: afterLearning(),
      inputs: { memberId: "12345" }
    })
    if (normal.result.result !== "success") {
      throw new Error(`expected success, got ${normal.result.result}`)
    }
    expect(normal.result.outputs["availableBalance"]).toEqual({
      type: "money",
      value: { amount: 4182.55, currency: "USD" }
    })

    const unheld = yield* replay({
      artifact: afterLearning(),
      inputs: { memberId: RESTRICTED, accountType: "Checking" },
      runId: "unheld"
    })
    if (unheld.result.result !== "success") {
      throw new Error(`expected success, got ${unheld.result.result}`)
    }
    expect(unheld.result.outputs["availableBalance"]).toEqual({
      type: "money",
      value: { amount: 318.42, currency: "USD" }
    })
  }),
  60_000
)

// ---------------------------------------------------------------------------
// The two lessons, side by side
// ---------------------------------------------------------------------------

it("is the same mechanism reaching opposite conclusions", () => {
  // The submission's central demonstration, as an assertion. One question, one
  // amendment mechanism, one ratchet — and two versions of one capability that
  // say opposite things, because two people did different things to resolve what
  // they met.
  const observed = record({
    intervention: { ...record().intervention, stepId: HELD_STEP },
    actions: [],
    nextTime: "automation_handles_it",
    classification: "unresolved"
  })
  const acted = record()

  const outcome = proposeAmendment({ artifact: shippedArtifact(undefined, "1.0.0"), record: observed })
  const human = proposeAmendment({ artifact: beforeLearning(), record: acted })

  if (outcome._tag !== "Amended" || human._tag !== "Amended") {
    throw new Error("expected two amendments")
  }
  expect(outcome.learnedClass).toBe("business_outcome")
  expect(human.learnedClass).toBe("requires_human")

  // The business outcome added something a run may *return*. The requires-human
  // entry added something a run must *stop* on, and took nothing away.
  expect(Object.keys(outcome.amended.outcomes ?? {})).toContain("NO_MATCHING_ITEM")
  expect(outcome.amended.requiresHuman).toBeUndefined()
  expect(Object.keys(human.amended.requiresHuman ?? {})).toEqual([CODE])
  expect(human.amended.outcomes).toEqual(beforeLearning().outcomes)

  // And the difference between them is not the question. It is what the person
  // did before answering it.
  expect(observed.nextTime).not.toBe(acted.nextTime)
  expect(observed.actions).toHaveLength(0)
  expect(acted.actions.length).toBeGreaterThan(0)
})
