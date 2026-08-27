/**
 * Reading a Capability Artifact, and checking that it hangs together.
 *
 * Schema decoding answers "is every field the right shape". It cannot answer
 * "does `{ from: parameter, name: memberId }` name an input that exists", and
 * that second question is the one that decides whether an Artifact is executable
 * at all. Both run here, so a Capability that references a Step it does not have
 * is rejected when it is read rather than three Steps into a live run against a
 * banking system.
 *
 * This is the check ticket 11's compiler has to satisfy. Emitting an Artifact
 * that fails `parseArtifact` is a compiler bug, and having the check exist first
 * is why the ordering in SPEC's build order puts Replay before Discovery.
 */

import { Result, Schema } from "effect"
import { CapabilityArtifact } from "./CapabilityArtifact.ts"
import type { Assertion } from "./Checkpoint.ts"
import type { ValueRef } from "./Value.ts"

/** The Artifact could not be read, or does not hang together. A Hard Failure. */
export class ArtifactInvalid extends Schema.TaggedError<ArtifactInvalid>()("ArtifactInvalid", {
  source: Schema.String,
  problems: Schema.Array(Schema.String)
}) {
  override get message(): string {
    return `${this.source}: ${this.problems.join("; ")}`
  }
}

const decode = Schema.decodeUnknownResult(CapabilityArtifact)

/**
 * Parses YAML into a checked Artifact.
 *
 * `Bun.YAML.parse` is built into the runtime, so an Artifact stays a
 * dependency-free file format. It only turns text into data; every judgement
 * about whether that data is an Artifact happens below it.
 */
export const parseArtifact = (
  source: string,
  yaml: string
): Result.Result<CapabilityArtifact, ArtifactInvalid> => {
  let document: unknown
  try {
    document = Bun.YAML.parse(yaml)
  } catch (cause) {
    return Result.fail(new ArtifactInvalid({ source, problems: [`not valid YAML: ${cause}`] }))
  }

  const decoded = decode(document)
  if (Result.isFailure(decoded)) {
    return Result.fail(new ArtifactInvalid({ source, problems: [String(decoded.failure)] }))
  }

  const problems = referentialProblems(decoded.success)
  return problems.length === 0
    ? Result.succeed(decoded.success)
    : Result.fail(new ArtifactInvalid({ source, problems }))
}

/** Round-trips an Artifact back to YAML, for the compiler and for schema tests. */
export const formatArtifact = (artifact: CapabilityArtifact): string =>
  Bun.YAML.stringify(Schema.encodeSync(CapabilityArtifact)(artifact))

/**
 * Every fixed literal in the document that contains one of `values`.
 *
 * The other half of ADR-0008: "Artifact compilation fails outright if a value
 * marked as fixed matches text from the Goal." A `{ from: parameter }` reference
 * has nowhere to put a member number, but a `{ from: constant }` and an
 * `assert: textPresent` both do — a discovery run that saw `Member 12345` on
 * screen and wrote that as the thing to assert has baked a runtime value into a
 * document that is supposed to outlive it.
 *
 * Containment rather than equality, because `Member 12345` is the shape the
 * mistake actually takes. False positives are possible and are the trade ADR-0008
 * names: a rejected Artifact is a much better failure than a leaked identifier.
 *
 * **Ticket 11:** call this with the Goal's terms and every value the discovery
 * run typed, and refuse to write an Artifact that returns anything. It is
 * deliberately not part of `parseArtifact`, because reading a stored document is
 * not the moment you know what the runtime values were.
 */
export const bakedInLiterals = (
  artifact: CapabilityArtifact,
  values: Iterable<string>
): ReadonlyArray<string> => {
  const needles = [...values].filter((value) => value.length > 0)
  if (needles.length === 0) return []

  const found: Array<string> = []
  const check = (where: string, text: string): void => {
    for (const needle of needles) {
      if (text.includes(needle)) {
        found.push(`${where} contains the runtime value ${JSON.stringify(needle)}`)
      }
    }
  }

  const checkValue = (where: string, ref: ValueRef): void => {
    if (ref.from === "constant") check(`${where}'s constant`, ref.text)
  }

  for (const step of artifact.steps) {
    const where = `step ${step.id}`
    if (step.action.type === "navigate") checkValue(`${where}'s path`, step.action.path)
    if (step.action.type === "fill") checkValue(`${where}'s value`, step.action.value)
    step.checkpoint.expect.forEach((assertion, index) => {
      const at = `${where}'s checkpoint assertion ${index}`
      if (assertion.assert === "textPresent" || assertion.assert === "textAbsent") {
        check(at, assertion.text)
      }
      if (assertion.assert === "targetReads") checkValue(at, assertion.equals)
      if (assertion.assert === "stepRead") check(`${at}'s pattern`, assertion.matches)
    })
  }

  return found
}

/**
 * Every reference in the document that has to point at something.
 *
 * Collected as a list rather than thrown one at a time, for the same reason input
 * validation is: an author fixing an Artifact wants the whole set.
 */
const referentialProblems = (artifact: CapabilityArtifact): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const inputs = new Set(Object.keys(artifact.inputs))
  const stepIds = new Set<string>()
  /** Steps that bind a reading, in order, so a forward reference is catchable. */
  const readBefore = new Set<string>()

  for (const step of artifact.steps) {
    if (stepIds.has(step.id)) problems.push(`step id ${step.id} is used more than once`)
    stepIds.add(step.id)
  }

  const checkValue = (where: string, ref: ValueRef): void => {
    switch (ref.from) {
      case "parameter":
        if (!inputs.has(ref.name)) {
          problems.push(`${where} refers to input ${ref.name}, which is not declared`)
        }
        return
      case "step":
        if (!readBefore.has(ref.step)) {
          problems.push(
            `${where} refers to step ${ref.step}, which has not read anything by that point`
          )
        }
        return
      case "constant":
        return
    }
  }

  const checkAssertion = (where: string, assertion: Assertion): void => {
    if (assertion.assert === "targetReads") checkValue(where, assertion.equals)
    if (assertion.assert === "stepRead" && !readBefore.has(assertion.step)) {
      problems.push(
        `${where} asserts on step ${assertion.step}, which has not read anything by that point`
      )
    }
  }

  for (const step of artifact.steps) {
    const where = `step ${step.id}`
    if (step.action.type === "navigate") checkValue(`${where}'s path`, step.action.path)
    if (step.action.type === "fill") checkValue(`${where}'s value`, step.action.value)
    // An `extract` binds its reading under the step's own id, and a Checkpoint on
    // that same step is allowed to assert on it — so bind before checking.
    if (step.action.type === "extract") readBefore.add(step.id)
    step.checkpoint.expect.forEach((assertion, index) =>
      checkAssertion(`${where}'s checkpoint assertion ${index}`, assertion)
    )
  }

  for (const [name, output] of Object.entries(artifact.outputs)) {
    if (!readBefore.has(output.from.step)) {
      problems.push(
        `output ${name} is built from step ${output.from.step}, which reads nothing`
      )
    }
    if (output.type === "money" && output.currency === undefined) {
      problems.push(`output ${name} is money and must declare a currency`)
    }
  }

  return problems
}
