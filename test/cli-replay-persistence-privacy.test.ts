import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Console, Effect } from "effect"
import { expect, vi } from "vitest"
import type { CapabilityArtifact } from "@cua/artifact"
import type { Advisor } from "@cua/replay"
import { runReplayCommand } from "../apps/cli/src/replay.ts"
import { shippedPolicy } from "../apps/demo/src/support/replay-harness.ts"

vi.mock("@cua/agent", async (original) => ({
  ...await original<typeof import("@cua/agent")>(),
  modelAdvisor: (): Advisor => ({
    consult: (question) => Effect.succeed({
      _tag: "TargetProposed",
      proposedControl: question.controls?.[0]?.name ?? "",
      confidence: 0.99,
      rationale: "The observed button is the corresponding control."
    })
  })
}))

it.live("CLI override persistence retains secrets registered from the live screen", () =>
  Effect.scoped(Effect.gen(function* () {
    const secret = "MARGUERITE A ELLSWORTH"
    const tenant = `privacy-${randomUUID()}`
    const capability = `audit.privacy-${randomUUID()}`
    const target = { role: "button", name: "Search", strategy: "accessible-name", robustness: "A unique named button." }
    const artifact: CapabilityArtifact = {
      capability, version: "1.0.0", title: "Read a result", summary: "Open the lookup and read its result.",
      authored: "hand-written", surface: { kind: "web", product: "Privacy fixture", entry: "/" },
      inputs: {}, outputs: { result: { type: "text", description: "The resulting text", from: { step: "read" } } },
      outcomes: { NO_RESULT: { title: "No result", summary: "The lookup returned no result." } },
      steps: [
        { id: "open", intent: "Open lookup", action: { type: "navigate", path: { from: "constant", text: "/" } },
          checkpoint: { description: "Lookup is ready", expect: [{ assert: "textPresent", text: "Lookup" }] } },
        { id: "search", intent: "Submit lookup", action: { type: "click", target },
          checkpoint: { description: "Result is ready", expect: [{ assert: "textPresent", text: "Result" }] } },
        { id: "read", intent: "Read result", action: { type: "extract", target },
          checkpoint: { description: "Reading exists", expect: [{ assert: "stepRead", step: "read", matches: ".+" }] } }
      ]
    }
    const server = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => new Response(`<h1>Lookup</h1><table><tr><td>Member Name</td><td>${secret}</td></tr></table><button>${secret}</button>`,
        { headers: { "Content-Type": "text/html" } })
    })), (server) => Effect.sync(() => server.stop(true)))
    const messages: string[] = []
    let operatorUrl: URL | undefined
    let operated: Promise<void> | undefined
    const capture = (...args: ReadonlyArray<unknown>): void => {
      const message = args.map(String).join(" ")
      messages.push(message)
      const printed = message.match(/operator interface: (http:\/\/\S+)/u)?.[1]
      if (printed !== undefined) operatorUrl = new URL(printed)
      if (!message.includes("PAUSED at step") || operatorUrl === undefined) return
      const desk = operatorUrl
      operated = (async () => {
        const post = (path: string, fields: Record<string, string>) => fetch(`${desk.origin}${path}`, {
          method: "POST", redirect: "manual", headers: { "x-operator-token": desk.searchParams.get("t") ?? "" },
          body: new URLSearchParams(fields)
        })
        expect((await post("/take", { operator: "reviewer" })).status).toBe(303)
        expect((await post("/return", { operator: "reviewer", classification: "unresolved",
          detail: "Confirmed the corresponding control", nextTime: "not_asked", confirmProposal: "confirmed" })).status).toBe(303)
      })()
      void operated.catch(() => undefined)
    }
    const priorExitCode = process.exitCode
    try {
      yield* runReplayCommand(artifact, artifact, undefined, undefined, shippedPolicy(), {
        positionals: [capability], switches: new Set(["handoff", "assist"]),
        options: { baseUrl: `http://127.0.0.1:${server.port}`, tenant, operatorPort: "0", handoffWait: "5" }
      }).pipe(Effect.provideService(Console.Console, { ...console, error: capture, log: capture }))
      yield* Effect.promise(async () => { await operated })
      expect(operated).toBeDefined()
      expect(existsSync(join("config/tenant-overrides", tenant, `${capability}.yaml`))).toBe(false)
      expect(messages.join("\n")).toContain("OVERRIDE REFUSED")
      expect(messages.join("\n")).not.toContain(secret)
      const directory = readdirSync("evidence/replay").find((name) => name.startsWith(capability))
      expect(directory).toBeDefined()
      if (directory !== undefined) {
        const log = readFileSync(join("evidence/replay", directory, "events.jsonl"), "utf8")
        expect(log).toContain("[redacted:memberName]")
        expect(log).not.toContain(secret)
      }
    } finally {
      process.exitCode = priorExitCode
      rmSync(join("config/tenant-overrides", tenant), { recursive: true, force: true })
      for (const directory of readdirSync("evidence/replay").filter((name) => name.startsWith(capability))) {
        rmSync(join("evidence/replay", directory), { recursive: true, force: true })
      }
    }
  })))
