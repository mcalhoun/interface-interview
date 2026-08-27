/**
 * The Artifact compiler: one successful Discovery run, turned into a Capability
 * Artifact a reviewer can approve and an agent can call.
 *
 * A pure function of a `Trajectory`. No model, no browser, no network, no clock —
 * which is why `Trajectory.ts` was written as plain data, and why every test in
 * `test/artifact-compiler.test.ts` that is about *compilation* runs in
 * milliseconds against a value.
 *
 * ## The claim this module is here to make true
 *
 * **Input parameters are derived, not declared.** Nobody writes an input schema.
 * Each distinct `goalDerived.name` the model recorded against a value becomes a
 * declared input, each use of it becomes `{ from: parameter }`, and the literal is
 * thrown away — SPEC, "Parameter discovery through provenance". A selection
 * becomes an `enum` input whose legal values were read off the live screen and
 * whose default is the goal's own word. That is the difference between a
 * discovery and a recording: a recording would have `12345` in it.
 *
 * ## Two invariants, enforced rather than encouraged
 *
 * **Sensitivity is deny-first.** Every discovered parameter is written
 * `sensitive: true`, in writing, always. Not because the model said so — a
 * document a model writes is not a control (ADR-0008). Declassifying one takes a
 * Policy allowlist entry *and* an Artifact that says `sensitive: false`, and
 * since Artifacts are immutable, the second half means a new version somebody
 * approved. The compiler cannot grant itself either.
 *
 * **A fixed value echoing the Goal fails compilation.** Three gates run over the
 * document that is about to be written, and any one of them stops it:
 *
 *   1. `goalEchoes` — every fixed literal in the document is checked against the
 *      Goal by token subset. ADR-0008's letter: "a `constant` colliding with the
 *      goal is a compile error". This is the gate that produces the clear message.
 *   2. `bakedInLiterals` (from `@cua/artifact`) — every fixed literal is checked
 *      for *containment* of a value this run actually typed, which catches
 *      `No member record found for member number 12345`, a string that echoes no
 *      goal token but carries the member number anyway.
 *   3. a scan of the finished YAML text for the values behind the parameters,
 *      which is the only gate that sees prose. A `summary` naming the member the
 *      run happened to use is a leak that no schema field could catch.
 *
 * Gate 1 duplicates a check `Provenance.ts` already makes at proposal time. That
 * is deliberate and ticket 10 asked for it in writing: a check that runs earlier
 * is not a check that runs instead. The proposal-time check exists so the model
 * gets told and re-tags; this one exists so that no path — a hand-edited
 * trajectory, a future caller assembling one, a bug in the loop — can reach the
 * artifacts directory with a member number in it.
 *
 * ## What is derived, and what is refused
 *
 * Everything in the emitted document comes from something the run observed. Where
 * nothing was observed, the compiler refuses rather than inventing:
 *
 *   - a Step whose success nothing could confirm is refused, not given a
 *     checkpoint that always passes. CONTEXT.md defines a Step as an Action
 *     paired with the Checkpoint that confirms it landed, and a vacuous
 *     Checkpoint is how "the action did not throw" becomes the success criterion
 *     again.
 *   - no `pattern` is derived for a string input. One run saw one value, and a
 *     format inferred from a single example is a constraint that will reject the
 *     second caller. The hand-written Artifact's `^[0-9]{4,10}$` is a human's
 *     claim about Heritage Core, and it should stay one.
 *   - no Business Outcomes and no recovery rules. Both are things a run *learns*
 *     from an Intervention, and inventing either would be the compiler claiming a
 *     behaviour the Capability has never demonstrated.
 */

