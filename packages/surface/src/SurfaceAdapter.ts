/**
 * The `SurfaceAdapter` service: the seam through which everything in this system
 * perceives and operates an application.
 *
 * Read the shape of it as an argument, not just an interface. `observe` returns
 * a Surface State — accessibility structure, location, frames — and every other
 * method takes a Target, which is a description of a control in an operator's
 * words. There is no method that returns markup and no parameter anywhere that
 * could hold a CSS or XPath selector. A caller who wants the DOM has nowhere to
 * put the request, which is the difference between a design claim and a
 * checkable one. See
 * docs/adr/0001-accessibility-tree-is-the-only-observation-channel.md.
 *
 * Frame traversal lives behind this seam too. Heritage Core hides every figure
 * an operator came for inside an unnamed iframe; a Target still just names the
 * control.
 */

import { Context, Effect, Schema } from "effect"
import type { AccessibilityNode } from "./AccessibilityTree.ts"
import type { TargetMatch, TargetStrategy } from "./resolution.ts"
import { Target } from "./Target.ts"

// ---------------------------------------------------------------------------
// What a Surface looks like at one moment
// ---------------------------------------------------------------------------

/**
 * One document in the Surface. A caller reads this to know a frame exists; it
 * never has to say so to reach a control inside one.
 */
export interface FrameDescriptor {
  /** `acctdetail` for Heritage Core's Account Detail panel. Empty when unnamed. */
  readonly name: string
  readonly url: string
  readonly isMain: boolean
}

/**
 * Surface State. The only thing Discovery ever sees.
 *
 * `accessibility` is the same tree as `tree`, rendered as the YAML a model or a
 * person reads. Neither carries markup, and neither carries the browser's
 * internal node handles, so nothing here can be pasted back in as a selector.
 */
export interface SurfaceState {
  readonly url: string
  readonly title: string
  readonly frames: ReadonlyArray<FrameDescriptor>
  readonly tree: AccessibilityNode
  readonly accessibility: string
  readonly observedAt: string
}

/** What `resolveTarget` reports: the node it chose, and why that one. */
export interface TargetResolution {
  readonly target: Target
  readonly match: TargetMatch
  readonly strategies: ReadonlyArray<TargetStrategy>
  readonly rationale: string
  readonly considered: number
  /**
   * How many other controls this Target also matched. `0` is the confidence
   * claim: the Target named exactly one control. Above zero means several
   * answered and an ordinal chose, which is a weaker thing for an Artifact to
   * rest on and is worth being able to see without reading the rationale.
   */
  readonly alternatives: number
}

/**
 * Evidence of one moment. The screenshot is for a person reviewing a run, never
 * an input to a decision: vision in the loop would invalidate the proof that the
 * accessibility tree alone suffices.
 */
