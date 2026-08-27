/**
 * One Heritage Core, one browser and one evidence directory per test.
 *
 * Every replay test drives the real mock application through the real adapter in
 * a real browser. SPEC's testing decisions are explicit about this: "the mock app
 * is the test fixture, so no browser stubbing happens anywhere", and the highest
 * seam available — the public capability API — is the one worth asserting on.
 *
 * Evidence lands in a fresh temporary directory per test, which is also how the
 * tests read it back: the files on disk are part of the product, so they are what
 * gets asserted rather than a spy on the writer.
 */

import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serve } from "@cua/legacy-core"
import {
  type CapabilityArtifact,
  ARTIFACTS_DIRECTORY,
  loadArtifact,
  prepareInputs
} from "@cua/artifact"
import { type EvidenceEvent, evidenceFiles } from "@cua/evidence"
import { permissivePolicy } from "@cua/policy"
import { automationOwnedSession } from "@cua/session"
import { playwrightSurface } from "@cua/surface"
import { type ReplayResult, replayCapability } from "@cua/replay"
import { Effect, Layer, Result } from "effect"

/** The capability this ticket's tracer bullet runs. */
export const ACCOUNT_BALANCE = "member.account-balance"

export const shippedArtifact = (capability = ACCOUNT_BALANCE): CapabilityArtifact => {
  const loaded = loadArtifact(ARTIFACTS_DIRECTORY, capability)
  if (Result.isFailure(loaded)) throw new Error(loaded.failure.message)
  return loaded.success
}

export interface ReplayOutcome {
  readonly result: ReplayResult
  readonly events: ReadonlyArray<EvidenceEvent>
  readonly evidenceDirectory: string
}

/**
 * Runs one capability against a fresh Heritage Core and reads its evidence back
 * off disk.
 *
 * `runId` is a parameter so a determinism test can tell two runs apart while
 * still comparing everything else about them.
 */
export const replay = (options: {
  readonly artifact: CapabilityArtifact
  readonly inputs: Readonly<Record<string, string>>
  readonly runId?: string
}): Effect.Effect<ReplayOutcome, unknown> =>
  Effect.gen(function* () {
    const core = yield* serve({ port: 0 })
    const prepared = prepareInputs(
      options.artifact.capability,
      options.artifact.inputs,
      options.inputs
    )
    if (Result.isFailure(prepared)) return yield* Effect.fail(prepared.failure)

    const root = mkdtempSync(join(tmpdir(), "cua-evidence-"))
    const runId = options.runId ?? "run"
    const sessionId = `session-${runId}`

    const result = yield* replayCapability({
      artifact: options.artifact,
      inputs: prepared.success,
      baseUrl: core.origin,
      runId
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          playwrightSurface({}),
          permissivePolicy,
          evidenceFiles({ root, runId, sessionId }),
          automationOwnedSession(sessionId)
        )
      )
    )

    const evidenceDirectory = join(root, runId)
    const events = readFileSync(join(evidenceDirectory, "events.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as EvidenceEvent)

    return { result, events, evidenceDirectory }
  }).pipe(Effect.scoped)
