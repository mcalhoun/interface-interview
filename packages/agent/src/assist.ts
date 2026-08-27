/**
 * The Assisted Recovery model: the one place a model is consulted during Replay,
 * and the one place in this system where a model has no verbs at all.
 *
 * ADR-0005: "When Replay cannot resolve a step, one bounded consultation of a
 * model is allowed before an Operator gets involved. **Its toolkit contains no
 * acting operations at all.** It returns a proposed meaning, a confidence and a
 * rationale, and nothing else."
 *
 * ## Two vocabularies, and the difference between them is the whole ticket
 *
 * `Vocabulary.ts` gives the Discovery model seven verbs, five of which touch a
 * Surface. It is safe because the handlers cannot execute and the loop puts every
 * proposal through Policy before acting on it — the model proposes an action and
 * something else decides whether it happens.
 *
 * This toolkit is stricter, and stricter in kind rather than in degree. There is
 * **no acting verb in it**. Not disabled, not gated, not denied at run time:
 * absent. A model consulted here cannot propose a click, because `click` is not a
 * word it has. No tool below has a `target` parameter, or a `path`, or a `value`,
 * or a selector of any description, so there is nowhere to put something the
 * engine could resolve and press.
 *
 * That is what "a hallucination cannot cause an unintended action on a banking
 * system" means when it is a property of a type rather than a promise:
 * `test/assisted-recovery.test.ts` enumerates the toolkit, renders each tool's
 * JSON Schema, and asserts there is nowhere in any of them to put a Target.
 *
 * ## The third word, added for the second tenant, and why it does not move the line
 *
 * `proposeTarget` (ticket 16) lets a consultation say that an institution calls
 * one control something else. It is the only tool here that mentions a control
 * at all, and the boundary survives it for three independent reasons, none of
 * them a runtime check:
 *
 *   - its `control` parameter is a `Schema.Literals` over names **read off the
 *     live screen**, so there is no free text and nothing to invent;
 *   - a name is not a Target — no role, no scope, no ordinal, no selector — so
 *     there is nothing in the reply the engine could resolve;
 *   - the engine turns the reply into an `Unassisted`, which is the value that
 *     means *the rung did not settle this*, and hands it to a person. Nothing
 *     between the model and that person acts on it, and the only expression that
 *     can write it down takes an `InterventionRecord` carrying a human's
 *     confirmation (ADR-0006).
 *
 * It is also **absent** from every consultation that is not about a named
 * control that was missing: `assistToolkit` and `assistTargetToolkit` are two
 * different types, and the caller has to be holding a list of the screen's
 * controls to reach the second.
 *
 * ## Bounded by construction
 *
 * One `generateText`. No loop, no recursion, no correction turn, no retry. A
 * response that does not decode is `AssistUnavailable` and the run goes to the
 * person it was always going to go to — which is the correct bound for a rung
 * whose job is to *avoid* an escalation, not to fight for one. Compare
 * `loop.ts`, which feeds a bad proposal back as a correction and asks again:
 * Discovery is working something out for the first time and can afford to; a
 * production Replay standing on a live banking screen cannot.
 *
 * ## The candidate set comes from the Artifact, not from here
 *
 * `assistTools` takes the codes it may offer as an argument, and they are built
 * by `@cua/replay`'s `proposableOutcomes` from the document being executed — and
 * the control list, when there is one, comes from `controlsOfferedIn` over the
 * tree the run just observed. Both enumerations are somebody else's facts. So
 * the enumeration in the schema the model is sent *is* the Capability's own
 * vocabulary, minus anything learned to need a person. An invented code fails
 * schema validation inside `generateText` before this module sees it, and
 * `consultAssist` checks membership again on arrival.
 *
 * ## No vendor here
 *
 * The model layer is a parameter. `provider.ts` remains the only file in the
 * workspace that names one, and the same `providerFor` that Discovery uses is
 * what the Replay CLI passes in — which is why a working `OPENAI_API_KEY`
 * turns this rung on with no code change, and why a test passes a scripted
 * `LanguageModel` layer through the identical path.
 */

