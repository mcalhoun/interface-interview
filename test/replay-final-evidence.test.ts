import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"
import { expect } from "vitest"
import { type CapabilityArtifact, prepareInputs } from "@cua/artifact"
import { Evidence } from "@cua/evidence"
import { serve } from "@cua/legacy-core"
import { originAuthorizer, policyFrom } from "@cua/policy"
import { evidenceForRun, replayCapability } from "@cua/replay"
import { automationOwnedSession } from "@cua/session"
import { playwrightSurface } from "@cua/surface"
import { shippedArtifact, shippedPolicy } from "../apps/demo/src/support/replay-harness.ts"

const runWithFinalWriteFailure = (
  failAt: "observe" | "run.end" | "none",
  artifact: CapabilityArtifact = shippedArtifact()
) => Effect.scoped(Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "cua-final-evidence-"))),
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
  )
  const core = yield* serve({ port: 0 })
  const policy = shippedPolicy()
  const inputs = prepareInputs(artifact.capability, artifact.inputs, { memberId: "12345" })
  if (Result.isFailure(inputs)) return yield* Effect.fail(inputs.failure)

  let reachedOutcome = false
  let refusedWrite = false
  const evidence = Layer.effect(Evidence)(Effect.gen(function* () {
    const writer = yield* Evidence
    return {
      ...writer,
      record: (body) => Effect.gen(function* () {
        if (body.kind === "outcome") reachedOutcome = true
        if (!refusedWrite && (body.kind === "run.end" && failAt === "run.end"
          || body.kind === "observe" && reachedOutcome && failAt === "observe")) {
          refusedWrite = true
          // Keep the real writer and its scrubber, but make its append target
          // unwritable exactly when finalisation reaches the selected event.
          const log = join(writer.directory, "events.jsonl")
          const saved = join(writer.directory, "before-final.jsonl")
          renameSync(log, saved)
          mkdirSync(log)
          return yield* writer.record(body).pipe(Effect.ensuring(Effect.sync(() => {
            // Later writes would succeed, so the persisted log exposes an
            // engine that continues after this structured write fails.
            rmSync(log, { recursive: true })
            renameSync(saved, log)
          })))
        }
        yield* writer.record(body)
      })
    } satisfies Evidence["Service"]
  })).pipe(Layer.provide(evidenceForRun({ root, runId: "run", sessionId: "session", inputs: inputs.success })))

  const result = yield* replayCapability({ artifact, inputs: inputs.success, baseUrl: core.origin, runId: "run" }).pipe(
    Effect.provide(Layer.mergeAll(
      playwrightSurface({ authorizeOrigin: originAuthorizer(policy) }),
      policyFrom(policy), evidence, automationOwnedSession("session")
    ))
  )
  const log = readFileSync(join(root, "run", "events.jsonl"), "utf8")
  return { result, log }
}))

it.live("a terminal event that cannot be persisted turns a completed replay into evidence_failed", () =>
  Effect.gen(function* () {
    const { result, log } = yield* runWithFinalWriteFailure("run.end")
    expect(log).toContain('"code":"SUCCESS"')
    expect(log).not.toContain('"kind":"run.end"')
    expect(result.result).toBe("failure")
    if (result.result !== "failure") return
    expect(result.failure.reason).toBe("evidence_failed")
    expect(result.failure.observed).toMatch(/directory|EISDIR/i)
    expect(result.failure).toHaveProperty("path", join(result.evidenceDirectory, "events.jsonl"))
  })
)

it.live("a final observation that cannot be persisted cannot leave a successful result", () =>
  Effect.gen(function* () {
    const { result, log } = yield* runWithFinalWriteFailure("observe")
    expect(log).toContain('"code":"SUCCESS"')
    expect(log).not.toContain('"kind":"run.end"')
    expect(result.result).toBe("failure")
    if (result.result !== "failure") return
    expect(result.failure.reason).toBe("evidence_failed")
  })
)

it.live("a failed terminal write retains the original failed step and scrubbed diagnosis", () =>
  Effect.gen(function* () {
    const artifact = shippedArtifact()
    const { result } = yield* runWithFinalWriteFailure("run.end", {
      ...artifact,
      steps: artifact.steps.map((step, index) => index === 0 ? {
        ...step,
        checkpoint: {
          description: "Missing caption for 12345",
          withinMillis: 100,
          expect: [{ assert: "textPresent", text: "Missing caption for 12345" }]
        }
      } : step)
    })
    expect(result.result).toBe("failure")
    if (result.result !== "failure") return
    expect(result.failure.reason).toBe("evidence_failed")
    expect(result.failure.stepId).toBe("open-member-search")
    expect(result.failure.stepIntent).toBe(artifact.steps[0]?.intent)
    expect(result.failure.observed).toContain("checkpoint_failed")
    expect(result.failure.observed).toContain("Missing caption")
    expect(JSON.stringify(result)).not.toContain("12345")
  })
)

it.live("refused optional screenshots leave a successful replay with its terminal event", () =>
  Effect.gen(function* () {
    const { result, log } = yield* runWithFinalWriteFailure("none")
    expect(result.result).toBe("success")
    expect(log).toContain('"kind":"run.end","result":"success"')
  })
)
