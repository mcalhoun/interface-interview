import { it } from "@effect/vitest"
import { expect } from "vitest"
import { attendedReplay } from "../apps/demo/src/support/handoff-harness.ts"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { discover, discoveredSecrets, compileArtifact } from "@cua/agent"
import { evidenceFiles } from "@cua/evidence"
import { serve } from "@cua/legacy-core"
import { serveOperator } from "@cua/operator"
import { heritagePublicGoalTerms, originAuthorizer, policyFrom } from "@cua/policy"
import { SessionControl, handoffSession, sessionControl } from "@cua/session"
import { SurfaceAdapter, playwrightSurface } from "@cua/surface"
import { Effect, Fiber, Layer, Result } from "effect"

import { readsTheScreen } from "../apps/demo/src/support/discovery-script.ts"
import { replay, shippedPolicy } from "../apps/demo/src/support/replay-harness.ts"
import { respondingModel } from "../apps/demo/src/support/scripted-model.ts"

for (const pausedTurn of [1, 2]) {
it.live(`a discovery intervention after action ${pausedTurn} remains a replayable human dependency`, () => Effect.scoped(Effect.gen(function* () {
    const core = yield* serve({ port: 0 })
    const root = mkdtempSync(join(tmpdir(), "cua-discovery-handoff-"))
    const secrets = discoveredSecrets()
    const policy = shippedPolicy()
    const evidence = evidenceFiles({ root, runId: "run", sessionId: "same-session", scrubber: secrets.registry })
    const layers = Layer.mergeAll(
      playwrightSurface({ authorizeOrigin: originAuthorizer(policy) }),
      policyFrom(policy),
      handoffSession.pipe(Layer.provideMerge(sessionControl({ sessionId: "same-session", waitMillis: 5_000 }).pipe(Layer.provideMerge(evidence)))),
      respondingModel((prompt, turn) => turn === pausedTurn ? {
        name: "escalate",
        params: { code: "OPERATOR_CHECK", detail: "Check member 12345 before proceeding", rationale: "Need a person" }
      } : readsTheScreen(prompt, turn))
    )
    const artifact = yield* Effect.gen(function* () {
      const control = yield* SessionControl
      const surface = yield* SurfaceAdapter
      const operator = yield* serveOperator({ control, port: 0 })
      const running = yield* Effect.forkChild(discover({
        goal: "Look up the savings account balance of member 12345",
        entry: "/", baseUrl: core.origin, runId: "run", sessionId: "same-session",
        secrets, publicGoalTerms: heritagePublicGoalTerms, modelName: "scripted", providerName: "test"
      }))
      let paused = false
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if ((yield* control.snapshot).owner === "paused") { paused = true; break }
        yield* Effect.sleep(50)
      }
      if (!paused) throw new Error("not paused");
      const post = (path: string, fields: Record<string, string>) => Effect.promise(() => fetch(
        `${operator.origin}${path}`, {
          method: "POST", redirect: "manual",
          headers: { "x-operator-token": operator.token, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(fields)
        }
      ))
      yield* post("/take", { operator: "reviewer" });
      if (pausedTurn === 1) yield* surface.click({role:"button", name:"Search", within:{name:"Member Number Search"}})
      yield* surface.click({ role: "link", name: "Primary Savings" });
      yield* post("/return", {operator:"reviewer", classification:"resolved", detail:"Opened savings account", actionTaken:"true"});
      const trajectory = yield* Fiber.join(running)
      const compiled = compileArtifact(trajectory, {capability:"member.audit", version:"1.0.0", publicGoalTerms: heritagePublicGoalTerms});
      expect(trajectory.conclusion.conclusion).toBe("reached")
      expect(Result.isSuccess(compiled), Result.isFailure(compiled) ? compiled.failure.message : "compiled").toBe(true)
      if (Result.isFailure(compiled)) throw compiled.failure
      expect(Object.values(compiled.success.requiresHuman ?? {})).toContainEqual(expect.objectContaining({
        step: pausedTurn === 1 ? "fill-1" : "click-2", basis: "discovery_intervention"
      }))
      return compiled.success
    }).pipe(Effect.provide(layers))
      const unattended = yield* replay({artifact:artifact, inputs:{memberId:"12345"}})
      expect(unattended.result.result).toBe("intervention_required")
      const attended = yield* attendedReplay({
        artifact: artifact, inputs: {memberId:"12345"},
        operate: (desk) => Effect.gen(function* () {
          yield* desk.awaitPause
          yield* desk.post("/take", {operator:"replay-operator"})
          if (pausedTurn === 1) yield* desk.surface.click({role:"button",name:"Search",within:{name:"Member Number Search"}})
          yield* desk.surface.click({role:"link",name:"Primary Savings"})
          yield* desk.post("/return", {operator:"replay-operator",classification:"resolved",detail:"Opened the requested account",actionTaken:"true"})
        })
      })
      expect(attended.result.result).toBe("success")

  })), 30_000)

}
