/**
 * The Discovery loop: observe, decide, act, until the Goal is met or a stopping
 * condition fires.
 *
 * This is the one place in the system where a model drives. Everything else —
 * Replay, the compiler, the recovery ladder — exists to make what happens here
 * reusable and safe to repeat. Read `Vocabulary.ts` first for what the model may
 * propose, then this for what happens to a proposal.
 *
 * ## The shape of one step
 *
 *     observe  ->  decide  ->  check  ->  act  ->  observe
 *
 *   1. **Observe.** `SurfaceAdapter.observe` gives the accessibility tree, URL and
 *      frames. A screenshot is captured too, and written to Evidence — but it
 *      goes nowhere near the prompt (ADR-0001, and see `prompt.ts`).
 *   2. **Decide.** One `generateText` call with the Toolkit and
 *      `toolChoice: "required"`, so the model must propose an action rather than
 *      narrate. `disableToolCallResolution: true` means the framework resolves
 *      nothing: the proposal comes back as data.
 *   3. **Check.** Three gates, in this order, each of which sends the model a
 *      correction rather than ending the run:
 *        - the proposal decodes against its Schema (`proposalFrom`),
 *        - its values' provenance survives contact with the Goal
 *          (`checkProvenance`, `checkSelection`),
 *        - Policy authorises it (`Policy.authorise`, `mode: "discovery"`).
 *   4. **Act.** Only now does the Surface get touched, and only through
 *      `authorised`, which is the single gate — the same structure `engine.ts`
 *      uses for Replay, for the same reason.
 *
 * ## Every failure is a correction, not an exception
 *
 * A model proposing a verb nobody defined, mis-tagging a value, naming a control
 * that is not there, or asking for something Policy denies are all *normal* in a
 * loop that is working something out for the first time. Each is recorded as
 * Evidence and fed back as text on the next turn. The run ends on a stopping
 * condition, never on a bad proposal — which is what `Stuck.ts` is for, and why
 * repeated resolution failure is one of its triggers: three of these in a row is
 * a model that has lost track of the screen, and *that* is worth stopping for.
 *
 * ## Why this file requires a LanguageModel and `engine.ts` must not
 *
 * `discover` requires `SurfaceAdapter | Policy | Evidence | LanguageModel`. That
 * fourth service is the difference between the two modes, and it is the whole of
 * ADR-0003: `test/replay-has-no-model.test.ts` asserts Replay's requirement set is
 * exactly the three plus `Session`, so a model cannot reach Replay without
 * failing that test to compile. Discovery adds it openly here.
 */

import type { EvidenceUnwritable } from "@cua/evidence"
import { Evidence } from "@cua/evidence"
import type { ActionRequest } from "@cua/policy"
import { Policy, personalCaptions, personalLabelFor } from "@cua/policy"
import type { SurfaceState, Target, TargetFailure } from "@cua/surface"
import {
  SurfaceAdapter,
  describeMatch,
  describeTarget,
  labelledValuesIn,
  selectFromTree
} from "@cua/surface"
import { Effect } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { checkProvenance } from "./Provenance.ts"
import type { ProvenancedValue } from "./Provenance.ts"
import { checkSelection, matchedLabel } from "./Selection.ts"
import type { StuckBounds, StuckTrigger } from "./Stuck.ts"
import { DEFAULT_BOUNDS, escalated, stuckDetector } from "./Stuck.ts"
import type {
  DiscoveredOutput,
  DiscoveredParameter,
  DiscoveredSelection,
  DiscoveryStep,
  StepOutcome,
  Trajectory
} from "./Trajectory.ts"
import type { Proposal } from "./Vocabulary.ts"
import { DISCOVERY_VERBS, discoveryToolkit, isUndecodable, proposalFrom } from "./Vocabulary.ts"
import type { DiscoveredSecrets } from "./redaction.ts"
import { asSecret, charactersToType } from "./redaction.ts"
import type { StepSummary } from "./prompt.ts"
import { decisionPrompt } from "./prompt.ts"

// ---------------------------------------------------------------------------
// What a run needs, and what stops it dead
// ---------------------------------------------------------------------------

export interface DiscoveryOptions {
  /** The natural-language statement of what to accomplish. */
  readonly goal: string
  /** Where to start, as a path. Resolved against `baseUrl`. */
  readonly entry: string
  /** The Tenant installation. Never recorded in the Trajectory. */
  readonly baseUrl: string
  readonly runId: string
  readonly sessionId: string
  /** The growing scrubber. See `redaction.ts` for why it grows. */
  readonly secrets: DiscoveredSecrets
  readonly bounds?: StuckBounds
  /** Named in the report so a reader knows which model produced the trajectory. */
  readonly modelName: string
}

/**
 * The machinery broke. Distinct from the model failing to work something out,
 * which is a `stuck` conclusion and an ordinary result.
 */
