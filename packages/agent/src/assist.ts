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
 * word it has. It cannot name a control, because no tool below has a `target`
 * parameter, or a `path`, or a `value`, or a selector of any description. The
 * strongest thing that can go wrong is that it returns the wrong one of the
 * Capability's own documented outcome codes, at a confidence the engine then
 * weighs.
 *
 * That is what "a hallucination cannot cause an unintended action on a banking
 * system" means when it is a property of a type rather than a promise:
 * `test/assisted-recovery.test.ts` enumerates the toolkit, renders each tool's
 * JSON Schema, and asserts there is nowhere in any of them to put a control.
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
 * by `@cua/replay`'s `proposableOutcomes` from the document being executed. So
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

import type { Advisor, AssistCandidate, AssistConsultation, AssistReply } from "@cua/replay"
import { AssistUnavailable } from "@cua/replay"
import { Effect, Layer, Schema } from "effect"
import type { ConfigError } from "effect/Config"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"

// ---------------------------------------------------------------------------
// The vocabulary, which contains no verb
// ---------------------------------------------------------------------------

/**
 * Everything the consulted model may say. Two words, and neither is an action.
 *
 * A test asserts this set is disjoint from both `@cua/policy`'s `ACTION_TYPES`
 * and the Discovery vocabulary, so a verb cannot be added here by copying one
 * from the loop without the disjointness failing first.
 */
export const ASSIST_VERBS = ["classify", "cannotClassify"] as const

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

/** The two tools, for one Artifact's candidate codes. */
export const assistTools = (candidates: ReadonlyArray<AssistCandidate>) =>
  Toolkit.make(classifyTool(candidates), CannotClassify)

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

export const assistToolkit = (candidates: ReadonlyArray<AssistCandidate>) => {
  const tools = assistTools(candidates)
  return Effect.provide(
    tools,
    tools.toLayer({
      classify: refuseToResolve("classify"),
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

You have no way to act. There is no click, no navigation, no field to fill and no control to name in anything you can return: this consultation reads a screen and returns a classification. Do not describe a remedy or suggest a next step; nothing is listening for one.`

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
      const answered = yield* LanguageModel.generateText({
        prompt: assistPrompt(consultation),
        // Built from this consultation's candidates, so the legal answers are
        // this Capability's own codes and nothing else.
        toolkit: assistToolkit(consultation.candidates),
        // It must answer with one of the two, rather than narrating.
        toolChoice: "required",
        // The framework resolves nothing; the reply comes back as data. Same as
        // the Discovery loop, though here there is nothing a resolution could
        // have performed even if it ran.
        disableToolCallResolution: true
      })

      const call = answered.toolCalls[0]
      if (call === undefined) {
        return yield* Effect.fail(
          new AssistUnavailable({
            reason: "the model answered without choosing classify or cannotClassify"
          })
        )
      }

      // One turn only. A reply that does not decode is not corrected and asked
      // again — that is the loop this rung must not become. It is an
      // unavailability, and a person is asked.
      if (call.name === "cannotClassify") {
        const decoded = decodeRefusal(call.params)
        return decoded._tag === "Failure"
          ? ({
              _tag: "Unclassified",
              rationale: "the model declined to classify, without saying why"
            } satisfies AssistReply)
          : ({ _tag: "Unclassified", rationale: decoded.success.rationale } satisfies AssistReply)
      }

      const decoded = decodeClassification(call.params)
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
