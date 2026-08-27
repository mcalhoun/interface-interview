/**
 * A Policy as a document: the file a reviewer reads instead of this code.
 *
 * SPEC's Policy engine section asks for "allowlisted origins and action types,
 * with risky or irreversible actions handled conservatively by default". All
 * three of those are decisions about a deployment rather than about a program, so
 * they live in `policies/<name>.yaml` and this module is only their schema and
 * the checks that make a wrong one refuse to load.
 *
 * YAML for the same reason a Capability Artifact is YAML: this is an approval
 * document. The justification a reviewer writes next to a permitted `click` is a
 * paragraph of prose, and a diff between two versions of an allowlist has to be
 * readable by the person signing it off. `Bun.YAML.parse` is built into the
 * runtime, so it costs no dependency, and it only turns text into data — every
 * judgement about whether that data is a Policy happens below it.
 *
 * ## Conservative by default, structurally
 *
 * Three rules, and none of them is a comment asking nicely:
 *
 * 1. **Nothing is permitted that is not written down.** There is no `allow: all`,
 *    no default-allow branch, and an Action type absent from the file is denied.
 *    A missing or unreadable Policy file therefore stops the run rather than
 *    running it unrestricted, which is the failure mode a banking system wants.
 * 2. **A risky Action type cannot be permitted silently.** Permitting `click` or
 *    `fill` requires a `because:` of real substance on the same entry, and a file
 *    that omits it does not load at all. The cost of permitting something
 *    irreversible is that somebody has to write down why, in the document the
 *    approver reads.
 * 3. **A mode may only narrow.** The optional `modes:` block lets Discovery run
 *    under a tighter set than Replay, but a mode listing an Action type the
 *    top-level allowlist does not contain is a load error. There is one allowlist
 *    and modes are subsets of it, so no reviewer has to cross-reference two lists
 *    to work out the union.
 *
 * ## What is deliberately not here
 *
 * Path-level rules. The origin allowlist constrains where the browser may go, not
 * which endpoint within an origin. That is enough for a product whose mutations
 * are all POSTs behind a `click`, and it would not be for a legacy application
 * with mutating GETs; `Policy.ts` says so in the note beside the risk table. Rate
 * limits, time windows and per-capability scoping are likewise absent — each is a
 * real control and each would need its own evidence and its own tests.
 */

import { Result, Schema } from "effect"
import { type OriginPattern, parseOriginPattern } from "./origins.ts"
import { type ActionMode, ACTION_TYPES, riskOf } from "./Policy.ts"

/**
 * How long a justification has to be before it counts as one.
 *
 * A number rather than a judgement call, for the same reason a Target's
 * `robustness` prose has a minimum: "yes" and "needed" are not reasons, and the
 * only mechanical way to ask for an argument is to ask for enough words to make
 * one. It is a floor on effort, not a check on quality — a reviewer still has to
 * read it.
 */
export const JUSTIFICATION_MINIMUM = 60

/** One permitted Action type. `because` is required for the risky ones. */
export const PermittedAction = Schema.Struct({
  type: Schema.String,
  /**
   * Why this deployment accepts the risk. Required for `click` and `fill`, and
   * carried into every `policy.check` Evidence event that allows one, so the
   * reviewer's argument travels with the run rather than staying in a file
   * nobody opens afterwards.
   */
  because: Schema.optional(Schema.String)
})
export type PermittedAction = typeof PermittedAction.Type

/** A per-mode narrowing. Listed Action types must already be permitted overall. */
export const ModeRule = Schema.Struct({
  actions: Schema.Array(Schema.String),
  /** Why this mode is narrower, for the reviewer. */
  because: Schema.optional(Schema.String)
})
export type ModeRule = typeof ModeRule.Type

export const PolicyDocument = Schema.Struct({
  /** How the Policy names itself. Recorded on every verdict. */
  policy: Schema.String,
  /** Prose, for the reviewer. What this Policy is for and when it applies. */
  description: Schema.String,
  /**
   * Every origin an Action may happen on or navigate to. Patterns, not URLs —
   * see `origins.ts` for exactly what one means.
   */
  origins: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  /** Every Action type permitted. Anything absent is denied. */
  actions: Schema.Array(PermittedAction),
  /** Optional per-mode narrowing. A mode may remove Action types, never add. */
  modes: Schema.optional(
    Schema.Struct({
      replay: Schema.optional(ModeRule),
      discovery: Schema.optional(ModeRule)
    })
  )
})
export type PolicyDocument = typeof PolicyDocument.Type