import type {
  Advisor,
  AssistCandidate,
  AssistConsultation,
  AssistControl,
  AssistReply
} from "@cua/replay"
import { AssistUnavailable } from "@cua/replay"
import { Effect, Layer, Schema } from "effect"
import type { ConfigError } from "effect/Config"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"

// ---------------------------------------------------------------------------
// The vocabulary, which contains no verb
// ---------------------------------------------------------------------------

/**
 * Everything the consulted model may say. Three words, and none of them is an
 * action: two classify a screen, and the third names a control for a person to
 * confirm.
 *
 * A test asserts this set is disjoint from both `@cua/policy`'s `ACTION_TYPES`
 * and the Discovery vocabulary, so a verb cannot be added here by copying one
 * from the loop without the disjointness failing first. `proposeTarget` is in
 * neither: Discovery's word for pressing something is `click`, and Policy's list
 * of things that can happen to a Surface does not contain a way to suggest.
 */
export const ASSIST_VERBS = ["classify", "proposeTarget", "cannotClassify"] as const

export type AssistVerb = (typeof ASSIST_VERBS)[number]

/** Why this classification. Lands in the `assist.proposal` Evidence event. */
const Rationale = Schema.String

/**
 * "This screen means one of your codes."
 *
 * `proposedOutcome` is a closed enumeration built from the Artifact, so the JSON
 * Schema the model receives lists the legal answers and nothing else. There is no
 * free-text code field, which is the difference between a model choosing among a
 * Capability's documented answers and a model naming a new one.
 */
const classifyTool = (candidates: ReadonlyArray<AssistCandidate>) =>
  Tool.make("classify", {
    description:
      "Say which of this capability's own outcome codes the screen means. You may only " +
      "choose from the codes listed; there is no way to write a new one. Give an honest " +
      "confidence: below the threshold this run uses, the answer is recorded and then " +
      "ignored, and a person is asked instead, which is the correct result when you are " +
      "not sure.",
    parameters: Schema.Struct({
      proposedOutcome: Schema.Literals(candidates.map((candidate) => candidate.code)),
      /**
       * 0 to 1. Checked by the schema, so a model returning 95 gets a validation
       * failure rather than a value that sails past every threshold in the
       * system.
       *
       * `Finite` rather than `Number`, and it is load-bearing twice over.
       * `Number` encodes `Infinity` as a string alternative, so its JSON Schema
       * comes out as an `anyOf` that carries no bounds at all — the model would
       * be told nothing about the range, and `Infinity` would clear every floor
       * ever written. `Finite` renders `{"type":"number","minimum":0,
       * "maximum":1}`, which is both a real constraint and a legible one.
       */
      confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
      rationale: Rationale
    })
  })

/**
 * "This screen calls that control something else."
 *
 * ## Why this is not an acting verb, and how that is enforced rather than said
 *
 * It is the one tool in this system that mentions a control at all, so it is
 * worth being exact about what it can and cannot do.
 *
 * 1. **`control` is `Schema.Literals` over names read off the live screen.**
 *    There is no free-text field: a model cannot name a control that is not
 *    there, because the enumeration it is sent contains only what is. An
 *    invented name fails validation inside `generateText`, and `consultAssist`
 *    checks membership again on arrival.
 * 2. **A name is not a Target.** There is no role here, no scope, no ordinal, no
 *    selector and no coordinate — nothing the engine could resolve. The test
 *    that renders every tool's JSON Schema and asserts no property is called
 *    `target`, `selector`, `css`, `xpath`, `path`, `url`, `value`, `role`,
 *    `label`, `click`, `action` or `coordinates` still passes, unchanged.
 * 3. **Nothing in the engine turns the reply into a gesture.** It becomes an
 *    `Unassisted` — the value that means the rung did *not* settle the stall —
 *    travels to `session.pause`, and is read by a person. The only expression
 *    that can promote it into a stored Tenant Override takes an
 *    `InterventionRecord` with a human's confirmation on it, exactly as
 *    `proposeAmendment` does for an outcome (ADR-0006: overrides are discovered
 *    and confirmed, never hand-written).
 *
 * So the boundary ADR-0005 draws is unmoved. What the rung may do is *say what
 * it sees*; what it may not do is touch the application, and a proposal that a
 * person has to agree to before it is even written down is the weakest possible
 * form of saying.
 */
