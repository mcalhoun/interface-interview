import { readFileSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { serve } from "@cua/legacy-core"
import { replay, shippedArtifact } from "../apps/demo/src/support/replay-harness.ts"

it.live("redacts URL components when a private entry path redirects to a different path", () =>
  Effect.scoped(Effect.gen(function* () {
    const core = yield* serve({ port: 0 })
    const server = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => Response.redirect(`${core.origin}/?token=FRESH_TOKEN_REDIRECT_R92&issued=OBSERVED_QUERY_zQ83#OBSERVED_FRAGMENT_sC92`, 302)
    })), (server) => Effect.sync(() => server.stop(true)))
    const base = shippedArtifact()
    const artifact = { ...base,
      inputs: { ...base.inputs, entryPath: { type: "string" as const, description: "Caller entry path", required: true, sensitive: true } },
      steps: base.steps.map((step, index) => index === 0 ? { ...step,
        action: { type: "navigate" as const, path: { from: "parameter" as const, name: "entryPath" } } } : step)
    }
    const run = yield* replay({ artifact,
      baseUrl: `http://BASE_USER_fJ72:BASE_PASSWORD_pK93@127.0.0.1:${server.port}/?session=BASE_QUERY_mR91#BASE_FRAGMENT_jT28`,
      inputs: { memberId: "12345", entryPath: "/start?token=FRESH_TOKEN_REDIRECT_R92#FRESH_FRAGMENT_fJ78" }
    })
    expect(run.result).toMatchObject({ result: "success", outputs: {
      availableBalance: { type: "money", value: { amount: 4182.55, currency: "USD" } }
    } })
    const disk = readFileSync(join(run.evidenceDirectory, "events.jsonl"), "utf8")
    for (const secret of ["FRESH_TOKEN_REDIRECT_R92", "FRESH_FRAGMENT_fJ78", "BASE_USER_fJ72",
      "BASE_PASSWORD_pK93", "BASE_QUERY_mR91", "BASE_FRAGMENT_jT28", "OBSERVED_QUERY_zQ83", "OBSERVED_FRAGMENT_sC92"]) {
      expect(disk).not.toContain(secret)
      expect(JSON.stringify(run.result)).not.toContain(secret)
    }
  })))

it.live("registers frame URL values before text evidence reflects them", () =>
  Effect.scoped(Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (request) => new Response(new URL(request.url).pathname === "/frame"
        ? '<p>Ready FRAME_QUERY_zJ29 FRAME_FRAGMENT_qM72</p>'
        : '<h1>Open</h1><iframe src="/frame?token=FRAME_QUERY_zJ29#FRAME_FRAGMENT_qM72"></iframe>',
      { headers: { "content-type": "text/html" } })
    })), (server) => Effect.sync(() => server.stop(true)))
    const run = yield* replay({
      artifact: {
        capability: "test.frame-privacy", version: "1.0.0", title: "Frame observation",
        summary: "Observe the loaded frame", authored: "hand-written",
        surface: { kind: "web", product: "Privacy fixture", entry: "/" }, inputs: {}, outputs: {},
        steps: [{ id: "open", intent: "Open the page", action: { type: "navigate", path: { from: "constant", text: "/" } },
          checkpoint: { description: "The frame loaded", expect: [{ assert: "textPresent", text: "Ready" }] } }]
      },
      baseUrl: `http://127.0.0.1:${server.port}`, inputs: {}
    })
    expect(run.result.result).toBe("success")
    const disk = readFileSync(join(run.evidenceDirectory, "events.jsonl"), "utf8")
    expect(disk).toContain("Ready")
    expect(disk).not.toContain("FRAME_QUERY_zJ29")
    expect(disk).not.toContain("FRAME_FRAGMENT_qM72")
  })))
