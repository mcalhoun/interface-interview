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
 * The same applies to the Business Outcomes an Artifact declares. A Checkpoint
 * branch returning an undeclared code, or a declared code no branch can reach,
 * are both documents that lie about the Capability's domain contract — and a
 * contract is only worth reading if something checks it.
 *
 * This is the check ticket 11's compiler has to satisfy. Emitting an Artifact
 * that fails `parseArtifact` is a compiler bug, and having the check exist first
 * is why the ordering in SPEC's build order puts Replay before Discovery.
 */

import { Result, Schema } from "effect"
import { noMatchCode, noMatchOutcome } from "./Action.ts"
import { CapabilityArtifact } from "./CapabilityArtifact.ts"
import type { Assertion } from "./Checkpoint.ts"
import type { ValueRef } from "./Value.ts"
import { toYaml } from "./yaml.ts"

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

/**
 * Round-trips an Artifact back to YAML, for the compiler and for schema tests.
 *
 * Written with `toYaml` rather than `Bun.YAML.stringify`, which emits flow style —
 * a whole Artifact on one line. See `yaml.ts`: an Artifact is a review document,
 * and a document with no readable diff cannot be the thing a reviewer approves.
 * The *reader* is still Bun's, so nothing here invents a dialect: the round trip
 * in `test/artifact-schema.test.ts` formats every stored version, parses it back
 * with `Bun.YAML.parse`, and requires the result to be identical.
 */
export const formatArtifact = (artifact: CapabilityArtifact): string =>
  toYaml(Schema.encodeSync(CapabilityArtifact)(artifact))

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
  const declared = new Set(Object.keys(artifact.outcomes ?? {}))
  /** Outcome codes some Checkpoint branch can actually produce. */
  const reachable = new Set<string>()

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
    if (step.action.type === "selectFromList") {
      checkValue(`${where}'s match`, step.action.match.against)
      // A selection that cannot say what it is choosing between, or what to
      // escalate when it lands on none or several, is not reviewable. The two
      // outcomes are the reason the Action exists, so an empty code is refused
      // here rather than surfacing at 3am as an escalation named "".
      if (step.action.list.itemRole.trim() === "") {
        problems.push(`${where} selects from a list without saying what an item is`)
      }
      if (noMatchCode(step.action.onNoMatch).trim() === "") {
        problems.push(`${where} declares no code for when nothing matches`)
      }
      if (step.action.onMultiple.escalate.trim() === "") {
        problems.push(`${where} declares no code to escalate under when several match`)
      }
      // A learned no-match is a Business Outcome like any other, and is held to
      // the same contract in both directions: it needs prose declaring what the
      // code means to a caller, and declaring it here is what makes it reachable.
      // Without this, an Amendment could promote a state to an answer and leave
      // the caller with a code nothing explains.
      const learned = noMatchOutcome(step.action.onNoMatch)
      if (learned !== undefined) {
        if (!declared.has(learned)) {
          problems.push(
            `${where}'s learned no-match outcome ${learned} is not declared in outcomes`
          )
        }
        reachable.add(learned)
      }
    }
    // An `extract` binds its reading under the step's own id, and a Checkpoint on
    // that same step is allowed to assert on it — so bind before checking.
    if (step.action.type === "extract") readBefore.add(step.id)
    step.checkpoint.expect.forEach((assertion, index) =>
      checkAssertion(`${where}'s checkpoint assertion ${index}`, assertion)
    )
    for (const branch of step.checkpoint.orOutcome ?? []) {
      // A code a caller can receive with no prose saying what it means is a
      // domain contract with a hole in it.
      if (!declared.has(branch.code)) {
        problems.push(
          `${where}'s outcome branch returns ${branch.code}, which is not declared in outcomes`
        )
      }
      reachable.add(branch.code)
      branch.when.forEach((assertion, index) =>
        checkAssertion(`${where}'s ${branch.code} branch condition ${index}`, assertion)
      )
    }
  }

  // ...and the other direction. A declared outcome nothing can reach is a
  // document claiming a behaviour the Capability does not have, which is worse
  // than not documenting it: a reviewer approves the claim, and a caller writes a
  // branch that never runs.
  for (const code of declared) {
    if (!reachable.has(code)) {
      problems.push(
        `outcome ${code} is declared but no checkpoint branch or learned no-match can reach it`
      )
    }
  }

  // The states this Capability has learned it must never handle itself.
  //
  // Three checks, and each one is a rule that would otherwise live only in the
  // Amendment that writes these entries. A hand-edited document has to obey them
  // too, which is the whole reason they are here: the write-once rule is a
  // property of the *Artifact*, not of the mechanism that happened to produce one.
  const humanSteps = new Map<string, string>()
  for (const [code, entry] of Object.entries(artifact.requiresHuman ?? {})) {
    const where = `requires-human state ${code}`
    if (!stepIds.has(entry.step)) {
      problems.push(`${where} names step ${entry.step}, which this capability does not have`)
    }
    // A code in both sections is a downgrade half-performed, and it is refused
    // rather than resolved: a document that classifies one state twice does not
    // say which classification is in force, and the safe reading of a
    // requires-human entry is the only reading there can be.
    if (declared.has(code)) {
      problems.push(
        `${where} is also declared as a business outcome. A learned classification only ever ` +
          `tightens, so a code is in one section or the other and never in both`
      )
    }
    // One Step's checkpoint reaches one classified state, because the Step is the
    // whole of how that state is recognised (see `RequiresHuman.ts`). Two entries
    // would make which one applies depend on key order.
    const already = humanSteps.get(entry.step)
    if (already !== undefined) {
      problems.push(
        `${where} and ${already} both classify step ${entry.step}, and a step's checkpoint ` +
          `reaches one classified state`
      )
    }
    humanSteps.set(entry.step, code)
  }

  // Recovery rules. A rule can fire at any Step, so unlike a Step's own values
  // its references are checked against the inputs alone: `{ from: step, ... }`
  // would mean something different depending on where the condition happened to
  // be met, and a rule whose meaning depends on when it fires is not reviewable.
  const conditions = new Set<string>()
  for (const rule of artifact.recoverable ?? []) {
    const where = `recoverable condition ${rule.condition}`
    if (conditions.has(rule.condition)) {
      problems.push(`${where} is declared more than once`)
    }
    conditions.add(rule.condition)

    rule.remedy.forEach((remedy, index) => {
      const at = `${where}'s remedy ${index}`
      const ref =
        remedy.action.type === "navigate"
          ? remedy.action.path
          : remedy.action.type === "fill"
            ? remedy.action.value
            : undefined
      if (ref === undefined) return
      if (ref.from === "step") {
        problems.push(`${at} refers to what a step read, which a remedy may not depend on`)
        return
      }
      checkValue(at, ref)
    })
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
