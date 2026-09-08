import { it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { expect } from "vitest"
import { SurfaceAdapter, playwrightSurface } from "@cua/surface"

const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html" } })

const fixture = (body: (other: string) => string) => Effect.acquireRelease(
  Effect.sync(() => {
    const received: Array<{ url: string; body: string }> = []
    const other = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      received.push({ url: request.url, body: await request.text() })
      return html('<label>Member Number<input></label><button>Search</button><p>Private balance</p>')
    } })
    const host = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/chain") return Response.redirect(new URL("/redirect", request.url).href, 307)
      if (path === "/redirect") return Response.redirect(other.url.origin + "/leak?member=12345", 307)
      if (path === "/allowed") return html('<label>Member Number<input></label><button>Search</button><p>Private balance</p>')
      return html(body(other.url.origin))
    } })
    return { host: host.url.origin, other: other.url.origin, received, stop() { host.stop(true); other.stop(true) } }
  }),
  (servers) => Effect.sync(() => servers.stop())
)

it.live("a forbidden iframe receives no requests and cannot be filled or read", () => Effect.gen(function* () {
  const servers = yield* fixture((other) => `<iframe src="${other}/"></iframe>`)
  const outcome = yield* Effect.gen(function* () {
    const surface = yield* SurfaceAdapter
    yield* surface.fill({ role: "textbox", name: "Member Number" }, "12345")
    return yield* surface.extract({ name: "Private balance" })
  }).pipe(Effect.provide(playwrightSurface({ startUrl: servers.host })), Effect.result)
  expect(Result.isFailure(outcome)).toBe(true)
  expect(servers.received).toEqual([])
}).pipe(Effect.scoped))

for (const kind of ["link", "get", "post", "redirect", "chain"] as const) {
  it.live(`blocks off-origin ${kind} before member data reaches its destination`, () => Effect.gen(function* () {
    const servers = yield* fixture((other) => kind === "link"
      ? `<a href="${other}/leak?member=12345">Continue</a>`
      : `<form method="${kind === "get" ? "GET" : "POST"}" action="${kind === "redirect" ? "/redirect" : kind === "chain" ? "/chain" : other + "/leak"}"><label>Member Number<input name="member"></label><button>Continue</button></form>`)
    const outcome = yield* Effect.gen(function* () {
      const surface = yield* SurfaceAdapter
      if (kind !== "link") yield* surface.fill({ role: "textbox", name: "Member Number" }, "12345")
      return yield* surface.click({ role: kind === "link" ? "link" : "button", name: "Continue" })
    }).pipe(Effect.provide(playwrightSurface({ startUrl: servers.host })), Effect.result)
    expect(Result.isFailure(outcome)).toBe(true)
    expect(servers.received).toEqual([])
  }).pipe(Effect.scoped))
}

it.live("same-origin iframe controls still work", () => Effect.gen(function* () {
  const servers = yield* fixture(() => '<iframe src="/allowed"></iframe>')
  yield* Effect.gen(function* () {
    const surface = yield* SurfaceAdapter
    yield* surface.fill({ role: "textbox", name: "Member Number" }, "12345")
    const screen = yield* surface.click({ role: "button", name: "Search" })
    expect(screen.accessibility).toContain("12345")
    expect(screen.accessibility).toContain("Private balance")
  }).pipe(Effect.provide(playwrightSurface({ startUrl: servers.host })))
}).pipe(Effect.scoped))


it.live("explicitly permitted cross-origin frames can fill, click and extract", () => Effect.gen(function* () {
  const servers = yield* fixture((other) => `<iframe src="${other}/"></iframe>`)
  yield* Effect.gen(function* () {
    const surface = yield* SurfaceAdapter
    yield* surface.fill({ role: "textbox", name: "Member Number" }, "12345")
    yield* surface.click({ role: "button", name: "Search" })
    expect(yield* surface.extract({ name: "Private balance" })).toContain("Private balance")
  }).pipe(Effect.provide(playwrightSurface({
    startUrl: servers.host,
    authorizeOrigin: (url) => [servers.host, servers.other].includes(new URL(url).origin)
  })))
}).pipe(Effect.scoped))

