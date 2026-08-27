/**
 * The action vocabulary, and the two rules that keep a Discovery run honest.
 *
 * Three claims are checked here, all of them deterministic and none of them
 * needing a model:
 *
 *   1. **A malformed or out-of-vocabulary action is not representable.** SPEC
 *      wants that to be a property of the Schema rather than of hand-written
 *      parsing, so the tests go through `proposalFrom`, which is the only door.
 *   2. **Provenance survives contact with the Goal.** A `goalDerived` value has
 *      to come from the goal and a `constant` must not — ADR-0008's rule, checked
 *      at the moment of proposal rather than at emission.
 *   3. **A selection records the goal's word, not the screen's label.** Ticket
 *      09's warning, and the one mistake that would silently un-do multi-tenant
 *      reuse.
 */

import { expect, it } from "vitest"
import {
  DISCOVERY_VERBS,
  SURFACE_VERBS,
  checkProvenance,
  checkSelection,
  isUndecodable,
  matchedLabel,
  proposalFrom
} from "@cua/agent"
import { ACTION_TYPES, riskOf } from "@cua/policy"
import { TargetSchema, isTokenSubsetOf } from "@cua/surface"
import { Schema } from "effect"

const GOAL = "Look up the savings account balance of member 12345"
const NOTHING_READ = new Set<string>()

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

it("the surface verbs are exactly the action types policy can classify", () => {
  // Policy is the backstop, not the first line (ticket 07's note to ticket 10).
  // The two lists drifting apart would mean either a verb the model can propose
  // that can only ever be denied, or a surface action Policy has never had an
  // opinion about.
  expect([...SURFACE_VERBS].sort()).toEqual([...ACTION_TYPES].sort())

  // And every one of them is classified. `unknown` is always denied, so a verb
  // landing there would be a verb the model could never use.
  for (const verb of SURFACE_VERBS) {
    expect(riskOf(verb), `${verb} is unclassified`).not.toBe("unknown")
  }
})

it("the two verbs that end a run are outside policy's vocabulary, deliberately", () => {
  // `succeed` and `escalate` touch no surface, so there is nothing for an origin
  // allowlist to judge. They are in the model's vocabulary and not in Policy's,
  // and that asymmetry is intentional rather than an oversight.
  const terminal = DISCOVERY_VERBS.filter((verb) => !SURFACE_VERBS.includes(verb as never))
  expect(terminal.sort()).toEqual(["escalate", "succeed"])
  for (const verb of terminal) expect(riskOf(verb)).toBe("unknown")
})

it("an invented verb does not decode, and says what is available", () => {
  const proposal = proposalFrom("executeScript", { script: "alert(1)" })
  expect(isUndecodable(proposal)).toBe(true)
  if (!isUndecodable(proposal)) return
  expect(proposal.complaint).toContain("executeScript")
  expect(proposal.complaint).toContain("selectFromList")
})

it("arguments that do not match the schema do not decode", () => {
  // A fill with no value at all.
  const missing = proposalFrom("fill", {
    intent: "type it",
    rationale: "because",
    target: { role: "textbox" }
  })
  expect(isUndecodable(missing)).toBe(true)

  // A fill whose value is a bare string. This is the shape SPEC forbids: the
  // whole point of provenance is that this cannot be expressed.
  const bare = proposalFrom("fill", {
    intent: "type it",
    rationale: "because",
    target: { role: "textbox" },
    value: "12345"
  })
  expect(isUndecodable(bare)).toBe(true)
})

it("a selector cannot survive decoding, because the target has nowhere to put one", () => {
  // ADR-0001, checked at the boundary rather than asserted. A model that has only
  // ever seen an accessibility tree has no markup to write a selector from, but
  // the interesting case is the one where it invents one anyway.
  const smuggled = proposalFrom("click", {
    intent: "press it",
    rationale: "because",
    target: { role: "button", selector: "#search-btn", css: ".btn", xpath: "//button" }
  })
  expect(isUndecodable(smuggled)).toBe(false)
  if (isUndecodable(smuggled) || smuggled.verb !== "click") return

  // The Target that comes out the other side carries the role and nothing else.
  // The selector is not rejected, it simply ceases to exist: there is no field on
  // `Target` for it to occupy, so nothing downstream could read it even by
  // reaching around the adapter.
  expect(Object.keys(smuggled.target)).toEqual(["role"])
  expect(JSON.stringify(smuggled.target)).not.toContain("search-btn")

  // And the model is told as much in the first place: the JSON Schema the tool
  // definition sends forbids properties the Target does not declare.
  const schema = JSON.stringify(Schema.toJsonSchemaDocument(TargetSchema))
  expect(schema).toContain("\"additionalProperties\":false")
  expect(schema).not.toContain("selector")
})

