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
import type { EvidenceEvent } from "@cua/evidence"
import {
  type CompiledPolicy,
  DEFAULT_POLICY,
  POLICIES_DIRECTORY,
  declassifierFor,
  loadPolicy,
  policyFrom,
  sensitivityPolicy
} from "@cua/policy"
import { automationOwnedSession } from "@cua/session"
import { playwrightSurface } from "@cua/surface"
import { type ReplayResult, evidenceForRun, replayCapability } from "@cua/replay"
import { Effect, Layer, Result } from "effect"

/** The capability this ticket's tracer bullet runs. */
export const ACCOUNT_BALANCE = "member.account-balance"

export const shippedArtifact = (capability = ACCOUNT_BALANCE): CapabilityArtifact => {
  const loaded = loadArtifact(ARTIFACTS_DIRECTORY, capability)
  if (Result.isFailure(loaded)) throw new Error(loaded.failure.message)
  return loaded.success
}

/**
 * A Policy from `policies/`, the same files a run in production would use.
 *
 * Every replay test runs under a real shipped Policy rather than a permissive
 * stand-in, which is the point: the tracer bullet passing means it passes the
 * allowlist somebody would actually approve, not that policy was switched off
 * for the tests.
 */
export const shippedPolicy = (name = DEFAULT_POLICY): CompiledPolicy => {
  const loaded = loadPolicy(POLICIES_DIRECTORY, name)
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
  /** Which Policy is in force. Defaults to the shipped `policies/default.yaml`. */
  readonly policy?: CompiledPolicy
  /**
   * The tenant installation to run against, overriding the in-process fixture.
   *
   * A Policy test needs a base URL the allowlist does not cover, and a base URL
   * is a replay parameter precisely because it is not in the Artifact.
   */
  readonly baseUrl?: string
  /**
   * The Surface Layer. Defaults to the real Playwright adapter, and a test that
   * overrides it is expected to *wrap* that adapter rather than replace it —
   * SPEC's testing decisions rule out browser stubbing, and a counting wrapper
   * around the real thing is an observation, not a substitute.
   */
  readonly surface?: ReturnType<typeof playwrightSurface>
}): Effect.Effect<ReplayOutcome, unknown> =>
  Effect.gen(function* () {
    const core = yield* serve({ port: 0 })
    // The same sensitivity policy the CLI runs under, so what the tests read off
    // disk is the redaction real runs get rather than a test-only arrangement.
    const prepared = prepareInputs(
      options.artifact.capability,
      options.artifact.inputs,
      options.inputs,
      declassifierFor(sensitivityPolicy, options.artifact.capability)
    )
    if (Result.isFailure(prepared)) return yield* Effect.fail(prepared.failure)

    const root = mkdtempSync(join(tmpdir(), "cua-evidence-"))
    const runId = options.runId ?? "run"
    const sessionId = `session-${runId}`

    const result = yield* replayCapability({
      artifact: options.artifact,
      inputs: prepared.success,
      baseUrl: options.baseUrl ?? core.origin,
      runId
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          options.surface ?? playwrightSurface({}),
          policyFrom(options.policy ?? shippedPolicy()),
          evidenceForRun({
            root,
            runId,
            sessionId,
            inputs: prepared.success,
            policy: `Sensitivity policy: ${sensitivityPolicy.summary}`
          }),
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
