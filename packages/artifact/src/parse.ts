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
import { type Action, noMatchCode, noMatchOutcome } from "./Action.ts"
import { CapabilityArtifact } from "./CapabilityArtifact.ts"
import type { Assertion, Checkpoint } from "./Checkpoint.ts"
import type { CapabilityTarget } from "./Target.ts"
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
 *
 * ## Every position, not a list somebody remembered to extend
 *
 * The walk covers *every* place the document holds fixed text: a `ValueRef`
 * constant, an assertion's literal, and a Target's own matching words. It covers
 * them wherever they appear — a Step's Action and Checkpoint, a Checkpoint's
 * outcome branches, and a Recoverable Condition's `detect` and `remedy`.
 *
 * The branches and the recovery rules matter more than they sound. Both are
 * written by an Amendment *after* a run met the state, from what that run saw on
 * screen — which is precisely the moment a member number gets copied into a
 * `textPresent`. A scanner that walked only `expect` would have been blind to the
 * documents most likely to carry one.
 *
 * A Target's `name`, `label`, `textNear` and scope are fixed text too: they are
 * the words the Artifact will use to find a control on every future run. A
 * discovered Target named after what one member's screen happened to say is the
 * same mistake as a baked-in constant, wearing a different field name.
 *
 * So are an input's declared `values` and its `pattern`. An `enum`'s legal values
 * are read off the screen during Discovery (ADR-0007), which is exactly the way a
 * run-specific label gets into a document, and `prepareInputs` matches against
 * them on every future call. A `pattern` is a regular expression the value must
 * satisfy, and one inferred from a single example can hold that example.
 *
 * ## What is deliberately *not* walked, and why
 *
 * `inputs.default` is by construction the Goal's own word — ticket 09's whole
 * argument is that recording the matched label there produces a capability that
 * works at one institution and looks correct doing it — so a `default` that
 * echoes a goal-derived value is the design rather than the defect. `description`
 * and `discoveredFrom` are prose, and prose is covered by the compiler's
 * whole-document text gate (`valuesInText` in `@cua/agent`), which reads the
 * finished YAML rather than a field list. Everything else in the schema is either
 * an identifier the document assigns itself (step ids, outcome codes, capability,
 * version) or reviewer prose (`title`, `summary`, `intent`, `robustness`,
 * `strategy`, `description`), neither of which the Artifact matches a screen with.
 */
/**
 * One position in a document that holds a value it should not.
 *
 * `where` and `value` are separate fields rather than one sentence a caller takes
 * apart, and that is the whole point of the shape. The caller that has to write a
 * refusal — `@cua/agent`'s compiler — must name the position and must *not* quote
 * the value, because a refusal about a leaked member number that contains the
 * member number lands in a terminal, a CI log and a ticket. Recovering the
 * position by splitting `finding` on a fixed phrase made that guarantee depend on
 * this module's wording: change the sentence and the value silently rides along
 * into the reason.
 */
export interface BakedInLiteral {
  /** Where in the document, e.g. `step open-account's checkpoint assertion 0's name`. */
  readonly where: string
  /**
   * The runtime value that was found.
   *
   * Safe here — the caller passed it in and already holds it — and never safe in
   * a message. See `where`.
   */
  readonly value: string
  /** Both halves as one sentence, for a caller that is allowed to print the value. */
  readonly finding: string
}