it("a well-formed action decodes into a typed proposal", () => {
  const proposal = proposalFrom("fill", {
    intent: "enter the member number",
    rationale: "the goal names a member",
    target: { role: "textbox", name: "Member Number" },
    value: { kind: "goalDerived", name: "memberId", literal: "12345" }
  })
  expect(isUndecodable(proposal)).toBe(false)
  if (isUndecodable(proposal)) return
  expect(proposal.verb).toBe("fill")
})

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

it("a goal-derived value has to actually come from the goal", () => {
  expect(
    checkProvenance(
      { kind: "goalDerived", name: "memberId", literal: "12345" },
      GOAL,
      NOTHING_READ
    )
  ).toBeUndefined()

  // Read off the screen and mislabelled as coming from the goal. This is how a
  // capability acquires a parameter whose default nobody can supply.
  const invented = checkProvenance(
    { kind: "goalDerived", name: "branch", literal: "001" },
    GOAL,
    NOTHING_READ
  )
  expect(invented?.complaint).toContain("does not appear")
  expect(invented?.complaint).toContain("uiDerived")
})

it("a goal-derived value has to name the parameter it becomes", () => {
  const unnamed = checkProvenance(
    { kind: "goalDerived", name: "", literal: "12345" },
    GOAL,
    NOTHING_READ
  )
  expect(unnamed?.complaint).toContain("semantic role")
})

it("a constant that collides with the goal is refused (ADR-0008)", () => {
  // The failure this closes: a lazily-tagged action bakes a member ID into a
  // stored capability. `bakedInLiterals` is the backstop at emission; this is the
  // same rule one stage earlier, where the model can still be told to re-tag.
  const baked = checkProvenance({ kind: "constant", literal: "12345" }, GOAL, NOTHING_READ)
  expect(baked?.complaint).toContain("bake")
  expect(baked?.complaint).toContain("goalDerived")

  // Containment, not equality: `member 12345` is the shape the mistake takes.
  expect(checkProvenance({ kind: "constant", literal: "member 12345" }, GOAL, NOTHING_READ))
    .toBeDefined()

  // A genuinely fixed value is fine.
  expect(checkProvenance({ kind: "constant", literal: "Search" }, GOAL, NOTHING_READ))
    .toBeUndefined()
})

