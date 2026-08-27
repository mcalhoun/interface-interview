/**
 * `bun run app` — serve Heritage Core Member Services on a local port.
 *
 * `PORT` overrides the default. `PORT=0` binds a free port and prints the origin,
 * which is how a test harness should start it.
 *
 * `EXPIRE_SESSION_AFTER=n` arms the one-shot session-expiry toggle after n page
 * requests, so the mid-flow expiry can be walked through by hand in a headed
 * browser as well as driven by a test.
 */

import { Effect } from "effect"
import { DEFAULT_PORT, serve } from "./server.ts"

const number = (name: string): number | undefined => {
  const configured = Bun.env[name]
  return configured === undefined || configured.trim() === "" ? undefined : Number(configured)
}

const port = number("PORT") ?? DEFAULT_PORT
const expireSessionAfter = number("EXPIRE_SESSION_AFTER")

const program = Effect.gen(function* () {
  const core = yield* serve({
    port,
    ...(expireSessionAfter === undefined ? {} : { expireSessionAfter })
  })
  yield* Effect.log(`Heritage Core Member Services listening on ${core.origin}`)
  yield* Effect.never
})

Effect.runFork(Effect.scoped(program))
