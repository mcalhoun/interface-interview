/**
 * Wiring a run's sensitive inputs to the Evidence scrubber.
 *
 * This module exists so that "the Evidence for a run redacts that run's
 * sensitive values" is something a caller cannot get wrong by omission. There is
 * one function that builds an Evidence Layer for a Replay run, it takes the
 * `ResolvedInputs`, and it derives the scrubber itself. A caller who wants
 * Evidence has to go through it.
 *
 * ## One of the two unwrap sites
 *
 * `Redacted.value(...)` appears exactly twice in `packages/*​/src`:
 *
 * 1. here, to learn the characters the scrubber has to look for, and
 * 2. `resolveValue` in `checkpoint.ts`, to type a value into a field.
 *
 * Both are unavoidable — a scrubber that does not know the value cannot find it,
 * and a `fill` that does not know the value cannot type it — and both are the
 * narrowest possible: the plaintext exists as a local, is consumed immediately,
 * and is never stored on anything that could be serialised.
 *
 * `test/sensitive-data.test.ts` greps the workspace and asserts that set of two.
 * A third unwrap does not silently appear; it fails the suite and has to be
 * argued for.
 *
 * ## Non-sensitive inputs are not scrubbed
 *
 * That is what non-sensitive means. Getting there takes both an Artifact
 * declaring `sensitive: false` and a Policy allowlist entry naming the parameter
 * (`classifySensitive` in `@cua/artifact`), so the set is empty unless somebody
 * decided it should not be.
 */

import type { ResolvedInputs } from "@cua/artifact"
import type { Evidence, EvidenceUnwritable, Scrubber, SensitiveText } from "@cua/evidence"
import { evidenceFiles, scrubbing } from "@cua/evidence"
import { Redacted } from "effect"
import type { Layer } from "effect/Layer"

/** The parameters this run treats as sensitive, by name. Never their values. */
export const sensitiveNames = (inputs: ResolvedInputs): ReadonlyArray<string> =>
  [...inputs.values()].filter((input) => input.sensitive).map((input) => input.name)

/**
 * The scrubber for one run's inputs.
 *
 * UNWRAP SITE 1 OF 2. The plaintext lives in the `SensitiveText` list and in the
 * closure `scrubbing` builds over it, and goes nowhere else.
 */
export const scrubberFor = (inputs: ResolvedInputs): Scrubber => {
  const values: Array<SensitiveText> = []
  for (const input of inputs.values()) {
    if (!input.sensitive) continue
    values.push({ label: input.name, text: Redacted.value(input.text) })
  }
  return scrubbing(values)
}

export interface RunEvidenceOptions {
  /** e.g. `evidence/replay`. One subdirectory per run is created under it. */
  readonly root: string
  readonly runId: string
  readonly sessionId: string
  /** The run's validated inputs. The scrubber is derived from these. */
  readonly inputs: ResolvedInputs
  /** How the run's sensitivity was decided, for the directory's own note. */
  readonly policy?: string
}

/**
 * The Evidence Layer for a Replay run, already redacting.
 *
 * Every entry point that replays a Capability builds its Evidence here — the CLI
 * and the test harness both — so there is no construction site where the
 * scrubber could be left off. `evidenceFiles` itself requires a scrubber, so
 * even a new entry point that skipped this function would have to say in writing
 * what it wanted instead.
 */
export const evidenceForRun = (
  options: RunEvidenceOptions
): Layer<Evidence, EvidenceUnwritable> =>
  evidenceFiles({
    root: options.root,
    runId: options.runId,
    sessionId: options.sessionId,
    scrubber: scrubberFor(options.inputs),
    redacting: sensitiveNames(options.inputs),
    ...(options.policy === undefined ? {} : { policy: options.policy })
  })