import {
  type CapabilityArtifact,
  type CapabilityTarget,
  type InputDeclaration,
  type OutputDeclaration,
  type Assertion,
  type Step,
  type ValueRef,
  bakedInLiterals,
  currencyOf,
  formatArtifact,
  parseArtifact,
  toSurfaceTarget
} from "@cua/artifact"
import { type Target, TargetSchema, describeTarget, isTokenSubsetOf } from "@cua/surface"
import { Result, Schema } from "effect"
import { ProvenancedValue } from "./Provenance.ts"
import type { DiscoveredSelection, DiscoveryStep, Trajectory } from "./Trajectory.ts"
import { isCompilable, literalsTyped } from "./Trajectory.ts"

// ---------------------------------------------------------------------------
// What the caller supplies, and what a refusal says
// ---------------------------------------------------------------------------

export interface CompileOptions {
  /**
   * The dotted, stable name a calling agent invokes. Supplied rather than
   * derived: naming is the one judgement in this document that belongs to a
   * person, and a name generated out of the Goal text would put the Goal's words
   * — possibly including its values — into the catalog.
   */
  readonly capability: string
  /** Semantic version. Artifacts are immutable, so this names a file that must not exist. */
  readonly version: string
  /**
   * The vendor product, for a reviewer's context.
   *
   * Not derivable: Discovery observes an accessibility tree, and Heritage Core's
   * page titles carry the member number rather than a product identifier. So a
   * person says what the product is, and the default says plainly that nobody
   * has.
   */
  readonly product?: string
  /** One line for a catalog listing. Defaults to what the model said it accomplished. */
  readonly title?: string
}

/** The default product string. Honest about being unanswered rather than plausible. */
export const PRODUCT_UNIDENTIFIED = "unidentified — discovery records no product identifier"

/**
 * Compilation refused, with every reason at once.
 *
 * A list rather than the first problem, for the same reason input validation is a
 * list: whoever has to fix this wants the whole set.
 *
 * **No reason here ever quotes a value.** The messages name the position — which
 * step, which field — and say what is wrong with it. A refusal that printed the
 * member number it found would be a leak produced by the check that exists to
 * prevent leaks, and it would land in a terminal, a CI log and a ticket.
 */
export class CompilationRefused extends Schema.TaggedError<CompilationRefused>()(
  "CompilationRefused",
  { capability: Schema.String, reasons: Schema.Array(Schema.String) }
) {
  override get message(): string {
    return `cannot compile ${this.capability}: ${this.reasons.join("; ")}`
  }
}

// ---------------------------------------------------------------------------
// Reading the actions a run recorded
// ---------------------------------------------------------------------------

/**
 * The recorded form of an action, decoded rather than trusted.
 *
 * `DiscoveryStep.action` is a `Record<string, unknown>` — the loop writes it and
 * the compiler reads it, and a shared TypeScript type between two packages is a
 * weaker guarantee than a decode when the value has been through JSON on the way
 * (a Trajectory read off disk has). A shape this does not recognise is a refusal
 * with the step named, not a crash three fields later.
 */
const RecordedAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("navigate"), path: Schema.String }),
  Schema.Struct({ type: Schema.Literal("click"), target: TargetSchema }),
  Schema.Struct({
    type: Schema.Literal("fill"),
    target: TargetSchema,
    value: ProvenancedValue
  }),
  Schema.Struct({ type: Schema.Literal("extract"), target: TargetSchema }),
  Schema.Struct({
    type: Schema.Literal("selectFromList"),
    list: Schema.Struct({
      within: Schema.optional(
        Schema.Struct({ role: Schema.optional(Schema.String), name: Schema.optional(Schema.String) })
      ),
      itemRole: Schema.String
    }),
    match: Schema.Struct({ against: ProvenancedValue, strategy: Schema.Literal("tokenSubset") }),
    robustness: Schema.String
  })
])
type RecordedAction = typeof RecordedAction.Type

const decodeAction = Schema.decodeUnknownResult(RecordedAction)

// ---------------------------------------------------------------------------
// Targets: the strategy, and the argument for it
// ---------------------------------------------------------------------------

