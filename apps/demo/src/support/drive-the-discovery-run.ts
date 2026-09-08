/**
 * One genuine discovery, its exact saved artifact, deterministic replay, and a
 * learned exceptional outcome. Every invocation reserves new evidence and new
 * immutable artifact versions before opening a browser or contacting a model.
 *
 * bun run apps/demo/src/support/drive-the-discovery-run.ts [--version 1.3.0] [--run-id review-1]
 */
import { createHash, randomUUID } from "node:crypto"
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  DEFAULT_BOUNDS, DEFAULT_PROVIDER, discoveryRun, providerFor
} from "@cua/agent"
import {
  ARTIFACTS_DIRECTORY, CapabilityArtifactSchema, describeOutputValue, formatArtifact, listVersions, loadArtifact,
  nextMinorVersion, writeArtifact
} from "@cua/artifact"
import { serve } from "@cua/legacy-core"
import {
  DEFAULT_POLICY, POLICIES_DIRECTORY, loadPolicy,
  heritagePublicGoalTerms, originAuthorizer, policyFrom
} from "@cua/policy"
import { automationOwnedSession } from "@cua/session"
import { playwrightSurface } from "@cua/surface"
import { Effect, Layer, Result, Schema } from "effect"
import { attendedReplay } from "./handoff-harness.ts"
import { replay } from "./replay-harness.ts"
import { scanForSecrets } from "./secret-scan.ts"

const GOAL = "Look up the savings account balance of member 12345"
const MODEL = "gpt-4.1"
const CAPABILITY = "member.account-balance.discovered"
const EVIDENCE_ROOT = "evidence/discovery"

