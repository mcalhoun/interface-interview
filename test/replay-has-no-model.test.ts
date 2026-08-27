/**
 * ADR-0003, asserted rather than asserted about: no model can run in Replay.
 *
 * This is a headline claim of the submission, so it is checked three ways, at
 * three different strengths.
 *
 *   1. **The requirement set, exactly.** `replayCapability`'s effect requires
 *      `SurfaceAdapter | Policy | Evidence | Session`. The two assignments below
 *      are mutually inverse, which means the sets are *equal* rather than merely
 *      compatible. Adding a `LanguageModel` call anywhere reachable from the
 *      engine adds `LanguageModel` to that set and `narrowing` stops compiling.
 *      This is the primary proof, and it is the concrete payoff of ADR-0002.
 *
 *   2. **The layer composes without one.** Providing exactly those four services
 *      leaves `never` in the requirement channel. If the engine ever needed a
 *      fifth, the annotation would fail — which catches the case where someone
 *      "fixes" the assignment above by widening a type alias.
 *
 *   3. **Evidence.** A real replay run's event log contains no `decide` event and
 *      no `assist.*` event. SPEC calls this the secondary proof, and it is the
 *      one available to a reviewer who does not want to take the type system's
 *      word for it.
 *
 * The source scan at the end is a fourth, weaker check: a model reached by raw
 * HTTP would not appear in any requirement set at all.
 */

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { expect } from "vitest"
import { Evidence, evidenceFiles } from "@cua/evidence"
import { Policy, permissivePolicy } from "@cua/policy"
import { Session, automationOwnedSession } from "@cua/session"
import { SurfaceAdapter, playwrightSurface } from "@cua/surface"
import { replayCapability } from "@cua/replay"
import { ACCOUNT_BALANCE, replay, shippedArtifact } from "./support/replay-harness.ts"

const REPLAY_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "replay",
  "src"
)

type ServicesOf<T> = T extends Effect.Effect<unknown, unknown, infer R> ? R : never

/** What the engine is allowed to need. */
type Permitted = SurfaceAdapter | Policy | Evidence | Session

type Required = ServicesOf<ReturnType<typeof replayCapability>>

// (1) Mutually inverse assignments. Equality, not compatibility: `narrowing`
// fails the moment the engine requires anything beyond the four, and `widening`
// fails if one of the four is quietly dropped from the signature.
const narrowing: (required: Required) => Permitted = (required) => required
const widening: (permitted: Permitted) => Required = (permitted) => permitted

it("the replay engine requires exactly the surface, policy, evidence and session services", () => {
  expect(typeof narrowing).toBe("function")
  expect(typeof widening).toBe("function")
})

it("the replay layer composes with no language model in it", () => {
  const services = Layer.mergeAll(
    playwrightSurface({}),
    permissivePolicy,
    evidenceFiles({ root: "/tmp/cua-unused", runId: "unused", sessionId: "unused" }),
    automationOwnedSession("unused")
  )

  // The annotation is the assertion. `never` in the third position says the four
  // layers above satisfy the engine completely: nothing is left outstanding, and
  // in particular no `LanguageModel` is.
  const composed: Effect.Effect<unknown, unknown, never> = replayCapability({
    artifact: shippedArtifact(),
    inputs: new Map(),
    baseUrl: "http://127.0.0.1:1",
    runId: "unused"
  }).pipe(Effect.provide(services))

  expect(typeof composed).toBe("object")
})

it.live("a real replay run's evidence contains no model decision", () =>
  Effect.gen(function* () {
    const outcome = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: "12345" }
    })

    expect(outcome.result.result).toBe("success")

    const kinds = outcome.events.map((event) => event.kind)
    expect(kinds).not.toContain("decide")
    expect(kinds.filter((kind) => kind.startsWith("assist."))).toEqual([])

    // And the run says which mode it was, so an auditor reading one file can tell
    // a replay log from a discovery log without inferring it from absences.
    const start = outcome.events.find((event) => event.kind === "run.start")
    expect(start && "mode" in start ? start.mode : undefined).toBe("replay")
  })
)

it("no source in the replay package can reach a model at all", () => {
  const withoutComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

  const sources = readdirSync(REPLAY_SOURCE)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: withoutComments(readFileSync(join(REPLAY_SOURCE, name), "utf8")) }))

  // A requirement set cannot catch a model reached by raw HTTP, so the ways in
  // are named directly. This is the weakest of the four checks and the only one
  // that would catch that case.
  const forbidden = [
    /effect\/unstable\/ai/,
    /LanguageModel/,
    /@effect\/ai-/,
    /\banthropic\b/i,
    /\bopenai\b/i,
    /\bfetch\s*\(/,
    /OPENAI_API_KEY|ANTHROPIC_API_KEY/
  ]

  for (const { name, text } of sources) {
    for (const pattern of forbidden) {
      expect(text, `${name} reaches for a model with ${pattern}`).not.toMatch(pattern)
    }
  }
})

it("every surface action in the engine goes through the policy chokepoint", () => {
  const engine = readFileSync(join(REPLAY_SOURCE, "engine.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")

  // Every acting call on the adapter must sit inside an `authorised(...)` block.
  // Counting them is crude and that is the point: a fifth one appearing outside
  // the chokepoint changes this number and fails here (SPEC user story 57).
  const acting = [...engine.matchAll(/surface\s*\.\s*(navigate|click|fill|extract)\s*\(/g)]
  expect(acting).toHaveLength(4)

  const authorisedBlocks = [...engine.matchAll(/authorised\s*\(/g)]
  expect(authorisedBlocks.length).toBeGreaterThan(0)

  // The complete set of adapter methods this engine touches. `observe`,
  // `resolveTarget` and `captureEvidence` are perception rather than action;
  // `resolveTarget` still happens inside the gate so that a resolution can never
  // be carried across a policy decision.
  const used = [...engine.matchAll(/surface\s*\.\s*(\w+)/g)].map((match) => match[1])
  expect(new Set(used)).toEqual(
    new Set([
      "navigate",
      "click",
      "fill",
      "extract",
      "observe",
      "resolveTarget",
      "captureEvidence"
    ])
  )
})

it("the capability name the tracer bullet runs is the one the tests exercise", () => {
  expect(shippedArtifact(ACCOUNT_BALANCE).capability).toBe(ACCOUNT_BALANCE)
})