export interface SurfaceEvidence {
  readonly capturedAt: string
  readonly state: SurfaceState
  /** PNG bytes. */
  readonly screenshot: Uint8Array
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/**
 * What `waitFor` waits on. Every condition is evaluated against the
 * accessibility tree, so a Checkpoint asserts what an operator could see rather
 * than what the document happens to contain.
 */
export const SurfaceCondition = Schema.Union([
  Schema.TaggedStruct("TargetPresent", { target: Target }),
  Schema.TaggedStruct("TargetAbsent", { target: Target }),
  Schema.TaggedStruct("TextPresent", { text: Schema.String }),
  Schema.TaggedStruct("TextAbsent", { text: Schema.String })
])
export type SurfaceCondition = typeof SurfaceCondition.Type

export const targetPresent = (target: Target): SurfaceCondition => ({ _tag: "TargetPresent", target })
export const targetAbsent = (target: Target): SurfaceCondition => ({ _tag: "TargetAbsent", target })
export const textPresent = (text: string): SurfaceCondition => ({ _tag: "TextPresent", text })
export const textAbsent = (text: string): SurfaceCondition => ({ _tag: "TextAbsent", text })

export const describeCondition = (condition: SurfaceCondition): string => {
  switch (condition._tag) {
    case "TargetPresent":
      return `a match for ${JSON.stringify(condition.target)}`
    case "TargetAbsent":
      return `no match for ${JSON.stringify(condition.target)}`
    case "TextPresent":
      return `the text ${JSON.stringify(condition.text)}`
    case "TextAbsent":
      return `no text ${JSON.stringify(condition.text)}`
  }
}

export interface WaitOptions {
  readonly timeoutMillis?: number
  readonly intervalMillis?: number
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** The Surface itself could not be reached or operated. A Hard Failure. */
export class SurfaceUnavailable extends Schema.TaggedError<SurfaceUnavailable>()(
  "SurfaceUnavailable",
  {
    action: Schema.String,
    reason: Schema.String
  }
) {}

/**
 * Nothing on the screen answers to the Target.
 *
 * A distinct failure from ambiguity on purpose, and not merely a different
 * message: a control that is absent is as likely to be the application telling
 * the truth about its own domain as it is to be breakage, so this is the one a
 * recovery ladder is allowed to consider before giving up. `narrowedBy` says
 * which part of the Target ran out of candidates, which is what such a ladder
 * would branch on.
 */
export class TargetNotFound extends Schema.TaggedError<TargetNotFound>()("TargetNotFound", {
  target: Schema.String,
  rationale: Schema.String,
  /** How many accessibility nodes the screen offered. */
  considered: Schema.Int,
  /** The narrowing step that emptied the candidate set, when one did. */
  narrowedBy: Schema.optional(Schema.String)
}) {}

/**
 * More than one control answers to the Target and nothing chooses between them.
 * A Hard Failure rather than a coin flip: on Heritage Core the wrong choice
 * lands on the Cross-Reference Lookup, which quietly is not Member Detail.
 *
 * Every candidate is listed, and each carries the two things that separate it
 * from its neighbours — its `ordinal` and the `region` it sits in — because on
 * `/fixtures/duplicate-labels` role, name and ancestor trail are identical
 * three times over, and a list of three identical lines answers nobody's
 * question. `remedy` says, in the Target's own vocabulary, what would fix it.
 */
export class TargetAmbiguous extends Schema.TaggedError<TargetAmbiguous>()("TargetAmbiguous", {
  target: Schema.String,
  rationale: Schema.String,
  /** What to add to the Target so it names exactly one control. */
  remedy: Schema.String,
  matches: Schema.Array(
    Schema.Struct({
      description: Schema.String,
      path: Schema.String,
      frame: Schema.String,
      text: Schema.String,
      ordinal: Schema.Int,
      region: Schema.String
    })
  )
}) {}

/** A condition never became true within its bound. */
export class SurfaceTimeout extends Schema.TaggedError<SurfaceTimeout>()("SurfaceTimeout", {
  condition: Schema.String,
  waitedMillis: Schema.Int
}) {}

/** Anything a Target-taking method can fail with. */
export type TargetFailure = TargetNotFound | TargetAmbiguous | SurfaceUnavailable

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class SurfaceAdapter extends Context.Service<SurfaceAdapter, {
  /** Open a location. A URL is a place, not a description of markup. */
  readonly navigate: (url: string) => Effect.Effect<SurfaceState, SurfaceUnavailable>

  /** What the Surface looks like now: accessibility structure, location, frames. */
  readonly observe: Effect.Effect<SurfaceState, SurfaceUnavailable>

  /** Which control a Target names, and the reasoning that picked it. */
  readonly resolveTarget: (target: Target) => Effect.Effect<TargetResolution, TargetFailure>

  readonly click: (target: Target) => Effect.Effect<SurfaceState, TargetFailure>

  /**
   * Types a value into a named control.
   *
   * The value is a plain string here on purpose. Provenance — whether a value
   * came from the Goal, an earlier screen or is genuinely fixed — is a property
   * of the Action that a Capability Artifact records, and Replay hands this
   * layer an already-resolved value. Putting provenance on the Surface seam
   * would make it browser-shaped and make Replay lie about where the value came
   * from.
   */
  readonly fill: (target: Target, value: string) => Effect.Effect<SurfaceState, TargetFailure>

  /** The text a named control shows, read out of the accessibility tree. */
  readonly extract: (target: Target) => Effect.Effect<string, TargetFailure>

  readonly waitFor: (
    condition: SurfaceCondition,
    options?: WaitOptions
  ) => Effect.Effect<SurfaceState, SurfaceTimeout | SurfaceUnavailable>

  /** A screenshot plus the Surface State that goes with it, for the record. */
  readonly captureEvidence: Effect.Effect<SurfaceEvidence, SurfaceUnavailable>
}>()("cua/surface/SurfaceAdapter") {}

export type SurfaceAdapterService = SurfaceAdapter["Service"]