/** The Policy could not be read, or does not hang together. A Hard Failure. */
export class PolicyInvalid extends Schema.TaggedError<PolicyInvalid>()("PolicyInvalid", {
  source: Schema.String,
  problems: Schema.Array(Schema.String)
}) {
  override get message(): string {
    return `${this.source}: ${this.problems.join("; ")}`
  }
}

/**
 * A Policy document with its patterns parsed and its rules checked.
 *
 * `decide` takes one of these rather than the raw document, so every check that
 * could have failed has already failed by the time a verdict is being produced.
 * A Policy either loaded or the run never started.
 */
export interface CompiledPolicy {
  readonly name: string
  readonly description: string
  /** Where it was read from, so evidence and error messages can name the file. */
  readonly source: string
  readonly origins: ReadonlyArray<OriginPattern>
  /** Mode to Action type to the entry that permitted it. Nothing else is permitted. */
  readonly permitted: ReadonlyMap<ActionMode, ReadonlyMap<string, PermittedAction>>
  readonly document: PolicyDocument
}

const decode = Schema.decodeUnknownResult(PolicyDocument)

const MODES: ReadonlyArray<ActionMode> = ["replay", "discovery"]

/**
 * Parses YAML into a checked, compiled Policy.
 *
 * Every problem in the file is collected rather than thrown one at a time, for
 * the same reason input validation collects them: an author fixing an allowlist
 * wants the whole set, not the first line that upset the parser.
 */
export const parsePolicy = (
  source: string,
  yaml: string
): Result.Result<CompiledPolicy, PolicyInvalid> => {
  let raw: unknown
  try {
    raw = Bun.YAML.parse(yaml)
  } catch (cause) {
    return Result.fail(new PolicyInvalid({ source, problems: [`not valid YAML: ${cause}`] }))
  }

  const decoded = decode(raw)
  if (Result.isFailure(decoded)) {
    return Result.fail(new PolicyInvalid({ source, problems: [String(decoded.failure)] }))
  }

  return compilePolicy(source, decoded.success)
}

/** The half of `parsePolicy` after decoding, so a document built in code is checked too. */
export const compilePolicy = (
  source: string,
  document: PolicyDocument
): Result.Result<CompiledPolicy, PolicyInvalid> => {
  const problems: Array<string> = []

  const origins: Array<OriginPattern> = []
  for (const entry of document.origins) {
    const parsed = parseOriginPattern(entry)
    if ("problem" in parsed) problems.push(parsed.problem)
    else origins.push(parsed.pattern)
  }

  const overall = new Map<string, PermittedAction>()
  for (const action of document.actions) {
    if (!ACTION_TYPES.includes(action.type as never)) {
      problems.push(
        `${action.type} is not an Action type this system has: ${ACTION_TYPES.join(", ")}. ` +
          `A policy cannot permit an Action the vocabulary does not contain`
      )
      continue
    }
    if (overall.has(action.type)) {
      problems.push(`${action.type} is permitted more than once; say it once`)
      continue
    }
    // Rule 2: the risky class costs a written reason, enforced at load rather
    // than checked at run time, so a policy that skipped it never runs at all.
    if (riskOf(action.type) === "risky") {
      const because = action.because?.trim() ?? ""
      if (because.length < JUSTIFICATION_MINIMUM) {
        problems.push(
          `${action.type} is a risky Action: it can commit a change that cannot be undone. ` +
            `Permitting it needs a because: of at least ${JUSTIFICATION_MINIMUM} characters ` +
            `saying why this deployment accepts that, and this one has ${because.length}`
        )
        continue
      }
    }
    overall.set(action.type, action)
  }

  // Rule 3: a mode narrows and never widens.
  const permitted = new Map<ActionMode, ReadonlyMap<string, PermittedAction>>()
  for (const mode of MODES) {
    const rule = document.modes?.[mode]
    if (rule === undefined) {
      permitted.set(mode, overall)
      continue
    }
    const narrowed = new Map<string, PermittedAction>()
    for (const type of rule.actions) {
      const entry = overall.get(type)
      if (entry === undefined) {
        problems.push(
          `mode ${mode} permits ${type}, which the policy's own actions: list does not. ` +
            `A mode may only narrow the allowlist, never widen it`
        )
        continue
      }
      narrowed.set(type, entry)
    }
    permitted.set(mode, narrowed)
  }

  if (problems.length > 0) return Result.fail(new PolicyInvalid({ source, problems }))

  return Result.succeed({
    name: document.policy,
    description: document.description,
    source,
    origins,
    permitted,
    document
  })
}
