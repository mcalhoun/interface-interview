/**
 * The Evidence service: one `events.jsonl` per run, plus attachments.
 *
 * ## The single serialisation point
 *
 * Everything written passes through `record`, and `record` does exactly three
 * things in order: stamp the envelope, scrub, validate against the schema. That
 * ordering is the design.
 *
 * *Scrub* is the seam ticket 08 fills. SPEC: "Text evidence, meaning
 * accessibility snapshots and event logs, passes a scrub replacing known
 * sensitive parameter values with a labelled placeholder, at the single point
 * where evidence gets serialized." There is one such point, it is `record`, and
 * the `Scrubber` below is currently the identity function. Nothing else in the
 * system may write to the evidence directory, which is what makes "keeping
 * sensitive values out of logs by construction" (user story 59) a property of the
 * code rather than of everyone's discipline.
 *
 * *Validate* comes after scrubbing rather than before, so a scrubber that
 * corrupts an event is caught by the same check that catches a malformed one.
 * SPEC: "Schema validates the union on write. That makes the evidence itself a
 * contract."
 *
 * Screenshots do not pass the scrubber and are stated as unredacted; see
 * ADR-0010 and the note this writes into every evidence directory.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Context, Effect, Layer, Result, Schema } from "effect"
import { type EvidenceEvent, type EvidenceEventBody, EvidenceEvent as EvidenceEventSchema } from "./Event.ts"

/** Evidence could not be written. Evidence failing silently is worse than a run failing. */
export class EvidenceUnwritable extends Schema.TaggedError<EvidenceUnwritable>()(
  "EvidenceUnwritable",
  {
    path: Schema.String,
    reason: Schema.String
  }
) {}

/**
 * Rewrites a text field before it is written.
 *
 * Ticket 08 supplies the real one: a function closed over the run's sensitive
 * input values, replacing each with a labelled placeholder. Until then it is
 * identity, and the type exists so that adding redaction touches one layer rather
 * than every call site.
 */
export type Scrubber = (text: string) => string

export const noScrubbing: Scrubber = (text) => text

export class Evidence extends Context.Service<Evidence, {
  /** The directory this run's evidence lands in. Printed so a reader can find it. */
  readonly directory: string
  /** Stamps, scrubs, validates and appends one event. */
  readonly record: (body: EvidenceEventBody) => Effect.Effect<void, EvidenceUnwritable>
  /**
   * Writes a binary attachment beside the log. Not scrubbed: a screenshot's
   * pixels are a stated limit rather than a solved problem (ADR-0010).
   */
  readonly attach: (name: string, bytes: Uint8Array) => Effect.Effect<void, EvidenceUnwritable>
  /** Everything recorded so far, for tests and for the run's own summary. */
  readonly written: Effect.Effect<ReadonlyArray<EvidenceEvent>>
}>()("cua/evidence/Evidence") {}

export interface EvidenceOptions {
  /** e.g. `evidence/replay`. One subdirectory per run is created under it. */
  readonly root: string
  readonly runId: string
  readonly sessionId: string
  readonly scrubber?: Scrubber
}

const NOTE = `Evidence in this directory is over synthetic data from the mock Heritage Core
application. Event logs and accessibility snapshots are scrubbed of declared
sensitive values at the single point where they are serialised.

Screenshots are NOT redacted. They contain rendered member identifiers and
balances as captured. Masking them properly means optical recognition of known
values, which is named as a known gap rather than half-solved. See
docs/adr/0010-evidence-screenshots-are-not-redacted.md.
`

const encode = Schema.encodeSync(EvidenceEventSchema)
const validate = Schema.decodeUnknownResult(EvidenceEventSchema)

/**
 * Applies the scrubber to every string an event carries.
 *
 * Field-blind on purpose. A scrubber that has to be told which fields might hold
 * a member number is a scrubber that misses the field added next month.
 */
const scrubDeeply = (value: unknown, scrubber: Scrubber): unknown => {
  if (typeof value === "string") return scrubber(value)
  if (Array.isArray(value)) return value.map((item) => scrubDeeply(item, scrubber))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubDeeply(item, scrubber)])
    )
  }
  return value
}

/** A filesystem-backed Evidence service. The only writer in the system. */
export const layer = (options: EvidenceOptions): Layer.Layer<Evidence, EvidenceUnwritable> =>
  Layer.effect(Evidence)(
    Effect.gen(function* () {
      const directory = join(options.root, options.runId)
      const logPath = join(directory, "events.jsonl")
      const scrubber = options.scrubber ?? noScrubbing

      yield* Effect.try({
        try: () => {
          mkdirSync(directory, { recursive: true })
          writeFileSync(join(directory, "README.txt"), NOTE)
        },
        catch: (cause) => new EvidenceUnwritable({ path: directory, reason: String(cause) })
      })

      let seq = 0
      const written: Array<EvidenceEvent> = []

      const record = (body: EvidenceEventBody): Effect.Effect<void, EvidenceUnwritable> =>
        Effect.suspend(() => {
          const stamped = {
            ...body,
            runId: options.runId,
            sessionId: options.sessionId,
            seq: seq++,
            at: new Date().toISOString()
          }
          const scrubbed = scrubDeeply(stamped, scrubber)
          const checked = validate(scrubbed)
          if (Result.isFailure(checked)) {
            return Effect.fail(
              new EvidenceUnwritable({
                path: logPath,
                reason: `event failed schema validation: ${checked.failure}`
              })
            )
          }
          written.push(checked.success)
          return Effect.try({
            try: () => appendFileSync(logPath, `${JSON.stringify(encode(checked.success))}\n`),
            catch: (cause) => new EvidenceUnwritable({ path: logPath, reason: String(cause) })
          })
        })

      const attach = (name: string, bytes: Uint8Array): Effect.Effect<void, EvidenceUnwritable> =>
        Effect.try({
          try: () => writeFileSync(join(directory, name), bytes),
          catch: (cause) =>
            new EvidenceUnwritable({ path: join(directory, name), reason: String(cause) })
        })

      return { directory, record, attach, written: Effect.sync(() => [...written]) }
    })
  )