/**
 * The short strategy label, from the narrowing the adapter actually did.
 *
 * `outcome.resolvedBy` is what resolved this Target on the live screen, not what
 * anybody intended, so the label a reviewer reads is a record rather than a
 * claim. The vocabulary matches the hand-written Artifact's — `accessible-name`,
 * `scoped-accessible-name`, `caption-label`, `text-near` — because a reviewer
 * comparing a compiled document with a hand-written one should not have to learn
 * two ways of saying the same thing.
 */
export const strategyFor = (resolvedBy: ReadonlyArray<string>): string => {
  const scoped = resolvedBy.includes("within")
  const narrowing = [...resolvedBy].reverse().find((strategy) => strategy !== "within")
  const base = narrowing === "label"
    ? "caption-label"
    : narrowing === "textNear"
      ? "text-near"
      : narrowing === "name" || narrowing === "nameContains" || narrowing === "nameTokens"
        ? "accessible-name"
        : narrowing === "ordinal"
          ? "ordinal"
          : narrowing === "role"
            ? "role"
            : "unrecorded"
  return scoped ? `scoped-${base}` : base
}

/**
 * Why that strategy, and what would have to change on screen to break it.
 *
 * SPEC user story 16 wants each Target to record "how it is identified and why
 * that strategy was chosen, so that I can judge whether it still works next
 * month", and this is the sentence a reviewer approves on. Every clause of it is
 * something the run observed: the narrowing the adapter reported, how many other
 * controls also answered, and what the description is actually made of.
 *
 * `alternatives` is the load-bearing number. Zero means this description named
 * exactly one control on a real screen; anything else means an ordinal chose, and
 * a reviewer should be told that in the document rather than discovering it when
 * a row is added.
 */
const robustnessFor = (target: Target, strategy: string, outcome: DiscoveryStep["outcome"]): string => {
  const confidence = outcome.alternatives === 0
    ? "No other control on the screen answered to this description, so it named exactly one thing on the run that discovered it."
    : `${outcome.alternatives} other control(s) also answered to it, so an ordinal chose between them — the weakest part of this target, and the first thing to break if the screen gains a row.`
  const made = [
    target.role === undefined ? undefined : "an ARIA role",
    target.name === undefined ? undefined : "the accessible name a screen reader would announce",
    target.label === undefined ? undefined : "the caption cell sitting beside the value",
    target.textNear === undefined ? undefined : "nearby text",
    target.within === undefined ? undefined : "the caption of the region it sits in"
  ].filter((part) => part !== undefined)
  return (
    `Identified by ${strategy}. The adapter narrowed to it like this: ${outcome.rationale}. ` +
    `${confidence} It is described by ${made.join(", ")} and by nothing else: there is no ` +
    `selector, id, class or coordinate here, so a change to the markup leaves it working ` +
    `(ADR-0001). What would break it is the screen saying something different — a renamed ` +
    `control, a renamed region, or a control that stops being a ${target.role ?? "control"}.`
  )
}

