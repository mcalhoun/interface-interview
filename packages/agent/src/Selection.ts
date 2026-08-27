/**
 * The one mistake a Discovery run must not be allowed to make.
 *
 * When the model chooses from a list, two words are in play: the word the **goal**
 * used (`savings`) and the label the **screen** offered (`Primary Savings`). The
 * capability records one of them as the parameter's default, and which one it
 * records decides whether the capability works anywhere else.
 *
 * Token subset matching runs one direction (`isTokenSubsetOf(wanted, label)`,
 * ADR-0007):
 *
 *     "Savings"         ⊂ "Primary Savings"   ✓
 *     "Savings"         ⊂ "Regular Savings"   ✓     <- another tenant, no change
 *     "Primary Savings" ⊄ "Regular Savings"   ✗     <- and this is the trap
 *
 * So recording the *matched label* produces a document that works at exactly one
 * institution and looks perfectly correct while doing it. Nothing downstream can
 * detect it: `Primary Savings` is a legal enum value, `parseArtifact` accepts it,
 * and the failure only shows up as a `NO_MATCHING_ITEM` at a tenant nobody has
 * run against yet. Ticket 09's handoff calls this "the one mistake that would
 * silently un-do multi-tenant reuse", and it is the reason this module exists as
 * a check rather than as a sentence in a prompt.
 *
 * ## The rule
 *
 * The match value must be `goalDerived`, and `Provenance.checkProvenance` already
 * requires every token of a `goalDerived` literal to appear in the Goal text. That
 * single requirement is what rejects `Primary Savings`: the Goal said "savings"
 * and never said "primary". The prompt asks for the right thing; this makes
 * asking unnecessary.
 *
 * Two further checks are cheap and catch the rest:
 *
 *   - the match has to be a token subset of at least one label actually on offer,
 *     so a run cannot record a rule that never matched anything, and
 *   - the labels have to be non-empty, because they become the enum's `values`
 *     and an empty list gives a reviewer nothing to check the default against.
 */

import { isTokenSubsetOf } from "@cua/surface"
import type { ProvenancedValue } from "./Provenance.ts"

/** Why a proposed selection was refused, in words meant for the model. */
export interface UnusableSelection {
  readonly complaint: string
}

export interface ProposedSelection {
  readonly match: ProvenancedValue
  readonly observedLabels: ReadonlyArray<string>
  readonly discoveredFrom: string
}

/**
 * Whether a proposed selection can be recorded, given the Goal it came from.
 *
 * Returns `undefined` when it can. The complaints spell out the multi-tenant
 * consequence rather than only naming the rule, because a model told "that is
 * invalid" tries a synonym, and a model told why tries the right thing.
 */
export const checkSelection = (
  selection: ProposedSelection,
  goal: string
): UnusableSelection | undefined => {
  if (selection.observedLabels.length === 0) {
    return {
      complaint:
        "list every label the screen is offering in `observedLabels`. They become " +
        "the legal values of the parameter, and a reviewer has to be able to see " +
        "what the choice was made among."
    }
  }

  if (selection.match.kind !== "goalDerived") {
    return {
      complaint:
        "the value you match on has to be goalDerived and has to name the " +
        "parameter it becomes, for example accountType. A selection matched on a " +
        "constant is a capability that can only ever choose one thing."
    }
  }

  const wanted = selection.match.literal

  // Checked here as well as in `checkProvenance`, deliberately. This is THE
  // mistake — recording `Primary Savings` where the goal said `savings` — and it
  // is worth having the rule stated in the module that exists to prevent it,
  // where a reader looking for it will find it, and testable without assembling a
  // provenance check first. The duplication is the cheapest possible insurance
  // against a later refactor moving the other check somewhere it no longer runs.
  if (!isTokenSubsetOf(wanted, goal)) {
    return {
      complaint:
        `${JSON.stringify(wanted)} does not come from the goal. Match on the goal's own ` +
        `word, not on the label you matched it against: the label belongs to this ` +
        `institution, and recording it would stop the capability working at one that ` +
        `spells the same thing differently.`
    }
  }

  const matched = selection.observedLabels.filter((label) => isTokenSubsetOf(wanted, label))
  if (matched.length === 0) {
    return {
      complaint:
        `${JSON.stringify(wanted)} does not match any label on offer ` +
        `(${selection.observedLabels.map((label) => JSON.stringify(label)).join(", ")}). ` +
        `Matching is by token subset: every word of your value has to appear in the ` +
        `label. Choose the word from the goal that does that.`
    }
  }
  if (matched.length > 1) {
    return {
      complaint:
        `${JSON.stringify(wanted)} matches more than one item ` +
        `(${matched.map((label) => JSON.stringify(label)).join(", ")}), so it does not say ` +
        `which one you mean. An ambiguous match stops a replay rather than guessing, so ` +
        `it cannot be recorded as a capability.`
    }
  }

  if (selection.discoveredFrom.trim() === "") {
    return {
      complaint:
        "say how you got from the goal's word to the label you matched, e.g. " +
        "\"goal term 'savings' ⊂ label 'Primary Savings'\". It is recorded as the " +
        "parameter's provenance and it is what a reviewer checks your inference against."
    }
  }

  return undefined
}

/**
 * The label the match landed on.
 *
 * Reported in Evidence and in the trajectory so a reader can see both words at
 * once — the goal's and the screen's — and check that the right one was recorded
 * as the parameter. Never itself recorded as the default.
 */
export const matchedLabel = (
  selection: ProposedSelection
): string | undefined => {
  if (selection.match.kind !== "goalDerived") return undefined
  const wanted = selection.match.literal
  return selection.observedLabels.find((label) => isTokenSubsetOf(wanted, label))
}
