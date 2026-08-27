/**
 * The Evidence service: one `events.jsonl` per run, plus attachments.
 *
 * ## The single serialisation point
 *
 * Everything written passes through `record`, and `record` does exactly three
 * things in order: stamp the envelope, scrub, validate against the schema. That
 * ordering is the design.
 *
 * *Scrub* is where redaction happens. SPEC: "Text evidence, meaning
 * accessibility snapshots and event logs, passes a scrub replacing known
 * sensitive parameter values with a labelled placeholder, at the single point
 * where evidence gets serialized." There is one such point and it is `record`.
 * Nothing else in the system may write to the evidence directory, which is what
 * makes "keeping sensitive values out of logs by construction" (user story 59) a
 * property of the code rather than of everyone's discipline.
 *
 * **`scrubber` is a required option** (ticket 08). Not defaulted to identity, and
 * not defaulted to anything else: a default is a decision made silently at every
 * construction site that forgets, and the whole point of this ticket is that
 * forgetting should not be possible. Declaring nothing up front is spelled
 * `noSecrets()`, which a reviewer can grep for and find every instance of.
 *
 * It is a `SecretRegistry` rather than a bare function, and `Evidence` exposes
 * `redact` on top of it, because a run meets sensitive text it was never told
 * about: what a person types during an Intervention, and what the application
 * renders back at it. Those register through the writer, which is the one
 * service every part of the system that could learn such a value already has.
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
import type { Scrubber, SecretRegistry, SensitiveText } from "./Scrub.ts"

/** Evidence could not be written. Evidence failing silently is worse than a run failing. */
export class EvidenceUnwritable extends Schema.TaggedError<EvidenceUnwritable>()(
  "EvidenceUnwritable",
  {
    path: Schema.String,
    reason: Schema.String
  }
) {}

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
  /**
   * Teach this run's scrubber a value it could not have known up front, so that
   * every event written from here on redacts it.
   *
   * It lives on `Evidence` rather than on a service of its own for the same
   * reason `scrubber` is a required option: so that it cannot be forgotten. The
   * two places a run learns a secret mid-flight — the engine, when a screen
   * renders a personal field, and `SessionControl`, when an Operator says what
   * they typed — both already require `Evidence`, because neither can do its job
   * without recording what happened. Registration therefore travels with the
   * writer, and a future call site cannot obtain one without the other.
   *
   * Registering before the event that would first name the value is what makes
   * that event redacted too. See `SecretRegistry`.
   */
  readonly redact: (values: Iterable<SensitiveText>) => Effect.Effect<void>
  /**
   * This run's live scrubber.
   *
   * Everything written to Evidence passes it already. This is here for the one
   * thing that *leaves the building*: the text of an assisted-recovery
   * consultation. What a run's log refuses to carry, its consultation refuses to
   * send, and using the same function rather than a second definition of
   * "sensitive" is what keeps the two from drifting.
   */
  readonly scrub: Scrubber
}>()("cua/evidence/Evidence") {}

export interface EvidenceOptions {
  /** e.g. `evidence/replay`. One subdirectory per run is created under it. */
  readonly root: string
  readonly runId: string
  readonly sessionId: string
  /**
   * Required, not optional. See the module header: a default here is a decision
   * made silently by every construction site that forgets to think about it.
   * `noSecrets()` is the explicit way to say "nothing is declared up front".
   *
   * A `SecretRegistry` rather than a bare `Scrubber`, because a run learns
   * sensitive values it could not have been told about in advance — what a
   * person types during an Intervention, what a screen renders back. The writer
   * holds the registry so that `Evidence.redact` exists wherever `Evidence`
   * does, which is the whole of how that registration is kept unforgettable.
   */
  readonly scrubber: SecretRegistry
  /**
   * The parameter *names* the scrubber was built from, for the note below.
   * Never the values. A reviewer opening the directory should be able to see
   * which parameters this run treated as sensitive without reading the code that
   * decided.
   */
  readonly redacting?: ReadonlyArray<string>
  /** One line saying which sensitivity policy the run was classified under. */
  readonly policy?: string
}

