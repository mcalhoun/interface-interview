/**
 * A Tenant Override: the scoped delta, and the only shape of difference it can
 * express.
 *
 * CONTEXT.md: "A scoped delta against a Capability Artifact, covering a
 * difference a Tenant's Surface presents that matching cannot absorb.
 * Discovered through the Recovery Ladder, never hand-written."
 *
 * ## Why a delta and not a copy
 *
 * SPEC user story 55: "I want tenant overrides stored as scoped deltas against
 * the base capability, so that the vendor-level capability stays
 * single-sourced." A per-tenant copy of `member.account-balance` would be the
 * obvious thing to build and it is the wrong thing, because it makes every later
 * amendment — a learned Business Outcome, a learned authority-class state — a
 * change that has to be made in N places by whoever remembers. One capability,
 * one set of versions, one review; a Tenant's file says only what is different
 * about that Tenant.
 *
 * Nothing under `artifacts/` changes when an Override is written. That is the
 * property, and it is visible on disk rather than argued for: the override lives
 * in its own tree and names the base version it was discovered against.
 *
 * ## What a delta may say, which is almost nothing
 *
 * One thing: **a Step's Action Target is called something else here.** Not a new
 * Step, not a different Action, not a retuned bound, not a fresh outcome code,
 * and not a selector — a Target has nowhere to put one (ADR-0001) and neither
 * does this.
 *
 * That narrowness is the safety property, exactly as it is for
 * `declareLearnedNoMatch`. An Override is written from a model's proposal and a
 * person's confirmation, and the worst thing that combination can do is point a
 * Step at a different control *on the screen the Step was already on*. It cannot
 * teach a Capability to do anything it did not already do.
 *
 * ## Why almost nothing is enough
 *
 * Because matching absorbs the rest. Of the four ways SPEC's second tenant
 * differs from the first, three need no entry here at all: a shortened field
 * caption is absorbed by token matching on the accessible name, differently
 * named products are absorbed by `tokenSubset` selection (ADR-0007), and an
 * account panel rendered without an iframe is absorbed because a Target was
 * never frame-aware. Only `Find` against `Search` — no shared token, in either
 * direction — is a real incompatibility, and it is the only row in the file.
 *
 * A design where every tenant needed a configuration file would make that ratio
 * invisible. This one makes it the first thing a reader notices.
 *
 * ## Provenance is required, both halves of it
 *
 * `discoveredFrom` and `confirmedBy` are non-optional strings. ADR-0006: tenant
 * overrides are "discovered and confirmed, never hand-written", and a document
 * with somewhere to omit either half is a document that permits the thing the
 * ADR forbids. An `OutcomeDeclaration`'s `discoveredFrom` is optional because a
 * Business Outcome can legitimately be written by somebody who knows the domain;
 * there is no equivalent here, because nobody knows a *tenant's* screen from
 * first principles — the only way to find out is to look at it.
 */

import { Result, Schema } from "effect"
import type { CapabilityArtifact, Step } from "./CapabilityArtifact.ts"
import { ArtifactInvalid, formatArtifact } from "./parse.ts"
import { toYaml } from "./yaml.ts"

/**
 * One control this Tenant calls something else.
 *
 * `was` is not redundant with the Step id. It is the assertion that makes the
 * delta safe to apply to a *later* version of the base capability: if somebody
 * cuts 1.3.0 and rewrites that Step's Target, `was` no longer matches and the
 * Override is refused rather than silently pointing at the wrong control. A
 * delta that could not go stale would be a delta nobody had to re-confirm.
 */
export const OverrideTarget = Schema.Struct({
  /** The Step whose Action names the control. */
  step: Schema.String,
  /** The accessible name the base Capability asks for, e.g. `Search`. */
  was: Schema.String,
  /** What this Tenant's installation calls it, e.g. `Find`. */
  name: Schema.String,
  /**
   * How it was found: the run that failed, the consultation that proposed it,
   * and where the proposal is in that run's Evidence.
   */
  discoveredFrom: Schema.String,
  /** Who agreed to it, when, and in which Intervention. Never inferred. */
  confirmedBy: Schema.String
})
export type OverrideTarget = typeof OverrideTarget.Type

export const TenantOverride = Schema.Struct({
  /** The institution, e.g. `community-cu`. Also the directory it is stored in. */
  tenant: Schema.String,
  capability: Schema.String,
  /**
   * The version of the base Capability this was discovered against.
   *
   * Recorded rather than enforced-forward: applying the Override to a later
   * version is allowed, and what protects that is `was` on each entry. The
   * version is here so a reviewer can see which document somebody was looking at
   * when they confirmed it.
   */
  baseVersion: Schema.String,
  targets: Schema.Array(OverrideTarget)
})
export type TenantOverride = typeof TenantOverride.Type

