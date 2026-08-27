/**
 * A `LanguageModel` that does what it is told.
 *
 * SPEC records it as a deliberate cut that no automated test calls a live model:
 * it is slow, it costs money on every CI run, and it is non-deterministic, so a
 * failure would not tell you whether the code broke or the model had an off day.
 * What *is* worth testing is everything around the model — the toolkit's
 * validation, the provenance rules, the Policy gate, stuck detection, and the
 * loop's control flow — and all of that is deterministic the moment the model's
 * output is.
 *
 * So these layers stand in for the provider. They are the model half only:
 * everything below them in a test is real. The browser is a real Chromium, the
 * application is the real Heritage Core fixture, Policy is the shipped
 * `policies/default.yaml`, and Evidence really is written to disk. The one thing
 * being simulated is the judgement, which is the one thing a test cannot assert
 * about anyway.
 *
 * `LanguageModel.make` takes the provider hook — the same seam
 * `@effect/ai-openai` fills — so a test double here exercises exactly the code
 * path a real provider does, including the Schema decoding of the tool call's
 * arguments. A stub that returned a `Proposal` directly would skip that, and the
 * decoding is a thing this ticket claims works.
 */

import { Effect, Layer, Stream } from "effect"
import { LanguageModel, type Prompt, type Response } from "effect/unstable/ai"

/** One turn: the action the stand-in model chooses. */
export interface ScriptedCall {
  readonly name: string
  readonly params: unknown
  /** Optional narration, so a test can assert the rationale reaches Evidence. */
  readonly text?: string
}

/** The text of the prompt one turn was asked with. */
export const promptText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
          .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
          .join("\n")
    )
    .join("\n\n")

const partsFor = (call: ScriptedCall): Array<Response.PartEncoded> => [
  ...(call.text === undefined
    ? []
    : [{ type: "text" as const, text: call.text }]),
  {
    type: "tool-call" as const,
    id: `call-${Math.random().toString(36).slice(2, 10)}`,
    name: call.name,
    params: call.params
  }
]

/**
 * Plays a fixed list of actions, one per turn.
 *
 * Running off the end is a failure rather than a repeat: a loop that asked for
 * more turns than the test scripted has done something the test did not expect,
 * and silently replaying the last action would hide it.
 */
export const scriptedModel = (
  calls: ReadonlyArray<ScriptedCall>
): Layer.Layer<LanguageModel.LanguageModel> => {
  let turn = 0
  return Layer.effect(LanguageModel.LanguageModel)(
    LanguageModel.make({
      generateText: () =>
        Effect.suspend(() => {
          const call = calls[turn]
          turn += 1
          if (call === undefined) {
            return Effect.die(
              `the scripted model ran out of actions after ${calls.length} turns; ` +
                `the loop asked for turn ${turn}`
            )
          }
          return Effect.succeed(partsFor(call))
        }),
      streamText: () => Stream.empty
    })
  )
}

/**
 * Decides from the prompt it is given.
 *
 * The useful one for driving a real browser: a test can write a handful of
 * if-statements over the accessibility YAML and have a deterministic "model" that
 * genuinely reacts to the screen rather than replaying a fixed script. It is also
 * how a test asserts what the loop *showed* the model — the prompt is the
 * argument, so a test can require that it never contains an image part.
 */
export const respondingModel = (
  decide: (prompt: string, turn: number) => ScriptedCall
): Layer.Layer<LanguageModel.LanguageModel> => {
  let turn = 0
  return Layer.effect(LanguageModel.LanguageModel)(
    LanguageModel.make({
      generateText: (options) =>
        Effect.suspend(() => {
          const call = decide(promptText(options.prompt), turn)
          turn += 1
          return Effect.succeed(partsFor(call))
        }),
      streamText: () => Stream.empty
    })
  )
}

/** Every prompt a model layer was asked with, for assertions about what was shown. */
export const recordingModel = (
  decide: (prompt: string, turn: number) => ScriptedCall
): {
  readonly layer: Layer.Layer<LanguageModel.LanguageModel>
  readonly prompts: () => ReadonlyArray<Prompt.Prompt>
} => {
  const prompts: Array<Prompt.Prompt> = []
  let turn = 0
  const layer = Layer.effect(LanguageModel.LanguageModel)(
    LanguageModel.make({
      generateText: (options) =>
        Effect.suspend(() => {
          prompts.push(options.prompt)
          const call = decide(promptText(options.prompt), turn)
          turn += 1
          return Effect.succeed(partsFor(call))
        }),
      streamText: () => Stream.empty
    })
  )
  return { layer, prompts: () => prompts }
}