const proposeTargetTool = (missing: string, controls: ReadonlyArray<AssistControl>) =>
  Tool.make("proposeTarget", {
    description:
      `The capability could not find ${missing} on this screen. If this institution simply ` +
      "calls that control something else, say which of the controls listed corresponds to " +
      "it. You may only choose from the controls listed; there is no way to write a new " +
      "one, and nothing will be pressed on your say-so — a person confirms it before it is " +
      "written down anywhere. If the control is genuinely absent rather than renamed, or if " +
      "the screen means one of the outcome codes instead, do not use this tool.",
    parameters: Schema.Struct({
      control: Schema.Literals(controls.map((control) => control.name)),
      /** `Finite` for the reason `classify`'s is. See the note there. */
      confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
      rationale: Rationale
    })
  })

/**
 * "None of these fits."
 *
 * A real answer, and worth a tool of its own rather than a low confidence on the
 * first: "I am 10% sure it is MEMBER_NOT_FOUND" and "this is not any of the
 * states you listed" are different things to tell an Operator, and a model with
 * no way to say the second will say the first.
 */
const CannotClassify = Tool.make("cannotClassify", {
  description:
    "None of the listed outcome codes describes this screen, or you cannot tell from " +
    "what you can see. Saying so is a correct answer and costs nothing: a person is " +
    "asked instead. Guessing is not.",
  parameters: Schema.Struct({ rationale: Rationale })
})

/**
 * A tool is only offered when its enumeration has something in it.
 *
 * `proposeTarget` is **absent** when `controls` is empty, which is every
 * consultation except one about a named control that was not on the screen. Not
 * disabled, not denied at run time: not a word the model has. That is the same
 * construction `ASSIST_VERBS` uses against acting verbs, applied one level down
 * — a rung cannot be asked a question it was not given the vocabulary for.
 *
 * `classify` is absent on the same terms and for a sharper reason. Its
 * `proposedOutcome` is a `Schema.Literals` over the Capability's codes, and over
 * an empty list that renders as `{"not": {}}` — a required property no value
 * satisfies. Offering it would mean sending a model a tool it cannot call
 * correctly under a `toolChoice: "required"` that obliges it to call something.
 * So an empty candidate list yields the vocabulary without it, and every word the
 * model is given is one it can actually use.
 *
 * `@cua/replay`'s `consultAssist` declines an empty-candidate consultation
 * outright, so nothing in this workspace reaches these branches from a run. They
 * are here because `assistTools` and the toolkits below are a public surface, and
 * a tool nobody can satisfy should not be constructible by accident.
 *
 * Note what is *not* here: no branch adds a word. Removing `classify` narrows
 * what the consulted model may return, so ADR-0005's line is where it was.
 */
export const assistTools = (candidates: ReadonlyArray<AssistCandidate>) =>
  candidates.length === 0
    ? Toolkit.make(CannotClassify)
    : Toolkit.make(classifyTool(candidates), CannotClassify)

/** The three-word vocabulary, for the tests that enumerate what it can say. */
export const assistTargetTools = (
  candidates: ReadonlyArray<AssistCandidate>,
  missing: string,
  controls: ReadonlyArray<AssistControl>
) =>
  candidates.length === 0
    ? Toolkit.make(proposeTargetTool(missing, controls), CannotClassify)
    : Toolkit.make(classifyTool(candidates), proposeTargetTool(missing, controls), CannotClassify)

