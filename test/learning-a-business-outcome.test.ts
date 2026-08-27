/**
 * A Capability learning its own domain contract.
 *
 * Member `88888` exists and holds a checking account. It holds no savings
 * account, so the row the Capability came for is simply not on the screen. That
 * looks exactly like breakage and is not: the UI is fine, the list rendered in
 * full, and the domain said no. The brief calls confusing one for the other the
 * most common design mistake in this problem, and nothing on the page
 * distinguishes them — which is why the distinction cannot be perceived and has
 * to be *learned* from what a person did when they met it.
 *
 * The arc under test, end to end and in a real browser:
 *
 *   1. The first replay escalates instead of reporting a hard failure.
 *   2. An Operator takes control, looks, touches nothing, and hands it back.
 *   3. At return-of-control the interface asks one question, and they answer it.
 *   4. That they resolved it *without acting* is the evidence the state is
 *      terminal and observational, so it is declarable (ADR-0004).
 *   5. Confirming emits a new version declaring the outcome, linked to the
 *      Intervention record that justified it.
 *   6. Replaying afterwards returns the business outcome with nobody involved.
 *
 * `it.live` for anything touching a browser: checkpoint evaluation polls with
 * `Effect.sleep`, and under `@effect/vitest`'s TestClock those never come back.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { expect } from "vitest"
import {
  type CapabilityArtifact,
  ActionSchema,
  atLeastAsStrictAs,
  classificationOf,
  declareLearnedNoMatch,
  diffArtifacts,
  formatArtifact,
  loadArtifact,
  nextMinorVersion,
  noMatchCode,
  noMatchOutcome,
  parseArtifact,
  writeArtifact
} from "@cua/artifact"
import { type InterventionRecord, classify } from "@cua/session"
import { noScrubbing } from "@cua/evidence"
import { proposeAmendment } from "@cua/replay"
import { attendedReplay } from "./support/handoff-harness.ts"
import { replay, shippedArtifact } from "./support/replay-harness.ts"

/** Ticket 13's member: a checking account, and nothing else. */
const CHECKING_ONLY = "88888"

/** The version from before anybody had met this state. */
const beforeLearning = (): CapabilityArtifact => shippedArtifact(undefined, "1.0.0")

/** A minimal closed record, for the table tests that need no browser. */
const record = (over: Partial<InterventionRecord> = {}): InterventionRecord => ({
  intervention: {
    capability: "member.account-balance",
    version: "1.0.0",
    runId: "run",
    stepId: "open-account",
    stepIntent: "Open the account the caller asked for.",
    reason: "this step could not act",
    detail: "nothing on offer matched",
    url: "http://example.invalid/member",
    accessibility: "- table:",
    interventionId: "session-intervention-1",
    sessionId: "session",
    raisedAt: "2026-08-27T00:00:00.000Z"
  },
  operator: "j.okafor",
  tookControlAt: "2026-08-27T00:00:10.000Z",
  actions: [],
  returnedAt: "2026-08-27T00:00:20.000Z",
  classification: "unresolved",
  detail: "there is no such account to open",
  nextTime: "automation_handles_it",
  // No consultation proposed a control in these episodes, so the second
  // question never came up. Ticket 16.
  confirmProposal: "not_asked",
  ...over
})

// ---------------------------------------------------------------------------
// ADR-0004's table, which is the whole classification mechanism
// ---------------------------------------------------------------------------

