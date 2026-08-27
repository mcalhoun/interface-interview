/**
 * `bun run discover` — hand a model a Goal and let it drive.
 *
 *   bun run discover "Look up the savings account balance of member 12345"
 *   bun run discover "..." --headed          # watch it happen
 *   bun run discover "..." --model gpt-5-mini
 *   bun run discover "..." --baseUrl http://host:1234
 *
 * With no `--baseUrl`, Heritage Core starts in-process on a free port, so the
 * demo is one command with nothing to set up first.
 *
 * ## The ordering, again
 *
 * Same rule as `bun run replay`: everything that can be refused without cost is
 * refused first. The policy is loaded (a pure `Result`), then the provider layer
 * is built — a missing `OPENAI_API_KEY` is a `ConfigError` from `Config.redacted`,
 * not a 401 six steps into a run — and only then does a browser open. A run that
 * cannot legally happen should not cost anyone a browser.
 *
 * The key is never printed. It is read as a `Redacted` inside `provider.ts` and
 * nothing in this file, in the report, or in Evidence can render it.
 */

import { randomUUID } from "node:crypto"
import {
  DEFAULT_BOUNDS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  PROVIDER_NAMES,
  discover,
  discoveredSecrets,
  compileArtifact,
  isProviderName,
  providerFor
} from "./index.ts"
import type { Trajectory } from "./index.ts"
import { ARTIFACTS_DIRECTORY, writeArtifact } from "@cua/artifact"
import { serve } from "@cua/legacy-core"
import { evidenceFiles } from "@cua/evidence"
import {
  DEFAULT_POLICY,
  POLICIES_DIRECTORY,
  listPolicies,
  loadPolicy,
  policyFrom
} from "@cua/policy"
import { playwrightSurface } from "@cua/surface"
import { Console, Effect, Layer, Result } from "effect"

const EVIDENCE_ROOT = "evidence/discovery"

const usage = (): string =>
  [
    "usage:",
    "  bun run discover \"<goal>\" [options]",
    "",
    "options:",
    "  --entry <path>    where to start (default: /)",
    "  --baseUrl <url>   the tenant installation to run against",
    "                    (default: start Heritage Core in-process on a free port)",
    `  --policy <name>   the policy in force (default: ${DEFAULT_POLICY}), by name or path`,
    `  --model <id>      the model that drives (default: ${DEFAULT_MODEL})`,
    `  --provider <name> which provider supplies it (default: ${DEFAULT_PROVIDER});`,
    `                    one of: ${PROVIDER_NAMES.join(", ")}`,
    `  --maxSteps <n>    step bound (default: ${DEFAULT_BOUNDS.maxSteps})`,
    `  --maxSeconds <n>  wall-clock bound (default: ${DEFAULT_BOUNDS.maxMillis / 1000})`,
    "  --headed          watch it happen in a visible browser",
    "  --json            print the whole trajectory rather than a summary",
    "  --emit <name>     on success, compile the run into a stored Capability",
    "                    Artifact under that name and write it to artifacts/",
    "  --artifactVersion <ver>  the version to cut with --emit (default: 1.0.0)",
    "  --product <text>  the vendor product to record with --emit; discovery",
    "                    observes an accessibility tree, not a product name",
    "",
    "examples:",
    "  bun run discover \"Look up the savings account balance of member 12345\"",
    "  bun run discover \"...\" --emit member.account-balance.discovered",
    "",
    "policies:",
    ...listPolicies(POLICIES_DIRECTORY).map((name) => `  ${name}`)
  ].join("\n")

interface Argv {
  readonly goal: string | undefined
  readonly options: Readonly<Record<string, string>>
  readonly switches: ReadonlySet<string>
}