/** The Override does not fit the Capability it names. A Hard Failure. */
export class OverrideRefused extends Schema.TaggedError<OverrideRefused>()("OverrideRefused", {
  tenant: Schema.String,
  capability: Schema.String,
  reason: Schema.String
}) {
  override get message(): string {
    return `cannot use the ${this.tenant} override for ${this.capability}: ${this.reason}`
  }
}

/**
 * The Target a Step's Action names, or nothing.
 *
 * A `selectFromList` deliberately has none: it works out which control to press
 * from the labels the screen is currently offering, so there is no written name
 * for a Tenant to disagree with — which is the same reason the account-naming
 * difference costs no Override.
 */
const namedTarget = (step: Step) =>
  step.action.type === "navigate" || step.action.type === "selectFromList"
    ? undefined
    : step.action.target

/**
 * Applies a Tenant's delta to the base Capability, in memory.
 *
 * The result is never written to `artifacts/`. It is the document *this run*
 * executes, assembled from the vendor's version plus the institution's
 * differences, and the two halves stay separately reviewable on disk.
 *
 * Every entry has to land somewhere, and an entry that does not is a refusal
 * rather than a no-op. An Override with a stale entry is a document somebody
 * believes is in force, and quietly ignoring it is how a tenant ends up running
 * a capability nobody has checked against their screens.
 */
export const applyOverride = (
  artifact: CapabilityArtifact,
  override: TenantOverride
): Result.Result<CapabilityArtifact, OverrideRefused> => {
  const refuse = (reason: string) =>
    Result.fail(
      new OverrideRefused({ tenant: override.tenant, capability: artifact.capability, reason })
    )

  if (override.capability !== artifact.capability) {
    return refuse(`it is written against ${override.capability}`)
  }

  let steps = artifact.steps
  for (const entry of override.targets) {
    const step = steps.find((candidate) => candidate.id === entry.step)
    if (step === undefined) {
      return refuse(`step ${entry.step} is not in version ${artifact.version}`)
    }
    const target = namedTarget(step)
    if (target === undefined) {
      return refuse(
        `step ${entry.step} names no control — its action works out which one to use from ` +
          `the screen, so there is nothing here for a tenant to rename`
      )
    }
    if (target.name !== entry.was) {
      return refuse(
        `step ${entry.step} asks for ${JSON.stringify(target.name ?? "(no name)")} in version ` +
          `${artifact.version}, and this override was confirmed against ` +
          `${JSON.stringify(entry.was)}. Re-confirm it against the current version`
      )
    }
    steps = steps.map((candidate) =>
      candidate.id === entry.step && candidate.action.type !== "navigate" &&
        candidate.action.type !== "selectFromList"
        ? {
            ...candidate,
            action: {
              ...candidate.action,
              target: { ...candidate.action.target, name: entry.name }
            }
          }
        : candidate
    )
  }

  return Result.succeed({ ...artifact, steps })
}

/** What an Operator's confirmation turns into. Derived, never typed by them. */
export interface ConfirmedTarget {
  readonly stepId: string
  /** The name the base capability asks for. Read off the Artifact. */
  readonly was: string
  /** The control the consultation proposed, read off the live screen. */
  readonly name: string
  readonly discoveredFrom: string
  readonly confirmedBy: string
}

export interface OverrideOptions {
  /**
   * The run's own Evidence scrubber, for the same reason an Amendment takes one:
   * what a run's log refuses to carry, its documents refuse to carry. An
   * Operator's confirmation is quoted into `confirmedBy` verbatim.
   *
   * **Required, exactly as `AmendmentOptions.scrub` is.** An optional scrubber
   * defaulting to identity compares the delta against an unchanged copy of
   * itself, so the check below always passes and the guarantee is gone without
   * anything saying so. `noScrubbing` is how a caller says it means it.
   */
  readonly scrub: (text: string) => string
}

/**
 * Adds one confirmed correspondence to a Tenant's Override, or starts one.
 *
 * Append-only per Step. An entry that already exists is a refusal, not a
 * replacement: a Tenant that renamed the control *again* is a new discovery and
 * has to go round the ladder again, because the confirmation on the existing
 * entry was given about a screen that has since changed. Silently overwriting it
 * would keep the old provenance sentence attached to a new fact, which is the
 * one thing a provenance field must never do.
 */