export class DiscoveryFailed extends Error {
  readonly _tag = "DiscoveryFailed"
  constructor(readonly detail: string) {
    super(detail)
  }
  override get message(): string {
    return this.detail
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * A value as the Trajectory records it, with the literal taken out where it
 * serves no purpose.
 *
 * A `goalDerived` literal is discarded by the compiler by definition — the whole
 * mechanism is that each distinct `name` becomes a declared input and the value
 * arrives at replay time from the caller. So carrying the characters into the
 * Trajectory buys nothing and creates a place for a member number to escape from
 * every time somebody prints one. The `name` is the part that matters and it
 * stays.
 *
 * A `constant` keeps its literal, because a constant is written into the stored
 * Artifact verbatim and the compiler genuinely needs it. That is safe precisely
 * because `checkProvenance` has already refused any constant that echoes the
 * Goal (ADR-0008) — a literal that survived that check is one there is no reason
 * to hide.
 *
 * The plaintext of a goal-derived value is not lost: it lives on
 * `DiscoveredParameter.literal` as a `Redacted`, which is where ticket 11 reads
 * it from for `bakedInLiterals`.
 */
const forTheRecord = (value: ProvenancedValue): ProvenancedValue =>
  value.kind === "goalDerived"
    ? { kind: "goalDerived", name: value.name, literal: `[redacted:${value.name}]` }
    : value

/** The value an action carries, if it carries one. */
const valueOf = (proposal: Proposal): ProvenancedValue | undefined => {
  switch (proposal.verb) {
    case "fill":
      return proposal.value
    case "selectFromList":
      return proposal.match
    default:
      return undefined
  }
}

/** A step id that is stable, readable, and cannot collide. */
const stepIdFor = (proposal: Proposal, ordinal: number): string => {
  if (proposal.verb === "extract") return proposal.bindAs
  return `${proposal.verb}-${ordinal}`
}

const describeAction = (proposal: Proposal): string => {
  switch (proposal.verb) {
    case "navigate":
      return `navigate ${proposal.path}`
    case "click":
      return `click ${describeTarget(proposal.target)}`
    case "fill":
      return `fill ${describeTarget(proposal.target)}`
    case "extract":
      return `extract ${describeTarget(proposal.target)}`
    case "selectFromList":
      // The scope is in the line because a selection that finds nothing is a
      // scope that named nothing, and a reader of the log has to be able to see
      // which words the model used.
      return (
        `selectFromList ${proposal.list.itemRole} items` +
        (proposal.list.within === undefined
          ? ""
          : ` within ${JSON.stringify(proposal.list.within)}`)
      )
    case "succeed":
      return `succeed: ${proposal.summary}`
    case "escalate":
      return `escalate ${proposal.code}`
  }
}

/**
 * The reasons a model call failed that asking again could fix.
 *
 * The distinction matters more than it looks. `generateText` validates the
 * provider's response against the Toolkit *before* the loop sees it, so a tool
 * name outside the vocabulary never reaches `proposalFrom` — it arrives here as an
 * `AiError`. That is a stronger guarantee than the loop's own decoding, and it is
 * also the case that must not kill the run: a model reaching for a verb nobody
 * defined is ordinary, and the answer is to tell it the vocabulary.
 *
 * Everything else — a rejected key, a rate limit, a network that is down — will
 * not improve by being asked twenty more times, and burning the whole step budget
 * discovering that would bury the actual cause. Those stay fatal.
 */
const RETRYABLE_MODEL_ERRORS: ReadonlySet<string> = new Set([
  "InvalidOutputError",
  "ToolNotFoundError",
  "ToolParameterValidationError",
  "StructuredOutputError"
])

/** How many unusable responses in a row before the model is not engaging at all. */
const UNUSABLE_RESPONSES_ALLOWED = 3

/**
 * Applies the scrubber to every string in an action's recorded form.
 *
 * Field-blind, and the same argument `EvidenceWriter.scrubDeeply` makes: an
 * action is a nested record whose shape differs per verb, and a scrubber that had
 * to be told which fields might hold a member number is one that misses the field
 * added next month.
 */
const scrubDeeply = (value: unknown, scrub: (text: string) => string): never => {
  if (typeof value === "string") return scrub(value) as never
  if (Array.isArray(value)) return value.map((item) => scrubDeeply(item, scrub)) as never
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubDeeply(item, scrub)])
    ) as never
  }
  return value as never
}

const reasonTagOf = (error: unknown): string => {
  const reason = (error as { reason?: { _tag?: unknown } } | undefined)?.reason
  return typeof reason?._tag === "string" ? reason._tag : "UnknownError"
}

/**
 * A target failure, as something to tell the model.
 *
 * The remedy matters more than the message. A model told "ambiguous" guesses
 * again; a model shown the three things that answered can pick one. A model told
 * only "nothing answers to that" does something worse — it is shown the very
 * same screen on the next turn, has no new information to reason from, and
 * proposes the identical Target. Three of those in a row is a stuck run, and
 * that is not hypothetical: it is how the first live discovery run against
 * Account Detail died.
 */