it("derives what was learned from what the operator did, not from what they were asked", () => {
  // Row one, and the row this ticket is built on. Nothing done, and the person
  // who resolved it says automation should handle it: the state is terminal and
  // observational, so it is declarable.
  const observed = classify(record({ actions: [], nextTime: "automation_handles_it" }))
  expect(observed._tag === "Learned" && observed.learnedClass).toBe("business_outcome")

  // Row two. The same answer to the same question, and a different class —
  // because they *acted*. What automation would handle is the remedy they
  // performed, which is a recovery rule rather than an outcome.
  const acted = classify(
    record({
      actions: [{ at: "2026-08-27T00:00:15.000Z", detail: "entered supervisor override", redacted: [] }],
      nextTime: "automation_handles_it"
    })
  )
  expect(acted._tag === "Learned" && acted.learnedClass).toBe("recoverable")

  // Row three. Acted, and said automation should never do this itself. Ticket
  // 14's case, derivable today and deliberately so: it is the entry that can
  // never be downgraded, and a rule that only appears when it is first needed is
  // a rule nobody has tested.
  const privileged = classify(
    record({
      actions: [{ at: "2026-08-27T00:00:15.000Z", detail: "authorised as supervisor", redacted: [] }],
      nextTime: "always_stop_here"
    })
  )
  expect(privileged._tag === "Learned" && privileged.learnedClass).toBe("requires_human")

  // The one question is what separates rows two and three, and it separates
  // nothing else: with the actions held constant, the two answers give two
  // classes, and with the answer held constant, the two action lists do too.
  expect(acted).not.toEqual(privileged)
  expect(observed).not.toEqual(acted)
})

it("learns nothing from an episode that demonstrated nothing", () => {
  // Nobody was asked. The commonest case by far, and the one that must not be
  // read as a confirmation: an interface that forgot to ask and an operator who
  // declined look identical from here, and neither authorises a change.
  expect(classify(record({ nextTime: "not_asked" }))._tag).toBe("NothingLearned")

  // Nobody came. The machine's own answer, and not something a person said.
  expect(classify(record({ classification: "unattended" }))._tag).toBe("NothingLearned")

  // Still open.
  expect(classify(record({ classification: undefined }))._tag).toBe("NothingLearned")

  // And the interesting refusal: "always stop here" about a state you did not
  // touch. Having shown the state is observational and then declined to let
  // automation observe it is a preference, not a finding — and a requires-human
  // entry can never be downgraded afterwards, so it is not written on the
  // strength of one.
  const contradictory = classify(record({ actions: [], nextTime: "always_stop_here" }))
  expect(contradictory._tag).toBe("NothingLearned")
  if (contradictory._tag !== "NothingLearned") throw new Error("unreachable")
  expect(contradictory.why).toContain("observational")
})

// ---------------------------------------------------------------------------
// The ratchet
// ---------------------------------------------------------------------------

it("a learned classification only ever tightens", () => {
  // SPEC: "These entries are write-once: no later intervention can downgrade one
  // to `business_outcome`. The rule only tightens."
  expect(atLeastAsStrictAs("requires_human", "business_outcome")).toBe(true)
  expect(atLeastAsStrictAs("requires_human", "recoverable")).toBe(true)
  expect(atLeastAsStrictAs("recoverable", "business_outcome")).toBe(true)

  // The direction that matters. Seeing a privileged decision a hundred times
  // never turns it into an automated one (ADR-0004).
  expect(atLeastAsStrictAs("business_outcome", "requires_human")).toBe(false)
  expect(atLeastAsStrictAs("business_outcome", "recoverable")).toBe(false)
  expect(atLeastAsStrictAs("recoverable", "requires_human")).toBe(false)

  // Same class, and unclassified, both pass — this is a ratchet, not a
  // strict ordering, and an unclassified state accepts anything.
  expect(atLeastAsStrictAs("business_outcome", "business_outcome")).toBe(true)
  expect(atLeastAsStrictAs("business_outcome", undefined)).toBe(true)
})

it("refuses to redeclare a state this capability has already classified", () => {
  const learned = shippedArtifact(undefined, "1.1.0")

  // 1.1.0 already declares NO_MATCHING_ITEM, so it is classified.
  expect(classificationOf(learned, "NO_MATCHING_ITEM")).toBe("business_outcome")
  expect(classificationOf(learned, "NOTHING_HAS_EVER_SAID_THIS")).toBeUndefined()

  const again = declareLearnedNoMatch(learned, {
    version: "1.9.0",
    stepId: "open-account",
    title: "something else entirely",
    summary: "a second intervention trying to redefine a declared state",
    discoveredFrom: "a later episode"
  }, { scrub: noScrubbing })

  expect(Result.isFailure(again)).toBe(true)
  if (!Result.isFailure(again)) throw new Error("unreachable")
  expect(again.failure.message).toContain("already declares NO_MATCHING_ITEM")
})