/**
 * The note written into every evidence directory, and the ADR-0010 disclosure.
 *
 * SPEC: screenshots "go only to /evidence, which carries a note that these are
 * demo artifacts over synthetic data". This is that note. It lives next to the
 * files it describes rather than only in an ADR, because the person who most
 * needs to read it is the one looking at a screenshot, and they are not
 * necessarily in the repository at the time.
 */
const note = (options: EvidenceOptions): string => {
  const redacting = options.redacting ?? []
  return `EVIDENCE FOR RUN ${options.runId}
${"=".repeat(20 + options.runId.length)}

This is a demo artifact over SYNTHETIC data from the mock Heritage Core
application. No real member data exists anywhere in this system.

WHAT IS REDACTED
----------------
events.jsonl and every accessibility snapshot in it pass a scrub at the single
point where evidence is serialised. ${
    redacting.length === 0
      ? "This run declared no sensitive parameters."
      : `Values of these parameters were replaced:\n  ${redacting.join("\n  ")}`
  }

Two further kinds of value are redacted, and neither was declared by anybody
before the run started, because neither could be:

  * fields a screen showed that Policy calls personal -- a member's name, a tax
    id. These are nobody's parameter; they arrive as ordinary text off the
    application. The list of captions is declared and argued for in
    packages/policy/src/Sensitivity.ts, and it is a denylist: a personal field on
    a screen nobody has looked at yet is not covered until somebody adds it.
  * anything an Operator said they typed into the live application during an
    Intervention. A supervisor id or an override code is a credential no
    Capability declared, and the operator interface asks for it so that the
    scrubber can be told. It is registered before the note that reports it, so
    the note is redacted too.

Two placeholders appear, and they mean different things:

  [redacted:<name>]   the literal value was found in text read off the screen
                      (an accessibility snapshot, a URL, a quoted control value)
                      and was taken out.
  <redacted:<name>>   a value the system was holding was serialised, and the
                      Redacted wrapper stopped it. Nothing leaked.

A placeholder can appear in the middle of a longer identifier — Heritage Core's
account number embeds the member number, so it reads 00000[redacted:memberId]-S01.
That is the substitution working, not a bug. Redaction is by literal occurrence,
with no minimum length and no attempt to guess field boundaries, because a rule
that skipped short or embedded matches would be a hole with a number on it.

${options.policy ?? "Sensitivity policy: deny-first (ADR-0008)."}

WHAT IS NOT REDACTED
--------------------
Screenshots are NOT redacted. Every *.png in this directory is stored exactly as
captured, and they contain rendered member identifiers and account balances.
They do not pass the scrubber and nothing masks them.

This is a stated limit, not an oversight. Redacting pixels properly means
optical recognition of known values over a screenshot, which is a larger problem
than this system needs to solve, and a half-implementation that missed a
rendering would be worse than an honest gap: it would imply a protection that
was not there. So the limit is written down here, where someone looking at the
screenshot will see it, and the mitigation is that these files are over
synthetic data and stay in this directory.

See docs/adr/0010-evidence-screenshots-are-not-redacted.md.
`
}

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
      const secrets = options.scrubber
      const scrubber = secrets.scrub

      yield* Effect.try({
        try: () => {
          // The root may already exist and should. The run directory may not.
          //
          // `recursive: true` on the run directory would accept one that is
          // already there, and a second writer opened on the same `runId` would
          // then append to the same `events.jsonl` with its own `seq` counter
          // starting at zero. The log would carry two sessions interleaved and a
          // `seq` that goes backwards, which is exactly what the event contract
          // promises cannot happen. Failing here costs a run; not failing here
          // costs the ability to trust any log.
          mkdirSync(options.root, { recursive: true })
          mkdirSync(directory)
          writeFileSync(join(directory, "README.txt"), note(options))
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

      return {
        directory,
        record,
        attach,
        written: Effect.sync(() => [...written]),
        redact: (values: Iterable<SensitiveText>) => Effect.sync(() => secrets.remember(values)),
        scrub: scrubber
      }
    })
  )
