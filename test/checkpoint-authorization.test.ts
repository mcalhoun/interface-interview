import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"
import { expect } from "vitest"
import type { Assertion, Checkpoint } from "@cua/artifact"
import { Evidence } from "@cua/evidence"
import { compilePolicy, Policy, policyFrom } from "@cua/policy"
import { Session, automationOwnedSession } from "@cua/session"
import { SurfaceAdapter, playwrightSurface } from "@cua/surface"
import { createCheckpointEvaluator, evidenceForRun } from "@cua/replay"

const read: Assertion = {
  assert: "targetReads",
  target: { role: "textbox", name: "Member Number", strategy: "accessible-name", robustness: "The visible label identifies the member number field." },
  equals: { from: "constant", text: "12345" }
}
const checkpoint: Checkpoint = { description: "The member number is present", expect: [read], withinMillis: 0 }
const step = { id: "check-member", intent: "Confirm the member number" }

const exercise = (test: (options: {
  evaluator: ReturnType<typeof createCheckpointEvaluator>
  extracts: () => number
  navigate: () => Effect.Effect<void, unknown>
  events: () => string
}) => Effect.Effect<void, unknown>, options: { allowRead?: boolean; changeDuringPoll?: boolean } = {}) =>
  Effect.gen(function* () {
    const server = () => Effect.acquireRelease(
      Effect.sync(() => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response('<label>Member Number<input value="12345"></label>', { headers: { "content-type": "text/html" } }) })),
      (server) => Effect.sync(() => server.stop(true))
    )
    const first = yield* server()
    const second = yield* server()
    const compiled = compilePolicy("checkpoint-test", {
      policy: "checkpoint-test", description: "Permit reads only on the first page",
      origins: [first.url.origin], actions: options.allowRead ? [{ type: "extract" }] : []
    })
    if (Result.isFailure(compiled)) throw new Error(compiled.failure.message)
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "cua-checkpoint-"))),
      (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true }))
    )
    yield* Effect.gen(function* () {
      const surface = yield* SurfaceAdapter
      const evidence = yield* Evidence
      let extracts = 0
      let observations = 0
      const evaluator = createCheckpointEvaluator({
        surface: {
          ...surface,
          observe: Effect.gen(function* () {
            observations++
            if (options.changeDuringPoll && observations === 2) yield* surface.navigate(second.url.origin)
            return yield* surface.observe
          }),
          extract: (target) => Effect.sync(() => { extracts++ }).pipe(Effect.andThen(surface.extract(target)))
        },
        policy: yield* Policy, session: yield* Session, evidence, inputs: new Map(), readings: new Map()
      })
      yield* test({ evaluator, extracts: () => extracts,
        navigate: () => surface.navigate(second.url.origin).pipe(Effect.asVoid),
        events: () => readFileSync(join(evidence.directory, "events.jsonl"), "utf8") })
    }).pipe(Effect.provide(Layer.mergeAll(
      playwrightSurface({ startUrl: first.url.origin, authorizeOrigin: (url) => [first.url.origin, second.url.origin].includes(new URL(url).origin) }),
      policyFrom(compiled.success), automationOwnedSession("checkpoint-session"),
      evidenceForRun({ root, runId: "checkpoint", sessionId: "checkpoint-session", inputs: new Map() })
    )))
  }).pipe(Effect.scoped)

it.live("the owned evaluator denies outcome-branch reads before extraction", () => exercise(({ evaluator, extracts, events }) => Effect.gen(function* () {
  const result = yield* evaluator.evaluate(step, { ...checkpoint,
    expect: [{ assert: "textPresent", text: "Missing intended state" }],
    orOutcome: [{ code: "MEMBER_FOUND", when: [read] }]
  }).pipe(Effect.result)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure).toMatchObject({ reason: "policy_violation", stepId: step.id })
  expect(extracts()).toBe(0)
  expect(events()).toContain('"verdict":"deny"')
})))

it.live("the owned evaluator denies recovery detection reads before extraction", () => exercise(({ evaluator, extracts }) => Effect.gen(function* () {
  const result = yield* evaluator.detect(step, [read]).pipe(Effect.result)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure).toMatchObject({ reason: "policy_violation" })
  expect(extracts()).toBe(0)
})))

it.live("each evaluation authorizes the current page after navigation", () => exercise(({ evaluator, extracts, navigate, events }) => Effect.gen(function* () {
  expect((yield* evaluator.evaluate(step, checkpoint)).verdict).toBe("held")
  yield* navigate()
  const result = yield* evaluator.evaluate(step, checkpoint).pipe(Effect.result)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure).toMatchObject({ reason: "policy_violation" })
  expect(extracts()).toBe(1)
  expect(events()).toContain('"verdict":"allow"')
  expect(events()).toContain('"verdict":"deny"')
}), { allowRead: true }))

it.live("polling reauthorizes when the observed page changes", () => exercise(({ evaluator, extracts }) => Effect.gen(function* () {
  const result = yield* evaluator.evaluate(step, { ...checkpoint, withinMillis: 500,
    expect: [read, { assert: "textPresent", text: "Still waiting" }]
  }).pipe(Effect.result)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure).toMatchObject({ reason: "policy_violation" })
  expect(extracts()).toBe(1)
}), { allowRead: true, changeDuringPoll: true }))

it.live("stable-page polling keeps one authorization record and a fresh evaluation asks again", () => exercise(({ evaluator, extracts, events }) => Effect.gen(function* () {
  const waiting = { ...checkpoint, withinMillis: 125,
    expect: [read, { assert: "textPresent", text: "Still waiting" } satisfies Assertion]
  }
  expect((yield* evaluator.evaluate(step, waiting)).verdict).toBe("failed")
  expect(extracts()).toBeGreaterThan(1)
  expect(events().match(/"action":"extract"/g)).toHaveLength(1)
  expect((yield* evaluator.evaluate(step, checkpoint)).verdict).toBe("held")
  expect(events().match(/"action":"extract"/g)).toHaveLength(2)
}), { allowRead: true }))
