/**
 * A Trajectory: everything one Discovery run learned, in the shape the compiler
 * reads.
 *
 * **Ticket 11 consumes this.** It is the seam between "a model drove a browser"
 * and "a reviewable Capability Artifact exists", and it is deliberately a plain
 * data structure with no behaviour: the compiler should be a function of this
 * value, testable without a model, a browser or a network.
 *
 * ## What the compiler is expected to do with it
 *
 * Each `DiscoveryStep` maps to one Artifact `Step`. The mapping is mechanical,
 * which is the whole claim of this design:
 *
 *   - `intent` is already the Step's `intent` — the model was asked for it at the
 *     moment it decided, rather than reconstructed afterwards.
 *   - `action` is already an Action in the Artifact's own vocabulary, minus the
 *     Targets' `strategy`/`robustness` prose, which the compiler adds from
 *     `resolvedBy` and `rationale`.
 *   - Every `goalDerived` value collapses into a declared input: group the
 *     `parameters` below by `name`, and each use becomes
 *     `{ from: parameter, name }`. **The literal is thrown away** — it exists in
 *     this structure only as a `Redacted` and only so the run could type it.
 *   - Every `uiDerived` value becomes `{ from: step, step }`.
 *   - `outputs` name the extract steps their readings came from, which is exactly
 *     `OutputDeclaration.from.step`.
 *   - `selections` carry the `values`, `default` and `discoveredFrom` of an enum
 *     input, already checked — see `Selection.ts` and read that module before
 *     writing the compiler's enum branch.
 *
 * ## Two things the compiler must not skip
 *
 * `parseArtifact` rejects a document whose ValueRef names an undeclared input, so
 * emitting one is a compiler bug (ticket 03's note). And `bakedInLiterals` must be
 * called with the Goal's terms and every literal this run typed, per ADR-0008 —
 * `literalsTyped` below exists to be handed straight to it.
 */

import type { Redacted } from "effect"
import type { ProvenancedValue } from "./Provenance.ts"
import type { StuckTrigger } from "./Stuck.ts"

// ---------------------------------------------------------------------------
// One step
// ---------------------------------------------------------------------------

/** What the Surface did in response, and how the Target actually resolved. */
export interface StepOutcome {
  readonly url: string
  /** The strategies the adapter applied, for the Artifact's `strategy` field. */
  readonly resolvedBy: ReadonlyArray<string>
  /** The adapter's sentence-per-narrowing-step, for the `robustness` argument. */
  readonly rationale: string
  /**
   * How many other controls the Target also matched. `0` is the confidence claim
   * a reviewer wants: the Target named exactly one control.
   */
  readonly alternatives: number
  /** What an `extract` read, when this step read anything. */
  readonly read?: string | undefined
}

/**
 * One decided, authorised, executed action.
 *
 * `id` is the model's own `bindAs` for an extract and a generated name otherwise,
 * and it is what a `uiDerived` value points at. It becomes the Artifact's Step id.
 */
export interface DiscoveryStep {
  readonly id: string
  readonly intent: string
  /** The model's reasoning, recorded beside the action it took. */
  readonly rationale: string
  readonly verb: string
  /** The action in Artifact vocabulary, ready for the compiler. */
  readonly action: Record<string, unknown>
  /** Present when the action typed or matched a value. */
  readonly value?: ProvenancedValue | undefined
  readonly outcome: StepOutcome
  /** Which policy allowed this, and how it classified it. */
  readonly authorisedBy: { readonly policy: string; readonly risk: string }
}

// ---------------------------------------------------------------------------
// What was discovered
// ---------------------------------------------------------------------------

/**
 * A parameter the model inferred from the Goal.
 *
 * The literal stays `Redacted`. The compiler does not need it and must not write
 * it down; it is here so `bakedInLiterals` can be given the values this run
 * actually typed, which is the check that keeps them out of the Artifact.
 */
export interface DiscoveredParameter {
  /** The semantic role the model inferred, e.g. `memberId`. Becomes the input name. */
  readonly name: string
  /** Every step that used it. Each becomes a `{ from: parameter }` reference. */
  readonly usedBy: ReadonlyArray<string>
  /** Sensitive unless Policy says otherwise (ADR-0008). Never the model's call. */
  readonly sensitive: boolean
  readonly literal: Redacted.Redacted<string>
}

