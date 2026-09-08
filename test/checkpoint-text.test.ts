import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { expect } from "vitest"
import { createCheckpointEvaluator, evidenceForRun } from "@cua/replay"
import { Evidence } from "@cua/evidence"
import { Policy, policyFrom } from "@cua/policy"
import { Session, automationOwnedSession } from "@cua/session"
import { shippedPolicy } from "../apps/demo/src/support/replay-harness.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SurfaceAdapter, playwrightSurface, textPresent, textAbsent } from "@cua/surface"

it.live("checkpoints and adapter waits share normalized visible-text semantics", () => Effect.gen(function* () {
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response('<h1>ACCOUNT   READY</h1><p>Available <span>Balance</span></p>', { headers: { "content-type": "text/html" } }) })),
    (server) => Effect.sync(() => server.stop(true))
  )
  const root = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "cua-checkpoint-text-"))),
    (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true }))
  )
  yield* Effect.gen(function* () {
    const surface = yield* SurfaceAdapter
    yield* surface.waitFor(textPresent(" account ready "), { timeoutMillis: 0 })
    yield* surface.waitFor(textAbsent("heading"), { timeoutMillis: 0 })
    const evaluator = createCheckpointEvaluator({ surface, policy: yield* Policy, session: yield* Session, evidence: yield* Evidence, inputs: new Map(), readings: new Map() })
    const context = { id: "visible-text", intent: "Check visible text" }
    const evaluate = evaluator.evaluate
    const present = yield* evaluate(context, { description: "Account is ready", expect: [{ assert: "textPresent", text: " account ready " }], withinMillis: 0 })
    expect(present.verdict).toBe("held")
    const acrossNodes = yield* evaluate(context, { description: "Balance label is visible", expect: [{ assert: "textPresent", text: "available balance" }], withinMillis: 0 })
    expect(acrossNodes.verdict).toBe("held")
    const absent = yield* evaluate(context, { description: "Account ready is absent", expect: [{ assert: "textAbsent", text: "ACCOUNT ready" }], withinMillis: 0 })
    expect(absent.verdict).toBe("failed")
    const metadata = yield* evaluate(context, { description: "A role name is visible text", expect: [{ assert: "textPresent", text: "heading" }], withinMillis: 0 })
    expect(metadata.verdict).toBe("failed")
    const metadataAbsent = yield* evaluate(context, { description: "A role name is not visible text", expect: [{ assert: "textAbsent", text: "heading" }], withinMillis: 0 })
    expect(metadataAbsent.verdict).toBe("held")
  }).pipe(Effect.provide(Layer.mergeAll(
    playwrightSurface({ startUrl: server.url.origin }), policyFrom(shippedPolicy()),
    automationOwnedSession("checkpoint-text"),
    evidenceForRun({ root, runId: "checkpoint-text", sessionId: "checkpoint-text", inputs: new Map() })
  )))
}).pipe(Effect.scoped))
