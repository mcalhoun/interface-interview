import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { planDiscoveryRun } from "../apps/demo/src/support/drive-the-discovery-run.ts"

describe("live evidence driver preflight", () => {
  const roots = () => {
    const root = mkdtempSync(join(tmpdir(), "cua-discovery-plan-"))
    return { artifactsRoot: join(root, "artifacts"), evidenceRoot: join(root, "evidence") }
  }

  it("rejects existing immutable versions without changing their bytes", () => {
    const options = roots()
    const directory = join(options.artifactsRoot, "member.account-balance.discovered")
    mkdirSync(directory, { recursive: true })
    const artifact = join(directory, "1.3.0.yaml")
    writeFileSync(artifact, "retained original artifact")
    expect(() => planDiscoveryRun({ ...options, version: "1.3.0" })).toThrow("Immutable artifact collision")
    expect(readFileSync(artifact, "utf8")).toBe("retained original artifact")
  })

  it("also rejects a collision in the learned version before any discovery starts", () => {
    const options = roots()
    const directory = join(options.artifactsRoot, "member.account-balance.discovered")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "1.4.0.yaml"), "existing learned artifact")
    expect(() => planDiscoveryRun({ ...options, version: "1.3.0" })).toThrow("Immutable artifact collision")
  })

  it("preserves existing evidence and generates different run IDs", () => {
    const options = roots()
    const directory = join(options.evidenceRoot, "prior-run")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "events.jsonl"), "original evidence")
    expect(() => planDiscoveryRun({ ...options, runId: "prior-run" })).toThrow("Evidence run already exists")
    expect(readFileSync(join(directory, "events.jsonl"), "utf8")).toBe("original evidence")
    expect(planDiscoveryRun(options).runId).not.toBe(planDiscoveryRun(options).runId)
  })

  it("chooses versions newer than every stored run and rejects unsafe path inputs", () => {
    const options = roots()
    const directory = join(options.artifactsRoot, "member.account-balance.discovered")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "1.12.0.yaml"), "prior")
    expect(planDiscoveryRun(options)).toMatchObject({ version: "1.13.0", learnedVersion: "1.14.0" })
    expect(() => planDiscoveryRun({ ...options, runId: "../prior" })).toThrow("plain directory name")
    expect(() => planDiscoveryRun({ ...options, version: "../1.0.0" })).toThrow("MAJOR.MINOR.PATCH")
  })
})

describe("resuming recorded discovery", () => {
  it("rejects a modified evidence copy before any replay and preserves it", async () => {
    const { createHash } = await import("node:crypto")
    const { Effect, Result } = await import("effect")
    const { loadArtifact } = await import("@cua/artifact")
    const { resumeDiscoveryEvidence } = await import("../apps/demo/src/support/drive-the-discovery-run.ts")
    const root = mkdtempSync(join(tmpdir(), "cua-discovery-resume-"))
    const artifactsRoot = join(root, "artifacts")
    const directory = join(root, "run")
    const capability = "member.account-balance.discovered"
    const yaml = readFileSync(join("artifacts", capability, "1.0.0.yaml"), "utf8")
    const artifact = loadArtifact("artifacts", capability, "1.0.0")
    if (Result.isFailure(artifact)) throw artifact.failure
    mkdirSync(join(artifactsRoot, capability), { recursive: true })
    mkdirSync(directory)
    writeFileSync(join(artifactsRoot, capability, "1.0.0.yaml"), yaml)
    const copy = join(directory, "1.0.0.yaml")
    writeFileSync(copy, yaml + "\n# tampered copy\n")
    writeFileSync(join(directory, "compilation.json"), JSON.stringify({
      format: "discovery-compilation-v1", verification: "checked-in-memory-before-erasing-private-context", artifact: artifact.success
    }))
    const receipt = JSON.stringify({ format: "discovery-source-v1", artifactsRoot, version: "1.0.0", sha256: createHash("sha256").update(yaml).digest("hex") })
    writeFileSync(join(directory, "source.json"), receipt)
    await expect(Effect.runPromise(resumeDiscoveryEvidence(directory))).rejects.toThrow("source mismatch")
    expect(readFileSync(copy, "utf8")).toBe(yaml + "\n# tampered copy\n")
    expect(readFileSync(join(directory, "source.json"), "utf8")).toBe(receipt)
    writeFileSync(copy, yaml)
    writeFileSync(join(directory, "source.json"), JSON.stringify({ format: "discovery-source-v1", artifactsRoot, version: "1.0.0", sha256: "wrong" }))
    await expect(Effect.runPromise(resumeDiscoveryEvidence(directory))).rejects.toThrow("digest changed")
  })
})