const capabilityTargetFor = (target: Target, outcome: DiscoveryStep["outcome"]): CapabilityTarget => {
  const strategy = strategyFor(outcome.resolvedBy)
  return { ...target, strategy, robustness: robustnessFor(target, strategy, outcome) }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * Provenance, turned into a reference.
 *
 * The three-line function the whole design is for. A `goalDerived` value becomes
 * a parameter reference and its literal goes nowhere — which is why a compiled
 * Artifact has no member number in it, structurally, rather than because someone
 * remembered to take it out.
 */
const valueRefFor = (value: ProvenancedValue): ValueRef => {
  switch (value.kind) {
    case "goalDerived":
      return { from: "parameter", name: value.name }
    case "uiDerived":
      return { from: "step", step: value.fromStep }
    case "constant":
      return { from: "constant", text: value.literal }
  }
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/**
 * The shape of a reading, never the reading.
 *
 * An `extract` that quietly returns `""`, `N/A` or a system message is the silent
 * failure of screen reading, so the Step asserts the *shape* of what came back.
 * The shape is derived from what this run read — a currency rendering becomes a
 * currency pattern — and deliberately carries none of its digits: a pattern built
 * around `4,182.55` would be a balance baked into a capability, which is the exact
 * mistake ADR-0008 is about, wearing a regular expression as a disguise.
 */
export const shapeOf = (read: string): string => {
  const trimmed = read.trim()
  const currency = currencyOf(trimmed)
  if (currency !== undefined) {
    const symbol = trimmed.slice(0, trimmed.search(/[\d-]/)).trim()
    return `^${symbol.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*-?[0-9,]+\\.[0-9]{2}$`
  }
  if (/^-?[\d,]+$/.test(trimmed)) return "^-?[0-9,]+$"
  // Non-empty and not all whitespace. The weakest useful assertion, and still
  // strictly stronger than believing an extract because it did not throw.
  return "^\\s*\\S[\\s\\S]*$"
}

/**
 * What the *next* Step needing to work proves about this one.
 *
 * A Step is believed when the state it produced turns out to be the state the run
 * went on to act in. That is not a convention invented here — it is what the
 * discovery run actually demonstrated, one step at a time, and it is the only
 * evidence of a click's success that a Trajectory carries. So a `click` is
 * checkpointed on the control the following Step resolved, and a `selectFromList`
 * on the region the following Step read from.
 *
 * `undefined` means nothing observable follows, and the caller refuses rather
 * than writing a Checkpoint that cannot fail.
 */
const observableOf = (step: DiscoveryStep, action: RecordedAction): Assertion | undefined => {
  switch (action.type) {
    case "click":
    case "fill":
    case "extract":
      return { assert: "targetPresent", target: capabilityTargetFor(action.target, step.outcome) }
    case "selectFromList": {
      const region = action.list.within?.name
      return region === undefined ? undefined : { assert: "textPresent", text: region }
    }
    case "navigate":
      return undefined
  }
}

const describeObservable = (assertion: Assertion): string => {
  switch (assertion.assert) {
    case "targetPresent":
      return `The control the next step acts on is on screen: ${
        describeTarget(toSurfaceTarget(assertion.target))
      }.`
    case "textPresent":
      return `The screen the next step chooses from is showing: ${JSON.stringify(assertion.text)}.`
    default:
      return "The state the next step needs was reached."
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

interface CompiledStep {
  readonly step: Step
  readonly problems: ReadonlyArray<string>
}

const stepFor = (
  step: DiscoveryStep,
  action: RecordedAction,
  next: { readonly step: DiscoveryStep; readonly action: RecordedAction } | undefined
): CompiledStep => {
  const problems: Array<string> = []
  const following = next === undefined ? undefined : observableOf(next.step, next.action)

  /** The Checkpoint's assertions, in the order they are argued for above. */
  const expect: Array<Assertion> = []
  let description: string

  if (action.type === "extract" && step.outcome.read !== undefined) {
    expect.push({ assert: "stepRead", step: step.id, matches: shapeOf(step.outcome.read) })
    description =
      "A reading came back in the shape this reading had when the capability was discovered, " +
      "rather than an empty cell, a placeholder or a system message."
  } else if (action.type === "fill") {
    // A fill is verifiable in a way nothing else here is: the control can be read
    // back. Typing into the wrong field is the failure a screen full of
    // near-duplicate captions actually produces, and it raises nothing at all.
    expect.push({
      assert: "targetReads",
      target: capabilityTargetFor(action.target, step.outcome),
      equals: valueRefFor(action.value)
    })
    description = "The value is sitting in the control that was filled, and not in a neighbouring one."
  } else if (following !== undefined) {
    expect.push(following)
    description = describeObservable(following)
  } else {
    problems.push(
      `step ${step.id} is a ${action.type} that nothing afterwards confirms, so there is no ` +
        `checkpoint to write for it. A step is an action paired with the check that it landed; ` +
        `end the discovery run on a reading, or act on the screen this one reached.`
    )
    description = "(nothing observed)"
  }

  const compiled: Step = {
    id: step.id,
    intent: step.intent,
    action: actionFor(step, action),
    checkpoint: { description, expect }
  }
  return { step: compiled, problems }
}

const actionFor = (step: DiscoveryStep, action: RecordedAction): Step["action"] => {
  switch (action.type) {
    case "navigate":
      return { type: "navigate", path: { from: "constant", text: action.path } }
    case "click":
      return { type: "click", target: capabilityTargetFor(action.target, step.outcome) }
    case "fill":
      return {
        type: "fill",
        target: capabilityTargetFor(action.target, step.outcome),
        value: valueRefFor(action.value)
      }
    case "extract":
      return { type: "extract", target: capabilityTargetFor(action.target, step.outcome) }
    case "selectFromList":
      return {
        type: "selectFromList",
        list: {
          ...(action.list.within === undefined ? {} : { within: action.list.within }),
          itemRole: action.list.itemRole
        },
        match: { against: valueRefFor(action.match.against), strategy: "tokenSubset" },
        // Declared, not discovered at 3am. Nothing matching and several things
        // matching are different facts about the world, so each escalates under
        // its own code — SPEC's selection sketch names both.
        onNoMatch: { escalate: "NO_MATCHING_ITEM" },
        onMultiple: { escalate: "AMBIGUOUS_MATCH" },
        robustness:
          `${action.robustness} Observed at discovery: ${step.outcome.rationale}. Matching is ` +
          `token subset in one direction — every word of the parameter must appear in the item's ` +
          `label — so an institution that words the same item differently still matches, and two ` +
          `items that both match stop the run rather than one of them being opened.`
      }
  }
}

/**
 * The Step that opens the application.
 *
 * The Discovery loop navigates to the entry path before its first decision, so
 * that navigation is not one of the model's steps — but Replay has no entry logic
 * and starts by doing what the Artifact's first Step says. Compiling it in is
 * therefore not an invention: it is the run's own opening action, recorded in its
 * Evidence under the step id `open`, written into the document that has to
 * reproduce it.
 */
const openingStep = (trajectory: Trajectory, following: Assertion | undefined): CompiledStep => {
  const problems = following === undefined
    ? ["the run's first step observes nothing, so opening the application cannot be checkpointed"]
    : []
  return {
    step: {
      id: "open",
      intent: "Open the application at the entry path this capability starts from.",
      action: { type: "navigate", path: { from: "constant", text: trajectory.entry } },
      checkpoint: {
        description: following === undefined
          ? "(nothing observed)"
          : describeObservable(following),
        expect: following === undefined ? [] : [following]
      }
    },
    problems
  }
}

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

const enumInput = (selection: DiscoveredSelection): InputDeclaration => ({
  type: "enum",
  description:
    `Which item to choose from the list on screen. The legal values below were read off that ` +
    `list during discovery rather than written here by a human deciding what ought to be ` +
    `allowed, and a value is legal if every word of it appears in one of them — so a shorter, ` +
    `more portable word than the label is the right thing to pass.`,
  // ADR-0008. A discovered parameter is sensitive, and this document cannot
  // declassify it: that takes a Policy allowlist entry AND an Artifact saying so
  // in writing, which — Artifacts being immutable — means a version a person
  // approved. See `classifySensitive`.
  sensitive: true,
  required: false,
  values: selection.values,
  // THE GOAL'S OWN WORD, never the label it matched. Recording "Primary Savings"
  // where the goal said "savings" produces a capability that works at exactly one
  // institution and looks perfectly correct doing it. See `Selection.ts`.
  default: selection.default,
  discoveredFrom:
    `${selection.discoveredFrom}. The list offered ${
      selection.values.map((value) => JSON.stringify(value)).join(", ")
    }${
      selection.matched === undefined
        ? ""
        : `, and the default matched ${JSON.stringify(selection.matched)} on the run that ` +
          `discovered this — which is this institution's word for it and is deliberately NOT ` +
          `what the default records`
    }. The inference was made once, by the model, at discovery time. Replay never repeats it: ` +
    `it matches the default's tokens against whatever the live list offers.`
})

const stringInput = (name: string, usedBy: ReadonlyArray<string>): InputDeclaration => ({
  type: "string",
  description:
    `Supplied by the caller. Discovered as the value ${
      usedBy.length === 1 ? `step ${usedBy[0]}` : `steps ${usedBy.join(", ")}`
    } took from the goal, and named ${JSON.stringify(name)} by the model that read it — the ` +
    `semantic role it plays, in a caller's vocabulary rather than the screen's.`,
  // In writing, so a reviewer does not have to know the default to know the
  // answer. ADR-0008: never the model's call, and never inferred from the shape
  // of the value.
  sensitive: true,
  required: true,
  discoveredFrom:
    `Derived from the provenance recorded against the value at ${
      usedBy.length === 1 ? "the step" : "the steps"
    } that used it: the discovery run tagged it as coming from the goal and named the parameter ` +
    `it should become. No format is declared for it, deliberately — one run saw one value, and a ` +
    `pattern inferred from a single example would reject the second caller.`
})

const outputFor = (output: Trajectory["outputs"][number]): OutputDeclaration => {
  const currency = output.value === undefined ? undefined : currencyOf(output.value)
  return {
    ...(currency === undefined
      ? { type: "text" as const }
      : { type: "money" as const, currency }),
    description: output.description,
    from: { step: output.fromStep }
  }
}

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

/** Every fixed literal in the document, with where it sits. */
const fixedLiterals = (
  artifact: CapabilityArtifact
): ReadonlyArray<{ readonly where: string; readonly text: string }> => {
  const found: Array<{ where: string; text: string }> = []
  const constant = (where: string, ref: ValueRef): void => {
    if (ref.from === "constant") found.push({ where, text: ref.text })
  }
  for (const step of artifact.steps) {
    const at = `step ${step.id}`
    if (step.action.type === "navigate") constant(`${at}'s path`, step.action.path)
    if (step.action.type === "fill") constant(`${at}'s value`, step.action.value)
    if (step.action.type === "selectFromList") constant(`${at}'s match`, step.action.match.against)
    step.checkpoint.expect.forEach((assertion, index) => {
      const on = `${at}'s checkpoint assertion ${index}`
      if (assertion.assert === "textPresent" || assertion.assert === "textAbsent") {
        found.push({ where: on, text: assertion.text })
      }
      if (assertion.assert === "targetReads") constant(on, assertion.equals)
    })
  }
  return found
}

/**
 * ADR-0008's letter: a fixed value that echoes the Goal stops compilation.
 *
 * Token subset against the Goal, the same rule `checkProvenance` applies at
 * proposal time and the same rule the Surface matches list items with — one
 * comparison, used everywhere, so a reviewer only has to understand it once.
 *
 * The message names the position and says what to do about it, and it never
 * quotes the literal: a constant that echoes the goal may well *be* the member
 * number, and printing it in the refusal would leak it into whatever is reading
 * this.
 */
const goalEchoes = (artifact: CapabilityArtifact, goal: string): ReadonlyArray<string> =>
  fixedLiterals(artifact)
    .filter((literal) => isTokenSubsetOf(literal.text, goal))
    .map(
      (literal) =>
        `${literal.where} is fixed text that echoes the goal — every word of it appears in the ` +
        `goal this capability was discovered from. A fixed value is written into the stored ` +
        `document verbatim, so this run's data would be baked into every future run (ADR-0008). ` +
        `It has to be a parameter, or the assertion has to be made on the screen's own words ` +
        `rather than on what was asked for.`
    )

/**
 * Ticket 08's backstop: a fixed literal that *contains* a value the run typed.
 *
 * Run one parameter at a time so a finding can say which parameter it was — and
 * so the reason can be rewritten. `bakedInLiterals` quotes the needle it found,
 * which is exactly right for a function whose caller holds the value already, and
 * exactly wrong for a message that ends up in a log. The position is kept and the
 * value is dropped.
 */
const typedValuesInFixedText = (
  artifact: CapabilityArtifact,
  trajectory: Trajectory
): ReadonlyArray<string> => {
  const reasons: Array<string> = []
  const literals = literalsTyped(trajectory)
  trajectory.parameters.forEach((parameter, index) => {
    const literal = literals[index]
    if (literal === undefined) return
    for (const finding of bakedInLiterals(artifact, [literal])) {
      const [where] = finding.split(" contains the runtime value")
      reasons.push(
        `${where} contains the value this run supplied for ${parameter.name}. No runtime value ` +
          `survives into a stored capability (ADR-0008): reference the parameter instead.`
      )
    }
  })
  return reasons
}

/**
 * The last gate, and the only one that reads prose.
 *
 * Schema fields are not the only place a member number can hide. A `summary` or a
 * `robustness` paragraph is free text a model wrote, and "the balance of member
 * 12345's savings account" is exactly the sentence a model writes. So the
 * finished YAML — the actual bytes about to be stored — is scanned for the values
 * behind the parameters.
 *
 * **Selection parameters are exempt, and the exemption is narrow.** A selection's
 * value is recorded on purpose, as the `default` of a declared `enum` input,
 * which is the opposite of baking a value into an action: the document says "this
 * is a parameter, and here is the word to use when the caller says nothing".
 * SPEC's selection design requires it and ticket 09's warning is about *which*
 * word goes there, not whether one does. The other two gates still walk every
 * fixed literal with the selection's value included, so a `savings` that turned
 * up in a `textPresent` is still refused.
 *
 * No minimum length, and no attempt to guess word boundaries — the same argument
 * `Scrub.ts` makes. A short value will produce false positives; a rejected
 * Artifact is a much better failure than a leaked identifier, and a length
 * threshold is a hole with a number on it.
 */
const valuesInText = (
  yaml: string,
  trajectory: Trajectory
): ReadonlyArray<string> => {
  const chosen = new Set(trajectory.selections.map((selection) => selection.parameter))
  const literals = literalsTyped(trajectory)
  const reasons: Array<string> = []
  trajectory.parameters.forEach((parameter, index) => {
    if (chosen.has(parameter.name)) return
    const literal = literals[index]
    if (literal !== undefined && literal.length > 0 && yaml.includes(literal)) {
      reasons.push(
        `the document text contains the value this run supplied for ${parameter.name}, in prose ` +
          `rather than in a field. An artifact outlives the run that produced it and is read by ` +
          `people who were not there; nothing in it may carry a value from one run (ADR-0008).`
      )
    }
  })
  return reasons
}

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

/**
 * Compiles a Trajectory into a Capability Artifact, or says why it will not.
 *
 * The document is assembled, written out as YAML, and read back through
 * `parseArtifact` before anything else looks at it — so what is checked and what
 * is returned is what will be on disk, and an Artifact that would not load cannot
 * be produced. The gates then run over that document and over its text.
 */
export const compileArtifact = (
  trajectory: Trajectory,
  options: CompileOptions
): Result.Result<CapabilityArtifact, CompilationRefused> => {
  const refuse = (reasons: ReadonlyArray<string>) =>
    Result.fail(new CompilationRefused({ capability: options.capability, reasons }))

  if (!isCompilable(trajectory)) {
    return refuse([
      trajectory.conclusion.conclusion === "reached"
        ? "the run reached its goal without taking a single step, so there is nothing to compile"
        : `the run ended ${trajectory.conclusion.conclusion} rather than reaching its goal. Only ` +
          `a successful run becomes a capability: compiling one that got stuck would store a ` +
          `flow nobody has ever seen work.`
    ])
  }

  // --- decode what the run recorded ---------------------------------------
  const problems: Array<string> = []
  const recorded: Array<{ step: DiscoveryStep; action: RecordedAction }> = []
  for (const step of trajectory.steps) {
    const decoded = decodeAction(step.action)
    if (Result.isFailure(decoded)) {
      problems.push(`step ${step.id} recorded an action this compiler does not understand`)
      continue
    }
    recorded.push({ step, action: decoded.success })
  }
  if (problems.length > 0) return refuse(problems)

  // --- steps ---------------------------------------------------------------
  const first = recorded[0]
  const opening = openingStep(
    trajectory,
    first === undefined ? undefined : observableOf(first.step, first.action)
  )
  problems.push(...opening.problems)

  const steps: Array<Step> = [opening.step]
  recorded.forEach((entry, index) => {
    const compiled = stepFor(entry.step, entry.action, recorded[index + 1])
    problems.push(...compiled.problems)
    steps.push(compiled.step)
  })

  // --- inputs, derived from provenance and from nothing else ---------------
  const chosen = new Map(trajectory.selections.map((selection) => [selection.parameter, selection]))
  const inputs: Record<string, InputDeclaration> = {}
  for (const parameter of trajectory.parameters) {
    const selection = chosen.get(parameter.name)
    inputs[parameter.name] = selection === undefined
      ? stringInput(parameter.name, parameter.usedBy)
      : enumInput(selection)
  }
  // A selection whose match was not goal-derived cannot happen — `checkSelection`
  // refuses it at proposal time — but a Trajectory is data and could be assembled
  // by something else, and an enum input nothing declares would fail at parse.
  for (const selection of trajectory.selections) {
    if (!Object.hasOwn(inputs, selection.parameter)) {
      problems.push(
        `step ${selection.stepId} chooses from a list on a value with no parameter behind it, ` +
          `so there is no input to declare. A selection has to match on a goal-derived value.`
      )
    }
  }

  const outputs: Record<string, OutputDeclaration> = {}
  for (const output of trajectory.outputs) outputs[output.name] = outputFor(output)
  if (trajectory.outputs.length === 0) {
    problems.push("the run named no outputs, so this capability would answer nothing")
  }

  if (problems.length > 0) return refuse(problems)

  // --- the document --------------------------------------------------------
  const summary = trajectory.conclusion.conclusion === "reached"
    ? trajectory.conclusion.summary
    : ""
  const document: CapabilityArtifact = {
    capability: options.capability,
    version: options.version,
    title: options.title ?? summary,
    summary:
      `${summary}\n\nCompiled from discovery run ${trajectory.runId}, whose evidence is at ` +
      `${trajectory.evidenceDirectory}. Every step below is an action that run took and a ` +
      `check that it landed; every input below was derived from the origin the run recorded ` +
      `against a value it used, not declared in advance by a person. No value from that run ` +
      `survives in this document.\n\nNothing here has been reviewed yet. It declares no ` +
      `business outcomes and no recoverable conditions, because one successful run has ` +
      `demonstrated neither, and a capability learns those from what a person had to do about ` +
      `them.`,
    authored: "discovered",
    surface: {
      kind: "web",
      product: options.product ?? PRODUCT_UNIDENTIFIED,
      // No origin, ever. Which institution's installation this runs against is
      // supplied at replay time, which is what lets one document serve every
      // tenant — and is why `DiscoveryOptions.baseUrl` is never recorded on a
      // Trajectory in the first place.
      entry: trajectory.entry
    },
    inputs,
    outputs,
    steps
  }

  // Round-tripped before it is judged, so the thing the gates read is the thing
  // that would be stored — including any way the emitter might render it.
  const yaml = formatArtifact(document)
  const stored = parseArtifact(`${options.capability}@${options.version}`, yaml)
  if (Result.isFailure(stored)) return refuse(stored.failure.problems)

  const reasons = [
    ...goalEchoes(stored.success, trajectory.goal),
    ...typedValuesInFixedText(stored.success, trajectory),
    ...valuesInText(yaml, trajectory)
  ]
  return reasons.length > 0 ? refuse(reasons) : Result.succeed(stored.success)
}
