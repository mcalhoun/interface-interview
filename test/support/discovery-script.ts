/**
 * A deterministic stand-in for the model, shared by every suite that needs a
 * discovery run to actually happen.
 *
 * It lives here rather than in one test file because two suites need the same
 * run: `discovery-loop.test.ts` asserts what the loop did, and
 * `artifact-compiler.test.ts` compiles what the loop produced and replays the
 * result. Two copies of a stand-in that drives a real browser would drift, and
 * the second copy to drift would be the one whose failure means nothing.
 *
 * Everything below the model stays real — see `discovery-harness.ts`.
 */

import type { ScriptedCall } from "./scripted-model.ts"

export const GOAL = "Look up the savings account balance of member 12345"

/**
 * A deterministic stand-in that genuinely reacts to the screen.
 *
 * It reads the accessibility YAML out of the prompt and decides from it, which
 * is what makes it a fair exercise of the loop: if a Target stopped resolving, or
 * the iframe stopped being traversed, this would fail exactly as a real run
 * would.
 */
export const readsTheScreen = (prompt: string, turn: number): ScriptedCall => {
  if (prompt.includes("Available Balance")) {
    if (!prompt.includes("read \"")) {
      return {
        name: "extract",
        params: {
          intent: "read the available balance",
          rationale: "the figure sits in the cell beside the Available Balance caption",
          target: { role: "cell", label: "Available Balance" },
          bindAs: "read-available-balance"
        }
      }
    }
    return {
      name: "succeed",
      params: {
        rationale: "the balance the goal asked for has been read",
        summary: "Reads the available balance of a member's savings account",
        outputs: [{
          name: "availableBalance",
          fromStep: "read-available-balance",
          description: "the account's available balance"
        }]
      }
    }
  }

  if (prompt.includes("Share and Deposit Accounts")) {
    return {
      name: "selectFromList",
      params: {
        intent: "open the savings account",
        rationale: "the goal names savings and one account label carries that word",
        list: { within: { name: "Share and Deposit Accounts" }, itemRole: "link" },
        match: { kind: "goalDerived", name: "accountType", literal: "savings" },
        observedLabels: ["Primary Savings", "Checking"],
        discoveredFrom: "goal term 'savings' matched label 'Primary Savings'",
        robustness:
          "The account list is the only table of links on Member Detail, and matching by " +
          "token subset against the goal's own word survives a tenant that labels the " +
          "same account differently."
      }
    }
  }

  if (prompt.includes("Member Number Search")) {
    return turn === 0
      ? {
        name: "fill",
        params: {
          intent: "enter the member number",
          rationale: "the goal names a member and the search panel takes a member number",
          target: {
            role: "textbox",
            name: "Member Number",
            within: { name: "Member Number Search" }
          },
          value: { kind: "goalDerived", name: "memberId", literal: "12345" }
        }
      }
      : {
        name: "click",
        params: {
          intent: "run the member search",
          rationale: "the member number is entered, so submit the search",
          target: { role: "button", name: "Search", within: { name: "Member Number Search" } }
        }
      }
  }

  return {
    name: "escalate",
    params: { rationale: "unrecognised screen", code: "UNKNOWN_SCREEN", detail: "nothing matched" }
  }
}
