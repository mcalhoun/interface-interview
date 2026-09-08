import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { Effect, Layer, Result } from "effect"
import { discoveryRun } from "@cua/agent"
import { prepareInputs } from "@cua/artifact"
import { serve } from "@cua/legacy-core"
import { heritagePublicGoalTerms, originAuthorizer, policyFrom } from "@cua/policy"
import { automationOwnedSession } from "@cua/session"
import { playwrightSurface } from "@cua/surface"
import { shippedPolicy } from "../apps/demo/src/support/replay-harness.ts"
import { GOAL, readsTheScreen } from "../apps/demo/src/support/discovery-script.ts"
import { respondingModel } from "../apps/demo/src/support/scripted-model.ts"
import { replay } from "../apps/demo/src/support/replay-harness.ts"
import { runDiscovery } from "../apps/demo/src/support/discovery-harness.ts"

for (const poisonSummary of [false, true]) {
  it.live(`public Discovery owns private compilation and ${poisonSummary ? "refuses escaped private metadata" : "requires fresh entry values"}`, () =>
    Effect.scoped(Effect.gen(function* () {
      const secret = 'URL_PRIVATE_"quote\\slash\nvalue_72'
      const core = yield* serve({ port: 0 })
      const policy = shippedPolicy()
      const root = mkdtempSync(join(tmpdir(), "cua-public-discovery-"))
      let calls = 0
      const run = yield* discoveryRun({
        goal: GOAL, entry: `/?token=${encodeURIComponent(secret)}`, baseUrl: core.origin,
        runId: "run", sessionId: "session", modelName: "scripted", providerName: "scripted",
        publicGoalTerms: heritagePublicGoalTerms,
        evidence: { root },
        compilation: { capability: "member.private-entry", version: "1.0.0",
          ...(poisonSummary ? { product: `Private product ${JSON.stringify(secret)}` } : {}) }
      })
      expect(calls).toBe(0)
      const result = yield* run.execute.pipe(Effect.provide(Layer.mergeAll(
        playwrightSurface({ authorizeOrigin: originAuthorizer(policy) }), policyFrom(policy),
        automationOwnedSession("session"), respondingModel((prompt, turn) => {
          calls += 1
          const call = readsTheScreen(prompt, turn)
          return call.name === "succeed" && typeof call.params === "object" && call.params !== null ? { ...call, params: {
            ...call.params, rationale: `The private token is ${secret}`,
          } } : call
        })
      )))
      expect(result.diagnostics.conclusion).toBe("reached")
      expect(calls).toBeGreaterThan(0)
      expect(Object.keys(result).sort()).toEqual(["compilation", "diagnostics"])
      expect(result).not.toHaveProperty("trajectory")
      expect(result).not.toHaveProperty("privateTextScrubber")
      expect(result).not.toHaveProperty("toJSON")
      const serialized = JSON.stringify(result)
      const disk = readFileSync(join(root, "run", "events.jsonl"), "utf8")
      for (const spelling of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), "12345"]) {
        expect(serialized).not.toContain(spelling)
        expect(disk).not.toContain(spelling)
      }
      if (poisonSummary) {
        expect(result.compilation.status).toBe("refused")
        return
      }
      if (result.compilation.status !== "compiled") throw new Error(JSON.stringify(result.compilation))
      const artifact = result.compilation.stored.artifact
      expect(artifact.surface.entry).toBe("/")
      expect(artifact.inputs.entryPath).toMatchObject({ type: "string", sensitive: true, required: true })
      expect(artifact.inputs.entryPath?.default).toBeUndefined()
      expect(Result.isFailure(prepareInputs(artifact.capability, artifact.inputs, { memberId: "22222" }))).toBe(true)
      const repeated = yield* replay({ artifact, inputs: { memberId: "22222", entryPath: "/?token=FRESH_ENTRY_29" } })
      expect(repeated.result.result).toBe("success")
      expect(JSON.stringify(repeated.events)).not.toContain("FRESH_ENTRY_29")
    })), 30_000)
}

it.live("returns safe diagnostics without implicitly requesting compilation", () => Effect.gen(function* () {
  const result = yield* runDiscovery({
    goal: "Read the balance for member PRIVATE_MEMBER_81",
    model: respondingModel(() => ({ name: "escalate", params: {
      code: "NEED_HELP", detail: "Cannot locate PRIVATE_MEMBER_81", rationale: "Check PRIVATE_MEMBER_81"
    } }))
  })
  expect(result.diagnostics.conclusion).toBe("stuck")
  expect(result.compilation).toEqual({ status: "not_requested" })
  expect(JSON.stringify(result)).not.toContain("PRIVATE_MEMBER_81")
  expect(result).not.toHaveProperty("trajectory")
}))

it.live("redacts encoded model prose even when compilation is not requested", () => Effect.gen(function* () {
  const secret = 'URL_PRIVATE_"quote\\slash\nvalue_72'
  const encoded = JSON.stringify(secret)
  let quoted = false
  const result = yield* runDiscovery({ goal: GOAL, entry: `/?token=${encodeURIComponent(secret)}`,
    model: respondingModel((prompt, turn) => {
      const call = readsTheScreen(prompt, turn)
      if (call.name !== "succeed" || typeof call.params !== "object" || call.params === null || quoted) return call
      quoted = true
      return { ...call, params: { ...call.params, summary: `Reads the balance. Token ${encoded}` } }
    })
  })
  expect(result.diagnostics.conclusion).toBe("reached")
  expect(result.compilation.status).toBe("not_requested")
  expect(result.diagnostics.summary).not.toContain(encoded)
  const disk = readFileSync(join(result.evidenceDirectory, "events.jsonl"), "utf8")
  expect(disk).not.toContain(JSON.stringify(encoded).slice(1, -1))
  expect(JSON.stringify(result)).not.toContain(JSON.stringify(encoded).slice(1, -1))
}))
