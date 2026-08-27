/**
 * `bun run replay` — invoke a saved Capability by name with typed arguments.
 *
 *   bun run replay member.account-balance --memberId 12345
 *   bun run replay member.account-balance --memberId 12345 --accountType Checking
 *   bun run replay member.account-balance --memberId 22222   # a tenant whose
 *                                                            # labels differ
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
  prepareInputs,
  writeArtifact
} from "@cua/artifact"
import type { EvidenceUnwritable } from "@cua/evidence"
import { DEFAULT_OPERATOR_PORT, serveOperator } from "@cua/operator"
import {
  type CompiledPolicy,
  DEFAULT_POLICY,
  POLICIES_DIRECTORY,
  declassifierFor,
  describeUnsafeRepeat,
  listPolicies,
  loadPolicy,
  policyFrom,
  sensitivityPolicy,
  unsafeRepeats
} from "@cua/policy"
import {
  type InterventionRecord,
  DEFAULT_HANDOFF_WAIT_MILLIS,
  SessionControl,
  handoffSession,
  sessionControl
} from "@cua/session"
import { type SurfaceUnavailable, playwrightSurface } from "@cua/surface"
import { Console, Effect, Layer, Result } from "effect"
import type { Scope } from "effect/Scope"
import {
  type ReplayResult,
  evidenceForRun,
  proposeAmendment,
  replayCapability,
  scrubberFor
} from "./index.ts"

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
    `  --policy <name>   the policy in force (default: ${DEFAULT_POLICY}), by name or path`,
    "  --headed          watch it happen in a visible browser",
    "  --json            print the whole ReplayResult rather than a summary",
    "  --handoff         attend the run: start the operator interface, and pause",
    "                    for a person instead of failing when a checkpoint will",
    "                    not hold. Use with --headed; the operator works in that",
    "                    window. Without it the run is unattended and a stuck",
    "                    checkpoint is a hard failure, because nobody is watching",
    "  --operatorPort <n>       port for the operator interface (default 4180)",
    "  --handoffWait <seconds>  how long a paused run waits for someone",
    "  --noAmend         do not store what an intervention taught this capability.",
    "                    Without it, an operator answering yes to the one question",
    "                    at return-of-control cuts a new version and prints the diff",
    "  --amendTo <ver>   the version an amendment is cut as (default: next minor)",
    "  --expireSessionAfter <n>",
    "                    arm Heritage Core's one-shot session-expiry toggle after",
    "                    n page requests, to watch a mid-flow expiry be recovered",
    "                    from (ignored when --baseUrl points somewhere else)",
    "",
    "capabilities:",
    ...listCapabilities(ARTIFACTS_DIRECTORY).map((name) => `  ${name}`),
    "  (bun run catalog prints each one's inputs, outputs and the line to call it with)",
    "",
    "policies:",
    ...listPolicies(POLICIES_DIRECTORY).map((name) => `  ${name}`)
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

/**
 * Everything the CLI consumes itself, so the rest is the capability's inputs.
 *
 * Every set of switches is here: the policy selector, the two that configure a
 * handoff, and the one that arms Heritage Core's session-expiry toggle. A name
 * missing from this list is passed to the Artifact as an input and rejected as
 * undeclared, so forgetting one is loud.
 *
 * Note what is *not* here: `--operatorPassword`. That is a declared input of the
 * capability, sensitive like any other, and it reaches the browser through
 * `prepareInputs` rather than through the CLI.
 */
const RESERVED = new Set([
  "baseUrl",
  "version",
  "policy",
  "operatorPort",
  "handoffWait",
  "expireSessionAfter",
  "amendTo"
])

