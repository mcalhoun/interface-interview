import { it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { expect } from "vitest"
import { SurfaceAdapter, playwrightSurface } from "@cua/surface"

const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html" } })
const server = (fetch: (request: Request) => Response | Promise<Response>) => Effect.acquireRelease(
  Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })),
  (running) => Effect.sync(() => running.stop(true))
)

it.live("an iframe submit returns the completed child document rather than its old form", () => Effect.gen(function* () {
  const host = yield* server(async (request) => {
    const path = new URL(request.url).pathname
    if (path === "/child") return html('<form action="/done" method="post"><button>Authorize</button></form>')
    if (path === "/done") {
      await Bun.sleep(600)
      return html("<h1>Authorization complete</h1>")
    }
    return html('<h1>Account workspace</h1><iframe src="/child"></iframe>')
  })
  yield* Effect.gen(function* () {
    const surface = yield* SurfaceAdapter
    const state = yield* surface.click({ role: "button", name: "Authorize" })
    expect(state.accessibility).toContain("Authorization complete")
    expect(state.accessibility).not.toContain('button "Authorize"')
    expect(state.frames.some((frame) => frame.url.endsWith("/done"))).toBe(true)
  }).pipe(Effect.provide(playwrightSurface({ startUrl: host.url.origin })))
}).pipe(Effect.scoped))

for (const transition of ["same URL", "another renderer", "an existing child renderer"] as const) {
  it.live(`an iframe submit settles when its destination uses ${transition}`, () => Effect.gen(function* () {
    const host = yield* server(async (request) => {
      const url = new URL(request.url)
      if (request.method === "POST") {
        await Bun.sleep(300)
        return html("<h1>Transfer complete</h1>")
      }
      if (url.pathname === "/child") {
        const destination = transition === "another renderer" ?
          `http://localhost:${url.port}/child` : "/child"
        return html(`<form action="${destination}" method="post"><button>Transfer</button></form>`)
      }
      const child = transition === "an existing child renderer" ? `http://localhost:${url.port}/child` : "/child"
      return html(`<iframe src="${child}"></iframe>`)
    })
    yield* Effect.gen(function* () {
      const surface = yield* SurfaceAdapter
      const state = yield* surface.click({ role: "button", name: "Transfer" })
      expect(state.accessibility).toContain("Transfer complete")
      expect(state.accessibility).not.toContain('button "Transfer"')
    }).pipe(Effect.provide(playwrightSurface({
      startUrl: host.url.origin,
      actionTimeoutMillis: 2_000,
      authorizeOrigin: (url) => [host.url.origin, `http://localhost:${host.port}`].includes(new URL(url).origin)
    })))
  }).pipe(Effect.scoped))
}

for (const childHost of ["127.0.0.1", "localhost"]) {
  it.live(`a child navigation on ${childHost} exceeding its deadline is stopped before human takeover`, () => Effect.gen(function* () {
    const host = yield* server(async (request) => {
      const path = new URL(request.url).pathname
      if (path === "/child") return html('<form action="/late" method="post"><button>Authorize</button></form>')
      if (path === "/late") {
        await Bun.sleep(1_200)
        return html("<h1>Late authorization response</h1>")
      }
      return html(`<iframe src="http://${childHost}:${new URL(request.url).port}/child"></iframe>`)
    })
    yield* Effect.gen(function* () {
      const surface = yield* SurfaceAdapter
      const started = Date.now()
      yield* surface.setDeadline(started + 250)
      const outcome = yield* surface.click({ role: "button", name: "Authorize" }).pipe(Effect.result)
      expect(Result.isFailure(outcome)).toBe(true)
      expect(Date.now() - started).toBeLessThan(750)
      yield* surface.setDeadline(undefined)
      yield* Effect.sleep(1_300)
      const state = yield* surface.observe
      expect(state.accessibility).not.toContain("Late authorization response")
      expect(state.accessibility).toContain('button "Authorize"')
    }).pipe(Effect.provide(playwrightSurface({
      startUrl: host.url.origin,
      authorizeOrigin: (url) => [host.url.origin, `http://localhost:${host.port}`].includes(new URL(url).origin)
    })))
  }).pipe(Effect.scoped))
}
