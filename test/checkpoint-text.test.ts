import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { evaluateCheckpoint as evaluate } from "@cua/replay"
import { SurfaceAdapter, playwrightSurface, textPresent, textAbsent } from "@cua/surface"

it.live("checkpoints and adapter waits share normalized visible-text semantics", () => Effect.gen(function* () {
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response('<h1>ACCOUNT   READY</h1><p>Available <span>Balance</span></p>', { headers: { "content-type": "text/html" } }) })),
    (server) => Effect.sync(() => server.stop(true))
  )
  yield* Effect.gen(function* () {
    const surface = yield* SurfaceAdapter
    yield* surface.waitFor(textPresent(" account ready "), { timeoutMillis: 0 })
    yield* surface.waitFor(textAbsent("heading"), { timeoutMillis: 0 })
    const context = { surface, read: surface.extract, inputs: new Map(), readings: new Map() }
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
  }).pipe(Effect.provide(playwrightSurface({ startUrl: server.url.origin })))
}).pipe(Effect.scoped))