export const bakedInLiterals = (
  artifact: CapabilityArtifact,
  values: Iterable<string>
): ReadonlyArray<BakedInLiteral> => {
  const needles = [...values].filter((value) => value.length > 0)
  if (needles.length === 0) return []

  const found: Array<BakedInLiteral> = []
  const check = (where: string, text: string): void => {
    for (const needle of needles) {
      if (text.includes(needle)) {
        found.push({
          where,
          value: needle,
          finding: `${where} contains the runtime value ${JSON.stringify(needle)}`
        })
      }
    }
  }

  const checkValue = (where: string, ref: ValueRef): void => {
    if (ref.from === "constant") check(`${where}'s constant`, ref.text)
  }

  /** The words a Target uses to find its control, every future run. */
  const checkTarget = (where: string, target: CapabilityTarget): void => {
    if (target.name !== undefined) check(`${where}'s name`, target.name)
    if (target.label !== undefined) check(`${where}'s label`, target.label)
    if (target.textNear !== undefined) check(`${where}'s textNear`, target.textNear)
    if (target.within?.name !== undefined) check(`${where}'s scope`, target.within.name)
  }

  const checkAssertion = (where: string, assertion: Assertion): void => {
    switch (assertion.assert) {
      case "textPresent":
      case "textAbsent":
        check(where, assertion.text)
        return
      case "targetPresent":
      case "targetAbsent":
        checkTarget(where, assertion.target)
        return
      case "targetReads":
        checkTarget(where, assertion.target)
        checkValue(where, assertion.equals)
        return
      case "stepRead":
        check(`${where}'s pattern`, assertion.matches)
        return
    }
  }

  const checkAction = (where: string, action: Action): void => {
    switch (action.type) {
      case "navigate":
        checkValue(`${where}'s path`, action.path)
        return
      case "fill":
        checkTarget(`${where}'s target`, action.target)
        checkValue(`${where}'s value`, action.value)
        return
      case "click":
      case "extract":
        checkTarget(`${where}'s target`, action.target)
        return
      case "selectFromList":
        checkValue(`${where}'s match`, action.match.against)
        if (action.list.within?.name !== undefined) {
          check(`${where}'s list scope`, action.list.within.name)
        }
        return
    }
  }

  const checkCheckpoint = (where: string, checkpoint: Checkpoint): void => {
    checkpoint.expect.forEach((assertion, index) =>
      checkAssertion(`${where}'s checkpoint assertion ${index}`, assertion)
    )
    for (const branch of checkpoint.orOutcome ?? []) {
      branch.when.forEach((assertion, index) =>
        checkAssertion(`${where}'s ${branch.code} branch condition ${index}`, assertion)
      )
    }
  }

  for (const step of artifact.steps) {
    const where = `step ${step.id}`
    checkAction(where, step.action)
    checkCheckpoint(where, step.checkpoint)
  }

  for (const rule of artifact.recoverable ?? []) {
    const where = `recoverable condition ${rule.condition}`
    rule.detect.forEach((assertion, index) =>
      checkAssertion(`${where}'s detect condition ${index}`, assertion)
    )
    rule.remedy.forEach((remedy, index) => checkAction(`${where}'s remedy ${index}`, remedy.action))
  }

  // The inputs. Screen-derived and matched against on every future run, which is
  // both halves of what makes a literal dangerous.
  for (const [name, declaration] of Object.entries(artifact.inputs)) {
    const where = `input ${name}`
    ;(declaration.values ?? []).forEach((value, index) =>
      check(`${where}'s value ${index}`, value)
    )
    if (declaration.pattern !== undefined) check(`${where}'s pattern`, declaration.pattern)
  }

  // The entry path. A Step's `navigate` constant is walked above, and the
  // compiler writes the same string into both — but this one is the field a
  // hand-written or amended document can move on its own, and
  // `/member?memberNumber=12345` is a perfectly ordinary thing to paste into it.
  check("the surface entry path", artifact.surface.entry)

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

  // Regular expressions, and the enum that can never be satisfied.
  //
  // `pattern` and `stepRead.matches` are plain strings in the schema, so an
  // invalid source decodes perfectly and then throws at the worst possible
  // moment. `prepareInputs` is a pure `Result` whose whole guarantee is that a
  // bad call costs nothing — a `SyntaxError` thrown out of it is not a `Result`
  // and no caller is written to catch one. Inside a Checkpoint it is worse: the
  // throw becomes a defect on a channel typed `never`, so it bypasses replay's
  // failure reporting, and the run ends without its final Evidence event. Both
  // are cheap to refuse when the document is read, which is the only moment
  // that costs nothing at all.
  const checkRegex = (where: string, source: string): void => {
    try {
      RegExp(source)
    } catch (cause) {
      problems.push(`${where} is not a valid regular expression: ${cause}`)
    }
  }

  for (const [name, declaration] of Object.entries(artifact.inputs)) {
    if (declaration.pattern !== undefined) {
      checkRegex(`input ${name}'s pattern`, declaration.pattern)
    }
    // An enum with no values parses, and then rejects everything: `values` is the
    // set legality is decided against, so an empty one makes the capability
    // uncallable while looking like a declaration. Discovery reads these off the
    // screen, and a screen that offered nothing is a discovery that found no
    // list, not a parameter with no legal values.
    if (declaration.type === "enum" && (declaration.values ?? []).length === 0) {
      problems.push(
        `input ${name} is an enum and declares no values, so no value a caller could pass ` +
          `would be legal`
      )
    }
  }

  const checkPatterns = (where: string, assertions: ReadonlyArray<Assertion>): void => {
    assertions.forEach((assertion, index) => {
      if (assertion.assert === "stepRead") checkRegex(`${where} ${index}`, assertion.matches)
    })
  }

  for (const step of artifact.steps) {
    checkPatterns(`step ${step.id}'s checkpoint assertion`, step.checkpoint.expect)
    for (const branch of step.checkpoint.orOutcome ?? []) {
      checkPatterns(`step ${step.id}'s ${branch.code} branch condition`, branch.when)
    }
  }
  for (const rule of artifact.recoverable ?? []) {
    checkPatterns(`recoverable condition ${rule.condition}'s detect condition`, rule.detect)
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
