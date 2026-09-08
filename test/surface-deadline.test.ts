import { it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { expect } from "vitest"
import { SurfaceAdapter, playwrightSurface } from "@cua/surface"

const page = (body: string) => new Response(body, { headers: { "Content-Type": "text/html" } })
const server = (fetch: (request: Request) => Response | Promise<Response>) => Effect.acquireRelease(
  Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })),
  (running) => Effect.sync(() => running.stop(true))
)

it.live("native navigation stops within the absolute deadline while the browser remains usable", () => Effect.gen(function* () {
  const host = yield* server(async (request) => {
    if (new URL(request.url).pathname === "/slow") {
      await Bun.sleep(1_200)
      return page('<h1>Late response</h1>')
    }
    return page('<h1>Ready</h1>')
  })
  yield* Effect.gen(function* () {
    const surface = yield* SurfaceAdapter
    yield* surface.navigate(host.url.origin)
    const started = Date.now()
    yield* surface.setDeadline(started + 100)
    const outcome = yield* surface.navigate(host.url.origin + "/slow").pipe(Effect.result)
    expect(Result.isFailure(outcome)).toBe(true)
    expect(Date.now() - started).toBeLessThan(650)
    yield* surface.setDeadline(undefined)
    yield* Effect.sleep(1_300)
    expect((yield* surface.observe).accessibility).toContain("Ready")
    expect((yield* surface.observe).accessibility).not.toContain("Late response")
    expect((yield* surface.navigate(host.url.origin)).accessibility).toContain("Ready")
  }).pipe(Effect.provide(playwrightSurface({ authorizeOrigin: (url) => new URL(url).origin === host.url.origin })))
}).pipe(Effect.scoped))

for (const action of ["click", "fill"] as const) {
  it.live(`a queued native ${action} cannot mutate after its deadline and human takeover`, () => Effect.gen(function* () {
    const submitted: string[] = []
    const host = yield* server(async (request) => {
      if (new URL(request.url).pathname === "/submit") {
        submitted.push(await request.text())
        return page("Submitted")
      }
      return page(`<form action="/submit" method="POST"><label>Member<input name="member" readonly></label><button disabled>Submit</button></form>
        <script>setTimeout(() => { document.querySelector('input').readOnly = false; document.querySelector('button').disabled = false }, 700)</script>`)
    })
    yield* Effect.gen(function* () {
      const surface = yield* SurfaceAdapter
      const started = Date.now()
      yield* surface.setDeadline(started + 100)
      const operation = action === "click"
        ? surface.click({ role: "button", name: "Submit" })
        : surface.fill({ role: "textbox", name: "Member" }, "12345")
      const outcome = yield* operation.pipe(Effect.result)
      expect(Result.isFailure(outcome)).toBe(true)
      expect(Date.now() - started).toBeLessThan(650)
      yield* surface.setDeadline(undefined)
      yield* Effect.sleep(800)
      expect(submitted).toEqual([])
      expect((yield* surface.observe).accessibility).not.toContain("12345")
      // Clearing the deadline permits a human to use this same live session.
      yield* surface.fill({ role: "textbox", name: "Member" }, "67890")
      expect((yield* surface.observe).accessibility).toContain("67890")
    }).pipe(Effect.provide(playwrightSurface({ startUrl: host.url.origin })))
  }).pipe(Effect.scoped))
}