/**
 * Handlers that refuse to run.
 *
 * Belt and braces, exactly as `Vocabulary.ts` does it, and here the braces are
 * holding up nothing: neither of these tools *has* an effect to perform, so even
 * a resolved call would only be describing its own arguments back. They die
 * anyway, so that "the framework resolved a tool call during a Replay
 * consultation" is loud rather than invisible.
 */
const refuseToResolve = (verb: AssistVerb) => () =>
  Effect.die(
    `the assist toolkit is a vocabulary of classifications, not an executor: ` +
      `${verb} was resolved by the framework instead of being read as data`
  )

/**
 * The classification-only toolkit: two words, neither of them an action.
 *
 * This is what every consultation gets except one about a control that was named
 * and not found. There is no `proposeTarget` in it — not disabled, absent — so a
 * model consulted about a Checkpoint that would not hold has no vocabulary in
 * which to suggest pressing anything.
 */
export const assistToolkit = (candidates: ReadonlyArray<AssistCandidate>) => {
  if (candidates.length === 0) {
    const only = Toolkit.make(CannotClassify)
    return Effect.provide(
      only,
      only.toLayer({ cannotClassify: refuseToResolve("cannotClassify") })
    )
  }
  const tools = Toolkit.make(classifyTool(candidates), CannotClassify)
  return Effect.provide(
    tools,
    tools.toLayer({
      classify: refuseToResolve("classify"),
      cannotClassify: refuseToResolve("cannotClassify")
    })
  )
}

/**
 * The same two words, plus the one that names a control on this screen.
 *
 * A separate function rather than a branch inside the one above, because the two
 * toolkits are different *types* and keeping them so is what makes "the tool is
 * absent" a fact rather than a runtime condition. A caller that wants
 * `proposeTarget` has to be holding a list of controls read off the live screen
 * to build it with, and there is no way to reach this function without one.
 */
export const assistTargetToolkit = (
  candidates: ReadonlyArray<AssistCandidate>,
  missing: string,
  controls: ReadonlyArray<AssistControl>
) => {
  if (candidates.length === 0) {
    const without = Toolkit.make(proposeTargetTool(missing, controls), CannotClassify)
    return Effect.provide(
      without,
      without.toLayer({
        proposeTarget: refuseToResolve("proposeTarget"),
        cannotClassify: refuseToResolve("cannotClassify")
      })
    )
  }
  const tools = Toolkit.make(
    classifyTool(candidates),
    proposeTargetTool(missing, controls),
    CannotClassify
  )
  return Effect.provide(
    tools,
    tools.toLayer({
      classify: refuseToResolve("classify"),
      proposeTarget: refuseToResolve("proposeTarget"),
      cannotClassify: refuseToResolve("cannotClassify")
    })
  )
}

// ---------------------------------------------------------------------------
// Decoding the answer
// ---------------------------------------------------------------------------

const Classification = Schema.Struct({
  proposedOutcome: Schema.String,
  confidence: Schema.Number,
  rationale: Schema.String
})
const decodeClassification = Schema.decodeUnknownResult(Classification)

const Correspondence = Schema.Struct({
  control: Schema.String,
  confidence: Schema.Number,
  rationale: Schema.String
})
const decodeCorrespondence = Schema.decodeUnknownResult(Correspondence)

const Refusal = Schema.Struct({ rationale: Schema.String })
const decodeRefusal = Schema.decodeUnknownResult(Refusal)

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/**
 * The standing instructions for a consultation.
 *
 * Short, because there is very little to say: the model has two things it can
 * return and a closed list to choose from. Most of what a Discovery prompt has to
 * explain — provenance tagging, how to name a control, which word to match on —
 * has no counterpart here, because none of it is expressible.
 *
 * The last paragraph is not a safety instruction. It is a description of the
 * tools, and it is here so the model does not waste a turn trying to help in a
 * way it cannot.
 */
