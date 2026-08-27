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
import { handle } from "./routes.ts"

export const DEFAULT_PORT = 4173

export interface LegacyCoreOptions {
  /** `0` asks the OS for a free port, which is what tests should pass. */
  readonly port?: number
  readonly hostname?: string
}

export interface LegacyCore {
  /** e.g. `http://127.0.0.1:4173`, with no trailing slash. */
  readonly origin: string
  readonly port: number
}

export const serve = (
  options: LegacyCoreOptions = {}
): Effect.Effect<LegacyCore, never, Scope> =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        port: options.port ?? DEFAULT_PORT,
        hostname: options.hostname ?? "127.0.0.1",
        fetch: handle
      })
    ),
    (server) => Effect.promise(() => server.stop(true))
  ).pipe(
    Effect.map((server) => ({
      origin: server.url.origin,
      // `server.port` is optional in Bun's types because a server can be bound to
      // a unix socket; this one never is, so read the port back off the URL.
      port: Number(server.url.port)
    }))
  )