const parse = (argv: ReadonlyArray<string>): Argv => {
  const options: Record<string, string> = {}
  const switches = new Set<string>()
  let goal: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (!argument.startsWith("--")) {
      goal ??= argument
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
  return { goal, options, switches }
}

/**
 * The report.
 *
 * Written to be read by someone deciding whether this trajectory is worth
 * compiling into a Capability. So it leads with what was discovered — the
 * parameters, the selection rule, the outputs — rather than with the step log,
 * because the steps are how it got there and the parameters are what it learned.
 */
const report = (trajectory: Trajectory, asJson: boolean): Effect.Effect<void> =>
  Effect.gen(function*() {
    if (asJson) {
      yield* Console.log(JSON.stringify(trajectory, undefined, 2))
      return
    }

    yield* Console.log("")
    switch (trajectory.conclusion.conclusion) {
      case "reached":
        yield* Console.log(`GOAL REACHED in ${trajectory.steps.length} steps`)
        yield* Console.log(`  ${trajectory.conclusion.summary}`)
        break
      case "stuck":
        yield* Console.log(`STUCK — ${trajectory.conclusion.trigger.trigger}`)
        yield* Console.log(`  ${trajectory.conclusion.trigger.detail}`)
        break
      case "failed":
        yield* Console.log("FAILED")
        yield* Console.log(`  ${trajectory.conclusion.reason}`)
        break
    }

    if (trajectory.parameters.length > 0) {
      yield* Console.log("")
      yield* Console.log("parameters discovered:")
      for (const parameter of trajectory.parameters) {
        yield* Console.log(
          `  ${parameter.name}  (sensitive: ${parameter.sensitive}; used by ${
            parameter.usedBy.join(", ")
          })`
        )
      }
    }

    for (const selection of trajectory.selections) {
      yield* Console.log("")
      yield* Console.log(`selection rule (${selection.parameter}):`)
      yield* Console.log(`  values:         ${selection.values.map((v) => JSON.stringify(v)).join(", ")}`)
      // Both words, side by side. The default is the goal's; the match is the
      // screen's. Printing them together is how a reviewer sees at a glance that
      // the right one was recorded — see Selection.ts for why it matters.
      yield* Console.log(`  default:        ${JSON.stringify(selection.default)}   (the goal's word)`)
      yield* Console.log(`  matched label:  ${JSON.stringify(selection.matched ?? "")}   (this tenant's word, NOT recorded)`)
      yield* Console.log(`  discoveredFrom: ${selection.discoveredFrom}`)
    }

    if (trajectory.outputs.length > 0) {
      yield* Console.log("")
      yield* Console.log("outputs:")
      for (const output of trajectory.outputs) {
        yield* Console.log(`  ${output.name}: ${output.value ?? "(unread)"}  <- step ${output.fromStep}`)
      }
    }

    yield* Console.log("")
    yield* Console.log("steps:")
    for (const step of trajectory.steps) {
      const read = step.outcome.read === undefined ? "" : `  -> ${step.outcome.read}`
      yield* Console.log(`  ${step.id}  ${step.intent}${read}`)
      yield* Console.log(`      ${step.rationale}`)
    }

    yield* Console.log("")
    yield* Console.log(`states seen: ${trajectory.signatures.length} (${
      new Set(trajectory.signatures).size
    } distinct)`)
    yield* Console.log(`duration:    ${(trajectory.durationMillis / 1000).toFixed(1)}s`)
    yield* Console.log(`evidence:    ${trajectory.evidenceDirectory}`)
  })

const program = Effect.gen(function*() {
  const argv = parse(Bun.argv.slice(2))
  if (argv.goal === undefined) {
    yield* Console.log(usage())
    return
  }

  // Resolved before anything opens. A policy that does not load is a run that
  // does not happen: there is no unrestricted fallback to fall through to.
  const policy = loadPolicy(POLICIES_DIRECTORY, argv.options["policy"] ?? DEFAULT_POLICY)
  if (Result.isFailure(policy)) {
    yield* Console.error(`cannot discover under this policy: ${policy.failure.message}`)
    process.exitCode = 2
    return
  }

  const goal = argv.goal
  const entry = argv.options["entry"] ?? "/"
  const model = argv.options["model"] ?? DEFAULT_MODEL

  // Named rather than called directly, so the only thing in this workspace that
  // names a vendor is provider.ts. Adding a second provider is an entry in its
  // PROVIDERS record and nothing here.
  const requested = argv.options["provider"] ?? DEFAULT_PROVIDER
  if (!isProviderName(requested)) {
    yield* Console.error(
      `no such provider ${JSON.stringify(requested)}. Available: ${PROVIDER_NAMES.join(", ")}`
    )
    process.exitCode = 2
    return
  }
  const provider = requested
  const baseUrl = argv.options["baseUrl"] ?? (yield* serve({ port: 0 })).origin
  const runId = `discover-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${
    randomUUID().slice(0, 8)
  }`
  const sessionId = randomUUID()

  const maxSteps = Number(argv.options["maxSteps"])
  const maxSeconds = Number(argv.options["maxSeconds"])
  const bounds = {
    ...DEFAULT_BOUNDS,
    ...(Number.isFinite(maxSteps) && maxSteps > 0 ? { maxSteps } : {}),
    ...(Number.isFinite(maxSeconds) && maxSeconds > 0 ? { maxMillis: maxSeconds * 1000 } : {})
  }

  // The scrubber that grows as the model discovers values. Built here so the
  // Evidence Layer and the loop share one — see redaction.ts.
  const secrets = discoveredSecrets()

  yield* Console.log(`goal:   ${goal}`)
  yield* Console.log(`model:  ${model} (${provider})`)
  yield* Console.log(`policy: ${policy.success.name}`)
  yield* Console.log("")

  const services = Layer.mergeAll(
    playwrightSurface({ headless: !argv.switches.has("headed") }),
    policyFrom(policy.success),
    evidenceFiles({
      root: EVIDENCE_ROOT,
      runId,
      sessionId,
      scrubber: secrets.scrubber,
      policy: "Sensitivity policy: every discovered parameter is sensitive (ADR-0008)."
    }),
    providerFor({ provider, model })
  )

  const trajectory = yield* discover({
    goal,
    entry,
    baseUrl,
    runId,
    sessionId,
    secrets,
    bounds,
    modelName: model
  }).pipe(Effect.provide(services))

  yield* report(trajectory, argv.switches.has("json"))

  // The whole point, when asked for: a successful run leaves a stored,
  // reviewable, callable Capability behind with nobody transcribing anything.
  //
  // Compiled here, in the process that did the run, because this is the only
  // place the values behind the parameters still exist — which is what lets all
  // three of the compiler's gates actually look for something. Compiling the
  // written-down trajectory later works too and `bun run compile` does it, but
  // that file has been scrubbed and two of the three gates go quiet. See
  // `compile-cli.ts`.
  const emitAs = argv.options["emit"]
  if (emitAs !== undefined && trajectory.conclusion.conclusion === "reached") {
    const compiled = compileArtifact(trajectory, {
      capability: emitAs,
      version: argv.options["artifactVersion"] ?? "1.0.0",
      ...(argv.options["product"] === undefined ? {} : { product: argv.options["product"] })
    })
    if (Result.isFailure(compiled)) {
      yield* Console.log("")
      yield* Console.error(`compilation refused for ${emitAs}:`)
      for (const reason of compiled.failure.reasons) yield* Console.error(`  - ${reason}`)
      process.exitCode = 1
    } else {
      const written = writeArtifact(ARTIFACTS_DIRECTORY, compiled.success)
      yield* Console.log("")
      if (Result.isFailure(written)) {
        yield* Console.error(written.failure.message)
        process.exitCode = 1
      } else {
        yield* Console.log(`artifact: ${written.success}`)
      }
    }
  }

  // Stuck is not a crash — it is the loop doing its job — but it is not a
  // completed one either, and a caller scripting this needs to be able to tell.
  if (trajectory.conclusion.conclusion !== "reached") process.exitCode = 1
})

Effect.runPromise(Effect.scoped(program)).catch((cause) => {
  console.error(String(cause))
  process.exitCode = 1
})