it("refuses to amend a version into itself", () => {
  // An amendment is a new file beside the old one. A "new version" that replaced
  // the version being amended would leave nothing to diff against, which is the
  // entire reason the store is immutable.
  const refused = declareLearnedNoMatch(beforeLearning(), {
    version: "1.0.0",
    stepId: "open-account",
    title: "t",
    summary: "s",
    discoveredFrom: "d"
  }, { scrub: noScrubbing })
  expect(Result.isFailure(refused)).toBe(true)
  if (!Result.isFailure(refused)) throw new Error("unreachable")
  expect(refused.failure.message).toContain("diffed")
})

it("refuses an amendment nobody supplied a scrubber for", () => {
  // The guarantee `AmendmentRequest.scrub` documents is unconditional: "the
  // amendment is refused if scrubbing the finished document would change it". An
  // optional field defaulting to identity does not weaken that a little, it
  // removes it — the document is compared against an unchanged copy of itself,
  // the comparison always matches, and ADR-0008's refusal never fires for any
  // caller who left the argument out.
  //
  // The field is required, so the cast below is the only way to express the
  // mistake at all. It stands in for the caller that would have made it: a new
  // CLI path, a harness, an operator interface written next year.
  const detail = `member ${CHECKING_ONLY} has no savings account`
  const closed = record({ detail })

  const unchecked = proposeAmendment(
    { artifact: beforeLearning(), record: closed } as unknown as Parameters<
      typeof proposeAmendment
    >[0]
  )
  expect(unchecked._tag).toBe("Refused")
  if (unchecked._tag !== "Refused") throw new Error("unreachable")
  expect(unchecked.refusal.message).toContain("no scrubber was supplied")
  expect(unchecked.refusal.message).not.toContain(CHECKING_ONLY)

  // With the run's real scrubber the same episode is refused for the reason it
  // should be, which is what proves the refusal above is the guard firing rather
  // than the amendment being impossible.
  const checked = proposeAmendment({
    artifact: beforeLearning(),
    record: closed,
    scrub: (text: string) => text.replaceAll(CHECKING_ONLY, "[redacted:memberId]")
  })
  expect(checked._tag).toBe("Refused")
  if (checked._tag !== "Refused") throw new Error("unreachable")
  expect(checked.refusal.message).toContain("ADR-0008")

  // And an episode with nothing sensitive in it still amends, so what the two
  // refusals above have in common is the check and not the document.
  const clean = proposeAmendment({
    artifact: beforeLearning(),
    record: record({ detail: "there is no such account to open" }),
    scrub: (text: string) => text.replaceAll(CHECKING_ONLY, "[redacted:memberId]")
  })
  expect(clean._tag).toBe("Amended")
})

it("refuses an amendment carrying a value the run treats as sensitive", () => {
  // An operator writing the member number into the detail box is an entirely
  // reasonable thing for them to do, and an entirely unacceptable thing to
  // commit: an artifact outlives the run it was learned from and carries no
  // runtime data (ADR-0008).
  //
  // The needle is the run's own Evidence scrubber, so the rule is exactly one
  // rule — what this run's evidence would redact, its artifact refuses to carry
  // — rather than a second definition of "sensitive" that could drift.
  const scrub = (text: string): string => text.replaceAll(CHECKING_ONLY, "[redacted:memberId]")

  const refused = declareLearnedNoMatch(
    beforeLearning(),
    {
      version: "1.5.0",
      stepId: "open-account",
      title: "nothing on offer matched",
      summary: `the operator wrote: member ${CHECKING_ONLY} has no savings account`,
      discoveredFrom: "an episode"
    },
    { scrub }
  )

  expect(Result.isFailure(refused)).toBe(true)
  if (!Result.isFailure(refused)) throw new Error("unreachable")

  // And the refusal does not repeat what it found. A message about a leaked
  // member number that contains the member number is a leak produced by the leak
  // check, and it lands in a terminal, a CI log and a ticket.
  expect(refused.failure.message).not.toContain(CHECKING_ONLY)
  expect(refused.failure.message).toContain("ADR-0008")

  // The same amendment without the value in it is accepted, so what was refused
  // was the value and not the amendment.
  const accepted = declareLearnedNoMatch(
    beforeLearning(),
    {
      version: "1.5.0",
      stepId: "open-account",
      title: "nothing on offer matched",
      summary: "the operator wrote: this member has no savings account",
      discoveredFrom: "an episode"
    },
    { scrub }
  )
  expect(Result.isSuccess(accepted)).toBe(true)
})

