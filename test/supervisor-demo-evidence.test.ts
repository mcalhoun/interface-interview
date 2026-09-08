import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { diffArtifacts, loadArtifact } from "@cua/artifact"
import { Result } from "effect"
import { expect, it } from "vitest"

for (const existing of [true, false]) {
  it(`supervisor demo records the artifact it replays when the target version ${existing ? "exists" : "is new"}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "cua-supervisor-evidence-"))
    const store = join(root, "artifacts")
    const target = join(store, "member.account-balance", "1.2.0.yaml")
    cpSync(resolve("artifacts"), store, { recursive: true })
    cpSync(resolve("policies"), join(root, "policies"), { recursive: true })
    const original = readFileSync(target, "utf8")
    if (!existing) rmSync(target)
    try {
      const child = Bun.spawn([process.execPath, resolve("apps/demo/src/support/drive-the-supervisor-hold.ts")], {
        cwd: root, stdout: "pipe", stderr: "pipe"
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ])
      expect(exitCode, stderr).toBe(0)
      expect(stdout).toContain(existing ? "not stored:" : "written to")
      expect(stdout).toContain("run ended: intervention_required")
      if (existing) expect(readFileSync(target, "utf8")).toBe(original)
      const before = loadArtifact(store, "member.account-balance", "1.1.0")
      const after = loadArtifact(store, "member.account-balance", "1.2.0")
      if (Result.isFailure(before)) throw before.failure
      if (Result.isFailure(after)) throw after.failure
      expect(readFileSync(join(root, "evidence/learning/77777-supervisor-hold/1.1.0-to-1.2.0.diff"), "utf8"))
        .toBe(`${diffArtifacts(before.success, after.success)}\n`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
}
