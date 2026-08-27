/**
 * `bun run replay` — invoke a saved Capability by name with typed arguments.
 *
 *   bun run replay member.account-balance --memberId 12345
 *   bun run replay member.account-balance --memberId 12345 --headed
 *   bun run replay member.account-balance --memberId 12345 --baseUrl http://host:1234
 *
 * With no `--baseUrl`, Heritage Core starts in-process on a free port, so the
 * demo is one command with nothing to set up first.
 *
 * ## The ordering here is the point
 *
 * The Artifact is loaded, then the inputs are validated, and only then is the
 * Playwright Layer provided. `prepareInputs` returns a pure `Result` and requires
 * no services, so a bad call cannot have opened a browser — the guarantee is in
 * the signature rather than in the order of statements below. SPEC user story 30.
 *
 * Argument parsing is hand-rolled rather than `effect/unstable/cli`, which needs
 * platform services (`FileSystem`, `Terminal`, `Stdio`, `ChildProcessSpawner`)
 * from a platform package this workspace does not depend on. Ticket 18 decides
 * whether to add one.
 */

import { randomUUID } from "node:crypto"
import { serve } from "@cua/legacy-core"
import {
  type CapabilityArtifact,
  ARTIFACTS_DIRECTORY,
  describeOutputValue,
  listCapabilities,
  loadArtifact,
  prepareInputs
} from "@cua/artifact"
import { type EvidenceUnwritable, evidenceFiles } from "@cua/evidence"
import { DEFAULT_OPERATOR_PORT, serveOperator } from "@cua/operator"
import { permissivePolicy } from "@cua/policy"
import {
  DEFAULT_HANDOFF_WAIT_MILLIS,
  SessionControl,
  handoffSession,
  sessionControl
} from "@cua/session"
import { type SurfaceUnavailable, playwrightSurface } from "@cua/surface"
import { Console, Effect, Layer, Result } from "effect"
import type { Scope } from "effect/Scope"
import { type ReplayResult, replayCapability } from "./index.ts"

const EVIDENCE_ROOT = "evidence/replay"

const usage = (): string =>
  [
    "usage:",
    "  bun run replay <capability> [--<input> <value>]... [options]",
    "",
    "options:",
    "  --baseUrl <url>   the tenant installation to run against",
    "                    (default: start Heritage Core in-process on a free port)",
    "  --version <ver>   a specific artifact version (default: the latest stored)",
    "  --headed          watch it happen in a visible browser",
    "  --json            print the whole ReplayResult rather than a summary",
    "  --handoff         attend the run: start the operator interface, and pause",
    "                    for a person instead of failing when a checkpoint will",
    "                    not hold. Use with --headed; the operator works in that",
    "                    window. Without it the run is unattended and a stuck",
    "                    checkpoint is a hard failure, because nobody is watching",
    "  --operatorPort <n>       port for the operator interface (default 4180)",
    "  --handoffWait <seconds>  how long a paused run waits for someone",
    "",
    "capabilities:",
    ...listCapabilities(ARTIFACTS_DIRECTORY).map((name) => `  ${name}`)
  ].join("\n")

interface Argv {
  readonly capability: string | undefined
  readonly options: Readonly<Record<string, string>>
  readonly switches: ReadonlySet<string>
}

const parse = (argv: ReadonlyArray<string>): Argv => {
  const options: Record<string, string> = {}
  const switches = new Set<string>()
  let capability: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (!argument.startsWith("--")) {
      capability ??= argument
      continue
    }
    const key = argument.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith("--")) {
      switches.add(key)
    } else {
      options[key] = next
      index += 1
    }
  }
  return { capability, options, switches }
}

/** Everything the CLI consumes itself, so the rest is the capability's inputs. */
const RESERVED = new Set(["baseUrl", "version", "operatorPort", "handoffWait"])

const report = (result: ReplayResult, asJson: boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (asJson) {
      yield* Console.log(JSON.stringify(result, undefined, 2))
      return
    }

    yield* Console.log("")
    switch (result.result) {
      case "success":
        yield* Console.log(`${result.capability}@${result.version}  SUCCESS`)
        for (const [name, value] of Object.entries(result.outputs)) {
          yield* Console.log(`  ${name}: ${describeOutputValue(value)}`)
        }
        break
      case "business_outcome":
        yield* Console.log(`${result.capability}@${result.version}  ${result.code}`)
        yield* Console.log(`  ${result.detail}`)
        break
      case "intervention_required":
        yield* Console.log(`${result.capability}@${result.version}  INTERVENTION REQUIRED`)
        yield* Console.log(`  at step ${result.stepId}: ${result.reason}`)
        yield* Console.log(`  session:  ${result.sessionId}`)
        break
      case "failure":
        yield* Console.log(`${result.capability}@${result.version}  FAILURE`)
        yield* Console.log(`  step:     ${result.failure.stepId} (${result.failure.stepIntent})`)
        yield* Console.log(`  reason:   ${result.failure.reason}`)
        yield* Console.log(`  expected: ${result.failure.expected}`)
        yield* Console.log(`  observed: ${result.failure.observed}`)
        break
    }

    yield* Console.log("")
    yield* Console.log("steps:")
    for (const step of result.steps) {
      const read = step.read === undefined ? "" : `  -> ${step.read}`
      yield* Console.log(`  [${step.checkpoint}] ${step.id}  ${step.intent}${read}`)
    }
    yield* Console.log("")
    yield* Console.log(`evidence: ${result.evidenceDirectory}`)
  })

