import { mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"
import { expect } from "vitest"
import { compileArtifact, serializeCompilation, discover, discoveredSecrets } from "@cua/agent"
import { formatArtifact, prepareInputs } from "@cua/artifact"
import { heritagePublicGoalTerms, policyFrom, originAuthorizer } from "@cua/policy"
import { serve } from "@cua/legacy-core"
import { evidenceFiles } from "@cua/evidence"
import { automationOwnedSession } from "@cua/session"
import { playwrightSurface } from "@cua/surface"
import { runDiscovery, shippedPolicy } from "../apps/demo/src/support/discovery-harness.ts"
import { respondingModel } from "../apps/demo/src/support/scripted-model.ts"
import { GOAL, readsTheScreen } from "../apps/demo/src/support/discovery-script.ts"
import { replay } from "../apps/demo/src/support/replay-harness.ts"

const options = { capability: "member.entry-privacy", version: "1.0.0", publicGoalTerms: heritagePublicGoalTerms }

it.live("keeps URL entry secrets out of diagnostics and compilation while replay accepts a fresh entry", () =>
  Effect.gen(function* () {
    const querySecret = "AUDIT_TOKEN_x7B92"
    const fragmentSecret = 'FRAGMENT_PRIVATE_"zB71'
    const run = yield* runDiscovery({ goal: GOAL,
      entry: `/?token=${querySecret}#access_token=${encodeURIComponent(fragmentSecret)}`,
      model: respondingModel(readsTheScreen) })
    expect(run.trajectory.conclusion.conclusion).toBe("reached")
    const diagnostic = JSON.stringify(run.trajectory)
    const events = readFileSync(join(run.evidenceDirectory, "events.jsonl"), "utf8")
    for (const secret of [querySecret, fragmentSecret, encodeURIComponent(fragmentSecret)]) {
      expect(events).not.toContain(secret)
      expect(diagnostic).not.toContain(secret)
    }
    const receipt = serializeCompilation(run.trajectory, options)
    if (Result.isFailure(receipt)) throw receipt.failure
    expect(Result.isSuccess(receipt)).toBe(true)
    const artifact = receipt.success.artifact
    expect(artifact.surface.entry).toBe("/")
    expect(artifact.steps[0]?.action).toMatchObject({ type: "navigate", path: { from: "parameter", name: "entryPath" } })
    expect(artifact.inputs.entryPath).toMatchObject({ type: "string", sensitive: true, required: true })
    expect(artifact.inputs.entryPath?.default).toBeUndefined()
    expect(Result.isFailure(prepareInputs(artifact.capability, artifact.inputs, { memberId: "22222" }))).toBe(true)
    for (const secret of [querySecret, fragmentSecret, encodeURIComponent(fragmentSecret)]) {
      expect(JSON.stringify(receipt.success)).not.toContain(secret)
      expect(formatArtifact(artifact)).not.toContain(secret)
    }
    for (const poison of [querySecret, fragmentSecret, encodeURIComponent(fragmentSecret), "MARGARET T HOLLOWAY"]) {
      const leaked = compileArtifact({ ...run.trajectory,
        conclusion: { conclusion: "reached", summary: `Reads account balance ${poison}` } }, options)
      expect(Result.isFailure(leaked)).toBe(true)
      expect(JSON.stringify(leaked)).not.toContain(poison)
    }
    const repeated = yield* replay({ artifact,
      inputs: { memberId: "22222", entryPath: "/?token=FRESH_TOKEN_c91#access_token=FRESH_FRAGMENT_f87" } })
    expect(repeated.result).toMatchObject({ result: "success",
      outputs: { availableBalance: { type: "money", value: { amount: 812.4, currency: "USD" } } } })
    expect(JSON.stringify(repeated.events)).not.toContain("FRESH_TOKEN_c91")
  }))

it.live("redacts base credentials before run.start and newly observed redirect URL values before evidence", () =>
  Effect.scoped(Effect.gen(function* () {
    const core = yield* serve({ port: 0 })
    const redirect = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => Response.redirect(`${core.origin}/?token=REDIRECT_PRIVATE_jC29#access_token=OBSERVED_FRAGMENT_jC93`, 302)
    })), (server) => Effect.sync(() => server.stop(true)))
    const base = `http://BASE_USER_gB79:BASE_PASSWORD_vC32@127.0.0.1:${redirect.port}/?token=BASE_QUERY_cL82#BASE_FRAGMENT_fK26`
    const root = mkdtempSync(join(tmpdir(), "cua-entry-privacy-"))
    const runId = "url-private-test"
    const secrets = discoveredSecrets()
    const policy = shippedPolicy()
    const trajectory = yield* discover({ goal: GOAL, entry: "/", baseUrl: base,
      runId, sessionId: runId, modelName: "scripted", secrets,
      publicGoalTerms: heritagePublicGoalTerms
    }).pipe(Effect.provide(Layer.mergeAll(
      playwrightSurface({ headless: true, authorizeOrigin: originAuthorizer(policy) }),
      policyFrom(policy), automationOwnedSession(runId), respondingModel(readsTheScreen),
      evidenceFiles({ root, runId, sessionId: runId, scrubber: secrets.registry, allowUnredactedScreenshots: true })
    )))
    expect(trajectory.conclusion.conclusion).toBe("reached")
    const events = readFileSync(join(root, runId, "events.jsonl"), "utf8")
    const diagnostic = JSON.stringify(trajectory)
    for (const secret of ["BASE_USER_gB79", "BASE_PASSWORD_vC32", "BASE_QUERY_cL82", "BASE_FRAGMENT_fK26",
      "REDIRECT_PRIVATE_jC29", "OBSERVED_FRAGMENT_jC93"]) {
      expect(events).not.toContain(secret)
      expect(diagnostic).not.toContain(secret)
      const compiled = compileArtifact({ ...trajectory,
        conclusion: { conclusion: "reached", summary: `Reads account balance ${secret}` } }, options)
      expect(Result.isFailure(compiled)).toBe(true)
      expect(JSON.stringify(compiled)).not.toContain(secret)
    }
  })))

it.live("refuses a model navigation carrying private URL values before writing or executing it", () =>
  Effect.gen(function* () {
    const secret = "MODEL_NAV_TOKEN_pQ72"
    const run = yield* runDiscovery({ goal: GOAL,
      model: respondingModel((prompt, turn) => turn === 0 ? {
        name: "navigate", params: { path: `/?token=${secret}`,
          intent: "open the entry page", rationale: `The entry token is ${secret}` }
      } : readsTheScreen(prompt, turn - 1)) })
    expect(run.trajectory.conclusion.conclusion).toBe("reached")
    expect(readFileSync(join(run.evidenceDirectory, "events.jsonl"), "utf8")).not.toContain(secret)
    expect(JSON.stringify(run.trajectory)).not.toContain(secret)
    expect(run.trajectory.steps.some((step) => step.verb === "navigate")).toBe(false)
    expect(run.events.filter((event) => event.kind === "policy.check" && event.action === "navigate")).toHaveLength(1)
    const compiled = compileArtifact(run.trajectory, options)
    expect(Result.isSuccess(compiled)).toBe(true)
    expect(JSON.stringify(compiled)).not.toContain(secret)
  }))
