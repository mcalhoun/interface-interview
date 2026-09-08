import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result } from "effect"
import { expect, it } from "vitest"
import { loadArtifact, loadOverride } from "@cua/artifact"
import { Evidence } from "@cua/evidence"
import { evidenceForRun, learningForIntervention } from "@cua/replay"
import type { InterventionRecord } from "@cua/session"
import { shippedArtifact } from "../apps/demo/src/support/replay-harness.ts"

const artifact = shippedArtifact(undefined, "1.0.0")
const record = (): InterventionRecord => ({
  intervention: {
    capability: artifact.capability, version: artifact.version, runId: "run",
    stepId: "open-account", stepIntent: "Open the requested account", reason: "this step could not act",
    failureCause: { type: "no_matching_item", code: "NO_MATCHING_ITEM" },
    detail: "nothing matched", url: "http://example.invalid/member", accessibility: "- table:",
    interventionId: "session-intervention-1", sessionId: "session", raisedAt: "2026-09-08T12:00:00.000Z"
  },
  operator: "reviewer", tookControlAt: "2026-09-08T12:00:10.000Z", returnedAt: "2026-09-08T12:00:20.000Z",
  actions: [], observed: [], classification: "unresolved", detail: "No requested account exists",
  nextTime: "automation_handles_it", confirmProposal: "not_asked"
})

const withEvidence = async (check: (root: string) => Effect.Effect<void, never, Evidence>) => {
  const root = mkdtempSync(join(tmpdir(), "cua-run-learning-"))
  try {
    await Effect.runPromise(check(root).pipe(Effect.provide(evidenceForRun({
      root, runId: "run", sessionId: "session", inputs: new Map()
    }))))
  } finally { rmSync(root, { recursive: true, force: true }) }
}

it.each(["screen", "operator"])("retains a %s secret registered after learning capture and refuses persistence", async (label) => {
  await withEvidence((root) => Effect.gen(function* () {
    const secret = `${label}-private-value-492817`
    const episode = { ...record(), detail: `The operator observed ${secret}` }
    const learning = yield* learningForIntervention({ artifact, record: episode })
    yield* (yield* Evidence).redact([{ label, text: secret }])
    const saved = learning.amendment({ directory: join(root, "artifacts") })
    expect(saved._tag).toBe("Refused")
    expect(JSON.stringify(saved)).not.toContain(secret)
    expect(existsSync(join(root, "artifacts"))).toBe(false)
  }))
})

it("saves confirmed learning with provenance and refuses a repeated immutable version", async () => {
  await withEvidence((root) => Effect.gen(function* () {
    const learning = yield* learningForIntervention({ artifact, record: record() })
    const directory = join(root, "artifacts")
    const saved = learning.amendment({ directory })
    expect(saved._tag).toBe("Amended")
    if (saved._tag !== "Amended") throw new Error("Expected a saved amendment")
    const loaded = loadArtifact(directory, artifact.capability, "1.1.0")
    expect(Result.isSuccess(loaded)).toBe(true)
    if (Result.isFailure(loaded)) throw new Error(loaded.failure.message)
    expect(loaded.success.version).toBe("1.1.0")
    expect(JSON.stringify(loaded.success)).toContain("session-intervention-1")
    const before = readFileSync(saved.path, "utf8")
    expect(learning.amendment({ directory })._tag).toBe("NotStored")
    expect(readFileSync(saved.path, "utf8")).toBe(before)
  }))
})

const overrideRecord = (): InterventionRecord => {
  const episode = record()
  return { ...episode, nextTime: "not_asked", confirmProposal: "confirmed", intervention: {
    ...episode.intervention, stepId: "run-member-search", failureCause: { type: "target_missing" },
    proposal: { forTarget: 'button "Search"', control: "Find", confidence: 0.99, rationale: "The lookup submit button", proposalRef: "assist/1" }
  } }
}

it("persists a confirmed override and retains later secrets in its gate", async () => {
  await withEvidence((root) => Effect.gen(function* () {
    const episode = overrideRecord()
    const learning = yield* learningForIntervention({ artifact, record: episode })
    const directory = join(root, "overrides")
    const saved = learning.override({ directory, tenant: "community-cu" })
    expect(saved._tag).toBe("Confirmed")
    const loaded = loadOverride(directory, "community-cu", artifact.capability)
    expect(Result.isSuccess(loaded) && loaded.success?.targets[0]?.name).toBe("Find")
    yield* (yield* Evidence).redact([{ label: "operator", text: "Find" }])
    expect(learning.override({ directory, tenant: "other-cu" })._tag).toBe("Refused")
    expect(existsSync(join(directory, "other-cu"))).toBe(false)
  }))
})

it.each([
  { capability: "different.capability" },
  { version: "9.0.0" },
  { stepId: "missing-step" }
])("refuses override learning bound to a different capability, version or Step: %j", async (mismatch) => {
  await withEvidence((root) => Effect.gen(function* () {
    const episode = overrideRecord()
    const learning = yield* learningForIntervention({ artifact, record: {
      ...episode, intervention: { ...episode.intervention, ...mismatch }
    } })
    expect(learning.override({ directory: join(root, "overrides"), tenant: "community-cu" })._tag).toBe("Refused")
    expect(existsSync(join(root, "overrides"))).toBe(false)
  }))
})

it("writes neither kind of learning without the Operator's confirmation", async () => {
  await withEvidence((root) => Effect.gen(function* () {
    const episode = overrideRecord()
    const learning = yield* learningForIntervention({ artifact, record: {
      ...episode, nextTime: "not_asked", confirmProposal: "not_asked"
    } })
    expect(learning.amendment({ directory: join(root, "artifacts") })._tag).toBe("Unchanged")
    expect(learning.override({ directory: join(root, "overrides"), tenant: "community-cu" })._tag).toBe("Unchanged")
    expect(existsSync(join(root, "artifacts"))).toBe(false)
    expect(existsSync(join(root, "overrides"))).toBe(false)
  }))
})