const run = (
  artifact: CapabilityArtifact,
  argv: Argv
): Effect.Effect<void, SurfaceUnavailable | EvidenceUnwritable, Scope> =>
  Effect.gen(function* () {
    // Pure, service-free, browser-free. A rejection here costs nothing.
    const supplied = Object.fromEntries(
      Object.entries(argv.options).filter(([key]) => !RESERVED.has(key))
    )
    const inputs = prepareInputs(artifact.capability, artifact.inputs, supplied)
    if (Result.isFailure(inputs)) {
      yield* Console.error(`bad call: ${inputs.failure.message}`)
      process.exitCode = 2
      return
    }

    const baseUrl = argv.options["baseUrl"] ?? (yield* serve({ port: 0 })).origin
    const runId = `${artifact.capability}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${
      randomUUID().slice(0, 8)
    }`
    const sessionId = randomUUID()

    const attended = argv.switches.has("handoff")
    const waitSeconds = Number(argv.options["handoffWait"])

    // Only now does anything open. The four services the engine requires, and
    // nothing else: there is no language model in this layer, which is what
    // ADR-0003's compile-time proof rests on.
    //
    // `SessionControl` is in the composition alongside `Session`, and one Ref
    // underlies both. It is the *operator's* half, which is why the operator
    // interface can be handed it and the engine cannot: `Session` is what the
    // engine requires, and nothing on it returns control to itself.
    const evidence = evidenceFiles({ root: EVIDENCE_ROOT, runId, sessionId })
    const control = sessionControl({
      sessionId,
      waitMillis: Number.isFinite(waitSeconds) && waitSeconds > 0
        ? waitSeconds * 1000
        : DEFAULT_HANDOFF_WAIT_MILLIS,
      announce: (intervention, operatorUrl) =>
        Console.log(
          [
            "",
            `PAUSED at step ${intervention.stepId}: ${intervention.reason}`,
            `  the live browser window is on ${intervention.url}`,
            `  take control at ${operatorUrl}`,
            ""
          ].join("\n")
        )
    }).pipe(Layer.provideMerge(evidence))

    const services = Layer.mergeAll(
      playwrightSurface({ headless: !argv.switches.has("headed") }),
      permissivePolicy,
      handoffSession.pipe(Layer.provideMerge(control))
    )

    const result = yield* Effect.gen(function* () {
      // Attaching the interface is what makes the run attended. An unattended
      // run has nobody to escalate to, so the engine reports a hard failure
      // rather than pausing for someone who is not coming.
      if (attended) {
        const operator = yield* serveOperator({
          control: yield* SessionControl,
          port: Number(argv.options["operatorPort"] ?? DEFAULT_OPERATOR_PORT)
        })
        yield* Console.log(`operator interface: ${operator.origin}`)
      }

      return yield* replayCapability({ artifact, inputs: inputs.success, baseUrl, runId })
    }).pipe(Effect.provide(services))

    yield* report(result, argv.switches.has("json"))

    // A Business Outcome exits zero: the application answered and the answer is
    // the product. An Intervention does not, because nothing was produced and a
    // person is still required — that it is not a *failure* in the taxonomy does
    // not make it a completed job. Callers that care about the difference read
    // `result` rather than the exit code.
    if (result.result === "failure" || result.result === "intervention_required") {
      process.exitCode = 1
    }
  })

const program = Effect.gen(function* () {
  const argv = parse(Bun.argv.slice(2))
  if (argv.capability === undefined) {
    yield* Console.log(usage())
    return
  }

  const artifact = loadArtifact(
    ARTIFACTS_DIRECTORY,
    argv.capability,
    argv.options["version"]
  )
  if (Result.isFailure(artifact)) {
    yield* Console.error(`cannot run ${argv.capability}: ${artifact.failure.message}`)
    process.exitCode = 2
    return
  }

  yield* run(artifact.success, argv)
})

Effect.runPromise(Effect.scoped(program)).catch((cause) => {
  console.error(String(cause))
  process.exitCode = 1
})
