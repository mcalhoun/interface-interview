import { it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Stream } from "effect"
import { AiError, LanguageModel } from "effect/unstable/ai"
import { expect } from "vitest"
import { modelAdvisor, providerFor } from "@cua/agent"
import type { AssistConsultation } from "@cua/replay"
import { scriptedModel } from "../apps/demo/src/support/scripted-model.ts"

const consultation: AssistConsultation = {
  capability: "member.account-balance@1.0.0", stepId: "open-account",
  stepIntent: "Open the account", stalled: "Nothing matched", question: "What is this state?",
  url: "http://example.invalid/", accessibility: '- heading "No savings account"',
  candidates: [{ code: "NO_MATCH", meaning: "No account matches" }]
}

it.live("missing model credentials produce an actionable public assistance diagnostic", () => Effect.gen(function* () {
  const model = providerFor().pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))))
  const failure = yield* Effect.flip(modelAdvisor({ model }).consult(consultation))
  expect(failure._tag).toBe("AssistUnavailable")
  expect(failure.reason).toBe("assistance is unavailable because model credentials or configuration are missing or invalid")
}))

it.live("provider failures never expose response bodies or configuration internals", () => Effect.gen(function* () {
  const model = Layer.effect(LanguageModel.LanguageModel)(LanguageModel.make({
    generateText: () => Effect.fail(AiError.make({
      module: "provider", method: "generateText",
      reason: new AiError.UnknownError({ description: "SchemaError: bearer PRIVATE_PROVIDER_TOKEN" })
    })),
    streamText: () => Stream.empty
  }))
  const failure = yield* Effect.flip(modelAdvisor({ model }).consult(consultation))
  expect(failure.reason).toBe("the assistance model could not provide a usable response; check the provider and try again")
  expect(JSON.stringify(failure)).not.toContain("PRIVATE_PROVIDER_TOKEN")
}))

it.live("malformed model replies produce a stable diagnostic without schema details", () => Effect.gen(function* () {
  const model = scriptedModel([{ name: "classify", params: { proposedOutcome: "NO_MATCH", confidence: "PRIVATE_MODEL_TEXT", rationale: "bad response" } }])
  const failure = yield* Effect.flip(modelAdvisor({ model }).consult(consultation))
  expect(failure.reason).toBe("the assistance model could not provide a usable response; check the provider and try again")
  expect(JSON.stringify(failure)).not.toContain("PRIVATE_MODEL_TEXT")
}))