const report = (
  result: ReplayResult,
  policy: CompiledPolicy,
  asJson: boolean
): Effect.Effect<void> =>
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
        // A selection failure carries the code the artifact declared for it, and
        // that code is what a caller routes on — so it is printed rather than
        // left to be dug out of the JSON.
        if ("code" in result.failure) {
          yield* Console.log(`  escalate: ${result.failure.code}`)
        }
        yield* Console.log(`  expected: ${result.failure.expected}`)
        yield* Console.log(`  observed: ${result.failure.observed}`)
        break
    }

    yield* Console.log("")
    yield* Console.log("steps:")
    for (const step of result.steps) {
      const read = step.read === undefined ? "" : `  -> ${step.read}`
      // A step that held on the second attempt still held, and a caller reading
      // this should be able to see both facts at once.
      const recovered =
        step.recovered === undefined ? "" : `  (recovered from ${step.recovered})`
      yield* Console.log(`  [${step.checkpoint}] ${step.id}  ${step.intent}${read}${recovered}`)
    }
    yield* Console.log("")
    yield* Console.log(`policy:   ${policy.name} (${policy.source})`)
    yield* Console.log(`evidence: ${result.evidenceDirectory}`)
  })

/**
 * Store what the run's Interventions taught the Capability, and show the diff.
 *
 * ## Why this happens without a further confirmation
 *
 * Because the confirmation already happened. SPEC gives the operator interface
 * one question, asked of the person who had just resolved the state, and this is
 * what answering it *means*. A second "are you sure" at the terminal would put
 * the decision back with whoever launched the run — who has not seen the screen —
 * and turn a per-case judgement into an approval step, which is the upfront
 * policy ADR-0004 exists to avoid.
 *
 * What protects the store is not a prompt. It is that the change is confined to
 * one shape (`declareLearnedNoMatch`), lands in a *new immutable file* beside the
 * old one, and is printed as a diff the moment it is written. Nothing is
 * replaced, so nothing is lost, and the review the diff exists for happens before
 * anybody promotes the new version rather than before it is stored.
 *
 * `--noAmend` is there for the case where somebody is demonstrating the handoff
 * and does not want a version cut, not as a safety catch.
 */
const amend = (
  artifact: CapabilityArtifact,
  episodes: ReadonlyArray<InterventionRecord>,
  scrub: (text: string) => string,
  argv: Argv
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (argv.switches.has("noAmend")) return

    for (const record of episodes) {
      const proposal = proposeAmendment({
        artifact,
        record,
        scrub,
        ...(argv.options["amendTo"] === undefined
          ? {}
          : { version: argv.options["amendTo"] })
      })

      // Silent for the ordinary case. Most runs raise no Intervention, and most
      // Interventions teach nothing; saying so every time would train everyone
      // to stop reading the line that matters.
      if (proposal._tag === "Unchanged") continue

      if (proposal._tag === "Refused") {
        yield* Console.error("")
        yield* Console.error(`AMENDMENT REFUSED  ${proposal.refusal.message}`)
        yield* Console.error(
          "  the operator's answer was recorded in the evidence; the capability is unchanged"
        )
        continue
      }

      const stored = writeArtifact(ARTIFACTS_DIRECTORY, proposal.amended)
      if (Result.isFailure(stored)) {
        yield* Console.error("")
        yield* Console.error(`AMENDMENT NOT STORED  ${stored.failure.message}`)
        continue
      }

      yield* Console.log("")
      yield* Console.log(
        `LEARNED  ${proposal.amended.capability}@${proposal.amended.version} ` +
          `(${proposal.learnedClass})`
      )
      yield* Console.log(`  ${proposal.because}`)
      yield* Console.log(`  written to ${stored.success}`)
      yield* Console.log("")
      yield* Console.log(proposal.diff)
      yield* Console.log("")
      yield* Console.log(
        `  both sides above are rendered by the same formatter, so this is a diff of what ` +
          `the two versions mean rather than of how they are laid out`
      )
    }
  })

