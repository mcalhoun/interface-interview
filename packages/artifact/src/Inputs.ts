/**
 * A Capability's declared inputs, and the validation that happens before a
 * browser ever opens.
 *
 * Two things here are load-bearing.
 *
 * **Sensitivity defaults to true** (ADR-0008). The schema's default is `true`, so
 * an input is sensitive unless an Artifact says otherwise in writing. Getting
 * this backwards is free at the moment it is written and expensive for years
 * afterwards, and we do not ask a model to judge what counts as PII in regulated
 * financial data.
 *
 * **Validation is a pure `Result`, not an `Effect`.** SPEC user story 30 wants
 * bad calls to "fail fast and cheap", before touching a browser. A function that
 * returns a `Result` and requires no services *cannot* have opened one — the
 * guarantee is in the signature rather than in the ordering of statements, which
 * is the same argument ADR-0003 makes one level up. `test/replay-inputs.test.ts`
 * pins it.
 *
 * ## Seam for ticket 08 (sensitive data handling)
 *
 * `ResolvedInput.text` is a plain string today. Ticket 08 turns a sensitive one
 * into `Redacted<string>`, so printing or serialising it takes a deliberate,
 * greppable `Redacted.value(...)`. Two call sites unwrap: the Surface `fill` in
 * the Replay executor, and the `targetReads` Checkpoint comparison. Everything
 * else already routes values through `ResolvedInputs` rather than passing raw
 * strings around, which is what makes that change small.
 */

import { Result, Schema } from "effect"

/**
 * What kind of value an input holds.
 *
 * `enum` carries its legal values, which ticket 09 reads off the page during
 * Discovery rather than taking from a human (ADR-0007). Deliberately small: an
 * Artifact declaring an input type nothing can validate is worse than one that
 * declares a string.
 */
export const InputType = Schema.Literals(["string", "integer", "enum"])
export type InputType = typeof InputType.Type

export const InputDeclaration = Schema.Struct({
  type: InputType,
  /** What this input means to the caller, not what the field is called on screen. */
  description: Schema.String,
  /**
   * Regulated by default. An Artifact must say `sensitive: false` in writing for
   * a value to reach Evidence unscrubbed. See ADR-0008.
   */
  sensitive: Schema.optional(Schema.Boolean),
  required: Schema.optional(Schema.Boolean),
  /** For `enum`: the legal values, read off the Surface during Discovery. */
  values: Schema.optional(Schema.Array(Schema.String)),
  /** Used when the caller omits an optional input. */
  default: Schema.optional(Schema.String),
  /** For `string`: a JavaScript regular expression source the value must match. */
  pattern: Schema.optional(Schema.String),
  /**
   * How Discovery arrived at this input, e.g.
   * `goal term 'savings' ⊂ label 'Primary Savings'`. Provenance a reviewer can
   * check, rather than a contract asserted after the fact.
   */
  discoveredFrom: Schema.optional(Schema.String)
})
export type InputDeclaration = typeof InputDeclaration.Type

/** Declared inputs, keyed by the name a caller passes. */
export const InputDeclarations = Schema.Record(Schema.String, InputDeclaration)
export type InputDeclarations = typeof InputDeclarations.Type

export const isSensitive = (declaration: InputDeclaration): boolean =>
  declaration.sensitive ?? true

export const isRequired = (declaration: InputDeclaration): boolean =>
  declaration.required ?? true

/** One validated value, carrying whether it may be written to Evidence as-is. */
export interface ResolvedInput {
  readonly name: string
  readonly text: string
  readonly sensitive: boolean
}

/** Every input a run may refer to, keyed by name. */
export type ResolvedInputs = ReadonlyMap<string, ResolvedInput>

/**
 * Why a call was rejected before it cost anything.
 *
 * `problems` is a list because telling a caller about one bad argument at a time
 * is a slow way to fix three.
 */
export class InputsInvalid extends Schema.TaggedError<InputsInvalid>()("InputsInvalid", {
  capability: Schema.String,
  problems: Schema.Array(Schema.String)
}) {
  override get message(): string {
    return `${this.capability}: ${this.problems.join("; ")}`
  }
}

/**
 * Validates raw caller arguments against the declared inputs.
 *
 * Pure, service-free and browser-free by construction. Unknown arguments are
 * rejected rather than ignored: a caller who passes `--memberID` and gets a run
 * against a default is worse off than one who gets told they typoed it.
 */
export const prepareInputs = (
  capability: string,
  declarations: InputDeclarations,
  supplied: Readonly<Record<string, string>>
): Result.Result<ResolvedInputs, InputsInvalid> => {
  const problems: Array<string> = []
  const resolved = new Map<string, ResolvedInput>()

  for (const name of Object.keys(supplied)) {
    if (!Object.hasOwn(declarations, name)) {
      const known = Object.keys(declarations).join(", ")
      problems.push(`${name} is not an input of this capability (declared: ${known || "none"})`)
    }
  }

  for (const [name, declaration] of Object.entries(declarations)) {
    const raw = supplied[name] ?? declaration.default
    if (raw === undefined) {
      if (isRequired(declaration)) problems.push(`${name} is required and was not supplied`)
      continue
    }
    const problem = validate(name, declaration, raw)
    if (problem !== undefined) {
      problems.push(problem)
      continue
    }
    resolved.set(name, { name, text: raw, sensitive: isSensitive(declaration) })
  }

  return problems.length === 0
    ? Result.succeed(resolved)
    : Result.fail(new InputsInvalid({ capability, problems }))
}

/**
 * The problem with one value, or `undefined`.
 *
 * A rejection message never quotes the offending value: an input is sensitive by
 * default, and an error string is one of the easier ways for a member number to
 * end up in a log.
 */
const validate = (
  name: string,
  declaration: InputDeclaration,
  value: string
): string | undefined => {
  switch (declaration.type) {
    case "string":
      if (value.length === 0) return `${name} must not be empty`
      if (declaration.pattern !== undefined && !new RegExp(declaration.pattern).test(value)) {
        return `${name} does not match the declared pattern /${declaration.pattern}/`
      }
      return undefined
    case "integer":
      if (!/^-?\d+$/.test(value)) return `${name} must be an integer`
      return undefined
    case "enum": {
      const values = declaration.values ?? []
      if (!values.includes(value)) {
        return `${name} must be one of: ${values.join(", ")}`
      }
      return undefined
    }
  }
}