/** Pure preflight, also used by the collision regression test. */
export const planDiscoveryRun = (options: {
  readonly version?: string
  readonly runId?: string
  readonly artifactsRoot?: string
  readonly evidenceRoot?: string
}) => {
  const artifactsRoot = options.artifactsRoot ?? ARTIFACTS_DIRECTORY
  const evidenceRoot = options.evidenceRoot ?? EVIDENCE_ROOT
  const version = options.version ?? nextMinorVersion(listVersions(artifactsRoot, CAPABILITY)[0] ?? "1.0.0")
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("version must be MAJOR.MINOR.PATCH")
  const learnedVersion = nextMinorVersion(version)
  const runId = options.runId ?? `live-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(runId)) throw new Error("run-id must be a plain directory name")
  const out = join(evidenceRoot, runId)
  for (const candidate of [version, learnedVersion, nextMinorVersion(learnedVersion), nextMinorVersion(nextMinorVersion(learnedVersion))]) {
    const path = join(artifactsRoot, CAPABILITY, `${candidate}.yaml`)
    if (existsSync(path)) throw new Error(`Immutable artifact collision: ${path}. Choose a new --version.`)
  }
  if (existsSync(out)) throw new Error(`Evidence run already exists: ${out}. Choose a new --run-id.`)
  return { artifactsRoot, evidenceRoot, version, learnedVersion, runId, out }
}

const say = (line: string) => process.stdout.write(`${line}\n`)
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

export const driveDiscoveryRun = (options: Parameters<typeof planDiscoveryRun>[0] = {}) =>
  Effect.gen(function* () {
    // Any collision is fatal before the provider is constructed or the UI opened.
    const plan = planDiscoveryRun(options)
    mkdirSync(plan.evidenceRoot, { recursive: true })
    mkdirSync(plan.out)
    const policy = loadPolicy(POLICIES_DIRECTORY, DEFAULT_POLICY)
    if (Result.isFailure(policy)) throw new Error(policy.failure.message)
    const baseUrl = (yield* serve({ port: 0 })).origin
    const sessionId = randomUUID()
    say(`model: ${MODEL}; capability: ${CAPABILITY}@${plan.version}; evidence: ${plan.out}`)
    const workflow = yield* discoveryRun({
      goal: GOAL, entry: "/", baseUrl, runId: "discovery", sessionId,
      evidence: { root: plan.out, allowUnredactedScreenshots: true,
        policy: "Every discovered parameter is sensitive; raw goals are never persisted." },
      compilation: { capability: CAPABILITY, version: plan.version,
        product: "Heritage Core Member Services (MSS 4.02.11)" },
      bounds: DEFAULT_BOUNDS, publicGoalTerms: heritagePublicGoalTerms, modelName: MODEL, providerName: DEFAULT_PROVIDER
    })
    const result = yield* workflow.execute.pipe(Effect.provide(Layer.mergeAll(
      playwrightSurface({ headless: true, authorizeOrigin: originAuthorizer(policy.success) }),
      policyFrom(policy.success),
      automationOwnedSession(sessionId),
      providerFor({ provider: DEFAULT_PROVIDER, model: MODEL })
    )))
    if (result.diagnostics.conclusion !== "reached") {
      throw new Error(`Discovery stopped: ${result.diagnostics.conclusion}; evidence: ${plan.out}`)
    }
    if (result.compilation.status !== "compiled") {
      const reasons = result.compilation.status === "refused" ? `: ${result.compilation.reasons.join("; ")}` : ""
      throw new Error(`Discovery compilation was not stored (${result.compilation.status})${reasons}`)
    }
    say(`Discovery reached the goal in ${result.diagnostics.steps.length} steps and compiled the recorded flow.`)
    const compilation = result.compilation.stored
    const written = writeArtifact(plan.artifactsRoot, compilation.artifact)
    if (Result.isFailure(written)) throw new Error(written.failure.message)
    const stored = loadArtifact(plan.artifactsRoot, CAPABILITY, plan.version)
    if (Result.isFailure(stored)) throw new Error(stored.failure.message)
    copyFileSync(written.success, join(plan.out, `${plan.version}.yaml`))
    writeFileSync(join(plan.out, "compilation.json"), JSON.stringify(compilation, null, 2) + "\n", { flag: "wx" })

    writeSourceReceipt(plan.out, plan.artifactsRoot)
    return yield* resumeDiscoveryEvidence(plan.out)
  }).pipe(Effect.scoped)

const SourceReceipt = Schema.Struct({
  format: Schema.Literal("discovery-source-v1"),
  artifactsRoot: Schema.String,
  version: Schema.String,
  sha256: Schema.String
})
const CompilationReceipt = Schema.Struct({
  format: Schema.Literal("discovery-compilation-v1"),
  verification: Schema.Literal("checked-in-memory-before-erasing-private-context"),
  artifact: CapabilityArtifactSchema
})

/** Verify the three saved representations before trusting a resumable run. */
const verifiedSource = (directory: string, artifactsRoot: string) => {
  const compilation = Schema.decodeUnknownSync(CompilationReceipt)(JSON.parse(readFileSync(join(directory, "compilation.json"), "utf8")))
  if (compilation.artifact.capability !== CAPABILITY) throw new Error("Unexpected capability in discovery receipt")
  const version = compilation.artifact.version
  const stored = loadArtifact(artifactsRoot, CAPABILITY, version)
  if (Result.isFailure(stored)) throw new Error(stored.failure.message)
  const path = join(artifactsRoot, CAPABILITY, `${version}.yaml`)
  const copy = join(directory, `${version}.yaml`)
  if (readFileSync(path, "utf8") !== readFileSync(copy, "utf8") ||
      formatArtifact(compilation.artifact) !== formatArtifact(stored.success)) {
    throw new Error("Discovery source mismatch: receipt, evidence copy and stored artifact must agree")
  }
  return { version, stored, path, sha256: hash(path) }
}

// Retained receipts name the former default store. Resolve its new location
// without changing the recorded path or relaxing the artifact digest checks.
const receiptStore = (recorded: string): string =>
  recorded === "artifacts" && !existsSync(recorded) ? ARTIFACTS_DIRECTORY : recorded

/** Older interrupted runs can acquire a receipt only after the same checks. */
const writeSourceReceipt = (directory: string, artifactsRoot = ARTIFACTS_DIRECTORY, lookupRoot = artifactsRoot) => {
  const verified = verifiedSource(directory, lookupRoot)
  const path = join(directory, "source.json")
  if (existsSync(path)) {
    const receipt = Schema.decodeUnknownSync(SourceReceipt)(JSON.parse(readFileSync(path, "utf8")))
    if (receipt.sha256 !== verified.sha256 || receipt.version !== verified.version || receipt.artifactsRoot !== artifactsRoot) {
      throw new Error("Discovery source digest changed since it was recorded")
    }
    return receipt
  }
  const receipt = { format: "discovery-source-v1", artifactsRoot, version: verified.version, sha256: verified.sha256 }
  writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" })
  return receipt
}

/** Append a fresh deterministic completion attempt; never rediscover or overwrite. */
export const resumeDiscoveryEvidence = (directory: string) => Effect.gen(function* () {
    const receiptPath = join(directory, "source.json")
    const recordedArtifactsRoot = existsSync(receiptPath)
      ? Schema.decodeUnknownSync(SourceReceipt)(JSON.parse(readFileSync(receiptPath, "utf8"))).artifactsRoot
      : ARTIFACTS_DIRECTORY
    const artifactsRoot = receiptStore(recordedArtifactsRoot)
    const receipt = writeSourceReceipt(directory, recordedArtifactsRoot, artifactsRoot)
    if (existsSync(join(directory, "manifest.json"))) {
      say(`Discovery evidence is already complete: ${directory}`)
      return
    }
    const source = verifiedSource(directory, artifactsRoot)
    const stored = source.stored
    const writtenPath = source.path
    const completion = `completion-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
    const completionOut = join(directory, completion)
    mkdirSync(completionOut)
    const plan = { artifactsRoot, version: receipt.version, learnedVersion: nextMinorVersion(listVersions(artifactsRoot, CAPABILITY)[0] ?? receipt.version), runId: directory.split("/").at(-1) ?? "resumed" }
    if (existsSync(join(artifactsRoot, CAPABILITY, `${plan.learnedVersion}.yaml`))) throw new Error("Learned artifact version already exists")
    copyFileSync(source.path, join(completionOut, `${plan.version}.yaml`))
    say(`Saved ${CAPABILITY}@${plan.version}; replaying the exact stored artifact.`)
    const happy = yield* replay({
      artifact: stored.success, inputs: { memberId: "12345" }, runId: "replay"
    })
    cpSync(happy.evidenceDirectory, join(completionOut, "replay"), { recursive: true, errorOnExist: true, force: false })
    if (happy.result.result !== "success") throw new Error(`Fresh artifact replay failed: ${happy.result.result}`)

    say("Fresh artifact replay succeeded; exercising its exceptional-state handoff.")
    // The model discovered this selection. A scripted operator judges a real
    // no-match screen through the same HTTP ownership protocol used by people.
    const episode = yield* attendedReplay({
      artifact: stored.success, inputs: { memberId: "88888" }, runId: "intervention",
      operate: (desk) => Effect.gen(function* () {
        const paused = yield* desk.awaitPause
        const step = stored.success.steps.find((candidate) => candidate.id === paused.pending?.intervention.stepId)
        if (step?.action.type !== "selectFromList") throw new Error("Expected the discovered selection to be the stuck step")
        const screen = yield* desk.surface.observe
        if (!JSON.stringify(screen).includes("Checking")) throw new Error("Expected the real checking-only fixture screen")
        const taken = yield* desk.post("/take", { operator: "demo.operator" })
        if (taken.status !== 303) throw new Error(`Operator take refused: ${taken.status}`)
        const returned = yield* desk.post("/return", {
          operator: "demo.operator", classification: "unresolved",
          detail: "Reviewed the complete account list without acting. Only a checking account is available; no matching account can be opened.",
          nextTime: "automation_handles_it"
        })
        if (returned.status !== 303) throw new Error(`Operator return refused: ${returned.status}`)
      })
    })
    cpSync(episode.evidenceDirectory, join(completionOut, "intervention"), { recursive: true, errorOnExist: true, force: false })
    const record = episode.snapshot.resolved[0]
    if (record === undefined || record.actions.length !== 0) throw new Error("Expected an observational intervention record")
    const learning = episode.learning[0]
    if (learning === undefined) throw new Error("Expected captured learning")
    const proposal = learning.amendment({ directory: plan.artifactsRoot, version: plan.learnedVersion })
    if (proposal._tag !== "Amended") throw new Error(`Learning did not produce an amendment: ${proposal._tag}`)
    say(`The observed intervention produced a ${proposal.learnedClass} amendment; replaying its saved version.`)
    const learned = loadArtifact(plan.artifactsRoot, CAPABILITY, plan.learnedVersion)
    if (Result.isFailure(learned)) throw new Error(learned.failure.message)
    copyFileSync(proposal.path, join(completionOut, `${plan.learnedVersion}.yaml`))
    writeFileSync(join(completionOut, "amendment.diff"), proposal.diff + "\n", { flag: "wx" })
    const exceptional = yield* replay({
      artifact: learned.success, inputs: { memberId: "88888" }, runId: "replay-learned-outcome"
    })
    cpSync(exceptional.evidenceDirectory, join(completionOut, "replay-learned-outcome"), { recursive: true, errorOnExist: true, force: false })
    if (exceptional.result.result !== "business_outcome") throw new Error(`Learned replay did not report a business outcome: ${exceptional.result.result}`)
    const learnedHappy = yield* replay({
      artifact: learned.success, inputs: { memberId: "12345" }, runId: "replay-learned-success"
    })
    cpSync(learnedHappy.evidenceDirectory, join(completionOut, "replay-learned-success"), { recursive: true, errorOnExist: true, force: false })
    if (learnedHappy.result.result !== "success") throw new Error(`Learned artifact lost successful replay: ${learnedHappy.result.result}`)
    let finalArtifact = learned.success
    const checkpointLessons: Array<{ code: string; version: string; artifact: string; sha256: string; intervention: string; diff: string }> = []
    for (const sample of [
      { name: "member-not-found", input: "99999", code: "MEMBER_NOT_FOUND", title: "No member exists for that number", text: "Member Not Found" },
      { name: "input-validation", input: "BAD-INPUT", code: "INPUT_VALIDATION_ERROR", title: "The member number has an invalid format", text: "Member number must contain only digits." }
    ]) {
      say(`Observing and learning the ${sample.code} checkpoint answer on the same discovered capability.`)
      const episode = yield* attendedReplay({
        artifact: finalArtifact, inputs: { memberId: sample.input }, runId: `learn-${sample.name}`,
        operate: (desk) => Effect.gen(function* () {
          yield* desk.awaitPause
          const taken = yield* desk.post("/take", { operator: "demo.operator" })
          if (taken.status !== 303) throw new Error("Operator take was refused")
          const returned = yield* desk.post("/return", {
            operator: "demo.operator", classification: "unresolved", detail: sample.title,
            nextTime: "automation_handles_it"
          })
          if (returned.status !== 303) throw new Error("Operator return was refused")
        })
      })
      cpSync(episode.evidenceDirectory, join(completionOut, `learn-${sample.name}`), { recursive: true, errorOnExist: true, force: false })
      const record = episode.snapshot.resolved[0]
      if (record === undefined) throw new Error("Expected a completed checkpoint intervention")
      const learning = episode.learning[0]
      if (learning === undefined) throw new Error("Expected captured checkpoint learning")
      const amended = learning.amendment({ directory: plan.artifactsRoot, confirmedOutcome: sample })
      if (amended._tag !== "Amended") throw new Error(`Checkpoint learning refused: ${amended._tag}`)
      const loaded = loadArtifact(plan.artifactsRoot, CAPABILITY, amended.amended.version)
      if (Result.isFailure(loaded)) throw new Error(loaded.failure.message)
      finalArtifact = loaded.success
      copyFileSync(amended.path, join(completionOut, `${finalArtifact.version}.yaml`))
      writeFileSync(join(completionOut, `${sample.name}.diff`), amended.diff + "\n", { flag: "wx" })
      checkpointLessons.push({ code: sample.code, version: finalArtifact.version,
        artifact: `${finalArtifact.version}.yaml`, sha256: hash(amended.path),
        intervention: `learn-${sample.name}/events.jsonl`, diff: `${sample.name}.diff` })
    }
    const finalReplays: Array<{ name: string; events: string; result: string; code?: string }> = []
    for (const sample of [
      { name: "success", input: "12345", code: "SUCCESS" },
      { name: "no-matching-account", input: "88888", code: exceptional.result.code },
      { name: "member-not-found", input: "99999", code: "MEMBER_NOT_FOUND" },
      { name: "input-validation", input: "BAD-INPUT", code: "INPUT_VALIDATION_ERROR" }
    ]) {
      const runId = `final-${sample.name}`
      const replayed = yield* replay({ artifact: finalArtifact, inputs: { memberId: sample.input }, runId })
      cpSync(replayed.evidenceDirectory, join(completionOut, runId), { recursive: true, errorOnExist: true, force: false })
      if (sample.code === "SUCCESS" ? replayed.result.result !== "success"
          : replayed.result.result !== "business_outcome" || replayed.result.code !== sample.code) {
        throw new Error(`Final discovered capability did not produce ${sample.code}`)
      }
      finalReplays.push({ name: sample.name, events: `${runId}/events.jsonl`, result: replayed.result.result,
        ...(replayed.result.result === "business_outcome" ? { code: replayed.result.code } : {}) })
    }
    const outputs = Object.fromEntries(Object.entries(happy.result.outputs).map(([key, value]) => [key, describeOutputValue(value)]))
    writeFileSync(join(completionOut, "manifest.json"), JSON.stringify({
      runId: plan.runId, provider: DEFAULT_PROVIDER, model: MODEL,
      discovery: { events: "../discovery/events.jsonl" },
      compiled: { path: writtenPath, copy: `${plan.version}.yaml`, sha256: hash(writtenPath) },
      replay: { events: "replay/events.jsonl", result: happy.result.result, outputs },
      learning: { events: "intervention/events.jsonl", operator: "scripted demonstration over real HTTP session handoff", learnedClass: proposal.learnedClass },
      amended: { path: proposal.path, copy: `${plan.learnedVersion}.yaml`, sha256: hash(proposal.path), diff: "amendment.diff" },
      exceptionalReplay: { events: "replay-learned-outcome/events.jsonl", result: exceptional.result.result, code: exceptional.result.code },
      amendedHappyReplay: { events: "replay-learned-success/events.jsonl", result: learnedHappy.result.result },
      checkpointLessons,
      finalCapability: { version: finalArtifact.version, artifact: `${finalArtifact.version}.yaml` },
      finalReplays
    }, null, 2) + "\n", { flag: "wx" })
    writeFileSync(join(completionOut, "README.txt"), [
      "A real model discovered the account-balance capability against the live local fixture.",
      `Provider: ${DEFAULT_PROVIDER}; model: ${MODEL}.`,
      "The raw goal and member identifiers are private. ../compilation.json contains the checked artifact only.",
      "The exact newly saved artifact is copied here and its SHA-256 is recorded in manifest.json.",
      "replay/ records deterministic success without a model.",
      "intervention/ records a real same-session handoff; the operator's judgment is scripted and explicitly labeled.",
      "amendment.diff was derived by proposeAmendment from that intervention, not handwritten.",
      "replay-learned-outcome/ and replay-learned-success/ run the same amended discovered capability without a model.",
      "Two further real checkpoint interventions confirm exact visible public answers; their amendments add not-found and validation outcomes.",
      "final-*/ records success and all three business outcomes from the same final discovered artifact, without a model or operator.",
      "Each subdirectory contains the writer's own redaction and capture policy.",
      "Prior evidence and artifact versions were retained unchanged.", ""
    ].join("\n"), { flag: "wx" })
    const leaks = scanForSecrets(completionOut, ["12345", "88888", "99999", "BAD-INPUT"])
    if (leaks.length !== 0) throw new Error(`Privacy scan failed in ${leaks.length} text locations`)
    writeFileSync(join(directory, "manifest.json"), JSON.stringify({
      source: "source.json", sha256: receipt.sha256,
      discovery: "discovery/events.jsonl", compilation: "compilation.json",
      completion: `${completion}/manifest.json`,
      note: "Prior attempt evidence was retained; this completion reused the verified discovery artifact without a model."
    }, null, 2) + "\n", { flag: "wx" })
    say(`Saved ${CAPABILITY}@${plan.version}, learned through @${finalArtifact.version}; success and three business outcomes; evidence: ${directory}`)
  }).pipe(Effect.scoped)

if (import.meta.main) {
  const args = process.argv.slice(2)
  const options: { version?: string; runId?: string } = {}
  let resume: string | undefined
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]
    const value = args[i + 1]
    if (value === undefined || (name !== "--version" && name !== "--run-id" && name !== "--resume")) throw new Error("Usage: drive-the-discovery-run.ts [--version X.Y.Z] [--run-id NAME] [--resume DIRECTORY]")
    if (name === "--version") options.version = value
    else if (name === "--run-id") options.runId = value
    else resume = value
  }
  // Report only controlled preflight diagnostics; provider failures may carry private input.
  try {
    if (resume === undefined) planDiscoveryRun(options)
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : "Invalid discovery run options")
    process.exit(1)
  }
  Effect.runPromise(resume === undefined ? driveDiscoveryRun(options) : resumeDiscoveryEvidence(resume)).catch(() => {
    console.error("Discovery evidence run failed. Existing evidence is retained; inspect the current run's events.")
    process.exitCode = 1
  })
}