const explainTargetFailure = (failure: TargetFailure): string => {
  switch (failure._tag) {
    case "TargetNotFound":
      return (
        `nothing on the screen answers to ${failure.target}. ${failure.rationale}. ` +
        `${failure.remedy}`
      )
    case "TargetAmbiguous":
      return (
        `${failure.target} names more than one control, so it is not clear which you mean. ` +
        `${failure.remedy} The candidates are: ` +
        `${failure.matches.map((match) => match.description).join("; ")}`
      )
    case "SurfaceUnavailable":
      return `the application could not be operated: ${failure.reason}`
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export const discover = (
  options: DiscoveryOptions
): Effect.Effect<
  Trajectory,
  DiscoveryFailed | EvidenceUnwritable,
  SurfaceAdapter | Policy | Evidence | LanguageModel.LanguageModel
> =>
  Effect.gen(function*() {
    const surface = yield* SurfaceAdapter
    const policy = yield* Policy
    const evidence = yield* Evidence
    const bounds = options.bounds ?? DEFAULT_BOUNDS
    const detector = stuckDetector(bounds)
    const startedAt = Date.now()

    const steps: Array<DiscoveryStep> = []
    const history: Array<StepSummary> = []
    /** Step id -> what that step read. Backs `uiDerived` and the outputs. */
    const readings = new Map<string, string>()
    /**
     * Which step read each control, keyed by the Target as it is described.
     *
     * Beside `readings`, which is keyed by the step's own name. Both are needed:
     * a model that re-reads picks a new name for the second reading as often as
     * it reuses the old one, and only one of those two maps sees each case.
     */
    const readAt = new Map<string, string>()
    /** Parameter name -> the uses of it, in order. */
    const parameters = new Map<string, { literal: string; usedBy: Array<string> }>()
    const selections: Array<DiscoveredSelection> = []
    let outputs: ReadonlyArray<DiscoveredOutput> = []

    /**
     * The single gate. Nothing in this file touches an acting method of the
     * adapter except through here, exactly as `engine.ts` does for Replay, and a
     * test counts the call sites so a second path would fail the suite.
     *
     * `page` is always passed. Discovery is the mode that wanders, and ticket 07's
     * note is explicit that an origin check with no current page constrains only
     * where you navigate — the weaker half.
     */
    const authorised = <A>(
      stepId: string,
      type: string,
      subject: string,
      page: string,
      act: () => Effect.Effect<A, TargetFailure>
    ): Effect.Effect<
      { readonly acted: A; readonly risk: string; readonly policy: string } | { readonly denied: string },
      TargetFailure | EvidenceUnwritable
    > =>
      Effect.gen(function*() {
        const request: ActionRequest = { type, subject, page, stepId, mode: "discovery" }
        const verdict = yield* policy.authorise(request)
        yield* evidence.record({
          kind: "policy.check",
          stepId,
          action: type,
          subject,
          verdict: verdict.verdict,
          reason: verdict.reason,
          policy: verdict.policy,
          risk: verdict.risk,
          ...(verdict.origin === undefined ? {} : { origin: verdict.origin })
        })
        if (verdict.verdict === "deny") return { denied: verdict.reason }
        const acted = yield* act()
        return { acted, risk: verdict.risk, policy: verdict.policy }
      })

    const observeAndRecord = (
      stepId: string | undefined
    ): Effect.Effect<SurfaceState, DiscoveryFailed | EvidenceUnwritable> =>
      Effect.gen(function*() {
        const state = yield* surface.observe.pipe(
          Effect.mapError((failure) => new DiscoveryFailed(failure.reason))
        )
        /**
         * Registered before the `observe` event that carries this very tree.
         *
         * Discovery's scrubber grows as the model tags the values it *types*.
         * That covers nothing the screen renders back on its own: a member's
         * name is nobody's parameter and no model ever proposes it. Same rule as
         * Replay's, same declared captions, same reason -- see `personalFields`
         * in packages/policy/src/Sensitivity.ts.
         */
        yield* evidence.redact(
          labelledValuesIn(state.tree, personalCaptions).flatMap((found) => {
            const label = personalLabelFor(found.caption)
            return label === undefined ? [] : [{ label, text: found.text }]
          })
        )
        yield* evidence.record({
          kind: "observe",
          ...(stepId === undefined ? {} : { stepId }),
          url: state.url,
          title: state.title,
          frames: state.frames.map((frame) => frame.name),
          accessibility: state.accessibility
        })
        return state
      })

    /**
     * A screenshot, every step, for the record — and never for the loop.
     *
     * Captured immediately after the observation the model is about to decide
     * from, so a reviewer can see the screen the tree described. It is written
     * straight to Evidence as bytes; nothing returns it into this function's
     * scope, so there is no variable here that a prompt could accidentally be
     * built from.
     */
    const captureScreenshot = (name: string): Effect.Effect<void, EvidenceUnwritable> =>
      surface.captureEvidence.pipe(
        Effect.flatMap((captured) => evidence.attach(name, captured.screenshot)),
        Effect.catchCause(() => Effect.void)
      )

    const finish = (
      conclusion: Trajectory["conclusion"],
      attempted: number
    ): Trajectory => ({
      goal: options.goal,
      runId: options.runId,
      sessionId: options.sessionId,
      entry: options.entry,
      evidenceDirectory: evidence.directory,
      conclusion,
      steps,
      parameters: [...parameters.entries()].map(([name, use]): DiscoveredParameter => ({
        name,
        usedBy: use.usedBy,
        // ADR-0008: sensitive unless Policy allowlists it, which ships empty.
        // Never the model's call, and never inferred from the value's shape.
        sensitive: true,
        literal: asSecret(name, use.literal)
      })),
      selections,
      outputs,
      signatures: detector.signatures(),
      steps_attempted: attempted,
      durationMillis: Date.now() - startedAt
    })

    // -----------------------------------------------------------------------
    // Open the application
    // -----------------------------------------------------------------------

    yield* evidence.record({
      kind: "run.start",
      mode: "discovery",
      capability: "(discovering)",
      version: "(none)",
      baseUrl: options.baseUrl,
      // Discovery has no declared inputs: finding them out is the point. The
      // parameters it discovers are recorded on the trajectory, by name, and are
      // sensitive by default.
      inputs: []
    })

    const entryUrl = new URL(options.entry, options.baseUrl).toString()
    const opened = yield* authorised(
      "open",
      "navigate",
      entryUrl,
      "about:blank",
      () => surface.navigate(entryUrl)
    ).pipe(
      Effect.mapError((failure) =>
        failure._tag === "EvidenceUnwritable"
          ? failure
          : new DiscoveryFailed(explainTargetFailure(failure))
      )
    )
    if ("denied" in opened) {
      return finish(
        { conclusion: "failed", reason: `policy refused to open ${options.entry}: ${opened.denied}` },
        0
      )
    }

    // -----------------------------------------------------------------------
    // observe -> decide -> check -> act
    // -----------------------------------------------------------------------

    let correction: string | undefined
    let attempted = 0
    /** Consecutive responses that were not a usable action. See above. */
    let unusableResponses = 0

    while (true) {
      attempted += 1
      if (attempted > bounds.maxSteps) {
        const trigger: StuckTrigger = {
          trigger: "max_steps",
          steps: attempted - 1,
          detail: `the run reached its limit of ${bounds.maxSteps} steps without meeting the goal.`
        }
        yield* evidence.record({ kind: "outcome", code: "STUCK", detail: trigger.detail })
        return finish({ conclusion: "stuck", trigger }, attempted - 1)
      }

      const state = yield* observeAndRecord(undefined)
      yield* captureScreenshot(`step-${String(attempted).padStart(2, "0")}.png`)

      // --- decide ---------------------------------------------------------
      const answered = yield* LanguageModel.generateText({
        prompt: decisionPrompt({
          goal: options.goal,
          state,
          step: attempted,
          maxSteps: bounds.maxSteps,
          history,
          correction
        }),
        toolkit: discoveryToolkit,
        toolChoice: "required",
        disableToolCallResolution: true
      }).pipe(
        Effect.map((response) => ({ response })),
        Effect.catch((error) => {
          const tag = reasonTagOf(error)
          if (!RETRYABLE_MODEL_ERRORS.has(tag)) {
            return Effect.fail(new DiscoveryFailed(`the model could not be reached (${tag}): ${error}`))
          }
          return Effect.succeed({
            unusable:
              `that was not one of the available actions. Choose one of: ` +
              `${DISCOVERY_VERBS.join(", ")}, and give its arguments exactly as described.`
          })
        })
      )
      correction = undefined

      if ("unusable" in answered) {
        unusableResponses += 1
        if (unusableResponses >= UNUSABLE_RESPONSES_ALLOWED) {
          return yield* Effect.fail(
            new DiscoveryFailed(
              `the model produced ${unusableResponses} unusable responses in a row; ` +
                `it is not engaging with the action vocabulary`
            )
          )
        }
        yield* evidence.record({
          kind: "decide",
          rationale: `refused before it reached the surface: ${answered.unusable}`,
          action: "(not an available action)"
        })
        correction = answered.unusable
        continue
      }
      unusableResponses = 0

      const call = answered.response.toolCalls[0]
      if (call === undefined) {
        correction =
          "you did not choose an action. Every turn must call exactly one of the available actions."
        continue
      }

      const proposal = proposalFrom(call.name, call.params)
      if (isUndecodable(proposal)) {
        yield* evidence.record({
          kind: "decide",
          rationale: `refused before it reached the surface: ${proposal.complaint}`,
          action: `${call.name} (rejected)`
        })
        correction = proposal.complaint
        continue
      }

      const stepId = stepIdFor(proposal, attempted)

      // --- register secrets BEFORE anything is written --------------------
      //
      // The `decide` event below quotes the model's rationale, and a rejection
      // complaint quotes the literal it is complaining about. Either can carry a
      // member number, so the scrubber has to know the value before the first
      // event that could mention it — not after the action succeeds. A value that
      // came out of the Goal is sensitive whatever the model tagged it, which is
      // why a mis-tagged `constant` is registered here too rather than only being
      // rejected below.
      const value = valueOf(proposal)
      if (value !== undefined && value.kind !== "uiDerived") {
        const name = value.kind === "goalDerived" ? value.name : "goalTerm"
        const mistagged = checkProvenance(value, options.goal, new Set(readings.keys()))
        const fromGoal = value.kind === "goalDerived" ? mistagged === undefined : mistagged !== undefined
        if (fromGoal) options.secrets.remember(name, asSecret(name, value.literal))
      }

      yield* evidence.record({
        kind: "decide",
        stepId,
        rationale: "rationale" in proposal ? proposal.rationale : "",
        action: describeAction(proposal)
      })

      // --- prose that carries this run's values ---------------------------
      //
      // A Step's `intent` is copied into the stored Artifact verbatim, so it is
      // as much a place for a member number to end up as the summary is. A live
      // run wrote "View the savings account details for member 12345" and the
      // compiler refused the whole document for it, at the end, after every
      // step had run. Refusing here costs one turn.
      //
      // Detected through the scrubber: the prose is scrubbed and the
      // placeholders it comes back with name the parameters it quoted. A
      // selection parameter's own value is exempt, for the reason the compiler's
      // third gate exempts it — `savings` is what the parameter is *for*.
      if ("intent" in proposal) {
        // The selection being proposed right now counts as exempt too, and not
        // only the ones already recorded. The step that introduces the parameter
        // is the step whose intent has to name it — "select the savings account"
        // — and without this the very proposal that discovers `accountType` is
        // the one refused for mentioning it. A live run spent its whole step
        // budget on that.
        const exempt = new Set(selections.map((selection) => selection.parameter))
        if (proposal.verb === "selectFromList" && proposal.match.kind === "goalDerived") {
          exempt.add(proposal.match.name)
        }
        const quotedInIntent = [
          ...options.secrets.scrubber(proposal.intent).matchAll(/\[redacted:([^\]]+)\]/g)
        ]
          .map((found) => found[1])
          .filter((name): name is string => name !== undefined && !exempt.has(name))
        if (quotedInIntent.length > 0) {
          const named = [...new Set(quotedInIntent)].join(", ")
          correction =
            `the intent quotes the value this run was given for ${named}. The intent is ` +
            `copied into the stored capability word for word, so say what the step does ` +
            `without ${named} in the sentence.`
          yield* evidence.record({
            kind: "decide",
            stepId,
            rationale: `refused: ${correction}`,
            action: `${proposal.verb} (rejected)`
          })
          continue
        }
      }

      // --- a reading that has already been taken --------------------------
      //
      // An `extract` step is named by the model's own `bindAs`, and a second
      // one under the same name is two things at once: a duplicate step id,
      // which the compiler refuses outright, and a re-read of a value the run
      // is already holding. A live run did both — it read the balance, read it
      // again, and then read it a third time under a new name "to confirm the
      // value is present" — and only the compiler noticed, after the whole run.
      //
      // Telling the model it already has the value is also what bounds a run
      // that only reads. Reading changes nothing, so the repetition rules are
      // deliberately blind to it (see `StuckObservation.readOnly`); this is the
      // rule that takes their place, and it is the specific one.
      if (proposal.verb === "extract") {
        // By the control, not only by the name. A rule that looked at `bindAs`
        // alone is one a model gets round by picking a new name, and a live run
        // did exactly that: it read the same cell four times as
        // `availableBalance`, `savingsAvailableBalance`,
        // `savingsAvailableBalanceFinal` and `finalSavingsAvailableBalance`,
        // and the compiled document carried four identical steps.
        const already = readAt.get(describeTarget(proposal.target)) ?? (
          readings.has(stepId) ? stepId : undefined
        )
        if (already !== undefined) {
          correction =
            `you have already read that control on this run and the value is recorded ` +
            `against step ${JSON.stringify(already)}. Do not read it again under any name: ` +
            `either act on the screen, or say succeed with ${JSON.stringify(already)} as ` +
            `the step an output came from.`
          yield* evidence.record({
            kind: "decide",
            stepId,
            rationale: `refused: ${correction}`,
            action: "extract (rejected)"
          })
          continue
        }
      }

      // --- the two terminal verbs ----------------------------------------
      //
      // Neither touches a Surface, so neither goes through Policy: there is
      // nothing for an origin allowlist to say about a model reporting that it
      // is finished.
      if (proposal.verb === "escalate") {
        const trigger = escalated(proposal.code, proposal.detail)
        yield* evidence.record({
          kind: "outcome",
          stepId,
          code: proposal.code,
          detail: proposal.detail
        })
        return finish({ conclusion: "stuck", trigger }, attempted)
      }

      if (proposal.verb === "succeed") {
        /**
         * A refusal to finish, recorded and then fed back.
         *
         * Recorded because every other refusal in this loop is, and a correction
         * that exists only in the next prompt is invisible to whoever reads the
         * run afterwards — which is precisely when it matters, because a run that
         * ends stuck ends stuck for a reason nobody can see.
         */
        const refuse = (complaint: string) =>
          evidence.record({
            kind: "decide",
            stepId,
            rationale: `refused: ${complaint}`,
            action: "succeed (rejected)"
          })

        const read = [...readings.keys()]
        const missing = proposal.outputs.filter((output) => !readings.has(output.fromStep))
        if (missing.length > 0) {
          // Which half of the complaint leads is the whole of its usefulness.
          // If something has already been read, the mistake is the *name*, and
          // telling the model to go and extract something sends it back to a
          // screen it has already read — a repeat state, and three of those end
          // the run. Only when nothing has been read is extracting the answer.
          const named = missing.map((output) => JSON.stringify(output.fromStep)).join(", ")
          correction = read.length === 0
            ? `you said the goal is met, but ${named} has not read anything, and no step has. ` +
              "Extract the value the goal asks for before finishing."
            : `you said the goal is met, but no step is called ${named}. ` +
              `The steps that have read something are: ${read.join(", ")}. ` +
              "Say succeed again with fromStep naming one of those — the value is already read, " +
              "so do not extract it a second time."
          yield* refuse(correction)
          continue
        }
        if (proposal.outputs.length === 0) {
          correction =
            "you said the goal is met but named no outputs. Name the reading that answers " +
            "the goal, and the extract step it came from" +
            (read.length === 0 ? "." : `: ${read.join(", ")}.`)
          yield* refuse(correction)
          continue
        }

        // The prose a model writes about a finished run is where a value from
        // that run gets into a document, and a live run did exactly this: the
        // summary read "the savings balance for member 12345", which is a
        // capability with one caller's identifier written into its description.
        //
        // The compiler's third gate already refuses such a document, but it does
        // so at the end, after the whole run. Refusing here costs one turn and
        // tells the model what to change, which is the same argument the
        // provenance checks make: a check that runs earlier is not a check that
        // runs instead.
        //
        // Detected through the scrubber rather than by unwrapping anything: the
        // prose is scrubbed and the placeholders it comes back with name the
        // parameters it was quoting. No call site has to hold the characters.
        //
        // A selection parameter's own value is exempt, and the compiler's third
        // gate makes the same exemption for the same reason: `savings` is what a
        // selection is *for*, the document declares it as a parameter with that
        // default, and a summary saying "a savings account" is describing the
        // capability rather than baking in a caller's data. Every other
        // parameter is refused, and naming it is what lets the model fix it in
        // one turn instead of guessing.
        const scrub = options.secrets.scrubber
        const selectionParameters = new Set(selections.map((selection) => selection.parameter))
        const quoted = new Set<string>()
        for (const prose of [
          proposal.summary,
          ...proposal.outputs.map((output) => output.description)
        ]) {
          for (const found of scrub(prose).matchAll(/\[redacted:([^\]]+)\]/g)) {
            const name = found[1]
            if (name !== undefined && !selectionParameters.has(name)) quoted.add(name)
          }
        }
        if (quoted.size > 0) {
          const named = [...quoted].join(", ")
          correction =
            `the summary or an output description quotes the value this run was given for ` +
            `${named}. A capability outlives the run that discovered it and is read by ` +
            `people who were not there, so say what it does and what it returns without ` +
            `${named} in the sentence at all.`
          yield* refuse(correction)
          continue
        }

        // The other half of the same rule, for values that came off the screen
        // rather than out of the goal. A balance is not a secret and no scrubber
        // touches it, but it is still one run's answer, and the compiler already
        // refuses to bake one into a checkpoint: an `extract` is checked against
        // a shape (`^\$[0-9,]+\.[0-9]{2}$`) built to carry none of the digits.
        // A summary reading "the balance is $4,182.55" puts the same figure back
        // into the same document in prose. Observed on a live run.
        const echoed = [...readings.entries()].filter(([, reading]) =>
          [proposal.summary, ...proposal.outputs.map((output) => output.description)].some(
            (prose) => reading.trim() !== "" && prose.includes(reading.trim())
          )
        )
        if (echoed.length > 0) {
          const named = echoed.map(([step]) => step).join(", ")
          correction =
            `the summary or an output description repeats what this run read at ${named}. ` +
            `That is one run's answer, not the capability's: say what the output means and ` +
            `let the value come from the run that asks for it.`
          yield* refuse(correction)
          continue
        }
        // `readings` itself stays raw: it is the working value, and a later
        // `uiDerived` fill will have to type the real characters. It is scrubbed
        // here, at the one point where a reading becomes part of the Trajectory.
        outputs = proposal.outputs.map((output): DiscoveredOutput => {
          const read = readings.get(output.fromStep)
          return {
            name: output.name,
            fromStep: output.fromStep,
            description: output.description,
            value: read === undefined ? undefined : scrub(read)
          }
        })
        yield* evidence.record({
          kind: "outcome",
          stepId,
          code: "SUCCESS",
          detail: proposal.summary
        })
        return finish({ conclusion: "reached", summary: proposal.summary }, attempted)
      }

      // --- provenance -----------------------------------------------------
      if (value !== undefined) {
        const mistagged = checkProvenance(value, options.goal, new Set(readings.keys()))
        if (mistagged !== undefined) {
          yield* evidence.record({
            kind: "decide",
            stepId,
            rationale: `refused: ${mistagged.complaint}`,
            action: `${proposal.verb} (rejected)`
          })
          correction = mistagged.complaint
          continue
        }
      }

      // --- act ------------------------------------------------------------
      const performed = yield* perform({
        proposal,
        stepId,
        state,
        baseUrl: options.baseUrl,
        goal: options.goal,
        surface,
        authorised
      })

      if ("correction" in performed) {
        yield* evidence.record({
          kind: "decide",
          stepId,
          rationale: `refused: ${performed.correction}`,
          action: `${proposal.verb} (rejected)`
        })
        correction = performed.correction
        const trigger = performed.resolutionFailure === true
          ? detector.resolutionFailed()
          : undefined
        if (trigger !== undefined) {
          yield* evidence.record({ kind: "outcome", code: "STUCK", detail: trigger.detail })
          return finish({ conclusion: "stuck", trigger }, attempted)
        }
        continue
      }
      detector.resolutionSucceeded()

      // --- record what happened -------------------------------------------
      yield* evidence.record({
        kind: "action",
        stepId,
        action: proposal.verb,
        ...(performed.subject === undefined ? {} : { target: performed.subject }),
        resolvedBy: performed.outcome.resolvedBy,
        rationale: performed.outcome.rationale
      })

      if (performed.outcome.read !== undefined) {
        readings.set(stepId, performed.outcome.read)
        if (proposal.verb === "extract") readAt.set(describeTarget(proposal.target), stepId)
      }

      if (value !== undefined && value.kind === "goalDerived") {
        const existing = parameters.get(value.name)
        if (existing === undefined) {
          parameters.set(value.name, { literal: value.literal, usedBy: [stepId] })
        } else {
          existing.usedBy.push(stepId)
        }
      }
      if (performed.selection !== undefined) selections.push(performed.selection)

      // The outcome is scrubbed on the way into the Trajectory, not on the way
      // out of it.
      //
      // A `StepOutcome` carries the URL the action landed on and the adapter's
      // rationale, and on Heritage Core both quote the member number —
      // `/member?memberNumber=12345`. The Trajectory is a value that gets handed
      // to a compiler, printed by `--json`, and written to disk by whoever is
      // debugging a run, and every one of those is a place a raw identifier would
      // escape. Scrubbing here makes the Trajectory safe to serialise anywhere,
      // which is a property, rather than a rule each of those callers has to
      // remember.
      //
      // Nothing is lost. The compiler needs the *path shape*, and an Artifact may
      // not contain a runtime value in any case (ADR-0008, and `bakedInLiterals`
      // enforces it), so a URL with the member number taken out is the only kind
      // it could legally use.
      const scrub = options.secrets.scrubber
      steps.push({
        id: stepId,
        intent: proposal.intent,
        rationale: scrub(proposal.rationale),
        verb: proposal.verb,
        action: scrubDeeply(performed.action, scrub),
        ...(value === undefined ? {} : { value: forTheRecord(value) }),
        outcome: {
          ...performed.outcome,
          url: scrub(performed.outcome.url),
          rationale: scrub(performed.outcome.rationale),
          ...(performed.outcome.read === undefined
            ? {}
            : { read: scrub(performed.outcome.read) })
        },
        authorisedBy: { policy: performed.policy, risk: performed.risk }
      })
      // The step id leads the line, and it is not decoration.
      //
      // `succeed` has to name the step each output came from, and an `extract`
      // step is named by whatever the model called its `bindAs`. Without the id
      // here, that word appears nowhere in the transcript after the turn that
      // proposed it: the model is required to name a handle it can no longer
      // see, guesses, and is told its finished run is unfinished. A live run did
      // exactly that, then re-read the balance it had already read, and the
      // repeated screen ended it as a cycle.
      history.push({
        ordinal: steps.length,
        line: `[${stepId}] ${proposal.intent} — ${describeAction(proposal)}${
          performed.outcome.read === undefined ? "" : ` -> read ${JSON.stringify(performed.outcome.read)}`
        }`
      })

      // --- observe again, and check for stuck ------------------------------
      const after = yield* observeAndRecord(stepId)
      const trigger = detector.observe({
        url: after.url,
        accessibility: after.accessibility,
        step: attempted,
        elapsedMillis: Date.now() - startedAt,
        // An `extract` reads and does not act, so the screen being identical
        // afterwards is what should happen. See `StuckObservation.readOnly`:
        // without this, a capability that reads two figures off one screen —
        // which is what `member.account-balance` does — cannot be discovered,
        // because the second read is counted as a lap.
        readOnly: proposal.verb === "extract"
      })
      if (trigger !== undefined) {
        yield* evidence.record({ kind: "outcome", stepId, code: "STUCK", detail: trigger.detail })
        return finish({ conclusion: "stuck", trigger }, attempted)
      }
    }
  })