export const declareTargetOverride = (
  existing: TenantOverride | undefined,
  tenant: string,
  artifact: CapabilityArtifact,
  confirmed: ConfirmedTarget,
  options: OverrideOptions
): Result.Result<TenantOverride, OverrideRefused> => {
  const refuse = (reason: string) =>
    Result.fail(new OverrideRefused({ tenant, capability: artifact.capability, reason }))

  const step = artifact.steps.find((candidate) => candidate.id === confirmed.stepId)
  if (step === undefined) {
    return refuse(`step ${confirmed.stepId} is not in version ${artifact.version}`)
  }
  const target = namedTarget(step)
  if (target === undefined || target.name !== confirmed.was) {
    return refuse(
      `step ${confirmed.stepId} does not ask for ${JSON.stringify(confirmed.was)} in version ` +
        `${artifact.version}`
    )
  }
  if (confirmed.name === confirmed.was) {
    return refuse(
      `the confirmed control is the one the capability already asks for, so there is no ` +
        `difference to record`
    )
  }
  if (existing?.targets.some((entry) => entry.step === confirmed.stepId) === true) {
    return refuse(
      `${tenant} already has a confirmed override for step ${confirmed.stepId}. An override ` +
        `is append-only: a control that has been renamed again is a new discovery, and the ` +
        `confirmation on the existing entry was given about a screen that has changed`
    )
  }

  const override: TenantOverride = {
    tenant,
    capability: artifact.capability,
    baseVersion: artifact.version,
    targets: [
      ...(existing?.targets ?? []),
      {
        step: confirmed.stepId,
        was: confirmed.was,
        name: confirmed.name,
        discoveredFrom: confirmed.discoveredFrom,
        confirmedBy: confirmed.confirmedBy
      }
    ]
  }

  // The same rule an Amendment is held to, applied to the same kind of document:
  // if scrubbing what would be written changes it, it carries a runtime value and
  // must not be stored. The line count is reported and the value never is.
  //
  // The type makes the scrubber required; this is the runtime half, because the
  // failure it prevents is a silent one — a delta compared against an unchanged
  // copy of itself passes every time.
  if (typeof options.scrub !== "function") {
    return refuse(
      "no scrubber was supplied, so the override could not be checked for values this run " +
        "treats as sensitive. The check is not optional (ADR-0008): an override that cannot " +
        "be checked is refused rather than written"
    )
  }
  const rendered = JSON.stringify(override)
  const scrubbed = options.scrub(rendered)
  if (scrubbed !== rendered) {
    return refuse(
      `the override would carry a value this run treats as sensitive. A tenant override ` +
        `outlives the run it was discovered in and carries no runtime data (ADR-0008)`
    )
  }

  // The delta has to produce a document that still loads. Checked here rather
  // than at the next run, so a confirmation that could not be honoured is loud at
  // the moment somebody gives it.
  const applied = applyOverride(artifact, override)
  if (Result.isFailure(applied)) return Result.fail(applied.failure)
  formatArtifact(applied.success)

  return Result.succeed(override)
}

/** How an Override reads in a report: one line per confirmed correspondence. */
export const describeOverride = (override: TenantOverride): string =>
  override.targets
    .map(
      (entry) =>
        `${override.capability}@${override.baseVersion} step ${entry.step}: ` +
        `${JSON.stringify(entry.was)} is ${JSON.stringify(entry.name)} at ${override.tenant}`
    )
    .join("\n")

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

const decode = Schema.decodeUnknownResult(TenantOverride)

/**
 * Reads a Tenant Override.
 *
 * `ArtifactInvalid` rather than a class of its own, because it says exactly what
 * this needs to say — which document, and what is wrong with it — and a second
 * near-identical error type would give a caller two things to handle where the
 * situation is one. An Override is a document in the same store, read the same
 * way, by the same reader.
 */
export const parseOverride = (
  source: string,
  yaml: string
): Result.Result<TenantOverride, ArtifactInvalid> => {
  let document: unknown
  try {
    document = Bun.YAML.parse(yaml)
  } catch (cause) {
    return Result.fail(new ArtifactInvalid({ source, problems: [`not valid YAML: ${cause}`] }))
  }
  const decoded = decode(document)
  return Result.isFailure(decoded)
    ? Result.fail(new ArtifactInvalid({ source, problems: [String(decoded.failure)] }))
    : Result.succeed(decoded.success)
}

/** Block-style YAML, for the same reason an Artifact gets it: somebody reads it. */
export const formatOverride = (override: TenantOverride): string =>
  toYaml(Schema.encodeSync(TenantOverride)(override))
