import { readFileSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { runDiscovery } from "../apps/demo/src/support/discovery-harness.ts"
import { scriptedModel, respondingModel } from "../apps/demo/src/support/scripted-model.ts"
import { GOAL, readsTheScreen } from "../apps/demo/src/support/discovery-script.ts"

for (const privateValue of ["65432", "Morgan Ellsworth", "CorrectHorse!River$92"]) {
  it.live(`protects a goal value in model prose before any fill (${privateValue.length} characters)`, () =>
    Effect.gen(function*() {
      const run = yield* runDiscovery({
        goal: `Read the savings balance for member ${privateValue}`,
        model: scriptedModel([{
          name: "escalate",
          params: {
            code: "NEED_HELP",
            detail: `I cannot locate member ref${privateValue}suffix`,
            rationale: `A person must help with member ${privateValue}`
          }
        }])
      })
      const disk = readFileSync(join(run.evidenceDirectory, "events.jsonl"), "utf8")
      expect(disk).not.toContain(privateValue)
      expect(JSON.stringify(run.trajectory)).not.toContain(privateValue)
      expect(run.trajectory.steps).toHaveLength(0)
      expect(run.events.find((event) => event.kind === "run.start")).toMatchObject({
        model: "scripted",
        provider: "scripted"
      })
      expect(run.events.at(-1)).toMatchObject({ kind: "run.end", result: "intervention_required" })
    }))
}

it.live("serializes a successful discovery without its raw goal", () =>
  Effect.gen(function*() {
    const { trajectory, events } = yield* runDiscovery({ goal: GOAL, model: respondingModel(readsTheScreen) })
    expect(trajectory.conclusion.conclusion).toBe("reached")
    expect(JSON.stringify(trajectory)).not.toContain("12345")
    expect(JSON.stringify(trajectory)).toContain("<redacted:goal>")
    expect(events.at(-1)).toMatchObject({ kind: "run.end", result: "success" })
    expect(trajectory.parameters.find((parameter) => parameter.name === "accountType")?.sensitive).toBe(false)
    expect(trajectory.selections[0]?.declassifiedBecause).toContain("validated against the live account list")
    const selection = trajectory.steps.find((step) => step.verb === "selectFromList")
    expect(JSON.stringify(selection?.action)).not.toContain("[redacted:accountType]")
    expect(JSON.stringify(selection?.action)).toContain("savings")
  }))

it.live("keeps an account selection sensitive when caller policy did not declassify it", () =>
  Effect.gen(function*() {
    const { trajectory } = yield* runDiscovery({
      goal: GOAL,
      publicGoalTerms: [],
      model: respondingModel(readsTheScreen)
    })
    expect(trajectory.conclusion.conclusion).toBe("reached")
    expect(trajectory.parameters.find((parameter) => parameter.name === "accountType")?.sensitive).toBe(true)
    expect(trajectory.selections[0]?.declassifiedBecause).toBeUndefined()
    expect(JSON.stringify(trajectory)).not.toContain("12345")
  }))