// ---------------------------------------------------------------------------
// Performing one proposal
// ---------------------------------------------------------------------------

interface PerformOptions {
  readonly proposal: Proposal
  readonly stepId: string
  readonly state: SurfaceState
  readonly baseUrl: string
  readonly goal: string
  readonly surface: SurfaceAdapter["Service"]
  readonly authorised: <A>(
    stepId: string,
    type: string,
    subject: string,
    page: string,
    act: () => Effect.Effect<A, TargetFailure>
  ) => Effect.Effect<
    { readonly acted: A; readonly risk: string; readonly policy: string } | { readonly denied: string },
    TargetFailure | EvidenceUnwritable
  >
}

interface Performed {
  readonly action: Record<string, unknown>
  readonly outcome: StepOutcome
  readonly subject: string | undefined
  readonly risk: string
  readonly policy: string
  readonly selection?: DiscoveredSelection | undefined
}

interface Refused {
  readonly correction: string
  /** Whether this was a Target that named nothing, which is a Stuck trigger. */
  readonly resolutionFailure?: boolean
}

/**
 * Turns one checked proposal into one authorised Surface action.
 *
 * Split out of the loop because it is the part with five branches and the loop is
 * the part with the control flow; together they were unreadable. Every branch
 * ends in `authorised(...)`, and the `surface` handle is only reachable inside
 * one — there is no path from here to an unjudged action.
 */
