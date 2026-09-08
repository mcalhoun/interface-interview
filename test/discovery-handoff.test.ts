import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { discoveryRun } from "@cua/agent"
import { serve } from "@cua/legacy-core"
import { serveOperator } from "@cua/operator"
import { heritagePublicGoalTerms, originAuthorizer, policyFrom } from "@cua/policy"
import { Session, SessionControl, handoffSession, sessionControl } from "@cua/session"
import { SurfaceAdapter, playwrightSurface } from "@cua/surface"
import { Effect, Fiber, Layer } from "effect"
import { expect } from "vitest"
import { readsTheScreen } from "../apps/demo/src/support/discovery-script.ts"
import { shippedPolicy } from "../apps/demo/src/support/replay-harness.ts"
import { respondingModel } from "../apps/demo/src/support/scripted-model.ts"

it.live("discovery hands over its live browser, guards ownership, records actions, and resumes", () =>
  Effect.scoped(Effect.gen(function* () {
    const core = yield* serve({ port: 0 })
    const root = mkdtempSync(join(tmpdir(), "cua-discovery-handoff-"))
    const policy = shippedPolicy()
    const workflow = yield* discoveryRun({
      goal: "Look up the savings account balance of member 12345",
      entry: "/", baseUrl: core.origin, runId: "run", sessionId: "same-session",
      publicGoalTerms: heritagePublicGoalTerms, modelName: "scripted", providerName: "test",
      evidence: { root }, compilation: { capability: "member.audit", version: "1.0.0", product: "Operator value 43210" }
    })
    const layers = Layer.mergeAll(
      playwrightSurface({ authorizeOrigin: originAuthorizer(policy) }),
      policyFrom(policy),
      handoffSession.pipe(Layer.provideMerge(sessionControl({ sessionId: "same-session", waitMillis: 5_000 }).pipe(Layer.provideMerge(workflow.evidence)))),
      respondingModel((prompt, turn) => turn === 0 ? {
        name: "escalate",
        params: { code: "OPERATOR_CHECK", detail: "Check member 12345 before proceeding", rationale: "Need a person" }
      } : readsTheScreen(prompt, turn - 1))
    )
    yield* Effect.gen(function* () {
      const control = yield* SessionControl
      const session = yield* Session
      const surface = yield* SurfaceAdapter
      const operator = yield* serveOperator({ control, port: 0 })
      const running = yield* Effect.forkChild(workflow.execute)
      let paused = false
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if ((yield* control.snapshot).owner === "paused") { paused = true; break }
        yield* Effect.sleep(50)
      }
      expect(paused, "discovery must raise a live intervention").toBe(true)
      const post = (path: string, fields: Record<string, string>) => Effect.promise(() => fetch(
        `${operator.origin}${path}`, {
          method: "POST", redirect: "manual",
          headers: { "x-operator-token": operator.token, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(fields)
        }
      ))
      expect((yield* post("/take", { operator: "reviewer" })).status).toBe(303)
      expect((yield* post("/note", { detail: "Confirming the request for member 12345" })).status).toBe(303)
      expect(yield* session.claim("automated fill").pipe(Effect.flip)).toMatchObject({ owner: "operator" })
      yield* surface.fill({ role: "textbox", name: "Member Number", within: { name: "Member Number Search" } }, "43210")
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if ((yield* control.snapshot).pending?.observed?.length) break
        yield* Effect.sleep(50)
      }
      yield* surface.fill({ role: "textbox", name: "Member Number", within: { name: "Member Number Search" } }, "")
      expect((yield* post("/return", {
        operator: "reviewer", classification: "resolved", detail: "Checked and cleared the input", actionTaken: "true"
      })).status).toBe(303)
      const result = yield* Fiber.join(running)
      expect(result.diagnostics.conclusion).toBe("reached")
      expect(result.diagnostics.sessionId).toBe("same-session")
      expect(result.compilation.status).toBe("refused")
      if (result.compilation.status === "refused") {
        expect(result.compilation.reasons).toContain(
          "the artifact contains registered private runtime data. Keep run-specific values behind caller-supplied parameter references."
        )
      }
      const snapshot = yield* control.snapshot
      expect(snapshot.owner).toBe("automation")
      expect(snapshot.resolved).toHaveLength(1)
      expect(snapshot.resolved[0]?.actions).toHaveLength(2)
      expect(JSON.stringify(snapshot)).not.toContain("12345")
      const log = readFileSync(join(root, "run/events.jsonl"), "utf8")
      expect(log).toContain("intervention.raise")
      expect(log).toContain("intervention.resolve")
      expect(log).not.toContain("12345")
      expect(log).not.toContain("43210")
      expect(JSON.stringify(result)).not.toContain("43210")
      expect(JSON.stringify(result)).not.toContain("12345")
    }).pipe(Effect.provide(layers))
  })), 30_000)