export const ASSIST_INSTRUCTIONS = `You are being consulted, once, about a single screen in a back-office banking application. An automated capability has stopped on it and cannot tell what it means.

Your job is to classify the state, not to fix it. Read the accessibility structure below and say which of the capability's own outcome codes the screen represents, or say that none of them does.

Judge only from what is on the screen. A code is right when the screen shows the state that code names, and wrong when you are inferring it from what you expect a banking application to do. If two codes could fit, or the screen shows something none of them names, use cannotClassify: a person will be asked, which is a perfectly good result and much better than a confident wrong answer about somebody's account.

You have no way to act. There is no click, no navigation and no field to fill in anything you can return: this consultation reads a screen. If you are offered a list of the screen's controls, naming one of them is a suggestion for a person to confirm — nothing will be pressed because you said so. Do not describe a remedy or a next step beyond that; nothing is listening for one.`

/** The user turn: what stalled, what the codes mean, and the screen. */
export const consultationPrompt = (consultation: AssistConsultation): string =>
  [
    `CAPABILITY: ${consultation.capability}`,
    `STEP: ${consultation.stepId} — ${consultation.stepIntent}`,
    "",
    `WHAT STOPPED IT: ${consultation.stalled}`,
    "",
    consultation.question,
    "",
    "THE CODES YOU MAY CHOOSE FROM:",
    ...consultation.candidates.map(
      (candidate) => `  ${candidate.code}: ${candidate.meaning}`
    ),
    "",
    ...(consultation.missing === undefined || (consultation.controls ?? []).length === 0
      ? []
      : [
          `THE CONTROL THAT WAS NOT FOUND: ${consultation.missing}`,
          "",
          "THE CONTROLS THIS SCREEN OFFERS (a proposal for a person to confirm, never an action):",
          ...(consultation.controls ?? []).map(
            (control) =>
              `  ${JSON.stringify(control.name)}` +
              (control.region === "" ? "" : ` in ${JSON.stringify(control.region)}`)
          ),
          ""
        ]),
    "CURRENT SCREEN",
    `  url: ${consultation.url}`,
    "",
    "accessibility tree:",
    consultation.accessibility
  ].join("\n")

/**
 * The prompt for one consultation. Two text turns, and no branch that could
 * attach an image — ADR-0001 holds here for the same reason it holds in
 * Discovery, and the same test walks the parts to prove it.
 */
export const assistPrompt = (consultation: AssistConsultation) => [
  { role: "system" as const, content: ASSIST_INSTRUCTIONS },
  { role: "user" as const, content: consultationPrompt(consultation) }
]

// ---------------------------------------------------------------------------
// The advisor
// ---------------------------------------------------------------------------

export interface AdvisorOptions {
  /**
   * The model layer. `providerFor({...})` in production; a scripted
   * `LanguageModel` layer in a test.
   *
   * A parameter rather than a construction, which is what makes the two
   * identical below this line: the same call, the same toolkit, the same Schema
   * decoding. Nothing in this module knows which one it has.
   */
  readonly model: Layer.Layer<LanguageModel.LanguageModel, ConfigError>
}

/**
 * An `Advisor` backed by a model.
 *
 * The layer is provided *inside* the one consultation rather than around the
 * run. It costs nothing — the rung is bounded to a single call, so the layer is
 * built at most once — and it buys two things worth more than the saving: the
 * Replay engine never has a `LanguageModel` in scope even transitively, and a
 * missing API key arrives as an `AssistUnavailable` at the moment of use rather
 * than as a `ConfigError` that would have to be handled by whoever assembled the
 * run.
 *
 * Every way this can fail becomes `AssistUnavailable`, which the rung treats as
 * "no answer" and falls through to a person. A consultation that goes wrong must
 * never be able to fail a run: the run was already stopping, and this rung exists
 * to stop it *less* often, never more.
 */