it("a ui-derived value has to name a step that read something", () => {
  const dangling = checkProvenance(
    { kind: "uiDerived", fromStep: "read-account-number" },
    GOAL,
    NOTHING_READ
  )
  expect(dangling?.complaint).toContain("read-account-number")

  expect(
    checkProvenance(
      { kind: "uiDerived", fromStep: "read-account-number" },
      GOAL,
      new Set(["read-account-number"])
    )
  ).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Selection: ticket 09's warning
// ---------------------------------------------------------------------------

const LABELS = ["Primary Savings", "Checking"]

/** The region the account list sits in. Required on every proposal; see below. */
const WITHIN = { name: "Share and Deposit Accounts" }

it("a selection records the goal's own word", () => {
  const good = checkSelection(
    {
      match: { kind: "goalDerived", name: "accountType", literal: "savings" },
      observedLabels: LABELS,
      within: WITHIN,
      discoveredFrom: "goal term 'savings' matched label 'Primary Savings'"
    },
    GOAL
  )
  expect(good).toBeUndefined()
})

it("a selection that records the matched label instead is refused", () => {
  // THE mistake. `Primary Savings` is a perfectly good enum value and every
  // downstream check would accept it; it simply stops working at a tenant that
  // calls the same account `Regular Savings`, and nothing would notice until a
  // run there failed. So it is refused here, where it can still be corrected.
  const bad = checkSelection(
    {
      match: { kind: "goalDerived", name: "accountType", literal: "Primary Savings" },
      observedLabels: LABELS,
      within: WITHIN,
      discoveredFrom: "matched the label"
    },
    GOAL
  )
  expect(bad).toBeDefined()
  expect(bad?.complaint).toContain("does not come from the goal")

  // And the reason multi-tenant reuse depends on it, stated as the property:
  // the goal's word travels, the tenant's label does not.
  expect(isTokenSubsetOf("savings", "Regular Savings")).toBe(true)
  expect(isTokenSubsetOf("Primary Savings", "Regular Savings")).toBe(false)
})

it("a selection matched on a constant is refused", () => {
  const fixed = checkSelection(
    {
      match: { kind: "constant", literal: "Checking" },
      observedLabels: LABELS,
      within: WITHIN,
      discoveredFrom: "it is always checking"
    },
    GOAL
  )
  expect(fixed?.complaint).toContain("goalDerived")
})

it("a selection has to match exactly one of the labels on offer", () => {
  const nothing = checkSelection(
    {
      match: { kind: "goalDerived", name: "accountType", literal: "balance" },
      observedLabels: LABELS,
      within: WITHIN,
      discoveredFrom: "guessing"
    },
    GOAL
  )
  expect(nothing?.complaint).toContain("does not match any label")

  // Two savings accounts: ambiguity stops a replay rather than choosing, so it
  // cannot be recorded as a capability either.
  const ambiguous = checkSelection(
    {
      match: { kind: "goalDerived", name: "accountType", literal: "savings" },
      observedLabels: ["Primary Savings", "Regular Savings"],
      within: WITHIN,
      discoveredFrom: "goal term 'savings'"
    },
    GOAL
  )
  expect(ambiguous?.complaint).toContain("more than one")
})

it("a selection has to name the region the list sits in", () => {
  // Found by a live model-driven run, which proposed a list with no scope. Two
  // things went wrong at once: the declared legal values picked up the page's
  // navigation link ("Return to Member Search" became an account type), and the
  // step that reached the screen had no named region to be checked against, so
  // the compiler refused the whole document for an uncheckable step.
  const unscoped = checkSelection(
    {
      match: { kind: "goalDerived", name: "accountType", literal: "savings" },
      observedLabels: [...LABELS, "Return to Member Search"],
      discoveredFrom: "goal term 'savings'"
    },
    GOAL
  )
  expect(unscoped?.complaint).toContain("list.within.name")

  // A region named but blank is the same thing wearing a field.
  expect(
    checkSelection(
      {
        match: { kind: "goalDerived", name: "accountType", literal: "savings" },
        observedLabels: LABELS,
        within: { name: "  " },
        discoveredFrom: "goal term 'savings'"
      },
      GOAL
    )?.complaint
  ).toContain("list.within.name")
})

it("a selection has to find something, and has to say how it inferred", () => {
  expect(
    checkSelection(
      {
        match: { kind: "goalDerived", name: "accountType", literal: "savings" },
        observedLabels: [],
        within: WITHIN,
        itemRole: "link",
        discoveredFrom: "goal term 'savings'"
      },
      GOAL
    )?.complaint
  ).toContain("no link items sit inside the region")

  expect(
    checkSelection(
      {
        match: { kind: "goalDerived", name: "accountType", literal: "savings" },
        observedLabels: LABELS,
        within: WITHIN,
        discoveredFrom: "   "
      },
      GOAL
    )?.complaint
  ).toContain("provenance")
})

it("the matched label is reported but is not the recorded default", () => {
  const selection = {
    match: { kind: "goalDerived", name: "accountType", literal: "savings" } as const,
    observedLabels: LABELS,
    within: WITHIN,
    discoveredFrom: "goal term 'savings'"
  }
  // Both words are available to a reader; only one of them is the default.
  expect(matchedLabel(selection)).toBe("Primary Savings")
  expect(selection.match.literal).toBe("savings")
})