/**
 * A choice made against a list, and the inference behind it.
 *
 * `default` is **the goal's own word**, never the label it matched. That is the
 * whole of ticket 09's warning and the reason `Selection.ts` exists; the field is
 * named `default` because that is the `InputDeclaration` field it becomes.
 */
export interface DiscoveredSelection {
  readonly stepId: string
  /** Becomes the enum input's name. */
  readonly parameter: string
  /** The labels read off the screen. Becomes `values`. */
  readonly values: ReadonlyArray<string>
  /** The goal's own word. Becomes `default`. NOT the matched label. */
  readonly default: string
  /** The label the default landed on. Recorded so a reader can see both words. */
  readonly matched: string | undefined
  /** The inference, e.g. `goal term 'savings' ⊂ label 'Primary Savings'`. */
  readonly discoveredFrom: string
  readonly robustness: string
}

/** A reading that answers the goal. Becomes an `OutputDeclaration`. */
export interface DiscoveredOutput {
  readonly name: string
  /** The extract step whose reading this is. Becomes `from.step`. */
  readonly fromStep: string
  readonly description: string
  /** What it actually read on this run, for the report. */
  readonly value: string | undefined
}

// ---------------------------------------------------------------------------
// How it ended
// ---------------------------------------------------------------------------

/**
 * Three ways a Discovery run ends, and they are genuinely different things.
 *
 * `reached` means the model said it was done and the goal's value was read.
 * `stuck` means a stopping condition fired, and the trigger says which. `failed`
 * means the machinery broke — a surface that would not open, evidence that would
 * not write — which is not the same as a model that could not work something out.
 */
export type DiscoveryConclusion =
  | { readonly conclusion: "reached"; readonly summary: string }
  | { readonly conclusion: "stuck"; readonly trigger: StuckTrigger }
  | { readonly conclusion: "failed"; readonly reason: string }

export interface Trajectory {
  /**
   * The Goal, exactly as it was given. **The one field here that is not scrubbed.**
   *
   * Every other string a Trajectory carries — step URLs, the adapter's
   * rationales, the readings — passes the run's scrubber on the way in, so a
   * Trajectory can be printed or written to disk without leaking the values the
   * run discovered. The Goal cannot join them, because ticket 11 has to hand it
   * to `bakedInLiterals` to check that no Artifact literal echoes it, and a
   * scrubbed Goal would make that check pass vacuously.
   *
   * So: a Goal is the caller's own sentence and it is theirs to handle, but
   * anything derived from it in here is already clean. **Ticket 11: do not write
   * this field into an Artifact, and do not put it in an Evidence event except
   * through the writer, which scrubs.**
   */
  readonly goal: string
  readonly runId: string
  readonly sessionId: string
  /** The entry path, relative. Never an origin: an Artifact records no host. */
  readonly entry: string
  readonly evidenceDirectory: string
  readonly conclusion: DiscoveryConclusion
  readonly steps: ReadonlyArray<DiscoveryStep>
  readonly parameters: ReadonlyArray<DiscoveredParameter>
  readonly selections: ReadonlyArray<DiscoveredSelection>
  readonly outputs: ReadonlyArray<DiscoveredOutput>
  /** Every state the run saw, in order. A cycle is visible as a repeat. */
  readonly signatures: ReadonlyArray<string>
  readonly steps_attempted: number
  readonly durationMillis: number
}

/** Whether this trajectory is worth compiling into an Artifact at all. */
export const isCompilable = (trajectory: Trajectory): boolean =>
  trajectory.conclusion.conclusion === "reached" && trajectory.steps.length > 0

/**
 * Every literal this run typed, for ADR-0008's baked-in-literal check.
 *
 * Ticket 11: hand this and the Goal's own terms to `bakedInLiterals` and refuse
 * to write an Artifact that returns anything. The unwrapping happens in
 * `redaction.ts`, which is the one place in this package permitted to do it.
 */
export const parameterNames = (trajectory: Trajectory): ReadonlyArray<string> =>
  trajectory.parameters.map((parameter) => parameter.name)
