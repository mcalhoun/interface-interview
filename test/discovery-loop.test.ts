/**
 * The Discovery loop, driving a real browser.
 *
 * Everything below the model is real: a real Chromium, the real Heritage Core
 * fixture, the shipped `policies/default.yaml`, Evidence on disk. Only the
 * judgement is scripted, and `test/support/scripted-model.ts` argues why (SPEC
 * records a live-model test as a deliberate cut: slow, costly, non-deterministic).
 *
 * What that buys is that these tests check the things that are actually hard —
 * whether a Target expressed in an operator's words resolves on a page built out
 * of nested layout tables, whether the balance behind an unnamed iframe can be
 * reached, whether the Policy gate really is the only path to the adapter — and
 * not merely that the control flow branches correctly.
 *
 * These use `it.live`, like every other browser suite in this workspace:
 * `it.effect` installs a TestClock and anything that sleeps hangs under it.
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { SYSTEM_INSTRUCTIONS } from "@cua/agent"
import { compilePolicy } from "@cua/policy"
import { Result } from "effect"
import { counting, runDiscovery, shippedPolicy } from "./support/discovery-harness.ts"
import { GOAL, readsTheScreen } from "./support/discovery-script.ts"
import { recordingModel, respondingModel, scriptedModel } from "./support/scripted-model.ts"
import type { ScriptedCall } from "./support/scripted-model.ts"


// ---------------------------------------------------------------------------
// The whole loop
// ---------------------------------------------------------------------------

it.live("drives the real application from a goal and reaches the balance", () =>
  Effect.gen(function*() {
    const run = yield* runDiscovery({ goal: GOAL, model: respondingModel(readsTheScreen) })
    const { trajectory } = run

    expect(trajectory.conclusion.conclusion).toBe("reached")
    expect(trajectory.steps.map((step) => step.verb)).toEqual([
      "fill",
      "click",
      "selectFromList",
      "extract"
    ])

    // The figure itself, behind an unnamed iframe, read out of a caption/value
    // row in a table with no headers. This is the same number `bun run replay`
    // produces, which is the point: discovery and replay reach the same place.
    const balance = trajectory.outputs.find((output) => output.name === "availableBalance")
    expect(balance?.value).toBe("$4,182.55")
    expect(balance?.fromStep).toBe("read-available-balance")
  }))

it.live("records where every typed value came from", () =>
  Effect.gen(function*() {
    const { trajectory } = yield* runDiscovery({
      goal: GOAL,
      model: respondingModel(readsTheScreen)
    })

    // The two parameters ticket 11 turns into declared inputs. Named with the
    // semantic role the model inferred, not with the screen's caption.
    expect(trajectory.parameters.map((parameter) => parameter.name).sort()).toEqual([
      "accountType",
      "memberId"
    ])

    const memberId = trajectory.parameters.find((parameter) => parameter.name === "memberId")
    expect(memberId?.usedBy).toEqual(["fill-1"])

    // ADR-0008: sensitive by default, and never the model's call. Nothing in the
    // proposal said so; the loop decided it because Policy declassifies nothing.
    expect(trajectory.parameters.every((parameter) => parameter.sensitive)).toBe(true)

    // And the literal is a `Redacted`, so an accidental serialisation of the
    // trajectory names the parameter rather than leaking the value.
    expect(JSON.stringify(trajectory.parameters)).not.toContain("12345")
    expect(JSON.stringify(trajectory.parameters)).toContain("<redacted:memberId>")
  }))

it.live("records the goal's own word as the selection default, not the matched label", () =>
  Effect.gen(function*() {
    const { trajectory } = yield* runDiscovery({
      goal: GOAL,
      model: respondingModel(readsTheScreen)
    })

    const selection = trajectory.selections[0]
    expect(selection?.parameter).toBe("accountType")

    // THE assertion of ticket 09. `Primary Savings` is not a token subset of
    // another tenant's `Regular Savings`; `savings` is. Recording the label here
    // would produce a capability that works at exactly one institution and looks
    // perfectly correct doing it.
    expect(selection?.default).toBe("savings")
    expect(selection?.default).not.toBe("Primary Savings")

    // The matched label is still reported, so a reviewer can see both words and
    // check the inference. It is simply not what gets recorded as the default.
    expect(selection?.matched).toBe("Primary Savings")

    // The values are read off the live tree, never taken from the model's word
    // for what was on screen.
    expect(selection?.values).toEqual(["Primary Savings", "Checking"])
  }))

// ---------------------------------------------------------------------------
// What the model is shown
// ---------------------------------------------------------------------------

it.live("shows the model the accessibility tree, the url and the frames, and no image", () =>
  Effect.gen(function*() {
    const recorder = recordingModel(readsTheScreen)
    yield* runDiscovery({ goal: GOAL, model: recorder.layer })

    const prompts = recorder.prompts()
    expect(prompts.length).toBeGreaterThan(3)

    for (const prompt of prompts) {
      for (const message of prompt.content) {
        const content = message.content
        if (typeof content === "string") continue
        for (const part of content) {
          // ADR-0001. Vision in the decision loop would make the claim that the
          // accessibility tree alone suffices unfalsifiable, because nobody could
          // tell afterwards which channel carried the run.
          expect(part.type, "an image reached the decision loop").not.toBe("file")
          expect(part.type).toBe("text")
        }
      }
    }

    // And the three things it IS shown are all there.
    const first = prompts[0]!
    const text = first.content
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : message.content
            .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
            .join("\n")
      )
      .join("\n")
    expect(text).toContain("url:")
    expect(text).toContain("frames:")
    expect(text).toContain("textbox \"Member Number\"")
    expect(text).toContain(SYSTEM_INSTRUCTIONS.slice(0, 40))
  }))

it.live("captures a screenshot every step even though none reaches the model", () =>
  Effect.gen(function*() {
    const run = yield* runDiscovery({ goal: GOAL, model: respondingModel(readsTheScreen) })
    const files = readdirSync(run.evidenceDirectory).filter((name) => name.endsWith(".png"))
    // One per observation the model decided from. They exist for a person
    // reviewing the run and for the operator UI, which is exactly the split
    // ADR-0001 asks for: evidence yes, input no.
    expect(files.length).toBeGreaterThanOrEqual(trajectorySteps(run.trajectory.steps.length))
  }))

const trajectorySteps = (count: number): number => count

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

it.live("records each decision with its rationale beside the action taken", () =>
  Effect.gen(function*() {
    const { events } = yield* runDiscovery({
      goal: GOAL,
      model: respondingModel(readsTheScreen)
    })

    const decisions = events.filter((event) => event.kind === "decide")
    expect(decisions.length).toBeGreaterThanOrEqual(4)
    for (const decision of decisions) {
      if (decision.kind !== "decide") continue
      expect(decision.rationale.length).toBeGreaterThan(0)
      expect(decision.action.length).toBeGreaterThan(0)
    }

    // A discovery run says so in its own log, so an auditor reading one file can
    // tell it from a replay log without inferring it from absences.
    const start = events.find((event) => event.kind === "run.start")
    expect(start && "mode" in start ? start.mode : undefined).toBe("discovery")

    // Every action was preceded by a policy check that allowed it.
    const checks = events.filter((event) => event.kind === "policy.check")
    const actions = events.filter((event) => event.kind === "action")
    expect(checks.length).toBeGreaterThanOrEqual(actions.length)
    for (const check of checks) {
      if (check.kind !== "policy.check") continue
      expect(check.policy).toBe("heritage-core-default")
      expect(["safe", "risky"]).toContain(check.risk)
    }
  }))

it.live("is safe to serialise: only the goal itself carries a discovered value", () =>
  Effect.gen(function*() {
    const { trajectory } = yield* runDiscovery({
      goal: GOAL,
      model: respondingModel(readsTheScreen)
    })

    // A Trajectory gets printed by `--json`, handed to a compiler, and written to
    // disk by whoever is debugging a run. Heritage Core puts the member number in
    // every URL after the search, so without scrubbing on the way in, each of
    // those is a leak. This is the property that makes it safe rather than a rule
    // three callers have to remember.
    const { goal, ...rest } = trajectory
    expect(JSON.stringify(rest)).not.toContain("12345")
    expect(JSON.stringify(rest)).toContain("[redacted:memberId]")

    // The goal is the exception, and deliberately: ticket 11 needs it intact to
    // check that no artifact literal echoes it.
    expect(goal).toBe(GOAL)
  }))

it.live("keeps the values it discovered out of its own evidence", () =>
  Effect.gen(function*() {
    const run = yield* runDiscovery({ goal: GOAL, model: respondingModel(readsTheScreen) })

    // Discovery cannot know its sensitive values up front — finding them out is
    // the point — so the scrubber grows as the model tags them, and a value is
    // registered before the `decide` event that first mentions it. That ordering
    // is what this asserts.
    const log = readFileSync(join(run.evidenceDirectory, "events.jsonl"), "utf8")
    expect(log).not.toContain("12345")
    expect(log).toContain("[redacted:memberId]")
  }))

// ---------------------------------------------------------------------------
// The policy chokepoint
// ---------------------------------------------------------------------------

it.live("lets nothing reach the browser when the policy denies everything", () =>
  Effect.gen(function*() {
    const locked = compilePolicy("test:denies-everything", {
      policy: "denies-everything",
      description: "Permits nothing at all, to demonstrate the chokepoint.",
      origins: ["http://127.0.0.1:*", "http://localhost:*"],
      actions: []
    })
    if (Result.isFailure(locked)) throw new Error(locked.failure.message)

    const tally: Record<string, number> = {}
    const { trajectory } = yield* runDiscovery({
      goal: GOAL,
      model: respondingModel(readsTheScreen),
      policy: locked.success,
      surface: counting(tally),
      bounds: { maxSteps: 4 }
    })

    // The run cannot even open the application, and the adapter is never asked to.
    expect(trajectory.conclusion.conclusion).toBe("failed")
    expect(tally).toEqual({})
  }))

it.live("turns a denial into a correction rather than a crash", () =>
  Effect.gen(function*() {
    // navigate and extract only: the model may look, and may not type or press.
    const readOnly = shippedPolicy("read-only")

    let sawDenial = false
    const { trajectory, events } = yield* runDiscovery({
      goal: GOAL,
      policy: readOnly,
      bounds: { maxSteps: 3 },
      model: respondingModel((prompt, turn) => {
        if (prompt.includes("YOUR LAST ACTION DID NOT HAPPEN")) sawDenial = true
        return readsTheScreen(prompt, turn)
      })
    })

    // A `deny` is a value the loop records and feeds back, never a throw. The run
    // ends on a stopping condition, which is the design: a model proposing
    // something forbidden is ordinary in a loop working things out.
    expect(sawDenial).toBe(true)
    expect(trajectory.conclusion.conclusion).toBe("stuck")

    const denials = events.filter(
      (event) => event.kind === "policy.check" && event.verdict === "deny"
    )
    expect(denials.length).toBeGreaterThan(0)
    // The denial names the document that refused, so the log says under which
    // policy rather than only that something was refused.
    for (const denial of denials) {
      if (denial.kind !== "policy.check") continue
      expect(denial.policy).toBe("heritage-core-read-only")
    }
  }))

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

it.live("tells the model to re-tag a value it baked in from the goal", () =>
  Effect.gen(function*() {
    // ADR-0008's failure mode, played deliberately: a lazily-tagged action that
    // would write a member number into a stored capability.
    const calls: Array<ScriptedCall> = [
      {
        name: "fill",
        params: {
          intent: "enter the member number",
          rationale: "typing it in",
          target: {
            role: "textbox",
            name: "Member Number",
            within: { name: "Member Number Search" }
          },
          value: { kind: "constant", literal: "12345" }
        }
      },
      {
        name: "escalate",
        params: { rationale: "told off", code: "GAVE_UP", detail: "re-tagging not attempted" }
      }
    ]

    const { events, trajectory } = yield* runDiscovery({
      goal: GOAL,
      model: scriptedModel(calls)
    })

    // Nothing was typed: the run has no steps at all.
    expect(trajectory.steps).toHaveLength(0)

    // And the refusal is in the record, with the reason, and with the value
    // already scrubbed — a rejection complaint quotes the literal it is
    // complaining about, which is exactly when a leak would happen.
    const refusal = events.find(
      (event) => event.kind === "decide" && event.rationale.startsWith("refused")
    )
    expect(refusal && "rationale" in refusal ? refusal.rationale : "").toContain("bake")
    const log = JSON.stringify(events)
    expect(log).not.toContain("12345")
  }))

it.live("refuses a summary that quotes a value the run was given, and says which", () =>
  Effect.gen(function*() {
    // Found on a live run. A model finishing a run naturally writes down what it
    // just did — "the balance for member 12345" — and that sentence becomes the
    // capability's own summary, read by people who were not there. The
    // compiler's third gate already refuses such a document; refusing here costs
    // one turn and tells the model what to change.
    let told = ""
    const { trajectory } = yield* runDiscovery({
      goal: GOAL,
      model: respondingModel((prompt, turn) => {
        if (prompt.includes("quotes the value this run was given")) {
          told = prompt
          // Second attempt, with the number out of the sentence.
          return readsTheScreen(prompt, turn)
        }
        const next = readsTheScreen(prompt, turn)
        return next.name === "succeed"
          ? {
              name: "succeed",
              params: {
                ...(next.params as Record<string, unknown>),
                summary: "Reads the savings balance of member 12345"
              }
            }
          : next
      })
    })

    // Named, so the model can fix it in one turn rather than guessing.
    expect(told).toContain("memberId")
    // And the run finished, because a refusal is a correction and not an end.
    expect(trajectory.conclusion.conclusion).toBe("reached")
    expect(trajectory.conclusion.conclusion === "reached" && trajectory.conclusion.summary)
      .not.toContain("12345")
  }))

it.live("refuses a second reading under a name already used, and never takes it", () =>
  Effect.gen(function*() {
    // Also found on a live run, which read the balance, read it again, and then
    // read it a third time "to confirm the value is present". Two of those share
    // a step id, which the compiler refuses outright — but only after the whole
    // run. Reading changes nothing, so the repetition rules in `Stuck.ts` are
    // deliberately blind to it; this is the rule that takes their place.
    const reread: Array<ScriptedCall> = [
      {
        name: "extract",
        params: {
          intent: "read the available balance",
          rationale: "the figure sits beside the caption",
          target: { role: "cell", label: "Available Balance" },
          bindAs: "read-available-balance"
        }
      },
      {
        name: "extract",
        params: {
          intent: "read it again to be sure",
          rationale: "confirming the value is present",
          target: { role: "cell", label: "Available Balance" },
          bindAs: "read-available-balance"
        }
      },
      {
        name: "escalate",
        params: { rationale: "told off", code: "GAVE_UP", detail: "did not re-read" }
      }
    ]

    const { trajectory, events } = yield* runDiscovery({
      goal: GOAL,
      entry: "/account?memberNumber=12345&accountNumber=0000012345-S01",
      model: scriptedModel(reread)
    })

    // One reading, not two, and the second never reached the adapter.
    expect(trajectory.steps.map((step) => step.id)).toEqual(["read-available-balance"])
    const refusal = events.find(
      (event) => event.kind === "decide" && event.rationale.startsWith("refused")
    )
    expect(refusal && "rationale" in refusal ? refusal.rationale : "")
      .toContain("already read that control")
  }))

it.live("refuses the same reading under a different name too", () =>
  Effect.gen(function*() {
    // The rule is about the control, not the name. A live run got round a
    // name-only rule by reading one cell four times as availableBalance,
    // savingsAvailableBalance, savingsAvailableBalanceFinal and
    // finalSavingsAvailableBalance, and the compiled document carried four
    // identical steps.
    const renamed: Array<ScriptedCall> = [
      {
        name: "extract",
        params: {
          intent: "read the available balance",
          rationale: "the figure sits beside the caption",
          target: { role: "cell", label: "Available Balance" },
          bindAs: "availableBalance"
        }
      },
      {
        name: "extract",
        params: {
          intent: "read it again under another name",
          rationale: "confirming the value is present",
          target: { role: "cell", label: "Available Balance" },
          bindAs: "availableBalanceFinal"
        }
      },
      {
        name: "escalate",
        params: { rationale: "told off", code: "GAVE_UP", detail: "did not re-read" }
      }
    ]

    const { trajectory, events } = yield* runDiscovery({
      goal: GOAL,
      entry: "/account?memberNumber=12345&accountNumber=0000012345-S01",
      model: scriptedModel(renamed)
    })

    expect(trajectory.steps.map((step) => step.id)).toEqual(["availableBalance"])
    const refusal = events.find(
      (event) => event.kind === "decide" && event.rationale.startsWith("refused")
    )
    // And it names the step that already holds the value, so the model can cite it.
    expect(refusal && "rationale" in refusal ? refusal.rationale : "")
      .toContain("availableBalance")
  }))

it.live("tells the model when it invents an action, and never performs it", () =>
  Effect.gen(function*() {
    // An invented verb never reaches the loop's own decoding: `generateText`
    // validates the provider's response against the Toolkit first, so the tool
    // name is refused one layer further out than this ticket's own check. Both
    // layers exist and this is the outer one — which is why the assertion is
    // about the consequence rather than about which check fired.
    const tally: Record<string, number> = {}
    const calls: Array<ScriptedCall> = [
      { name: "executeScript", params: { script: "document.forms[0].submit()" } },
      {
        name: "escalate",
        params: { rationale: "no other idea", code: "GAVE_UP", detail: "vocabulary exhausted" }
      }
    ]

    const { events, trajectory } = yield* runDiscovery({
      goal: GOAL,
      model: scriptedModel(calls),
      surface: counting(tally)
    })

    // Nothing was performed, and the run ended on the model's own escalation
    // rather than on a crash: an out-of-vocabulary proposal is a correction.
    expect(trajectory.steps).toHaveLength(0)
    expect(trajectory.conclusion.conclusion).toBe("stuck")
    expect(tally.click).toBeUndefined()
    expect(tally.fill).toBeUndefined()

    const refusal = events.find(
      (event) => event.kind === "decide" && event.rationale.startsWith("refused")
    )
    expect(refusal && "rationale" in refusal ? refusal.rationale : "").toContain(
      "not one of the available actions"
    )
  }))

it.live("stops when the model escalates, and says so", () =>
  Effect.gen(function*() {
    const { trajectory } = yield* runDiscovery({
      goal: "Look up the savings balance of member 99999",
      model: scriptedModel([
        {
          name: "escalate",
          params: {
            rationale: "the search says there is no such member and I cannot act on that",
            code: "MEMBER_NOT_FOUND",
            detail: "Heritage Core reports no member with that number"
          }
        }
      ])
    })

    expect(trajectory.conclusion.conclusion).toBe("stuck")
    if (trajectory.conclusion.conclusion !== "stuck") return
    // The trigger is reported the same way a detector's finding is, so a caller
    // does not have to special-case the one the model raised itself.
    expect(trajectory.conclusion.trigger.trigger).toBe("escalated")
    expect(trajectory.conclusion.trigger.detail).toContain("no member")
  }))
