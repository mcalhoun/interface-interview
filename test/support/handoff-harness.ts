/**
 * One Heritage Core, one browser, one Session, and a person at the operator
 * interface — all in one process, which is the point (ADR-0009).
 *
 * The "person" here drives the same two things a person drives: the operator
 * interface over HTTP, and the live browser window. Nothing is stubbed. The
 * operator's browser handle *is* the `SurfaceAdapter` the automation was using,
 * because there is only one Session and that is what a handoff means — a test
 * that gave the Operator a second browser would be testing a different design.
 *
 * The replay runs on a forked fiber so the test can act while it is parked on
 * its `Deferred`, exactly as a real run and a real person overlap in time.
 */

import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serve } from "@cua/legacy-core"
import { type CapabilityArtifact, type ResolvedInputs, prepareInputs } from "@cua/artifact"
import type { EvidenceEvent } from "@cua/evidence"
import { serveOperator } from "@cua/operator"
import { Policy, declassifierFor, policyFrom, sensitivityPolicy } from "@cua/policy"
import {
  type HandoffSnapshot,
  Session,
  SessionControl,
  handoffSession,
  sessionControl
} from "@cua/session"
import { type SurfaceAdapterService, SurfaceAdapter, playwrightSurface } from "@cua/surface"
import { type ReplayResult, evidenceForRun, replayCapability } from "@cua/replay"
import { Effect, Fiber, Layer, Result } from "effect"
import { shippedPolicy } from "./replay-harness.ts"

/** Long enough for a person in a test, short enough that a hang is a failure. */
const DEFAULT_WAIT_MILLIS = 30_000

/** What the "Operator" is handed. Everything a real one has, and nothing more. */
export interface OperatorDesk {
  /** The operator interface's own origin. Reached over HTTP, like a person. */
  readonly origin: string
  /** The operator-facing half of the Session. What the HTTP handlers call. */
  readonly control: SessionControl["Service"]
  /**
   * The live browser the automation was driving. The Operator's hands.
   *
   * That this is the same value the engine holds is the whole claim of ADR-0009,
   * and it is why `observe` here shows the screen the run stopped on.
   */
  readonly surface: SurfaceAdapterService
  /** Blocks until the run pauses. Fails the test rather than hanging forever. */
  readonly awaitPause: Effect.Effect<HandoffSnapshot>
  readonly awaitOwner: (owner: HandoffSnapshot["owner"]) => Effect.Effect<HandoffSnapshot>
  readonly get: (path: string) => Effect.Effect<{ status: number; body: string }>
  readonly post: (
    path: string,
    fields: Readonly<Record<string, string>>
  ) => Effect.Effect<{ status: number; body: string }>
  /** The snapshot as the interface serves it, not as the machine holds it. */
  readonly served: Effect.Effect<HandoffSnapshot>
  /**
   * Another run of the same capability, on the same live Session, with its own
   * Evidence. The only way to ask "what happens if the engine acts while the
   * Operator holds control" without pretending to be the engine.
   */
  readonly replayAgain: (
    runId: string
  ) => Effect.Effect<ReplayResult, unknown, SurfaceAdapter | Policy | Session>
}

export interface AttendedOutcome {
  readonly result: ReplayResult
  readonly events: ReadonlyArray<EvidenceEvent>
  readonly evidenceDirectory: string
  readonly snapshot: HandoffSnapshot
}

export interface AttendedOptions {
  readonly artifact: CapabilityArtifact
  readonly inputs: Readonly<Record<string, string>>
  readonly runId?: string
  /**
   * `false` leaves no operator interface attached, which is what every
   * unattended run in the world looks like. The engine then has nobody to
   * escalate to and reports a Hard Failure instead.
   */
  readonly attended?: boolean
  readonly waitMillis?: number
  /**
   * The person. Runs concurrently with the replay, inside the same provided
   * services — which is how it can act on the same live browser and, in the
   * guard test, run a second replay against the same Session.
   */
  readonly operate?: (
    desk: OperatorDesk
  ) => Effect.Effect<void, unknown, SurfaceAdapter | Policy | Session>
}

