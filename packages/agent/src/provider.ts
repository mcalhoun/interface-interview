/**
 * The model provider, as a Layer — and the only file in this package that names
 * one.
 *
 * SPEC: "Model access goes through `effect/unstable/ai/LanguageModel`. Provider
 * choice is a `Layer` swap between `@effect/ai-anthropic` and `@effect/ai-openai`,
 * both at matching RC versions. We hand-roll no provider abstraction."
 *
 * The claim that matters is the second half. There is no `ModelClient` interface
 * here, no adapter, no wrapper around a wrapper: `LanguageModel` **is** the
 * abstraction, it ships with the framework, and swapping providers means
 * providing a different Layer. So `loop.ts` imports `LanguageModel` and nothing
 * else, and a test asserts that no file in this package outside this one mentions
 * OpenAI at all. That is what makes "switching providers needs no change to the
 * loop" checkable rather than asserted.
 *
 * ## The key
 *
 * Read through `Config.redacted`, which yields a `Redacted<string>`. It is never
 * held as a plain string here, never logged, never written to Evidence, and never
 * printed by the CLI. `Config` also means a missing key is a `ConfigError` at
 * layer construction — before a browser opens — rather than a 401 six steps into
 * a run.
 *
 * ## Ticket 15
 *
 * The assisted-recovery model is a classification-only call against the same
 * provider. Reuse `openAiProvider` unchanged and give it a toolkit containing no
 * acting verb — ADR-0005's "structurally incapable of acting" is a property of the
 * toolkit you hand it, not of the layer.
 */

import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Config, Layer } from "effect"
import type { ConfigError } from "effect/Config"
import type { LanguageModel } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"

/**
 * The default model.
 *
 * A mid-size model rather than the largest available, deliberately: the argument
 * of this project is that a constrained action vocabulary over an accessibility
 * tree is enough structure that the task does not need a frontier model to reason
 * its way through raw markup. Running it on something modest is part of the
 * evidence for that.
 */
export const DEFAULT_MODEL = "gpt-4.1-mini"

/** The environment variable the key is read from. Named once, here. */
export const API_KEY_VARIABLE = "OPENAI_API_KEY"

export interface ProviderOptions {
  /** A model id, e.g. `gpt-4.1-mini`. */
  readonly model?: string
  /**
   * Sampling temperature. Discovery defaults to 0: the loop is not looking for
   * variety, and a lower temperature makes a failed run easier to reproduce.
   */
  readonly temperature?: number
}

/**
 * OpenAI as the `LanguageModel` service.
 *
 * `Layer<LanguageModel, ConfigError>`: the error channel is the missing key, and
 * it is the caller's job to report it. `FetchHttpClient` is used rather than a
 * platform HTTP client because Bun has a global `fetch` and adding
 * `@effect/platform-*` for one service would be a dependency bought for nothing.
 */
export const openAiProvider = (
  options: ProviderOptions = {}
): Layer.Layer<LanguageModel.LanguageModel, ConfigError> =>
  OpenAiLanguageModel.layer({
    model: options.model ?? DEFAULT_MODEL,
    config: { temperature: options.temperature ?? 0 }
  }).pipe(
    Layer.provide(
      OpenAiClient.layerConfig({ apiKey: Config.redacted(API_KEY_VARIABLE) })
    ),
    Layer.provide(FetchHttpClient.layer)
  )

/**
 * Every provider this build can use, by name.
 *
 * The reason this exists rather than the CLI simply calling `openAiProvider`:
 * with a direct call, "switching providers is a Layer swap" would still be true
 * of the loop but false of everything that starts one, and the CLI would name a
 * vendor. Here the only thing that names one is this file, and adding
 * `@effect/ai-anthropic` is a second entry in this record plus a dependency —
 * no change to `loop.ts`, `cli.ts`, or anything between them.
 *
 * A single entry today is honest rather than embarrassing: the second is
 * genuinely one line, and a two-entry map built with no second implementation to
 * check it against would be speculation.
 */
export const PROVIDERS = {
  openai: openAiProvider
} as const satisfies Record<string, (options: ProviderOptions) => Layer.Layer<
  LanguageModel.LanguageModel,
  ConfigError
>>

export type ProviderName = keyof typeof PROVIDERS

export const PROVIDER_NAMES = Object.keys(PROVIDERS) as ReadonlyArray<ProviderName>

export const DEFAULT_PROVIDER: ProviderName = "openai"

export const isProviderName = (name: string): name is ProviderName =>
  Object.hasOwn(PROVIDERS, name)

/**
 * The model layer for a named provider.
 *
 * The one function a caller needs. Everything above it is configuration; nothing
 * below it is reachable from the loop.
 */
export const providerFor = (
  options: ProviderOptions & { readonly provider?: ProviderName } = {}
): Layer.Layer<LanguageModel.LanguageModel, ConfigError> =>
  PROVIDERS[options.provider ?? DEFAULT_PROVIDER](options)
