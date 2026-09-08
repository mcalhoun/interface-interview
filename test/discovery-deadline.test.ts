import { it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { expect } from "vitest"
import { runDiscovery } from "./support/private-discovery-harness.ts"
import { DEFAULT_BOUNDS, discoveredSecrets } from "@cua/agent"
import { discover } from "../packages/agent/src/loop.ts"
import { evidenceFiles } from "@cua/evidence"
import { originAuthorizer, policyFrom } from "@cua/policy"
import { automationOwnedSession } from "@cua/session"
import { playwrightSurface } from "@cua/surface"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { shippedPolicy } from "../apps/demo/src/support/replay-harness.ts"
import { scriptedModel } from "../apps/demo/src/support/scripted-model.ts"

it.live("a silent model cannot outlive discovery's wall-clock budget", () =>
  Effect.gen(function* () {
    const model = Layer.effect(LanguageModel.LanguageModel)(LanguageModel.make({
      generateText: () => Effect.never,
      streamText: () => Stream.empty
    }))
    const result = yield* runDiscovery({ goal: "Read a balance", model, bounds: { maxMillis: 150 } })
    expect(result.trajectory.conclusion).toMatchObject({ conclusion: "stuck", trigger: { trigger: "deadline" } })
    expect(result.trajectory.durationMillis).toBeLessThan(1_000)
    expect(result.events.at(-1)?.kind).toBe("run.end")
  }), 3_000)

it.live("a slow permitted application cannot outlive discovery's navigation budget", () =>
  Effect.scoped(Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: async () => {
        await Bun.sleep(2_000)
        return new Response("<h1>Slow application</h1>", { headers: { "Content-Type": "text/html" } })
      }
    })), (server) => Effect.sync(() => server.stop(true)))
    const secrets = discoveredSecrets()
    const policy = shippedPolicy()
    const trajectory = yield* discover({
      goal: "Read balance", entry: "/", baseUrl: server.url.toString(),
      runId: "run", sessionId: "slow-session", secrets, modelName: "scripted",
      bounds: { ...DEFAULT_BOUNDS, maxMillis: 150 }
    }).pipe(Effect.provide(Layer.mergeAll(
      playwrightSurface({ authorizeOrigin: originAuthorizer(policy) }), policyFrom(policy),
      automationOwnedSession("slow-session"),
      evidenceFiles({ root: mkdtempSync(join(tmpdir(), "cua-slow-discovery-")), runId: "run", sessionId: "slow-session", scrubber: secrets.registry }),
      scriptedModel([{ name: "escalate", params: { code: "UNEXPECTED", detail: "Should not reach the model" } }])
    )))
    expect(trajectory.conclusion).toMatchObject({ conclusion: "stuck", trigger: { trigger: "deadline" } })
    expect(trajectory.durationMillis).toBeLessThan(1_000)
  })), 5_000)
