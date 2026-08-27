/**
 * Input validation, and the fact that it happens before a browser opens.
 *
 * SPEC user story 30 wants bad calls to "fail fast and cheap". The way that is
 * made true here is structural rather than procedural: `prepareInputs` returns a
 * `Result` and requires no services, so it *cannot* have opened a browser. The
 * first test is a type-level assertion of exactly that, in the same spirit as the
 * no-model proof one level up.
 */

import { expect, it } from "vitest"
import { Effect, Result } from "effect"
import { prepareInputs } from "@cua/artifact"
import { shippedArtifact } from "./support/replay-harness.ts"

const inputsOf = () => shippedArtifact().inputs

it("validation is a pure Result, so it cannot have touched a surface", () => {
  const validated = prepareInputs("member.account-balance", inputsOf(), { memberId: "12345" })

  // Not an Effect, so it has no services to require and no browser to open. If
  // this ever became an Effect the assignment below would stop compiling, and
  // "validated before a browser opens" would go back to being a claim about the
  // order of statements somewhere.
  expect(Effect.isEffect(validated)).toBe(false)
  const pure: Result.Result<unknown, unknown> = validated
  expect(Result.isResult(pure)).toBe(true)

  expect(Result.isSuccess(validated)).toBe(true)
  if (!Result.isSuccess(validated)) return
  expect(validated.success.get("memberId")).toEqual({
    name: "memberId",
    text: "12345",
    sensitive: true
  })
})

it("rejects a missing required input, a malformed one, and an unknown one", () => {
  const missing = prepareInputs("member.account-balance", inputsOf(), {})
  expect(Result.isFailure(missing)).toBe(true)
  if (Result.isFailure(missing)) expect(missing.failure.message).toContain("memberId is required")

  const malformed = prepareInputs("member.account-balance", inputsOf(), { memberId: "not-a-number" })
  expect(Result.isFailure(malformed)).toBe(true)

  // An unknown argument is rejected rather than ignored. A caller who typos
  // `--memberID` and gets a run against something else is worse off than one who
  // gets told.
  const unknown = prepareInputs("member.account-balance", inputsOf(), {
    memberId: "12345",
    memberID: "99999"
  })
  expect(Result.isFailure(unknown)).toBe(true)
  if (Result.isFailure(unknown)) expect(unknown.failure.message).toContain("memberID")
})

it("never quotes the offending value back, because inputs are sensitive by default", () => {
  const malformed = prepareInputs("member.account-balance", inputsOf(), { memberId: "4419-secret" })
  expect(Result.isFailure(malformed)).toBe(true)
  if (!Result.isFailure(malformed)) return

  // An error string is one of the easier ways for a member identifier to end up
  // in a log, so a rejection describes the rule rather than repeating the value.
  expect(malformed.failure.message).not.toContain("4419-secret")
  expect(malformed.failure.message).toContain("pattern")
})

it("fills an omitted optional input from its declared default", () => {
  const declarations = {
    accountType: {
      type: "enum" as const,
      description: "which account",
      values: ["Primary Savings", "Checking"],
      default: "Primary Savings",
      required: false,
      sensitive: false
    }
  }

  const defaulted = prepareInputs("selection", declarations, {})
  expect(Result.isSuccess(defaulted)).toBe(true)
  if (Result.isSuccess(defaulted)) {
    expect(defaulted.success.get("accountType")?.text).toBe("Primary Savings")
  }

  // And an enum value that is not one of the discovered ones is refused, which is
  // the guard ticket 09 relies on.
  const bogus = prepareInputs("selection", declarations, { accountType: "Money Market" })
  expect(Result.isFailure(bogus)).toBe(true)
})
