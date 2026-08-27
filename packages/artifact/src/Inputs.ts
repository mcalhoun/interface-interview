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
 * ## Values are `Redacted`, uniformly (ticket 08)
 *
 * `ResolvedInput.text` is a `Redacted<string>`, and it is *always* one — the
 * wrapper does not appear and disappear with the `sensitive` flag. A type that
 * changes shape according to a boolean somebody wrote in a YAML file is a type no
 * call site can rely on, and the one call site that got it wrong would be the
 * leak. So the representation is uniform and the flag governs something else
 * entirely: whether Evidence gets scrubbed of the value on the way out.
 *
 * What the wrapper buys is that the ordinary ways a value escapes stop working.
 * `String(input.text)`, `JSON.stringify(input)`, a template literal and a
 * `console.log` all render `<redacted:memberId>`. Getting the characters back
 * takes `Redacted.value(...)`, which is a string you can grep the repository for
 * — and `test/sensitive-data.test.ts` does exactly that, pinning the call sites
 * so a new one has to be argued for in review rather than merged by accident.
 */

import { Redacted, Result, Schema } from "effect"

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

/**
 * What the Artifact *asks* for. Not the answer on its own — see `Declassifier`.
 *
 * Absent means sensitive (ADR-0008). Read through this rather than touching
 * `declaration.sensitive`, because `undefined` and `false` mean opposite things
 * and only one of them is safe to get wrong.
 */
export const isSensitive = (declaration: InputDeclaration): boolean =>
  declaration.sensitive ?? true

export const isRequired = (declaration: InputDeclaration): boolean =>
  declaration.required ?? true

/**
 * Whether Policy permits one parameter's value to appear in Evidence in the
 * clear.
 *
 * A plain predicate rather than a service, because `prepareInputs` is a pure
 * `Result` and has to stay one — a bad call must not be able to have opened a
 * browser. `@cua/policy` builds these; nothing here imports it, so the
 * dependency runs one way.
 *
 * The default declassifies nothing, which is what makes forgetting to pass one
 * safe rather than silently permissive.
 */
export type Declassifier = (parameter: string) => boolean

export const declassifiesNothing: Declassifier = () => false

/**
 * The deny-first rule: **two independent voices have to agree before a value is
 * treated as non-sensitive.**
 *
 * The Artifact has to say `sensitive: false` in writing, *and* Policy has to
 * allowlist the parameter. An Artifact is a discovered document — at ticket 11 a
 * model writes it — so on its own it does not get to declassify anything.
 * Configuration a human approved is the second signature.
 *
 * Written as an `||` on purpose: every path that is not "both said yes" lands on
 * sensitive. ADR-0008 takes the false positives happily, because a rejected
 * value is a much better failure than a leaked member identifier.
 */
export const classifySensitive = (
  declaration: InputDeclaration,
  parameter: string,
  declassify: Declassifier
): boolean => isSensitive(declaration) || !declassify(parameter)

/**
 * One validated value.
 *
 * `text` is `Redacted` whether or not it is sensitive; `sensitive` says whether
 * the Evidence scrubber replaces occurrences of it in text evidence. See the
 * module header for why those are two separate things.
 */
export interface ResolvedInput {
  readonly name: string
  readonly text: Redacted.Redacted<string>
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
  supplied: Readonly<Record<string, string>>,
  declassify: Declassifier = declassifiesNothing
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
    // Labelled with the input's own name, so an accidental serialisation renders
    // `<redacted:memberId>` — which names the leak that did not happen.
    resolved.set(name, {
      name,
      text: Redacted.make(raw, { label: name }),
      sensitive: classifySensitive(declaration, name, declassify)
    })
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
