import { describe, expect, it } from "vitest"
import { parseArguments } from "../apps/cli/src/arguments.ts"

const contract = { switches: ["json", "headed"], options: ["model"], maxPositionals: 1 }
describe("CLI argument boundary", () => {
  it("never consumes the goal after a declared boolean switch", () => {
    expect(parseArguments(["--json", "--headed", "a goal", "--model", "chosen"], contract)).toEqual({
      positionals: ["a goal"], switches: new Set(["json", "headed"]), options: { model: "chosen" }
    })
  })
  it("preserves arbitrary replay input options for schema validation", () => {
    expect(parseArguments(["--json", "lookup", "--memberId", "12345", "--accountType=savings"], {
      ...contract, allowInputOptions: true
    }).options).toEqual({ memberId: "12345", accountType: "savings" })
  })
  it("rejects ambiguous and malformed arguments", () => {
    for (const argv of [["--model"], ["--json=true"], ["--unknown", "value"], ["a", "b"], ["--model", "a", "--model", "b"]]) {
      expect(() => parseArguments(argv, contract)).toThrow()
    }
    expect(() => parseArguments(["--__proto__", "value"], { ...contract, allowInputOptions: true })).toThrow()
  })
  it("allows an explicit positional boundary", () => {
    expect(parseArguments(["--", "--a goal"], contract).positionals).toEqual(["--a goal"])
  })
})
