import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"

const temporary = mkdtempSync(join(tmpdir(), "cua-cli-contract-"))
afterAll(() => rmSync(temporary, { recursive: true, force: true }))

const execute = async (args: ReadonlyArray<string>) => {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, OPENAI_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe"
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  return { stdout, stderr, code }
}

it("discovery JSON compiles and replays without leaking member or entry URL values", async () => {
  const preload = join(temporary, "model.ts")
  const agent = join(process.cwd(), "packages/agent/src/provider.ts")
  const model = join(process.cwd(), "apps/demo/src/support/scripted-model.ts")
  const script = join(process.cwd(), "apps/demo/src/support/discovery-script.ts")
  writeFileSync(preload, `import { mock } from "bun:test";
import { respondingModel } from ${JSON.stringify(model)};
import { readsTheScreen } from ${JSON.stringify(script)};
const providerFor = () => respondingModel(readsTheScreen);
mock.module(${JSON.stringify(agent)}, () => ({ DEFAULT_MODEL: "scripted", DEFAULT_PROVIDER: "openai", PROVIDER_NAMES: ["openai"], API_KEY_VARIABLE: "OPENAI_API_KEY", isProviderName: (name) => name === "openai", providerFor, PROVIDERS: { openai: providerFor } }));`)
  const discovered = await execute([
    "run", "--preload", preload, "apps/cli/src/discover.ts",
    "--json", "--entry", "/?token=CLI_ENTRY_SECRET_c91#CLI_FRAGMENT_SECRET_f82", "Look up the savings account balance of member 12345"
  ])
  expect(discovered.code, discovered.stderr).toBe(0)
  expect(() => JSON.parse(discovered.stdout)).not.toThrow()
  expect(discovered.stdout).not.toContain("12345")
  expect(discovered.stdout).not.toContain("CLI_ENTRY_SECRET_c91")
  expect(discovered.stdout).not.toContain("CLI_FRAGMENT_SECRET_f82")
  expect(discovered.stderr).not.toContain("12345")
  const trajectory = join(temporary, "trajectory.json")
  writeFileSync(trajectory, discovered.stdout)
  const compiled = await execute([
    "run", "apps/cli/src/compile.ts", trajectory,
    "--capability", "review.roundtrip", "--out", temporary
  ])
  expect(compiled.code, compiled.stderr).toBe(0)
  const document = readFileSync(join(temporary, "review.roundtrip/1.0.0.yaml"), "utf8")
  expect(document).not.toContain("12345")
  const { parseArtifact } = await import("@cua/artifact")
  const { Result, Effect } = await import("effect")
  const { replay } = await import("../apps/demo/src/support/replay-harness.ts")
  const artifact = parseArtifact("CLI roundtrip", document)
  if (Result.isFailure(artifact)) throw artifact.failure
  const result = await Effect.runPromise(replay({ artifact: artifact.success, inputs: { memberId: "12345", entryPath: "/?token=FRESH_CLI_ENTRY_vB21#FRESH_CLI_FRAGMENT_kC92" } }))
  expect(result.result.result).toBe("success")
  if (result.result.result === "success") {
    expect(result.result.outputs.availableBalance).toEqual({ type: "money", value: { amount: 4182.55, currency: "USD" } })
  }
})

it("replay failure diagnostics redact member identifiers in stdout", async () => {
  const run = await execute([
    "run", "apps/cli/src/replay.ts", "member.account-balance",
    "--memberId", "77777", "--version", "1.1.0", "--json"
  ])
  expect(run.code).toBe(1)
  expect(JSON.parse(run.stdout).result).toBe("failure")
  expect(run.stdout).not.toContain("77777")
  expect(run.stderr).not.toContain("77777")
})

it("missing assistance credentials give a stable public diagnostic", async () => {
  const run = await execute([
    "run", "apps/cli/src/replay.ts", "member.account-balance",
    "--memberId", "88888", "--version", "1.0.0", "--assist", "--json"
  ])
  const result = JSON.parse(run.stdout)
  const events = readFileSync(join(result.evidenceDirectory, "events.jsonl"), "utf8")
  expect(events).not.toContain("ConfigError")
  expect(events).not.toContain("SchemaError")
  expect(events).toContain("assist.declined")
})

it.each(["discover", "compile", "replay", "surface"])("%s has a working help entrypoint", async (command) => {
  const result = await execute(["run", `apps/cli/src/${command}.ts`, "--help"])
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toContain(`bun run ${command}`)
})

it.each([
  ["discover", "--model"], ["compile", "--capability"],
  ["replay", "--memberId"], ["surface", "--name"]
])("%s rejects a missing option value before running", async (command, option) => {
  const result = await execute(["run", `apps/cli/src/${command}.ts`, option])
  expect(result.code).toBe(2)
  expect(result.stderr).toContain("requires a value")
  expect(result.stdout).toBe("")
})