export const attendedReplay = (
  options: AttendedOptions
): Effect.Effect<AttendedOutcome, unknown> =>
  Effect.gen(function* () {
    const core = yield* serve({ port: 0 })
    // The same sensitivity policy the CLI runs under. A handoff run writes the
    // same Evidence every other run does, redaction included, so nothing here is
    // a test-only arrangement.
    const prepared = prepareInputs(
      options.artifact.capability,
      options.artifact.inputs,
      options.inputs,
      declassifierFor(sensitivityPolicy, options.artifact.capability)
    )
    if (Result.isFailure(prepared)) return yield* Effect.fail(prepared.failure)

    const root = mkdtempSync(join(tmpdir(), "cua-handoff-"))
    const runId = options.runId ?? "run"
    const sessionId = `session-${runId}`
    const waitMillis = options.waitMillis ?? DEFAULT_WAIT_MILLIS

    const services = Layer.mergeAll(
      playwrightSurface({}),
      // A real shipped Policy, like every other replay test: an escalation that
      // only happens because policy was switched off would prove nothing.
      policyFrom(shippedPolicy()),
      handoffSession.pipe(
        Layer.provideMerge(
          sessionControl({ sessionId, waitMillis }).pipe(
            Layer.provideMerge(
              evidenceForRun({
                root,
                runId,
                sessionId,
                inputs: prepared.success,
                policy: `Sensitivity policy: ${sensitivityPolicy.summary}`
              })
            )
          )
        )
      )
    )

    const { result, snapshot } = yield* Effect.gen(function* () {
      const control = yield* SessionControl
      const surface = yield* SurfaceAdapter

      const operator =
        options.attended === false
          ? undefined
          : yield* serveOperator({ control, port: 0, hostname: "127.0.0.1" })

      const running = yield* Effect.forkChild(
        replayCapability({
          artifact: options.artifact,
          inputs: prepared.success,
          baseUrl: core.origin,
          runId
        })
      )

      if (options.operate !== undefined && operator !== undefined) {
        yield* options.operate(desk(operator.origin, control, surface, waitMillis, () => ({
          artifact: options.artifact,
          inputs: prepared.success,
          baseUrl: core.origin,
          root
        })))
      }

      const finished = yield* Fiber.join(running)
      return { result: finished, snapshot: yield* control.snapshot }
    }).pipe(Effect.provide(services))

    const evidenceDirectory = join(root, runId)
    const events = readFileSync(join(evidenceDirectory, "events.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as EvidenceEvent)

    return { result, events, evidenceDirectory, snapshot }
  }).pipe(Effect.scoped)

// ---------------------------------------------------------------------------

const desk = (
  origin: string,
  control: SessionControl["Service"],
  surface: SurfaceAdapterService,
  waitMillis: number,
  again: () => {
    readonly artifact: CapabilityArtifact
    readonly inputs: ResolvedInputs
    readonly baseUrl: string
    readonly root: string
  }
): OperatorDesk => {
  const request = (
    path: string,
    init?: RequestInit
  ): Effect.Effect<{ status: number; body: string }> =>
    Effect.promise(async () => {
      const response = await fetch(origin + path, { redirect: "manual", ...init })
      return { status: response.status, body: await response.text() }
    })

  const awaitOwner = (owner: HandoffSnapshot["owner"]): Effect.Effect<HandoffSnapshot> =>
    Effect.gen(function* () {
      const deadline = Date.now() + waitMillis
      while (true) {
        const snapshot = yield* control.snapshot
        if (snapshot.owner === owner) return snapshot
        if (Date.now() > deadline) {
          return yield* Effect.die(
            new Error(`the session never became ${owner}; it is ${snapshot.ownerLabel}`)
          )
        }
        yield* Effect.sleep(25)
      }
    })

  return {
    origin,
    control,
    surface,
    awaitPause: awaitOwner("paused"),
    awaitOwner,
    get: (path) => request(path),
    post: (path, fields) =>
      request(path, { method: "POST", body: new URLSearchParams(fields) }),
    served: request("/state").pipe(
      Effect.map((response) => JSON.parse(response.body) as HandoffSnapshot)
    ),
    replayAgain: (runId) =>
      Effect.suspend(() => {
        const { artifact, inputs, baseUrl, root } = again()
        return replayCapability({ artifact, inputs, baseUrl, runId }).pipe(
          Effect.provide(
            evidenceForRun({ root, runId, sessionId: `session-${runId}`, inputs })
          )
        )
      })
  }
}
