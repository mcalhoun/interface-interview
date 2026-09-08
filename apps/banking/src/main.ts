/**
 * `bun run app` — serve Heritage Core Member Services on a local port.
 *
 * `PORT` overrides the default. `PORT=0` binds a free port and prints the origin,
 * which is how a test harness should start it.
 *
 * `EXPIRE_SESSION_AFTER=n` arms the one-shot session-expiry toggle after n page
 * requests, so the mid-flow expiry can be walked through by hand in a headed
 * browser as well as driven by a test.
 *
 * `--tenant community-cu` (or `TENANT=community-cu`) serves the second
 * institution's installation of the same product: a shorter field caption,
 * different product names, no iframe on Account Detail, and a submit button that
 * reads Find. Run both at once on different ports to see one Capability meet
 * two screens.
 */

import { Effect } from "effect"
import { serve } from "./server.ts"
import { optionsFromEnvironment } from "./environment.ts"
import { DEFAULT_TENANT } from "./tenants.ts"

/** `--tenant <key>`, falling back to `TENANT`, falling back to Heritage Core. */
const flag = (name: string): string | undefined => {
  const at = Bun.argv.indexOf(`--${name}`)
  const supplied = at === -1 ? undefined : Bun.argv[at + 1]
  return supplied === undefined || supplied.startsWith("--") ? undefined : supplied
}

const options = optionsFromEnvironment(Bun.env)
const tenant = flag("tenant") ?? Bun.env["TENANT"] ?? DEFAULT_TENANT

const program = Effect.gen(function* () {
  const core = yield* serve({
    ...options,
    tenant
  })
  yield* Effect.log(
    `${core.tenant.institution} Member Services (tenant ${core.tenant.key}) listening on ${
      core.origin
    }`
  )
  yield* Effect.never
})

Effect.runFork(Effect.scoped(program))
