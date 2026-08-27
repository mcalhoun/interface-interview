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
 *   - ticket 04 added `outcomes:` here and a branch to `Checkpoint`; ticket 06
 *     added `recoverable:`. Both are optional sections, and the order they are
 *     consulted in when a Checkpoint does not hold is documented on
 *     `Checkpoint.ts` — outcomes always before recovery.
 *   - ticket 14 adds `requiresHuman:` entries, write-once.
 *   - ticket 16 adds Tenant Overrides as scoped deltas *against* this document,
 *     never as edits to it.
 */

import { Schema } from "effect"
import { Action } from "./Action.ts"
import { type OutcomeDeclaration, OutcomeDeclarations } from "./BusinessOutcomes.ts"
import { Checkpoint } from "./Checkpoint.ts"
import { InputDeclarations } from "./Inputs.ts"
import { OutputDeclarations } from "./Outputs.ts"
import { RecoverableCondition } from "./Recovery.ts"
import { type RequiresHumanDeclaration, RequiresHumanDeclarations } from "./RequiresHuman.ts"

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
  /**
   * The Business Outcomes this Capability can return instead of its outputs.
   *
   * The domain contract, and the second half of a caller's signature: `outputs`
   * says what comes back when the flow completes, `outcomes` says what comes back
   * when the application's own domain answers something else. A reviewer reading
   * only this document can therefore see every value the Capability can produce,
   * which is the point of declaring them rather than letting the engine infer a
   * class from the shape of a screen.
   *
   * Optional and empty on a Capability that has learned none yet. Each code here
   * has to be reachable from some Checkpoint's `orOutcome`, and every branch's
   * code has to appear here; `parseArtifact` enforces both directions.
   */
  outcomes: Schema.optional(OutcomeDeclarations),
  /**
   * The states this Capability has learned it must never handle itself.
   *
   * The other half of the domain contract, and the half that only ever tightens.
   * `outcomes` says what the application answers; this says where it refuses, in
   * a way no amount of waiting, retrying or better perception gets past, because
   * getting past it takes authority (SPEC's error taxonomy, ADR-0004).
   *
   * Optional and empty on a Capability nobody has met one of these on. Entries
   * are write-once: `Amendment.ts` holds the ratchet, and `parseArtifact` refuses
   * a document where a code appears both here and under `outcomes`, so a
   * downgrade cannot be spelled even by hand.
   */
  requiresHuman: Schema.optional(RequiresHumanDeclarations),
  steps: Schema.Array(Step).check(Schema.isMinLength(1)),
  /**
   * Transient states this Capability declares it can get past unattended, in
   * priority order: the first whose `detect` holds is the one that applies.
   *
   * Optional, and an Artifact without it recovers from nothing — which is the
   * honest default, because a state is only recoverable once somebody has seen it
   * and said what to do. See `Recovery.ts`.
   *
   * A declared Business Outcome always beats a rule here. `outcomes` is what the
   * application *means*; a rule here is a state it is passing through, and a rule
   * that could pre-empt a declared answer would spend a run's recovery budget
   * retrying a question that has already been answered.
   */
  recoverable: Schema.optional(Schema.Array(RecoverableCondition))
})
export type CapabilityArtifact = typeof CapabilityArtifact.Type

/** The declared rules, in priority order. Empty when the Artifact declares none. */
export const recoverableConditions = (
  artifact: CapabilityArtifact
): ReadonlyArray<RecoverableCondition> => artifact.recoverable ?? []

/** `member.account-balance@1.0.0`, the way Evidence and the catalog name a run. */
export const capabilityRef = (artifact: CapabilityArtifact): string =>
  `${artifact.capability}@${artifact.version}`

/**
 * The declaration for one Business Outcome code, or `undefined`.
 *
 * The accessor exists so that nothing outside this module reads `outcomes`
 * directly and has to remember it is optional. `parseArtifact` guarantees every
 * code a Checkpoint can reach is declared, so a caller that has a code from a
 * branch will always get a declaration back — but the type says `undefined`
 * anyway, because a guarantee enforced somewhere else is not one the compiler
 * knows about.
 */
export const declaredOutcome = (
  artifact: CapabilityArtifact,
  code: string
): OutcomeDeclaration | undefined => artifact.outcomes?.[code]

/** Every Business Outcome code this Capability declares, in document order. */
export const declaredOutcomeCodes = (
  artifact: CapabilityArtifact
): ReadonlyArray<string> => Object.keys(artifact.outcomes ?? {})

/** Every always-escalating code this Capability declares, in document order. */
export const declaredRequiresHumanCodes = (
  artifact: CapabilityArtifact
): ReadonlyArray<string> => Object.keys(artifact.requiresHuman ?? {})

/**
 * What this Capability has learned about a Step whose Checkpoint will not hold,
 * or `undefined` if it has learned nothing.
 *
 * The single lookup Replay does. It is by Step rather than by code because the
 * engine meets the *state* before anything has a name for it — see the module
 * note in `RequiresHuman.ts` on why the Step is the whole recognition rule.
 *
 * `parseArtifact` refuses a document with two entries for one Step, so the first
 * match is the only match.
 */
export const requiresHumanAtStep = (
  artifact: CapabilityArtifact,
  stepId: string
): { readonly code: string; readonly declaration: RequiresHumanDeclaration } | undefined => {
  for (const [code, declaration] of Object.entries(artifact.requiresHuman ?? {})) {
    if (declaration.step === stepId) return { code, declaration }
  }
  return undefined
}
