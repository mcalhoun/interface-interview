/**
 * Running a Discovery loop in a test.
 *
 * Everything below the model is real, on purpose. A real Chromium, the real
 * Heritage Core fixture on an ephemeral port, the shipped `policies/default.yaml`,
 * and Evidence written to a real temporary directory. SPEC's no-stubbed-browser
 * rule applies here exactly as it does to Replay: a loop tested against a fake
 * accessibility tree would prove nothing about whether these Targets resolve on a
 * page built out of nested layout tables, which is the entire difficulty.
 *
 * The model is the one substitution, and `scripted-model.ts` says why.
 */

import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoveredSecrets, discover, DEFAULT_BOUNDS } from "@cua/agent"
import type { StuckBounds, Trajectory } from "@cua/agent"
import type { EvidenceEvent } from "@cua/evidence"
import { evidenceFiles } from "@cua/evidence"
import { serve } from "@cua/legacy-core"
import type { CompiledPolicy } from "@cua/policy"
import { DEFAULT_POLICY, POLICIES_DIRECTORY, loadPolicy, policyFrom } from "@cua/policy"
import { playwrightSurface } from "@cua/surface"
import type { SurfaceAdapterService } from "@cua/surface"
import { SurfaceAdapter } from "@cua/surface"
import { Effect, Layer, Result } from "effect"
import type { LanguageModel } from "effect/unstable/ai"

/** The shipped operating policy, loaded the way the CLI loads it. */
export const shippedPolicy = (name: string = DEFAULT_POLICY): CompiledPolicy => {
  const policy = loadPolicy(POLICIES_DIRECTORY, name)
  if (Result.isFailure(policy)) throw new Error(policy.failure.message)
  return policy.success
}

export interface DiscoveryRun {
  readonly trajectory: Trajectory
  readonly events: ReadonlyArray<EvidenceEvent>
  readonly evidenceDirectory: string
}

export interface DiscoveryHarnessOptions {
  readonly goal: string
  readonly model: Layer.Layer<LanguageModel.LanguageModel>
  readonly entry?: string
  readonly policy?: CompiledPolicy
  readonly bounds?: Partial<StuckBounds>
  /**
   * Wraps the real adapter, never replaces it. Ticket 07's harness note: a test
   * overriding the surface is expected to count or observe, not to stub, or the
   * no-browser-stubbing rule stops meaning anything.
   */
  readonly surface?: (
    inner: Layer.Layer<SurfaceAdapter, never, never>
  ) => Layer.Layer<SurfaceAdapter, never, never>
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

      const real = playwrightSurface({ headless: true }) as unknown as Layer.Layer<
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
          scrubber: secrets.registry
        }),
        options.model
      )

      const trajectory = yield* discover({
        goal: options.goal,
        entry: options.entry ?? "/",
        baseUrl,
        runId,
        sessionId: runId,
        secrets,
        bounds: { ...DEFAULT_BOUNDS, ...options.bounds },
        modelName: "scripted"
      }).pipe(Effect.provide(services))

      const directory = join(root, runId)
      const events = readFileSync(join(directory, "events.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as EvidenceEvent)

      return { trajectory, events, evidenceDirectory: directory }
    })
  ) as Effect.Effect<DiscoveryRun, unknown, never>

/**
 * A layer that counts what actually reached the adapter.
 *
 * It forwards every call to the real Playwright adapter — it counts, it does not
 * stub — which is what lets "under a policy that denies everything, the browser
 * is never touched" be demonstrated behaviourally rather than by reading source.
 */
export const counting = (
  tally: Record<string, number>
) =>
(inner: Layer.Layer<SurfaceAdapter, never, never>): Layer.Layer<SurfaceAdapter, never, never> =>
  Layer.effect(SurfaceAdapter)(
    Effect.gen(function*() {
      const adapter = yield* SurfaceAdapter
      const count = (name: string) => {
        tally[name] = (tally[name] ?? 0) + 1
      }
      const wrapped: SurfaceAdapterService = {
        navigate: (url) => {
          count("navigate")
          return adapter.navigate(url)
        },
        observe: adapter.observe,
        resolveTarget: adapter.resolveTarget,
        click: (target) => {
          count("click")
          return adapter.click(target)
        },
        fill: (target, value) => {
          count("fill")
          return adapter.fill(target, value)
        },
        extract: (target) => {
          count("extract")
          return adapter.extract(target)
        },
        waitFor: adapter.waitFor,
        captureEvidence: adapter.captureEvidence
      }
      return wrapped
    })
  ).pipe(Layer.provide(inner)) as Layer.Layer<SurfaceAdapter, never, never>
