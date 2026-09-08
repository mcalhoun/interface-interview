import { expect, it } from "vitest"
import { noScrubbing } from "@cua/evidence"
import { proposeAmendment } from "@cua/replay"
import type { InterventionRecord } from "@cua/session"
import { shippedArtifact } from "../apps/demo/src/support/replay-harness.ts"

const artifact = shippedArtifact(undefined, "1.0.0")
const step = artifact.steps.find((candidate) => candidate.id === "open-account")!
const checkpointRecord = (): InterventionRecord => ({
  intervention: {
    capability: artifact.capability,
    version: artifact.version,
    runId: "run",
    stepId: step.id,
    stepIntent: step.intent,
    reason: `the checkpoint "${step.checkpoint.description}" did not hold`,
    detail: "The selected account is closed.",
    url: "http://example.invalid/account",
    accessibility: "- text: Account closed",
    interventionId: "intervention",
    sessionId: "session",
    raisedAt: "2026-09-08T00:00:00Z"
  },
  operator: "operator",
  tookControlAt: "2026-09-08T00:00:01Z",
  actions: [],
  observed: [],
  returnedAt: "2026-09-08T00:00:02Z",
  classification: "unresolved",
  detail: "This selected account is closed; report that answer.",
  nextTime: "automation_handles_it",
  confirmProposal: "not_asked"
})

it("does not turn a failed checkpoint after selecting an account into a missing account outcome", () => {
  const record = checkpointRecord()
  const proposal = proposeAmendment({ artifact, record, scrub: noScrubbing })
  expect(proposal._tag).toBe("Refused")
})

it.each([
  ["missing cause", undefined],
  ["failed checkpoint", { type: "checkpoint_failed" }],
  ["missing target", { type: "target_missing" }],
  ["another no-match code", { type: "no_matching_item", code: "SOME_OTHER_STATE" }]
] satisfies ReadonlyArray<readonly [string, InterventionRecord["intervention"]["failureCause"]]>)("refuses to learn no-match from %s", (_label, failureCause) => {
  const record = checkpointRecord()
  const withCause = { ...record, intervention: { ...record.intervention, failureCause } }
  expect(proposeAmendment({ artifact, record: withCause, scrub: noScrubbing })._tag).toBe("Refused")
})

it.each(["business_outcome", "requires_human", "checkpoint_outcome"] as const)(
  "refuses to apply a %s episode to another capability or version",
  (branch) => {
    const original = checkpointRecord()
    const record = {
      ...original,
      actions: branch === "requires_human" ? [{ at: "2026-09-08T00:00:01Z", detail: "authorised the release" }] : [],
      nextTime: branch === "requires_human" ? "always_stop_here" as const : "automation_handles_it" as const,
      intervention: {
        ...original.intervention,
        failureCause: branch === "business_outcome"
          ? { type: "no_matching_item" as const, code: "NO_MATCHING_ITEM" }
          : { type: "checkpoint_failed" as const }
      }
    }
    const confirmedOutcome = branch === "checkpoint_outcome"
      ? { code: "ACCOUNT_CLOSED", title: "The account is closed", text: "Account closed" }
      : undefined
    for (const identity of [{ capability: "another.capability" }, { version: "9.0.0" }, { stepId: "unknown-step" }]) {
      expect(proposeAmendment({
        artifact, record: { ...record, intervention: { ...record.intervention, ...identity } },
        scrub: noScrubbing, ...(confirmedOutcome === undefined ? {} : { confirmedOutcome })
      })._tag).toBe("Refused")
    }
  }
)

it("refuses to learn a checkpoint's human requirement from a failed action", () => {
  const original = checkpointRecord()
  const record = {
    ...original,
    actions: [{ at: "2026-09-08T00:00:01Z", detail: "authorised the release" }],
    nextTime: "always_stop_here" as const,
    intervention: { ...original.intervention, failureCause: { type: "target_missing" as const } }
  }
  expect(proposeAmendment({ artifact, record, scrub: noScrubbing })._tag).toBe("Refused")
})

it("requires a recorded checkpoint cause even when checkpoint prose looks correct", () => {
  expect(proposeAmendment({
    artifact, record: checkpointRecord(), scrub: noScrubbing,
    confirmedOutcome: { code: "ACCOUNT_CLOSED", title: "The account is closed", text: "Account closed" }
  })._tag).toBe("Refused")
})
