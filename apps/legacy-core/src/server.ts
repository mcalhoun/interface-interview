/**
 * Heritage Core's lifecycle.
 *
 * `@effect/platform-bun` at this RC exports no Bun HTTP server, so the server
 * itself is `Bun.serve`, wrapped as a scoped Effect resource. Closing the Scope
 * stops the server, which is what lets a test open one per suite and be sure the
 * port is released again.
 */

import { Effect } from "effect"
import type { Scope } from "effect/Scope"
import type { TransientOptions } from "./conditions.ts"
import { transientState } from "./conditions.ts"
import { router } from "./routes.ts"
import { type Tenant, DEFAULT_TENANT, tenantFor } from "./tenants.ts"

export const DEFAULT_PORT = 4173

export interface LegacyCoreOptions extends TransientOptions {
  /** `0` asks the OS for a free port, which is what tests should pass. */
  readonly port?: number
  readonly hostname?: string
  /**
   * Which institution's installation this is: `heritage-core` (the default) or
   * `community-cu`.
   *
   * One server per tenant rather than one server serving both, because that is
   * what two institutions actually are — two installations on two hosts — and
   * because Policy checks the origin a run is on. A tenant selected by a query
   * parameter would make "which installation is this" a property of a URL that
   * an automation could change.
   */
  readonly tenant?: string
}

export interface LegacyCore {
  /** e.g. `http://127.0.0.1:4173`, with no trailing slash. */
  readonly origin: string
  /** The institution this installation belongs to. */
  readonly tenant: Tenant
  readonly port: number
  /** Page requests served so far, for a test explaining what fired when. */
  readonly pageRequests: () => number
}

export const serve = (
  options: LegacyCoreOptions = {}
): Effect.Effect<LegacyCore, never, Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      // One state per server, so two servers in one test process cannot see each
      // other's transient conditions.
      const state = transientState(options)
      const tenant = tenantFor(options.tenant ?? DEFAULT_TENANT)
      return {
        server: Bun.serve({
          port: options.port ?? DEFAULT_PORT,
          hostname: options.hostname ?? "127.0.0.1",
          fetch: router(state, tenant)
        }),
        state,
        tenant
      }
    }),
    ({ server }) => Effect.promise(() => server.stop(true))
  ).pipe(
    Effect.map(({ server, state, tenant }) => ({
      origin: server.url.origin,
      tenant,
      // `server.port` is optional in Bun's types because a server can be bound to
      // a unix socket; this one never is, so read the port back off the URL.
      port: Number(server.url.port),
      pageRequests: state.pageRequests
    }))
  )