export const modelAdvisor = (options: AdvisorOptions): Advisor => ({
  consult: (consultation: AssistConsultation) =>
    Effect.gen(function* () {
      const controls = consultation.controls ?? []
      const missing = consultation.missing

      /**
       * One call, one of two vocabularies.
       *
       * Written as two calls rather than one call with a computed toolkit
       * because the toolkits are different types, and that is the point: which
       * words the model has is decided here, from the shape of the stall, and
       * cannot be changed by anything the model returns. Everything else about
       * the two branches — the prompt, `toolChoice`, the resolution ban, the
       * single turn — is identical.
       */
      const answered = yield* (controls.length === 0 || missing === undefined
        ? LanguageModel.generateText({
            prompt: assistPrompt(consultation),
            // Built from this consultation's candidates, so the legal answers
            // are this Capability's own codes and nothing else.
            toolkit: assistToolkit(consultation.candidates),
            // It must answer with one of the words it has, rather than narrating.
            toolChoice: "required",
            // The framework resolves nothing; the reply comes back as data. Same
            // as the Discovery loop, though here there is nothing a resolution
            // could have performed even if it ran.
            disableToolCallResolution: true
          })
        : LanguageModel.generateText({
            prompt: assistPrompt(consultation),
            toolkit: assistTargetToolkit(consultation.candidates, missing, controls),
            toolChoice: "required",
            disableToolCallResolution: true
          }))

      const call = answered.toolCalls[0]
      if (call === undefined) {
        return yield* Effect.fail(
          new AssistUnavailable({
            reason: "the model answered without choosing classify or cannotClassify"
          })
        )
      }

      /**
       * The arguments, read once, before anything narrows on the name.
       *
       * Every word in every one of these vocabularies carries `params`, but the
       * vocabularies are now four different types — `classify` is absent when
       * the Capability offers no code to classify with — so narrowing on `name`
       * first can leave a branch whose call type is `never` and take `params`
       * with it. Each reply is validated by its own Schema below regardless, so
       * reading the arguments as `unknown` loses nothing.
       */
      const params: unknown = call.params

      // One turn only. A reply that does not decode is not corrected and asked
      // again — that is the loop this rung must not become. It is an
      // unavailability, and a person is asked.
      if (call.name === "proposeTarget") {
        const decoded = decodeCorrespondence(params)
        return decoded._tag === "Failure"
          ? yield* Effect.fail(
              new AssistUnavailable({
                reason: `the model's proposed control did not validate: ${decoded.failure}`
              })
            )
          : ({
              _tag: "TargetProposed",
              proposedControl: decoded.success.control,
              confidence: decoded.success.confidence,
              rationale: decoded.success.rationale
            } satisfies AssistReply)
      }

      if (call.name === "cannotClassify") {
        const decoded = decodeRefusal(params)
        return decoded._tag === "Failure"
          ? ({
              _tag: "Unclassified",
              rationale: "the model declined to classify, without saying why"
            } satisfies AssistReply)
          : ({ _tag: "Unclassified", rationale: decoded.success.rationale } satisfies AssistReply)
      }

      const decoded = decodeClassification(params)
      if (decoded._tag === "Failure") {
        return yield* Effect.fail(
          new AssistUnavailable({
            reason: `the model's classification did not validate: ${decoded.failure}`
          })
        )
      }

      return {
        _tag: "Classified",
        proposedOutcome: decoded.success.proposedOutcome,
        confidence: decoded.success.confidence,
        rationale: decoded.success.rationale
      } satisfies AssistReply
    }).pipe(
      Effect.provide(options.model),
      Effect.catch((problem) =>
        problem instanceof AssistUnavailable
          ? Effect.fail(problem)
          : Effect.fail(
              new AssistUnavailable({ reason: `the model could not be reached: ${problem}` })
            )
      )
    )
})