for (const operation of ["fill", "click", "extract"] as const) {
  it.live(`rechecks frame origins before ${operation} even when the outer document remains allowed`, () => Effect.gen(function* () {
    const servers = yield* fixture((other) => `<iframe src="${other}/"></iframe>`)
    let allowChild = true
    yield* Effect.gen(function* () {
      const surface = yield* SurfaceAdapter
      allowChild = false
      const action = operation === "fill"
        ? surface.fill({ role: "textbox", name: "Member Number" }, "12345").pipe(Effect.asVoid)
        : operation === "click" ? surface.click({ role: "button", name: "Search" }).pipe(Effect.asVoid)
          : surface.extract({ name: "Private balance" }).pipe(Effect.asVoid)
      const result = yield* action.pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure._tag).toBe("SurfaceUnavailable")
    }).pipe(Effect.provide(playwrightSurface({
      startUrl: servers.host,
      authorizeOrigin: (url) => new URL(url).origin === servers.host ||
        (allowChild && new URL(url).origin === servers.other)
    })))
  }).pipe(Effect.scoped))
}

it.live("without an initial origin or explicit gate, navigation is denied", () => Effect.gen(function* () {
  const servers = yield* fixture(() => "Allowed only explicitly")
  yield* Effect.gen(function* () {
    const surface = yield* SurfaceAdapter
    const result = yield* surface.navigate(servers.other).pipe(Effect.result)
    expect(Result.isFailure(result)).toBe(true)
    expect(servers.received).toEqual([])
  }).pipe(Effect.provide(playwrightSurface()))
}).pipe(Effect.scoped))


it.live("a cross-site iframe cannot redirect a submitted member number to a forbidden origin", () => Effect.gen(function* () {
  const received: string[] = []
  const sink = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({
    hostname: "127.0.0.1", port: 0, async fetch(request) {
      received.push(await request.text())
      return html("Member data received")
    }
  })), (server) => Effect.sync(() => server.stop(true)))
  const child = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({
    hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname === "/submit") return Response.redirect(sink.url.origin, 307)
      return html('<form action="/submit" method="POST"><label>Member Number<input name="member"></label><button>Continue</button></form>')
    }
  })), (server) => Effect.sync(() => server.stop(true)))
  const childOrigin = `http://localhost:${child.port}`
  const host = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({
    hostname: "127.0.0.1", port: 0, fetch() {
      return html(`<iframe src="${childOrigin}/"></iframe>`)
    }
  })), (server) => Effect.sync(() => server.stop(true)))
  yield* Effect.gen(function* () {
    const surface = yield* SurfaceAdapter
    yield* surface.fill({ role: "textbox", name: "Member Number" }, "12345")
    const result = yield* surface.click({ role: "button", name: "Continue" }).pipe(Effect.result)
    // A cross-site frame can start its redirect after the click returns.
    // Keep the browser alive so a late request cannot hide behind scope cleanup.
    yield* Effect.sleep(250)
    const after = yield* surface.observe.pipe(Effect.result)
    expect(received).toEqual([])
    expect(Result.isFailure(result) || Result.isFailure(after)).toBe(true)
  }).pipe(Effect.provide(playwrightSurface({
    startUrl: host.url.origin,
    authorizeOrigin: (url) => [host.url.origin, childOrigin].includes(new URL(url).origin)
  })))
}).pipe(Effect.scoped))


it.live("allowed redirects preserve the final browser location", () => Effect.gen(function* () {
  const servers = yield* fixture(() => '<a href="/chain">Continue</a>')
  yield* Effect.gen(function* () {
    const surface = yield* SurfaceAdapter
    const screen = yield* surface.click({ role: "link", name: "Continue" })
    expect(screen.url).toBe(servers.other + "/leak?member=12345")
    expect(screen.accessibility).toContain("Private balance")
  }).pipe(Effect.provide(playwrightSurface({
    startUrl: servers.host,
    authorizeOrigin: (url) => [servers.host, servers.other].includes(new URL(url).origin)
  })))
}).pipe(Effect.scoped))