const run = (
  artifact: CapabilityArtifact,
  policy: CompiledPolicy,
  argv: Argv
): Effect.Effect<void, SurfaceUnavailable | EvidenceUnwritable, Scope> =>
  Effect.gen(function* () {
    // Pure, service-free, browser-free. A rejection here costs nothing.
    //
    // Policy's sensitivity allowlist is consulted here rather than inside the
    // engine, because this is the moment a value becomes a `ResolvedInput` and
    // its classification is fixed for the rest of the run. It ships empty
    // (ADR-0008), so every parameter comes out sensitive.
    const supplied = Object.fromEntries(
      Object.entries(argv.options).filter(([key]) => !RESERVED.has(key))
    )
    const inputs = prepareInputs(
      artifact.capability,
      artifact.inputs,
      supplied,
      declassifierFor(sensitivityPolicy, artifact.capability)
    )
    if (Result.isFailure(inputs)) {
      yield* Console.error(`bad call: ${inputs.failure.message}`)
      process.exitCode = 2
      return
    }

    const expireSessionAfter = argv.options["expireSessionAfter"]
    const baseUrl =
      argv.options["baseUrl"] ??
      (yield* serve({
        port: 0,
        ...(expireSessionAfter === undefined
          ? {}
          : { expireSessionAfter: Number(expireSessionAfter) })
      })).origin
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
    // Evidence for a run is built from the run's inputs, so the scrubber cannot
    // be left off by forgetting to pass one. It is a `const` rather than an
    // element of the merge below because `SessionControl` needs the *same*
    // writer: the parked run cannot record what an Operator did while it sleeps.
    const evidence = evidenceForRun({
      root: EVIDENCE_ROOT,
      runId,
      sessionId,
      inputs: inputs.success,
      policy: `Sensitivity policy: ${sensitivityPolicy.summary}`
    })
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
      policyFrom(policy),
      // One Ref underlies `Session` and `SessionControl`, and one Evidence
      // instance underlies both halves — `Layer.provideMerge` rather than two
      // `evidenceFiles` calls, which would be two writers appending to one file
      // with independent `seq` counters.
      handoffSession.pipe(Layer.provideMerge(control))
    )

    const ran = yield* Effect.gen(function* () {
      // Attaching the interface is what makes the run attended. An unattended
      // run has nobody to escalate to, so the engine reports a hard failure
      // rather than pausing for someone who is not coming.
      const control = yield* SessionControl
      if (attended) {
        const operator = yield* serveOperator({
          control,
          port: Number(argv.options["operatorPort"] ?? DEFAULT_OPERATOR_PORT)
        })
        yield* Console.log(`operator interface: ${operator.origin}`)
      }

      const result = yield* replayCapability({
        artifact,
        inputs: inputs.success,
        baseUrl,
        runId
      })

      // Every episode this Session closed, read once, after the run is over.
      // The interventions are the input to the amendment below and nothing else
      // in this file reads the Session, which is what keeps "what a person did"
      // out of the executor's decisions.
      return { result, episodes: (yield* control.snapshot).resolved }
    }).pipe(Effect.provide(services))

    const { result } = ran
    yield* report(result, policy, argv.switches.has("json"))
    yield* amend(artifact, ran.episodes, scrubberFor(inputs.success), argv)

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

  // An `at-step` recovery rule performs a Step's own Action a second time, so a
  // Capability whose Actions are risky has to say in writing why doing one twice
  // is safe. Asked here, before a browser is even requested, for the same reason
  // the inputs and the policy are: a document that cannot legally run should not
  // cost anyone a browser. `replayCapability` asks again as the backstop that
  // cannot be forgotten.
  const unsafe = unsafeRepeats(artifact.success)
  if (unsafe.length > 0) {
    yield* Console.error(
      [`cannot run ${argv.capability}:`, ...unsafe.map(describeUnsafeRepeat)].join("\n  ")
    )
    process.exitCode = 2
    return
  }

  // Resolved before anything opens, like the inputs and for the same reason: a
  // policy that does not load is a run that does not happen. There is no
  // unrestricted fallback to fall through to.
  const policy = loadPolicy(POLICIES_DIRECTORY, argv.options["policy"] ?? DEFAULT_POLICY)
  if (Result.isFailure(policy)) {
    yield* Console.error(`cannot run under this policy: ${policy.failure.message}`)
    process.exitCode = 2
    return
  }

  yield* run(artifact.success, policy.success, argv)
})

Effect.runPromise(Effect.scoped(program)).catch((cause) => {
  console.error(String(cause))
  process.exitCode = 1
})