const perform = (
  options: PerformOptions
): Effect.Effect<Performed | Refused, DiscoveryFailed | EvidenceUnwritable> =>
  Effect.gen(function*() {
    const { authorised, proposal, state, stepId, surface } = options

    /** Runs an acting call, turning a Target failure into a correction. */
    const attempt = <A>(
      type: string,
      subject: string,
      act: () => Effect.Effect<A, TargetFailure>
    ): Effect.Effect<
      | { readonly acted: A; readonly risk: string; readonly policy: string }
      | Refused,
      EvidenceUnwritable
    > =>
      authorised(stepId, type, subject, state.url, act).pipe(
        Effect.map((result) =>
          "denied" in result
            ? ({
              correction:
                `policy refused that action: ${result.denied} ` +
                `Choose something the policy permits, or escalate.`
            } satisfies Refused)
            : result
        ),
        Effect.catch((failure): Effect.Effect<Refused, EvidenceUnwritable> =>
          // An `EvidenceUnwritable` is machinery breaking and stays on the error
          // channel. A Target failure is the model being wrong about the screen,
          // which is an ordinary event in a loop that is working things out — so
          // it crosses to the success channel as something to tell the model.
          //
          // Discriminated by `_tag` rather than `instanceof Error`: every failure
          // in this system is a `Schema.TaggedError` and therefore an `Error`, so
          // an `instanceof` check here would silently match everything.
          failure._tag === "EvidenceUnwritable"
            ? Effect.fail(failure)
            : Effect.succeed({
              correction: explainTargetFailure(failure),
              resolutionFailure: true
            } satisfies Refused)
        )
      )

    switch (proposal.verb) {
      case "navigate": {
        const url = new URL(proposal.path, options.baseUrl).toString()
        const result = yield* attempt("navigate", url, () =>
          surface.navigate(url).pipe(Effect.mapError((failure) => failure as TargetFailure)))
        if ("correction" in result) return result
        return {
          action: { type: "navigate", path: proposal.path },
          subject: proposal.path,
          outcome: {
            url: result.acted.url,
            resolvedBy: ["path"],
            rationale: `navigated to ${proposal.path}`,
            alternatives: 0
          },
          risk: result.risk,
          policy: result.policy
        }
      }

      case "click": {
        const subject = describeTarget(proposal.target)
        // Resolved inside the gate, so a resolution can never be carried across a
        // policy decision — the same rule `engine.ts` follows.
        const result = yield* attempt("click", subject, () =>
          Effect.gen(function*() {
            const resolution = yield* surface.resolveTarget(proposal.target)
            const after = yield* surface.click(proposal.target)
            return { resolution, after }
          }))
        if ("correction" in result) return result
        return {
          action: { type: "click", target: proposal.target },
          subject,
          outcome: {
            url: result.acted.after.url,
            resolvedBy: result.acted.resolution.strategies,
            rationale: result.acted.resolution.rationale,
            alternatives: result.acted.resolution.alternatives
          },
          risk: result.risk,
          policy: result.policy
        }
      }

      case "fill": {
        const subject = describeTarget(proposal.target)
        const text = proposal.value.kind === "uiDerived"
          ? undefined
          : charactersToType(asSecret("value", proposal.value.literal))
        if (text === undefined) {
          return {
            correction:
              "filling from an earlier reading is not supported yet: give the value as " +
              "goalDerived or constant."
          }
        }
        const result = yield* attempt("fill", subject, () =>
          Effect.gen(function*() {
            const resolution = yield* surface.resolveTarget(proposal.target)
            const after = yield* surface.fill(proposal.target, text)
            return { resolution, after }
          }))
        if ("correction" in result) return result
        return {
          action: { type: "fill", target: proposal.target, value: proposal.value },
          subject,
          outcome: {
            url: result.acted.after.url,
            resolvedBy: result.acted.resolution.strategies,
            rationale: result.acted.resolution.rationale,
            alternatives: result.acted.resolution.alternatives
          },
          risk: result.risk,
          policy: result.policy
        }
      }

      case "extract": {
        const subject = describeTarget(proposal.target)
        const result = yield* attempt("extract", subject, () =>
          Effect.gen(function*() {
            const resolution = yield* surface.resolveTarget(proposal.target)
            const read = yield* surface.extract(proposal.target)
            return { resolution, read }
          }))
        if ("correction" in result) return result
        if (result.acted.read.trim() === "") {
          return {
            correction:
              `${subject} resolved, but it reads as empty. That is usually the wrong ` +
              `control: name the cell holding the value rather than its caption.`
          }
        }
        return {
          action: { type: "extract", target: proposal.target },
          subject,
          outcome: {
            url: state.url,
            resolvedBy: result.acted.resolution.strategies,
            rationale: result.acted.resolution.rationale,
            alternatives: result.acted.resolution.alternatives,
            read: result.acted.read
          },
          risk: result.risk,
          policy: result.policy
        }
      }

      case "selectFromList": {
        // The labels are read off the LIVE tree, never taken from the model's
        // word for what is on screen. `observedLabels` is the model's claim and
        // it is checked against this, because a hallucinated list would otherwise
        // become the enum's declared values.
        const listed = selectFromTree(state.tree, {
          list: {
            ...(proposal.list.within === undefined ? {} : { within: proposal.list.within }),
            itemRole: proposal.list.itemRole
          },
          wanted: proposal.match.kind === "uiDerived" ? "" : proposal.match.literal,
          describedAs: "the value being matched"
        })

        const items = listed._tag === "Selected" ? listed.items : listed.items
        const labels = items.map((item) => item.label)

        const unusable = checkSelection(
          {
            match: proposal.match,
            observedLabels: labels,
            discoveredFrom: proposal.discoveredFrom,
            within: proposal.list.within,
            itemRole: proposal.list.itemRole
          },
          options.goal
        )
        if (unusable !== undefined) return { correction: unusable.complaint }

        if (listed._tag !== "Selected") {
          return {
            correction:
              listed._tag === "NoMatch"
                ? `nothing in that list matched. ${listed.rationale}`
                : `more than one item matched, so it does not say which you mean. ${listed.rationale}`,
            resolutionFailure: true
          }
        }

        // Turned into an ordinary Target and pressed through the click call site,
        // exactly as `packages/replay/src/selection.ts` does: Policy sees the
        // control actually about to be pressed, and the adapter re-resolves
        // against a fresh snapshot so no accessibility ref crosses a page load.
        const target: Target = {
          role: proposal.list.itemRole,
          name: listed.item.label,
          exact: true,
          ...(proposal.list.within === undefined ? {} : { within: proposal.list.within })
        }
        const subject = describeTarget(target)
        const result = yield* attempt("selectFromList", subject, () =>
          Effect.gen(function*() {
            const resolution = yield* surface.resolveTarget(target)
            const after = yield* surface.click(target)
            return { resolution, after }
          }))
        if ("correction" in result) return result

        const wanted = proposal.match.kind === "goalDerived" ? proposal.match.literal : ""
        return {
          action: {
            type: "selectFromList",
            list: proposal.list,
            match: { against: proposal.match, strategy: "tokenSubset" },
            robustness: proposal.robustness
          },
          subject,
          outcome: {
            url: result.acted.after.url,
            resolvedBy: result.acted.resolution.strategies,
            rationale: `${listed.rationale}; ${result.acted.resolution.rationale}`,
            alternatives: result.acted.resolution.alternatives
          },
          risk: result.risk,
          policy: result.policy,
          selection: {
            stepId,
            parameter: proposal.match.kind === "goalDerived" ? proposal.match.name : "selection",
            values: labels,
            // THE GOAL'S OWN WORD. Never `listed.item.label`. See `Selection.ts`.
            default: wanted,
            matched: matchedLabel({
              match: proposal.match,
              observedLabels: labels,
              discoveredFrom: proposal.discoveredFrom
            }),
            discoveredFrom: proposal.discoveredFrom,
            robustness: proposal.robustness
          }
        }
      }

      // `succeed` and `escalate` end the run in the loop and never reach here.
      case "succeed":
      case "escalate":
        return yield* Effect.fail(
          new DiscoveryFailed(`${proposal.verb} should have ended the run before acting`)
        )
    }
  })

export { describeMatch }