it("has no spelling for a learned ambiguous match, and never will", () => {
  // SPEC: "two or more matches is a hard failure, never a coin flip." Several
  // items carrying every token of the parameter is a capability that has stopped
  // being precise enough, and no amount of human confirmation makes picking one
  // of them a correct answer — so `onMultiple` takes an escalation and nothing
  // else, and the schema is where that is enforced rather than a review comment.
  const decode = Schema.decodeUnknownResult(ActionSchema)
  const selection = {
    type: "selectFromList",
    list: { itemRole: "link" },
    match: { against: { from: "parameter", name: "accountType" }, strategy: "tokenSubset" },
    robustness: "x"
  }

  expect(
    Result.isSuccess(
      decode({ ...selection, onNoMatch: { outcome: "X" }, onMultiple: { escalate: "Y" } })
    )
  ).toBe(true)
  expect(
    Result.isFailure(
      decode({ ...selection, onNoMatch: { escalate: "X" }, onMultiple: { outcome: "Y" } })
    )
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// The diff, which is what a reviewer approves
// ---------------------------------------------------------------------------

it("diffing the two versions shows exactly the outcome that was added", () => {
  const before = beforeLearning()
  const after = shippedArtifact(undefined, "1.1.0")
  const diff = diffArtifacts(before, after)

  // The two lines that carry the whole change. One state stopped being an
  // escalation and became an answer; the code did not move, because what was
  // learned is the classification and not the vocabulary.
  expect(diff).toContain("-      escalate: NO_MATCHING_ITEM")
  expect(diff).toContain("+      outcome: NO_MATCHING_ITEM")

  // The declaration, and the link back to the episode that justified it.
  expect(diff).toContain("+  NO_MATCHING_ITEM:")
  expect(diff).toContain("Learned from intervention")

  // And nothing else was touched. Every removed line is one of two: the version
  // number, and the escalation that became an outcome. An amendment that could
  // quietly rewrite a target or retune a bound would make this diff worthless as
  // a review artefact, so the assertion is on the whole removed set rather than
  // on a sample of it.
  const removed = diff
    .split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---"))
  expect(removed).toEqual(["-version: 1.0.0", "-      escalate: NO_MATCHING_ITEM"])

  // Both sides are rendered by the same formatter, so this is a diff of what the
  // two versions *mean*. The stored 1.0.0 carries a great deal of comment prose
  // that `Bun.YAML.parse` drops, and diffing the files would have buried the two
  // lines above under every comment in the document.
  expect(diff).toContain("--- member.account-balance@1.0.0")
  expect(diff).toContain("+++ member.account-balance@1.1.0")
})

// ---------------------------------------------------------------------------
// The arc, in a real browser
// ---------------------------------------------------------------------------

it.live("an unattended run reports the hard failure it always did", () =>
  Effect.gen(function* () {
    // Nothing about this ticket changes what happens with nobody watching.
    // Escalating into an empty room would name a person as responsible for a run
    // no person can see, so the run reports what it observed and stops.
    const { result } = yield* replay({
      artifact: beforeLearning(),
      inputs: { memberId: CHECKING_ONLY }
    })

    if (result.result !== "failure") throw new Error(`expected a failure, got ${result.result}`)
    if (result.failure.reason !== "no_matching_item") {
      throw new Error(`expected no_matching_item, got ${result.failure.reason}`)
    }
    // The escalation-shaped failure: it carries the whole list that *was* on
    // offer, which is very often the answer on its own.
    expect(result.failure.items).toEqual(["Checking"])
    expect(result.failure.stepId).toBe("open-account")
  })
)

it.live(
  "an operator who looks and touches nothing teaches the capability an outcome, and the next run needs nobody",
  () =>
    Effect.gen(function* () {
      const before = beforeLearning()

      // ---------------------------------------------------------------
      // 1 and 2. The run escalates, and a person looks without acting.
      // ---------------------------------------------------------------
      const episode = yield* attendedReplay({
        artifact: before,
        inputs: { memberId: CHECKING_ONLY },
        runId: "learning",
        operate: (desk) =>
          Effect.gen(function* () {
            const paused = yield* desk.awaitPause

            // The Action never ran, and the Operator is told so — which is the
            // difference between looking for something wrong with the screen and
            // looking for something that is missing from it.
            expect(paused.pending?.intervention.stepId).toBe("open-account")
            expect(paused.pending?.intervention.reason).toContain("could not act")
            expect(paused.pending?.intervention.detail).toContain("Checking")

            yield* desk.post("/take", { operator: "j.okafor" })

            // 3. The one question, on the page, at return-of-control.
            const page = yield* desk.get("/")
            expect(page.body).toContain(
              "Next time automation meets this state, should it handle it itself?"
            )
            expect(page.body).toContain("You have not recorded doing anything to this session")

            // Deliberately no `/note`. Touching nothing is the evidence.
            //
            // `unresolved` and `automation_handles_it` together, which is the
            // pair a single field could not have expressed: this run cannot
            // continue — there is no savings account for anybody to conjure into
            // existence — and the state is nonetheless an answer.
            yield* desk.post("/return", {
              operator: "j.okafor",
              classification: "unresolved",
              detail: "checking account only; there is no savings account to open",
              nextTime: "automation_handles_it"
            })
          })
      })

      // The first run ends as an intervention, not a failure. Nothing is broken
      // and there is nothing to page anybody about; a person was needed and a
      // person came.
      expect(episode.result.result).toBe("intervention_required")

      // Exactly one escalation. The step was re-attempted after control came
      // back, found the same empty list, and reported rather than pausing again
      // — a run that keeps interrupting the person attending it is not attended.
      const raises = episode.events.filter((event) => event.kind === "intervention.raise")
      expect(raises).toHaveLength(1)

      // The record an auditor reads, and the answer to the one question in it.
      const resolve = episode.events.find((event) => event.kind === "intervention.resolve")
      if (resolve?.kind !== "intervention.resolve") throw new Error("no resolve event")
      expect(resolve.nextTime).toBe("automation_handles_it")
      expect(resolve.classification).toBe("unresolved")

      // No `intervention.human_action` beyond taking control. That the operator
      // did nothing is a fact in the evidence, not an assumption in the code.
      const acted = episode.events.filter(
        (event) => event.kind === "intervention.human_action" && !event.detail.startsWith("took")
      )
      expect(acted).toEqual([])

      // ---------------------------------------------------------------
      // 4 and 5. A new version, declaring the outcome.
      // ---------------------------------------------------------------
      const closed = episode.snapshot.resolved[0]
      if (closed === undefined) throw new Error("no closed intervention")
      expect(closed.actions).toEqual([])

      const proposal = proposeAmendment({ artifact: before, record: closed, scrub: noScrubbing })
      if (proposal._tag !== "Amended") {
        throw new Error(`expected an amendment, got ${proposal._tag}`)
      }
      expect(proposal.learnedClass).toBe("business_outcome")
      expect(proposal.amended.version).toBe(nextMinorVersion(before.version))

      const store = mkdtempSync(join(tmpdir(), "cua-amendment-"))
      try {
        // Both versions in the store, because an amendment is a new file and
        // never an edit.
        expect(Result.isSuccess(writeArtifact(store, before))).toBe(true)
        const written = writeArtifact(store, proposal.amended)
        if (Result.isFailure(written)) throw new Error(written.failure.message)

        // Refuses to be written twice, which is what makes 1.0.0 still mean what
        // it meant when somebody approved it.
        expect(Result.isFailure(writeArtifact(store, proposal.amended))).toBe(true)

        // Read back off disk and through the parser, so what is replayed below is
        // what a reviewer would have read rather than an object held in memory.
        const reloaded = loadArtifact(store, before.capability, proposal.amended.version)
        if (Result.isFailure(reloaded)) throw new Error(reloaded.failure.message)

        const selection = reloaded.success.steps.flatMap((step) =>
          step.action.type === "selectFromList" ? [step.action] : []
        )[0]!
        // The same code, reclassified. Not renamed: what was learned is the
        // classification, and letting whoever is on shift name a capability's
        // states would be the answer smuggled in as vocabulary.
        expect(noMatchOutcome(selection.onNoMatch)).toBe("NO_MATCHING_ITEM")
        expect(noMatchCode(selection.onNoMatch)).toBe(
          noMatchCode(
            before.steps.flatMap((step) =>
              step.action.type === "selectFromList" ? [step.action] : []
            )[0]!.onNoMatch
          )
        )

        // The link to the Intervention that justified it, by identifier, so an
        // auditor can find the episode in the evidence rather than take the
        // document's word for it.
        const declaration = reloaded.success.outcomes?.["NO_MATCHING_ITEM"]
        expect(declaration?.discoveredFrom).toContain(closed.intervention.interventionId)
        expect(declaration?.discoveredFrom).toContain("recorded no actions on the live session")
        expect(declaration?.discoveredFrom).toContain("j.okafor")

        // 1.0.0 in the store is untouched.
        const original = loadArtifact(store, before.capability, "1.0.0")
        if (Result.isFailure(original)) throw new Error(original.failure.message)
        expect(original.success.outcomes?.["NO_MATCHING_ITEM"]).toBeUndefined()

        // ---------------------------------------------------------------
        // 6. And the payoff: the same member, unattended, no browser paused,
        //    nobody asked, and a business outcome comes back.
        // ---------------------------------------------------------------
        const after = yield* replay({
          artifact: reloaded.success,
          inputs: { memberId: CHECKING_ONLY },
          runId: "after-learning"
        })

        if (after.result.result !== "business_outcome") {
          throw new Error(`expected a business outcome, got ${after.result.result}`)
        }
        expect(after.result.code).toBe("NO_MATCHING_ITEM")
        expect(after.result.detail).toBe(declaration?.title)

        // No person, and no pause. The run that escalated and the run that
        // answered are the same six steps against the same screen; the only
        // thing that changed is what the document says the fifth one means.
        expect(after.events.filter((event) => event.kind.startsWith("intervention."))).toEqual([])
        expect(after.result.steps.map((step) => `${step.id}:${step.checkpoint}`)).toEqual([
          "open-member-search:held",
          "enter-member-number:held",
          "run-member-search:held",
          "open-account:outcome",
          "read-available-balance:not_reached",
          "read-current-balance:not_reached"
        ])

        // The outcome event says what was observed, including everything the
        // list did offer — so the answer is re-derivable from the record rather
        // than asserted by it.
        const outcome = after.events.find((event) => event.kind === "outcome")
        if (outcome?.kind !== "outcome") throw new Error("no outcome event")
        expect(outcome.matched).toContain("Checking")

        // No `action` event for the step that answered. Nothing was pressed, no
        // target was resolved and Policy was never asked, because there was
        // nothing to ask about — and a log that showed a gesture there would be
        // describing something that did not happen.
        const actions = after.events.filter(
          (event) => event.kind === "action" && event.stepId === "open-account"
        )
        expect(actions).toEqual([])
      } finally {
        rmSync(store, { recursive: true, force: true })
      }
    }),
  90_000
)

it.live("the capability still serves the account this member does hold", () =>
  Effect.gen(function* () {
    // The amendment declared a state, not a member. Asking the same member for
    // the account they actually have returns a balance exactly as before, which
    // is what stops "this member is a business outcome" being the thing that was
    // learned.
    const { result } = yield* replay({
      artifact: shippedArtifact(undefined, "1.1.0"),
      inputs: { memberId: CHECKING_ONLY, accountType: "Checking" }
    })

    if (result.result !== "success") throw new Error(`expected success, got ${result.result}`)
    expect(result.outputs["availableBalance"]).toEqual({
      type: "money",
      value: { amount: 1046.73, currency: "USD" }
    })
  })
)

it.live("a state nobody has classified still escalates after the amendment", () =>
  Effect.gen(function* () {
    // The amendment is scoped to one step's no-match, and every other way this
    // capability can stop is untouched. Two savings accounts is still a hard
    // failure naming both (SPEC: never a coin flip), at the learned version.
    const { result } = yield* replay({
      artifact: shippedArtifact(undefined, "1.1.0"),
      inputs: { memberId: "33333" }
    })

    if (result.result !== "failure") throw new Error(`expected a failure, got ${result.result}`)
    expect(result.failure.reason).toBe("ambiguous_match")
  })
)

// ---------------------------------------------------------------------------
// What the mechanism will not do
// ---------------------------------------------------------------------------

it("will not turn a checkpoint failure into a business outcome", () => {
  // Ticket 12's `77777` is a supervisor hold: the Action landed, the Checkpoint
  // failed, and an Operator got past it by *acting* with authority. `classify`
  // returns `requires_human` for that, and this mechanism will not write it as
  // anything else.
  //
  // Ticket 14 gave that class somewhere to go, so what used to be `Unchanged`
  // here is now an amendment — into `requiresHuman:`, never into `outcomes:`.
  // What this test is for is unchanged: the state the operator had to *act* to
  // resolve does not become an answer this capability may return.
  const held = record({
    actions: [{ at: "2026-08-27T00:00:15.000Z", detail: "entered supervisor override", redacted: [] }],
    nextTime: "always_stop_here",
    classification: "resolved"
  })

  const proposal = proposeAmendment({ artifact: beforeLearning(), record: held, scrub: noScrubbing })
  if (proposal._tag !== "Amended") throw new Error(`expected an amendment, got ${proposal._tag}`)
  expect(proposal.learnedClass).toBe("requires_human")

  // The document gained an always-escalating entry and no business outcome. The
  // no-match state at this same step is still an escalation at this version,
  // which is the assertion that the two learned states stayed separate.
  expect(proposal.amended.outcomes?.["NO_MATCHING_ITEM"]).toBeUndefined()
  expect(Object.keys(proposal.amended.requiresHuman ?? {})).toEqual([
    "OPEN_ACCOUNT_REQUIRES_HUMAN"
  ])
})

it("will not amend on the strength of a question nobody answered", () => {
  const unanswered = record({ nextTime: "not_asked" })
  const proposal = proposeAmendment({ artifact: beforeLearning(), record: unanswered, scrub: noScrubbing })
  expect(proposal._tag).toBe("Unchanged")
})

it("writes a document that loads, executes and round-trips", () => {
  // What the amendment produces is held to exactly the contract every other
  // artifact is: it parses, its references resolve, every declared outcome is
  // reachable and every reachable code is declared. `writeArtifact` re-parses
  // before it writes, and this asserts the same thing one level up so a failure
  // says which half broke.
  const proposal = proposeAmendment({ artifact: beforeLearning(), record: record(), scrub: noScrubbing })
  if (proposal._tag !== "Amended") throw new Error(`expected an amendment, got ${proposal._tag}`)

  const again = parseArtifact("round-trip", formatArtifact(proposal.amended))
  if (Result.isFailure(again)) throw new Error(again.failure.message)
  expect(again.success).toEqual(proposal.amended)
})
