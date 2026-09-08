/** Internal integration seam for tests that must inspect or poison compiler inputs. */
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoveredSecrets, DEFAULT_BOUNDS } from "@cua/agent"
import type { Trajectory } from "../../packages/agent/src/Trajectory.ts"
import { discover } from "../../packages/agent/src/loop.ts"
import type { EvidenceEvent } from "@cua/evidence"
import { evidenceFiles } from "@cua/evidence"
import { serve } from "@cua/legacy-core"
import { heritagePublicGoalTerms, originAuthorizer, policyFrom } from "@cua/policy"
import { automationOwnedSession } from "@cua/session"
import { playwrightSurface, type SurfaceAdapter } from "@cua/surface"
import { Effect, Layer } from "effect"
import { shippedPolicy } from "../../apps/demo/src/support/discovery-harness.ts"
import type { DiscoveryHarnessOptions } from "../../apps/demo/src/support/discovery-harness.ts"
export { counting, shippedPolicy } from "../../apps/demo/src/support/discovery-harness.ts"

export interface DiscoveryRun {
  readonly trajectory: Trajectory
  readonly events: ReadonlyArray<EvidenceEvent>
  readonly evidenceDirectory: string
}

export const runDiscovery = (
  options: DiscoveryHarnessOptions
): Effect.Effect<DiscoveryRun, unknown, never> =>
  Effect.scoped(
    Effect.gen(function*() {
      const baseUrl = (yield* serve({ port: 0 })).origin
      const root = mkdtempSync(join(tmpdir(), "cua-discovery-"))
      const runId = `test-${randomUUID().slice(0, 8)}`
      const secrets = discoveredSecrets()

      const real = playwrightSurface({ headless: true, authorizeOrigin: originAuthorizer(options.policy ?? shippedPolicy()) }) as unknown as Layer.Layer<
        SurfaceAdapter,
        never,
        never
      >
      const surface = options.surface === undefined ? real : options.surface(real)

      const services = Layer.mergeAll(
        surface,
        policyFrom(options.policy ?? shippedPolicy()),
        evidenceFiles({
          root,
          runId,
          sessionId: runId,
          scrubber: secrets.registry, allowUnredactedScreenshots: true
        }),
        options.model,
        automationOwnedSession(runId)
      )

      const trajectory = yield* discover({
        goal: options.goal,
        entry: options.entry ?? "/",
        baseUrl,
        runId,
        sessionId: runId,
        secrets,
        bounds: { ...DEFAULT_BOUNDS, ...options.bounds },
        publicGoalTerms: options.publicGoalTerms ?? heritagePublicGoalTerms,
        modelName: "scripted", providerName: "scripted"
      }).pipe(Effect.provide(services))

      const directory = join(root, runId)
      const events = readFileSync(join(directory, "events.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as EvidenceEvent)

      return { trajectory, events, evidenceDirectory: directory }
    })
  ) as Effect.Effect<DiscoveryRun, unknown, never>

