/**
 * `bun run app` — serve Heritage Core Member Services on a local port.
 *
 * `PORT` overrides the default. `PORT=0` binds a free port and prints the origin,
 * which is how a test harness should start it.
 */

import { Effect } from "effect"
import { DEFAULT_PORT, serve } from "./server.ts"

const configured = Bun.env["PORT"]
const port =
  configured === undefined || configured.trim() === "" ? DEFAULT_PORT : Number(configured)

const program = Effect.gen(function* () {
  const core = yield* serve({ port })
  yield* Effect.log(`Heritage Core Member Services listening on ${core.origin}`)
  yield* Effect.never
})

Effect.runFork(Effect.scoped(program))
