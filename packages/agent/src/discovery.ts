import { Evidence, evidenceFiles } from "@cua/evidence"
import type { EvidenceOptions } from "@cua/evidence"
import { Effect, Layer, Result } from "effect"
import { serializeCompilation } from "./compile.ts"
import type { CompileOptions, StoredCompilation } from "./compile.ts"
import { discover } from "./loop.ts"
import type { DiscoveryOptions } from "./loop.ts"
import { discoveredSecrets } from "./redaction.ts"
import type { Trajectory } from "./Trajectory.ts"

export interface DiscoveryRunOptions extends Omit<DiscoveryOptions, "secrets"> {
  readonly evidence: Omit<EvidenceOptions, "scrubber" | "runId" | "sessionId">
  /** Omit to observe Discovery without requesting a Capability Artifact. */
  readonly compilation?: Omit<CompileOptions, "publicGoalTerms">
}

/** Plain diagnostics contain no executable actions, readings or private compiler inputs. */
export interface DiscoveryDiagnostics {
  readonly format: "discovery-diagnostics-v3"
  readonly runId: string
  readonly sessionId: string
  readonly evidenceDirectory: string
  readonly conclusion: Trajectory["conclusion"]["conclusion"]
  readonly summary: string
  readonly steps: ReadonlyArray<{ readonly id: string; readonly intent: string; readonly verb: string }>
  readonly stepsAttempted: number
  readonly durationMillis: number
}

export type DiscoveryCompilation =
  | { readonly status: "not_requested" }
  | { readonly status: "not_reached" }
  | { readonly status: "refused"; readonly reasons: ReadonlyArray<string> }
  | { readonly status: "compiled"; readonly stored: StoredCompilation }

export interface DiscoveryResult {
  readonly diagnostics: DiscoveryDiagnostics
  readonly compilation: DiscoveryCompilation
}

/**
 * Creates one Evidence writer shared by Discovery and its Session/Operator.
 * Construction opens Evidence only. The caller supplies the Surface, Policy,
 * Session and model to execute. Compilation finishes before private context
 * leaves that execution; persistence remains an explicit caller operation.
 */
export const discoveryRun = (options: DiscoveryRunOptions) => Effect.gen(function* () {
  const secrets = discoveredSecrets()
  const writer = yield* Evidence.pipe(Effect.provide(evidenceFiles({
    ...options.evidence, runId: options.runId, sessionId: options.sessionId,
    scrubber: secrets.registry
  })))
  const execution = discover({ ...options, secrets }).pipe(
    Effect.provideService(Evidence, writer),
    Effect.map((trajectory): DiscoveryResult => {
      const compiled = options.compilation === undefined || trajectory.conclusion.conclusion !== "reached"
        ? undefined
        : serializeCompilation(trajectory, { ...options.compilation,
          ...(options.publicGoalTerms === undefined ? {} : { publicGoalTerms: options.publicGoalTerms }) })
      const compilation: DiscoveryCompilation = options.compilation === undefined
        ? { status: "not_requested" }
        : compiled === undefined ? { status: "not_reached" }
        : Result.isFailure(compiled) ? { status: "refused", reasons: compiled.failure.reasons.map(writer.scrub) }
        : { status: "compiled", stored: compiled.success }
      const conclusion = trajectory.conclusion
      const summary = conclusion.conclusion === "reached" ? conclusion.summary
        : conclusion.conclusion === "stuck" ? conclusion.trigger.detail : conclusion.reason
      return {
        diagnostics: {
          format: "discovery-diagnostics-v3",
          runId: writer.scrub(trajectory.runId), sessionId: writer.scrub(trajectory.sessionId),
          evidenceDirectory: writer.scrub(trajectory.evidenceDirectory),
          conclusion: conclusion.conclusion, summary: writer.scrub(summary),
          steps: trajectory.steps.map((step) => ({
            id: writer.scrub(step.id), intent: writer.scrub(step.intent), verb: writer.scrub(step.verb)
          })),
          stepsAttempted: trajectory.steps_attempted, durationMillis: trajectory.durationMillis
        },
        compilation
      }
    })
  )
  return { evidence: Layer.succeed(Evidence, writer), execute: execution }
})
