/**
 * Evidence as a contract.
 *
 * SPEC: "Schema validates the union on write. That makes the evidence itself a
 * contract, and makes 'no model decided anything in replay' assertable by a test
 * over the files." A log that accepts anything is not evidence of anything, so
 * the writer's rejection of a malformed event is as much the product as its
 * acceptance of a valid one.
 *
 * The scrubbing seam is checked here too. Ticket 08 supplies the real scrubber;
 * what ticket 03 owes it is a single point where one can be inserted and be sure
 * of seeing everything.
 */

import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { expect } from "vitest"
import {
  type EvidenceEvent,
  type Scrubber,
  Evidence,
  EvidenceEventSchema,
  KINDS_FORBIDDEN_IN_REPLAY,
  evidenceFiles,
  noScrubbing
} from "@cua/evidence"

const withEvidence = <A, E>(
  body: (evidence: Evidence["Service"], directory: string) => Effect.Effect<A, E>,
  scrubber: Scrubber = noScrubbing
) =>
  Effect.gen(function* () {
    const root = mkdtempSync(join(tmpdir(), "cua-evidence-test-"))
    const layer: Layer.Layer<Evidence, unknown> = evidenceFiles({
      root,
      runId: "r1",
      sessionId: "s1",
      scrubber
    })
    return yield* Effect.gen(function* () {
      const evidence = yield* Evidence
      return yield* body(evidence, join(root, "r1"))
    }).pipe(Effect.provide(layer))
  }).pipe(Effect.scoped)

const linesOf = (directory: string): ReadonlyArray<EvidenceEvent> =>
  readFileSync(join(directory, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EvidenceEvent)

it.live("stamps the envelope on every event so records join up afterwards", () =>
  withEvidence((evidence, directory) =>
    Effect.gen(function* () {
      yield* evidence.record({ kind: "outcome", code: "SUCCESS", detail: "first" })
      yield* evidence.record({ kind: "outcome", stepId: "step-2", code: "SUCCESS", detail: "second" })

      const written = linesOf(directory)
      expect(written.map((event) => event.seq)).toEqual([0, 1])
      expect(written.every((event) => event.runId === "r1" && event.sessionId === "s1")).toBe(true)
      expect(written[1]?.stepId).toBe("step-2")
    })
  )
)

it.live("refuses to write an event that does not satisfy the schema", () =>
  withEvidence((evidence, directory) =>
    Effect.gen(function* () {
      // A malformed event is what a future ticket's bug looks like from here, and
      // a log that swallowed it would be worse than no log.
      const rejected = yield* evidence
        .record({ kind: "outcome", code: 404 } as never)
        .pipe(Effect.flip)
      expect(rejected._tag).toBe("EvidenceUnwritable")
      expect(rejected.reason).toContain("schema")

      // Nothing partial reached the file.
      expect(() => linesOf(directory)).toThrow()
    })
  )
)

it.live("passes every string through the scrubber before it is written", () =>
  withEvidence(
    (evidence, directory) =>
      Effect.gen(function* () {
        yield* evidence.record({
          kind: "observe",
          url: "http://example/member?memberNumber=12345",
          title: "Member 12345",
          frames: ["main"],
          accessibility: 'cell "12345"'
        })

        // Ticket 08's real scrubber replaces declared sensitive values with a
        // labelled placeholder. What this pins is that it will see all of them —
        // nested, in arrays, in fields nobody thought to list — from one place.
        const written = JSON.stringify(linesOf(directory))
        expect(written).not.toContain("12345")
        expect(written).toContain("[redacted:memberId]")
      }),
    (text) => text.replaceAll("12345", "[redacted:memberId]")
  )
)

it.live("writes a screenshot beside the log, unscrubbed and stated as such", () =>
  withEvidence((evidence, directory) =>
    Effect.gen(function* () {
      yield* evidence.attach("final.png", new Uint8Array([137, 80, 78, 71]))
      expect(readFileSync(join(directory, "final.png")).byteLength).toBe(4)
      expect(readFileSync(join(directory, "README.txt"), "utf8")).toContain("NOT redacted")
    })
  )
)

it("defines every event kind SPEC lists, including the ones replay may never emit", () => {
  const kinds = new Set(
    EvidenceEventSchema.members.map(
      (member) => (member.fields.kind as { readonly literal: string }).literal
    )
  )

  const SPEC_KINDS = [
    "run.start",
    "observe",
    "decide",
    "policy.check",
    "action",
    "checkpoint",
    "outcome",
    "assist.request",
    "assist.proposal",
    "intervention.raise",
    "intervention.human_action",
    "intervention.resolve",
    "run.end"
  ]
  for (const kind of SPEC_KINDS) expect(kinds, `SPEC lists ${kind}`).toContain(kind)

  // `decide` has to be a thing that could have been written for "a replay run
  // contains no decide event" to be a claim worth testing.
  expect(KINDS_FORBIDDEN_IN_REPLAY).toEqual(["decide"])

  // Six additions to SPEC's list, and every group is added for the reason SPEC
  // itself gives for `assist.*` having its own kinds rather than reusing
  // `decide`.
  //
  // The `recovery.*` three: getting past a transient state unattended must not
  // be able to hide inside an ordinary `action` or a re-run `checkpoint`.
  //
  // `assist.declined` (ticket 15): a consultation that produced no proposal must
  // say so and say why. Without it, a rung that could not reach a model and a
  // rung whose answer was dropped on the floor look identical in the log, and
  // "every assisted-recovery decision recorded as evidence" would hold only for
  // the decisions that went well.
  //
  // `assist.target_proposal` (ticket 16): a proposed *outcome* is something the
  // run may act on and a proposed *control* is something only a person may act
  // on. One kind for both would put "the model classified this state" and "the
  // model suggested a button to somebody" on the same line.
  //
  // `override.applied` (ticket 16): a run against a tenant executes the base
  // capability plus that tenant's confirmed delta, and which document actually
  // ran is the first thing an auditor asks. Without it the log of a run against
  // an institution whose button reads Find is identical to one against an
  // institution whose button reads Search.
  //
  // Pinning the whole set here means a further kind is a decision somebody has
  // to make on purpose.
  const RECOVERY_KINDS = ["recovery.detected", "recovery.attempt", "recovery.resolved"]
  const ASSIST_KINDS = ["assist.declined", "assist.target_proposal"]
  const TENANT_KINDS = ["override.applied"]
  expect(kinds).toEqual(
    new Set([...SPEC_KINDS, ...RECOVERY_KINDS, ...ASSIST_KINDS, ...TENANT_KINDS])
  )
})
