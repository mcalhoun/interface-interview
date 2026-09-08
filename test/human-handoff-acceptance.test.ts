import { cpSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { attendedReplay, type AttendedOutcome } from "../apps/demo/src/support/handoff-harness.ts"
import { shippedArtifact } from "../apps/demo/src/support/replay-harness.ts"

const retainProof = (name: string, outcome: AttendedOutcome): void => {
  const root = process.env.CUA_HANDOFF_EVIDENCE
  if (root === undefined) return
  const directory = join(root, name)
  mkdirSync(directory, { recursive: false })
  cpSync(outcome.evidenceDirectory, join(directory, "run"), { recursive: true, errorOnExist: true, force: false })
  writeFileSync(join(directory, "receipt.json"), JSON.stringify({
    verifiedAt: new Date().toISOString(),
    provenance: "Scripted Operator judgment through the real local operator interface and the same real Chromium Surface Adapter used by Replay. No person at a keyboard is claimed.",
    screenshots: "Synthetic fixture only. Screenshot pixels are not redacted.",
    sessionId: outcome.snapshot.sessionId,
    owners: outcome.snapshot.history.map((entry) => entry.owner),
    result: outcome.result,
    observedFields: outcome.snapshot.resolved.flatMap((record) => record.observed),
    events: "run/events.jsonl"
  }, undefined, 2), { flag: "wx" })
}

it.live("demonstrates a same-session handoff, ownership exclusion, recorded actions and verified completion", () =>
  Effect.gen(function* () {
    const outcome = yield* attendedReplay({
      artifact: shippedArtifact(undefined, "1.1.0"),
      inputs: { memberId: "77777" }, runId: "handoff-completed",
      operate: (desk) => Effect.gen(function* () {
        const paused = yield* desk.awaitPause
        expect(paused.pending?.intervention).toMatchObject({ capability: "member.account-balance", version: "1.1.0", stepId: "open-account" })
        expect(paused.pending?.intervention.reason).not.toBe("")
        expect(paused.pending?.intervention.accessibility).toContain("SUPERVISOR AUTHORIZATION REQUIRED")
        expect((yield* desk.get("/")).body).toContain("Automation is paused and cannot act.")
        const before = yield* desk.surface.observe
        expect((yield* desk.post("/take", { operator: "demo.operator" })).status).toBe(303)
        expect((yield* desk.served).owner).toBe("operator")
        const refused = yield* desk.replayAgain("ownership-exclusion")
        expect(refused).toMatchObject({ result: "failure", failure: { reason: "control_lost" } })
        expect((yield* desk.surface.observe).url).toBe(before.url)
        yield* desk.surface.fill({ role: "textbox", name: "Supervisor ID" }, "SUP7")
        yield* desk.surface.fill({ role: "textbox", name: "Authorization Code" }, "4417")
        yield* desk.awaitObserved("supervisorId")
        yield* desk.awaitObserved("authorizationCode")
        yield* desk.surface.click({ role: "button", name: "Authorize" })
        expect((yield* desk.surface.observe).accessibility).toContain("Available Balance")
        expect((yield* desk.post("/return", {
          operator: "demo.operator", classification: "resolved", actionTaken: "true",
          detail: "Entered synthetic supervisor values and clicked Authorize in the existing browser window.",
          nextTime: "always_stop_here"
        })).status).toBe(303)
      })
    })
    expect(outcome.result).toMatchObject({ result: "success", outputs: {
      availableBalance: { value: { amount: 2730.11, currency: "USD" } },
      currentBalance: { value: { amount: 2905.60, currency: "USD" } }
    } })
    expect(outcome.snapshot.history.map((entry) => entry.owner)).toEqual([
      "automation", "paused", "operator", "resume_requested", "automation"
    ])
    expect(new Set(outcome.events.map((event) => event.sessionId))).toEqual(new Set([outcome.snapshot.sessionId]))
    expect(outcome.snapshot.resolved[0]?.actions.some((action) => action.kind !== "note")).toBe(true)
    const returned = outcome.events.findIndex((event) => event.kind === "intervention.resolve")
    expect(returned).toBeGreaterThan(0)
    expect(outcome.events.slice(returned + 1).some((event) =>
      event.kind === "checkpoint" && event.stepId === "open-account" && event.verdict === "held"
    )).toBe(true)
    expect(outcome.events.at(-1)).toMatchObject({ kind: "run.end", result: "success" })
    const text = JSON.stringify(outcome.events)
    for (const secret of ["77777", "SUP7", "4417"]) expect(text).not.toContain(secret)
    expect(outcome.events.some((event) => event.kind === "decide")).toBe(false)
    retainProof("completed", outcome)
  }))

it.live("a blocked Operator return stops the run without a successful result", () =>
  Effect.gen(function* () {
    const outcome = yield* attendedReplay({
      artifact: shippedArtifact(undefined, "1.1.0"), inputs: { memberId: "77777" }, runId: "handoff-blocked",
      operate: (desk) => Effect.gen(function* () {
        yield* desk.awaitPause
        expect((yield* desk.post("/take", { operator: "demo.operator" })).status).toBe(303)
        expect((yield* desk.post("/return", {
          operator: "demo.operator", classification: "blocked",
          detail: "No supervisor is available to authorize the synthetic hold.", nextTime: "not_asked"
        })).status).toBe(303)
      })
    })
    expect(outcome.result.result).toBe("intervention_required")
    expect(outcome.snapshot.resolved[0]?.classification).toBe("blocked")
    expect(outcome.events.at(-1)).toMatchObject({ kind: "run.end", result: "intervention_required" })
    retainProof("blocked", outcome)
  }))
