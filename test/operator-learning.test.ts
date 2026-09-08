import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { classify } from "@cua/session"
import { proposeAmendment } from "@cua/replay"
import { noScrubbing } from "@cua/evidence"
import { attendedReplay } from "../apps/demo/src/support/handoff-harness.ts"
import { shippedArtifact } from "../apps/demo/src/support/replay-harness.ts"
import { scanForSecrets } from "../apps/demo/src/support/secret-scan.ts"

it.live("learns from an observed supervisor release without a separate note", () =>
  Effect.gen(function* () {
    const outcome = yield* attendedReplay({
      artifact: shippedArtifact(undefined, "1.1.0"),
      inputs: { memberId: "77777" },
      runId: "observed-release-without-note",
      operate: (desk) => Effect.gen(function* () {
        yield* desk.awaitPause
        expect((yield* desk.post("/take", { operator: "r.mensah" })).status).toBe(303)
        yield* desk.surface.fill({ role: "textbox", name: "Supervisor ID" }, "SUP7")
        yield* desk.surface.fill({ role: "textbox", name: "Authorization Code" }, "4417")
        yield* desk.awaitObserved("supervisorId")
        yield* desk.awaitObserved("authorizationCode")
        yield* desk.surface.click({ role: "button", name: "Authorize" })
        expect((yield* desk.post("/return", {
          operator: "r.mensah",
          classification: "resolved",
          detail: "Released the hold as an authorized supervisor SUP7 with 4417",
          nextTime: "always_stop_here"
        })).status).toBe(303)
      })
    })
    expect(outcome.result.result).toBe("success")
    const record = outcome.snapshot.resolved[0]!
    expect(record.observed).toEqual(expect.arrayContaining(["supervisorId", "authorizationCode"]))
    expect(classify(record)).toMatchObject({ _tag: "Learned", learnedClass: "requires_human" })
    expect(scanForSecrets(outcome.evidenceDirectory, ["SUP7", "4417"])).toEqual([])
    expect(JSON.stringify(record)).not.toContain("SUP7")
    expect(JSON.stringify(record)).not.toContain("4417")
    const amendment = proposeAmendment({ artifact: shippedArtifact(undefined, "1.1.0"), record, scrub: noScrubbing })
    expect(amendment._tag).toBe("Amended")
    if (amendment._tag === "Amended") {
      const declaration = amendment.amended.requiresHuman?.OPEN_ACCOUNT_REQUIRES_HUMAN
      expect(declaration?.discoveredFrom).toContain("supervisorId")
      expect(declaration?.discoveredFrom).toContain("authorizationCode")
      expect(declaration?.discoveredFrom).not.toContain("recorded no actions")
      expect(declaration?.summary).not.toContain("0 action(s)")
    }
  }), 60_000)

it.live("an observation note does not turn an untouched business outcome into a remedy", () =>
  Effect.gen(function* () {
    const outcome = yield* attendedReplay({
      artifact: shippedArtifact(undefined, "1.0.0"),
      inputs: { memberId: "88888" },
      operate: (desk) => Effect.gen(function* () {
        yield* desk.awaitPause
        yield* desk.post("/take", { operator: "j.okafor" })
        yield* desk.post("/note", { detail: "The list contains only a checking account." })
        yield* desk.post("/return", {
          operator: "j.okafor",
          classification: "unresolved",
          detail: "There is no savings account. I only inspected the account list.",
          nextTime: "automation_handles_it"
        })
      })
    })
    const record = outcome.snapshot.resolved[0]!
    expect(record.observed).toEqual([])
    expect(classify(record)).toMatchObject({ _tag: "Learned", learnedClass: "business_outcome" })
    const amendment = proposeAmendment({ artifact: shippedArtifact(undefined, "1.0.0"), record, scrub: noScrubbing })
    expect(amendment._tag).toBe("Amended")
    if (amendment._tag === "Amended") {
      expect(amendment.diff).toContain("recorded no actions on the live session")
      expect(amendment.diff).not.toContain("recorded 1 action(s)")
    }
  }), 60_000)

it.live("records and learns a confirmed click-only action on return", () =>
  Effect.gen(function* () {
    const outcome = yield* attendedReplay({
      artifact: shippedArtifact(undefined, "1.0.0"),
      inputs: { memberId: "88888" },
      operate: (desk) => Effect.gen(function* () {
        yield* desk.awaitPause
        yield* desk.post("/take", { operator: "j.okafor" })
        yield* desk.surface.click({ role: "link", name: "Primary Checking" })
        yield* desk.post("/return", {
          operator: "j.okafor",
          classification: "unresolved",
          detail: "Opened Primary Checking to inspect the alternative account.",
          actionTaken: "true",
          nextTime: "always_stop_here"
        })
      })
    })
    const record = outcome.snapshot.resolved[0]!
    expect(record.actions).toContainEqual(expect.objectContaining({
      detail: "Opened Primary Checking to inspect the alternative account.",
      kind: "confirmed_action"
    }))
    expect(classify(record)).toMatchObject({ _tag: "Learned", learnedClass: "requires_human" })
  }), 60_000)

it.live("a blocked operator teaches nothing even after observed input and explicit confirmation", () =>
  Effect.gen(function* () {
    const outcome = yield* attendedReplay({
      artifact: shippedArtifact(undefined, "1.1.0"),
      inputs: { memberId: "77777" },
      operate: (desk) => Effect.gen(function* () {
        yield* desk.awaitPause
        yield* desk.post("/take", { operator: "j.okafor" })
        yield* desk.surface.fill({ role: "textbox", name: "Supervisor ID" }, "SUP7")
        yield* desk.post("/return", {
          operator: "j.okafor",
          classification: "blocked",
          detail: "I do not have the authorization code.",
          actionTaken: "true",
          nextTime: "always_stop_here"
        })
      })
    })
    expect(outcome.result.result).toBe("intervention_required")
    expect(outcome.snapshot.resolved[0]!.observed).toContain("supervisorId")
    expect(classify(outcome.snapshot.resolved[0]!)).toMatchObject({ _tag: "NothingLearned" })
  }), 60_000)
