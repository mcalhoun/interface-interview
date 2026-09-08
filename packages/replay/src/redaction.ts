/**
 * Wiring a run's sensitive inputs to the Evidence scrubber.
 *
 * The writer derives its scrubber from ResolvedInputs so the call site cannot
 * forget which values the run supplied. Non-sensitive treatment requires both
 * an artifact declaration and policy authorization.
 *
 * Unwrapping is limited to explicit boundaries: this module registers input
 * values for scrubbing, checkpoint.ts resolves values for actions and comparisons,
 * and the discovery redaction module manages its private runtime context.
 * The source scan in test/sensitive-data.test.ts checks those boundaries.
 * Plaintext must not enter serialized evidence or artifact metadata.
 */

import type { ResolvedInputs } from "@cua/artifact"
import type {
  Evidence,
  EvidenceUnwritable,
  Scrubber,
  SecretRegistry,
  SensitiveText
} from "@cua/evidence"
import { evidenceFiles, scrubbing, secretRegistry, privateUrlValues } from "@cua/evidence"
import { Redacted } from "effect"
import type { Layer } from "effect/Layer"

/** The parameters this run treats as sensitive, by name. Never their values. */
export const sensitiveNames = (inputs: ResolvedInputs): ReadonlyArray<string> =>
  [...inputs.values()].filter((input) => input.sensitive).map((input) => input.name)

/**
 * The scrubber for one run's declared inputs, fixed at the moment it is built.
 *
 * The plaintext lives in the `SensitiveText` list `declaredSecrets` returns and
 * in the closure `scrubbing` builds over it, and goes nowhere else.
 */
export const scrubberFor = (inputs: ResolvedInputs): Scrubber => scrubbing(declaredSecrets(inputs))

/**
 * The same values, as a registry the run can add to.
 *
 * Evidence uses this live registry because a run learns secrets from operator
 * actions and rendered screens. Post-run amendment and override persistence must
 * retain Evidence.scrub too; rebuilding it from declared inputs would forget
 * those values. `scrubberFor` is only a fixed snapshot for pre-run diagnostics.
 */
export const secretsFor = (inputs: ResolvedInputs): SecretRegistry =>
  secretRegistry(declaredSecrets(inputs))

/** Runtime scrubbing boundary. The plaintext goes into a `SensitiveText` and nowhere else. */
const declaredSecrets = (inputs: ResolvedInputs): ReadonlyArray<SensitiveText> => {
  const values: Array<SensitiveText> = []
  for (const input of inputs.values()) {
    if (!input.sensitive) continue
    const text = Redacted.value(input.text)
    values.push({ label: input.name, text })
    // A redirect or a rendered value can contain only one component of an input URL.
    try { values.push(...urlSecrets(new URL(text, "http://runtime.invalid").toString())) } catch { /* not a URL */ }
  }
  return values
}

/** URLs observed at runtime are private independently of declared parameter sensitivity. */
export const urlSecrets = (url: string): ReadonlyArray<SensitiveText> =>
  privateUrlValues(url).map((text) => ({ label: "url", text }))

export interface RunEvidenceOptions {
  /** e.g. `evidence/replay`. One subdirectory per run is created under it. */
  readonly root: string
  readonly runId: string
  readonly sessionId: string
  /** The run's validated inputs. The scrubber is derived from these. */
  readonly inputs: ResolvedInputs
  /** Only callers using synthetic fixtures should enable unredacted binary proof. */
  readonly allowUnredactedScreenshots?: boolean
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
    ...(options.allowUnredactedScreenshots === undefined ? {} : { allowUnredactedScreenshots: options.allowUnredactedScreenshots }),
    runId: options.runId,
    sessionId: options.sessionId,
    scrubber: secretsFor(options.inputs),
    redacting: sensitiveNames(options.inputs),
    ...(options.policy === undefined ? {} : { policy: options.policy })
  })
