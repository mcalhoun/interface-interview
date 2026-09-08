import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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
    const yaml = readFileSync(join("config/capabilities", capability, "1.0.0.yaml"), "utf8")
    const artifact = loadArtifact("config/capabilities", capability, "1.0.0")
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

it("resolves the recorded default store after relocation without changing receipt bytes", async () => {
  const { Effect } = await import("effect")
  const { resumeDiscoveryEvidence } = await import("../apps/demo/src/support/drive-the-discovery-run.ts")
  const original = "evidence/discovery/live-2026-09-08T14-45-52-190Z-132a40d2"
  const directory = mkdtempSync(join(tmpdir(), "cua-relocated-discovery-"))
  try {
    for (const name of ["source.json", "compilation.json", "manifest.json"]) {
      copyFileSync(join(original, name), join(directory, name))
    }
    const copy = join(directory, "1.5.0.yaml")
    copyFileSync("config/capabilities/member.account-balance.discovered/1.5.0.yaml", copy)
    await Effect.runPromise(resumeDiscoveryEvidence(directory))
    for (const name of ["source.json", "compilation.json", "manifest.json"]) {
      expect(readFileSync(join(directory, name), "utf8")).toBe(readFileSync(join(original, name), "utf8"))
    }
    writeFileSync(copy, readFileSync(copy, "utf8") + "\n# tampered copy\n")
    await expect(Effect.runPromise(resumeDiscoveryEvidence(directory))).rejects.toThrow("source mismatch")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each([
  { legacy: "empty", current: "matching", succeeds: true },
  { legacy: "stale", current: "matching", succeeds: true },
  { legacy: "matching", current: "stale", succeeds: true },
  { legacy: "stale", current: "stale", succeeds: false }
])("checks historical discovery with $legacy legacy and $current current stores", async ({ legacy, current: currentState, succeeds }) => {
  const root = mkdtempSync(join(tmpdir(), "cua-leftover-store-"))
  const original = "evidence/discovery/live-2026-09-08T14-45-52-190Z-132a40d2"
  const capability = "member.account-balance.discovered"
  const current = join(root, "config/capabilities", capability)
  const old = join(root, "artifacts", capability)
  const directory = join(root, "run")
  try {
    for (const path of [current, old, directory]) mkdirSync(path, { recursive: true })
    for (const name of ["source.json", "compilation.json", "manifest.json"]) {
      copyFileSync(join(original, name), join(directory, name))
    }
    const source = join("config/capabilities", capability, "1.5.0.yaml")
    copyFileSync(source, join(current, "1.5.0.yaml"))
    copyFileSync(source, join(directory, "1.5.0.yaml"))
    if (legacy === "matching") copyFileSync(source, join(old, "1.5.0.yaml"))
    if (legacy === "stale") writeFileSync(join(old, "1.5.0.yaml"), readFileSync(source, "utf8") + "\n# stale copy\n")
    if (currentState === "stale") writeFileSync(join(current, "1.5.0.yaml"), readFileSync(source, "utf8") + "\n# stale copy\n")
    const child = Bun.spawn([process.execPath, resolve("apps/demo/src/support/drive-the-discovery-run.ts"), "--resume", directory], {
      cwd: root, stdout: "pipe", stderr: "pipe"
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
    ])
    expect(exitCode, stderr).toBe(succeeds ? 0 : 1)
    if (succeeds) expect(stdout).toContain("already complete")
    else {
      expect(stderr).toContain("Discovery evidence run failed")
      const probe = Bun.spawn([process.execPath, "--eval", `
        import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))}
        import { resumeDiscoveryEvidence } from ${JSON.stringify(resolve("apps/demo/src/support/drive-the-discovery-run.ts"))}
        await Effect.runPromise(resumeDiscoveryEvidence(${JSON.stringify(directory)}))
      `], { cwd: root, stdout: "pipe", stderr: "pipe" })
      const [probeExit, , probeError] = await Promise.all([
        probe.exited, new Response(probe.stdout).text(), new Response(probe.stderr).text()
      ])
      expect(probeExit).toBe(1)
      expect(probeError).toContain("neither capability store matches the recorded source and digest")
    }
    expect(readFileSync(join(directory, "source.json"), "utf8")).toBe(readFileSync(join(original, "source.json"), "utf8"))
    if (legacy === "stale") expect(readFileSync(join(old, "1.5.0.yaml"), "utf8")).toBe(readFileSync(source, "utf8") + "\n# stale copy\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