it("surface parses an exact switch before its subcommand and resolves a real control", async () => {
  const result = await execute(["run", "apps/cli/src/surface.ts", "--exact", "resolve", "/", "--role", "textbox", "--name", "Member Number", "--within", "Member Number Search"])
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toContain("unique:     yes")
})

it("replay keeps named inputs and tenant notices do not corrupt JSON", async () => {
  const result = await execute(["run", "apps/cli/src/replay.ts", "--json", "member.account-balance", "--memberId", "12345", "--accountType", "savings", "--tenant", "community-cu"])
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result).toBe("success")
  expect(result.stderr).toContain("tenant:")
  expect(result.stdout).not.toContain("12345")
})

it.each([
  ["discover", "goal", "--maxSteps", "0"],
  ["replay", "member.account-balance", "--operatorPort", "99999"],
  ["surface", "resolve", "/", "--nth", "-1"]
])("%s rejects invalid numeric bounds", async (...args) => {
  const [command, ...options] = args
  const result = await execute(["run", `apps/cli/src/${command}.ts`, ...options])
  expect(result.code).toBe(2)
  expect(result.stderr).toContain("must be")
})

it("discovery CLI hands the live session to an operator and keeps resumed JSON clean", async () => {
  const preload = join(temporary, "handoff-model.ts")
  const provider = join(process.cwd(), "packages/agent/src/provider.ts")
  const model = join(process.cwd(), "apps/demo/src/support/scripted-model.ts")
  const script = join(process.cwd(), "apps/demo/src/support/discovery-script.ts")
  writeFileSync(preload, `import { mock } from "bun:test";
import { respondingModel } from ${JSON.stringify(model)};
import { readsTheScreen } from ${JSON.stringify(script)};
const providerFor = () => respondingModel((prompt, turn) => turn === 0 ? { name: "escalate", params: { code: "OPERATOR_CHECK", detail: "Check member 12345 before continuing", rationale: "Need operator review" } } : readsTheScreen(prompt, turn - 1));
mock.module(${JSON.stringify(provider)}, () => ({ DEFAULT_MODEL: "scripted", DEFAULT_PROVIDER: "openai", PROVIDER_NAMES: ["openai"], API_KEY_VARIABLE: "OPENAI_API_KEY", isProviderName: name => name === "openai", providerFor, PROVIDERS: { openai: providerFor } }));`)
  const child = Bun.spawn([process.execPath, "run", "--preload", preload, "apps/cli/src/discover.ts", "--json", "--handoff", "Look up the savings account balance of member 12345", "--operatorPort", "0", "--handoffWait", "10"], {
    cwd: process.cwd(), env: { ...process.env, OPENAI_API_KEY: "" }, stdout: "pipe", stderr: "pipe"
  })
  let stderr = ""
  const stderrDone = (async () => {
    const reader = child.stderr.getReader()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      stderr += new TextDecoder().decode(chunk.value)
    }
  })()
  const stdoutDone = new Response(child.stdout).text()
  try {
    for (let attempt = 0; attempt < 150 && !stderr.includes("PAUSED:"); attempt += 1) await Bun.sleep(25)
    expect(stderr).toContain("PAUSED:")
    const address = stderr.match(/operator interface: (http:\/\/[^\s]+)/)?.[1]
    if (address === undefined) throw new Error("Operator address was not announced")
    const url = new URL(address)
    const token = url.searchParams.get("t")
    if (token === null) throw new Error("Operator link has no token")
    const post = (path: string, fields: Record<string, string>) => fetch(url.origin + path, {
      method: "POST", redirect: "manual",
      headers: { "x-operator-token": token, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields)
    })
    expect((await post("/take", { operator: "cli.reviewer" })).status).toBe(303)
    expect((await post("/return", { operator: "cli.reviewer", classification: "resolved", detail: "Reviewed the live entry screen; continue the requested lookup" })).status).toBe(303)
    const [stdout, code] = await Promise.all([stdoutDone, child.exited, stderrDone])
    expect(code, stderr).toBe(0)
    const envelope = JSON.parse(stdout)
    expect(envelope.format).toBe("discovery-compilation-v1")
    expect(stdout).not.toContain("12345")
    expect(stderr).not.toContain("12345")
  } finally { child.kill() }
}, 20_000)

it("surface observation diagnostics redact URL parameters and personal fields", async () => {
  const result = await execute(["run", "apps/cli/src/surface.ts", "observe", "/member?memberNumber=12345"])
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).not.toContain("12345")
  expect(result.stdout).toContain("[redacted:memberNumber]")
  expect(result.stdout).toContain("[redacted:memberName]")
})
