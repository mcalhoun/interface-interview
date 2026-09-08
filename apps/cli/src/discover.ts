import { commandArguments, numberOption } from "./arguments.ts"
import { heritagePublicGoalTerms, originAuthorizer } from "@cua/policy"
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
  discoveryRun,
  isProviderName,
  providerFor
} from "@cua/agent"
import type { DiscoveryDiagnostics } from "@cua/agent"
import { ARTIFACTS_DIRECTORY, writeArtifact } from "@cua/artifact"
import { serve } from "@cua/legacy-core"
import { DEFAULT_OPERATOR_PORT, serveOperator } from "@cua/operator"
import { DEFAULT_HANDOFF_WAIT_MILLIS, SessionControl, automationOwnedSession, handoffSession, sessionControl } from "@cua/session"
import { Evidence } from "@cua/evidence"
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
    "  --json            print a checked compilation envelope for bun run compile",
    "  --handoff         pause for an operator on the same live session when stuck",
    "  --operatorPort <n> operator interface port (default: 4180)",
    "  --handoffWait <s>  how long a paused run waits for an operator",
    "  --emit <name>     on success, compile the run into a stored Capability",
    "                    Artifact under that name and write it to config/capabilities/",
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


const report = (diagnostics: DiscoveryDiagnostics): Effect.Effect<void> => Console.log([
  `${diagnostics.conclusion.toUpperCase()} in ${diagnostics.steps.length} steps`,
  diagnostics.summary,
  ...diagnostics.steps.map((step) => `  ${step.id}: ${step.intent}`),
  `evidence: ${diagnostics.evidenceDirectory}`
].join("\n"))

const program = Effect.gen(function*() {
  const argv = commandArguments({ switches: ['headed', 'json', 'help', 'handoff'], options: ['entry', 'baseUrl', 'policy', 'model', 'provider', 'maxSteps', 'maxSeconds', 'emit', 'artifactVersion', 'product', 'operatorPort', 'handoffWait'], maxPositionals: 1 })
  if (argv.switches.has("help") || argv.positionals[0] === undefined) {
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

  const goal = argv.positionals[0]
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
  const maxSteps = numberOption(argv, "maxSteps", { minimum: 1, integer: true })
  const maxSeconds = numberOption(argv, "maxSeconds", { minimum: 0.001 })
  const operatorPort = numberOption(argv, "operatorPort", { integer: true, maximum: 65535 }) ?? DEFAULT_OPERATOR_PORT
  const handoffWait = numberOption(argv, "handoffWait", { minimum: 0.001 })
  const baseUrl = argv.options["baseUrl"] ?? (yield* serve({ port: 0 })).origin
  const runId = `discover-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${
    randomUUID().slice(0, 8)
  }`
  const sessionId = randomUUID()

  const bounds = {
    ...DEFAULT_BOUNDS,
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(maxSeconds !== undefined ? { maxMillis: maxSeconds * 1000 } : {})
  }

  yield* Console.error(`model: ${model} (${provider}); policy: ${policy.success.name}`)

  const common = Layer.mergeAll(
    playwrightSurface({ headless: !argv.switches.has("headed"), authorizeOrigin: originAuthorizer(policy.success) }),
    policyFrom(policy.success),
    providerFor({ provider, model })
  )
  const asJson = argv.switches.has("json")
  const emitAs = argv.options["emit"]
  const workflow = yield* discoveryRun({
    goal, entry, baseUrl, runId, sessionId, bounds,
    modelName: model, providerName: provider, publicGoalTerms: heritagePublicGoalTerms,
    evidence: {
      root: EVIDENCE_ROOT,
      allowUnredactedScreenshots: argv.options["baseUrl"] === undefined,
      policy: "Sensitive goal and parameter values are removed from persisted diagnostics."
    },
    ...(asJson || emitAs !== undefined ? { compilation: {
      capability: emitAs ?? "discovered.capability",
      version: argv.options["artifactVersion"] ?? "1.0.0",
      ...(argv.options["product"] === undefined ? {} : { product: argv.options["product"] })
    } } : {})
  })
  const execution = workflow.execute
  const controlled = sessionControl({
    sessionId, waitMillis: handoffWait === undefined ? DEFAULT_HANDOFF_WAIT_MILLIS : handoffWait * 1000,
    announce: (intervention, operatorUrl) => Effect.gen(function* () {
      const evidence = yield* Evidence
      yield* Console.error([
      `PAUSED: ${evidence.scrub(intervention.reason)}`,
      `  take control at ${operatorUrl}`,
      argv.switches.has("headed") ? "  use the existing Playwright browser window" : "  restart with --headed for direct browser interaction"
    ].join("\n"))
    }).pipe(Effect.provide(workflow.evidence))
  }).pipe(Layer.provideMerge(workflow.evidence))
  const result = argv.switches.has("handoff")
    ? yield* Effect.gen(function* () {
      const control = yield* SessionControl
      const operator = yield* serveOperator({ control, port: operatorPort })
      yield* Console.error(`operator interface: ${operator.url}`)
      return yield* execution
    }).pipe(Effect.provide(Layer.mergeAll(common, handoffSession.pipe(Layer.provideMerge(controlled)))))
    : yield* execution.pipe(Effect.provide(Layer.mergeAll(common, automationOwnedSession(sessionId))))

  if (result.compilation.status === "refused") {
    yield* Console.error("compilation refused; see the redacted discovery evidence")
    for (const reason of result.compilation.reasons) yield* Console.error(reason)
    process.exitCode = 1
  } else if (result.compilation.status === "compiled") {
    if (emitAs !== undefined) {
      const written = writeArtifact(ARTIFACTS_DIRECTORY, result.compilation.stored.artifact)
      if (Result.isFailure(written)) {
        yield* Console.error(written.failure.message)
        process.exitCode = 1
      } else yield* Console.error(`artifact: ${written.success}`)
    }
    if (asJson) yield* Console.log(JSON.stringify(result.compilation.stored, undefined, 2))
  }
  if (!asJson) yield* report(result.diagnostics)
  else if (result.diagnostics.conclusion !== "reached") {
    yield* Console.log(JSON.stringify(result.diagnostics, undefined, 2))
  }

  // Stuck is not a crash — it is the loop doing its job — but it is not a
  // completed one either, and a caller scripting this needs to be able to tell.
  if (result.diagnostics.conclusion !== "reached") process.exitCode = 1
})

Effect.runPromise(Effect.scoped(program)).catch(() => {
  console.error("Discovery could not start or finish. Check the provider credentials, policy and evidence directory.")
  process.exitCode = 1
})
