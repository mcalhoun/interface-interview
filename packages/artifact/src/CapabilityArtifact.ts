/**
 * The Capability Artifact: the typed, versioned, human-readable document
 * describing how a Capability is carried out.
 *
 * This schema is the centre of the system. Discovery compiles into it (ticket
 * 11), Replay executes it, a reviewer approves it, and every later ticket adds a
 * field rather than a mechanism. The ordering — Replay before Discovery — exists
 * so that the schema is provably executable before anything starts generating
 * one.
 *
 * ## What the shape has to earn
 *
 * A reviewer must be able to read one of these and know what the Capability does,
 * what it needs, what it returns and how it verifies itself, without opening any
 * source. That is SPEC user stories 11 to 19, and it is why:
 *
 *   - every Step carries a required `intent` and a required `checkpoint`;
 *   - every Target carries a required `strategy` and `robustness` argument;
 *   - inputs declare type, sensitivity and how Discovery arrived at them;
 *   - outputs declare a type and which Step reads them;
 *   - the Artifact carries no origin, so the same document serves every Tenant.
 *
 * ## Format
 *
 * YAML, parsed with `Bun.YAML` (built in, so no dependency) and then decoded
 * through this schema, which is where the real validation lives. YAML because an
 * Artifact is a review document: `robustness` is a paragraph of prose, and a
 * diff between `1.0.0` and `1.1.0` has to be readable by the person approving it.
 * JSON turns both of those into escaped one-liners.
 *
 * ## Seams
 *
 *   - ticket 04 adds `outcomes:` here and a branch to `Checkpoint`.
 *   - ticket 06 adds `recoverable:` rules here.
 *   - ticket 14 adds `requiresHuman:` entries, write-once.
 *   - ticket 16 adds Tenant Overrides as scoped deltas *against* this document,
 *     never as edits to it.
 */

import { Schema } from "effect"
import { Action } from "./Action.ts"
import { Checkpoint } from "./Checkpoint.ts"
import { InputDeclarations } from "./Inputs.ts"
import { OutputDeclarations } from "./Outputs.ts"

/**
 * One named unit of work, pairing an Action with the Checkpoint that confirms it
 * landed. `checkpoint` is required: CONTEXT.md defines a Step as that pair, and
 * an optional Checkpoint is how "the action did not throw" quietly becomes the
 * success criterion.
 */
export const Step = Schema.Struct({
  /** Stable, referable, and the name a reading of this Step is bound under. */
  id: Schema.String,
  /** What this Step is for, in an operator's words. Quoted in failure reports. */
  intent: Schema.String,
  action: Action,
  checkpoint: Checkpoint
})
export type Step = typeof Step.Type

/**
 * What kind of Surface this Capability runs against, and where in it to start.
 *
 * No origin. Which institution's installation this runs against is supplied at
 * Replay time, so one vendor-level Capability serves every Tenant (SPEC user
 * story 51) and the Policy engine has an origin to check rather than one baked
 * into a document nobody re-reads.
 */
export const SurfaceDeclaration = Schema.Struct({
  kind: Schema.Literals(["web"]),
  /** The vendor product this was discovered against, for a reviewer's context. */
  product: Schema.String,
  /** Where the flow starts, relative to the Tenant's base URL. */
  entry: Schema.String
})
export type SurfaceDeclaration = typeof SurfaceDeclaration.Type

export const CapabilityArtifact = Schema.Struct({
  /** Dotted, stable, and how a calling agent names this Capability. */
  capability: Schema.String,
  /** Semantic version. Artifacts are immutable; a change is a new version. */
  version: Schema.String,
  /** One line, for a catalog listing. */
  title: Schema.String,
  /** What this Capability does and what a caller should expect, in prose. */
  summary: Schema.String,
  /**
   * How this document came to exist. `hand-written` is honest about the one in
   * this repository at 1.0.0: ticket 03 wrote it by hand so that ticket 11's
   * compiler has an executable target to emit.
   */
  authored: Schema.Literals(["hand-written", "discovered"]),
  surface: SurfaceDeclaration,
  inputs: InputDeclarations,
  outputs: OutputDeclarations,
  steps: Schema.Array(Step).check(Schema.isMinLength(1))
})
export type CapabilityArtifact = typeof CapabilityArtifact.Type

/** `member.account-balance@1.0.0`, the way Evidence and the catalog name a run. */
export const capabilityRef = (artifact: CapabilityArtifact): string =>
  `${artifact.capability}@${artifact.version}`
