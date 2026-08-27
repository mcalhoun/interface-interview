/**
 * Turning a `selectFromList` Action into the control to press.
 *
 * The whole of this module is a pure function from an observed accessibility
 * tree plus a parameter to either a Target or a failure. No Effect, no services,
 * no browser — which matters more than tidiness: it is the reason the choice a
 * run makes is reproducible from the Evidence, because the tree it was made from
 * is the tree the `observe` event already recorded.
 *
 * ## What it produces, and why that is a Target
 *
 * Selection reads the live list, matches the parameter against the item labels
 * by token subset, and hands back an ordinary `Target` naming the item it chose
 * — `link "Primary Savings"`, scoped to the same list. The Action then proceeds
 * as a click, through the same chokepoint and the same adapter call as any other
 * click.
 *
 * That indirection is deliberate three times over. Policy sees the actual
 * control that is about to be pressed rather than an abstract "select
 * something", so ticket 07 classifies the real subject. The adapter re-resolves
 * against a fresh snapshot at the moment of acting, so nothing carries a stale
 * accessibility ref across a page load. And the engine gains no new way to touch
 * the Surface, which is what keeps the chokepoint count in
 * `test/replay-has-no-model.test.ts` meaningful.
 *
 * ## Sensitivity
 *
 * The wanted value may be a sensitive input, and a rationale ends up in both
 * Evidence and a failure report. `describedAs` names the parameter instead of
 * quoting it whenever the Artifact classifies it as sensitive, so the record
 * says "the value of parameter accountType" rather than the value itself. An
 * item's *label* is screen text, not a runtime value, and is quoted freely —
 * that is what makes a no-match diagnosable.
 */

import {
  type ItemList,
  type ResolvedInputs,
  type SelectFromListAction,
  type ValueRef,
  describeItemList,
  noMatchCode,
  noMatchOutcome
} from "@cua/artifact"
import { type AccessibilityNode, type Target, selectFromTree } from "@cua/surface"
import type { ReplayFailureBody } from "./ReplayResult.ts"

/** What the engine gets back: a control to press, or the reason there is none. */
export type Choice =
  | {
      readonly _tag: "Chosen"
      readonly target: Target
      /** The item's label, exactly as the screen showed it. */
      readonly label: string
      /** Every step of the reasoning, for the `action` Evidence event. */
      readonly rationale: string
    }
  | { readonly _tag: "Unchosen"; readonly failure: ReplayFailureBody }
  /**
   * Nothing matched, and the Artifact says what that means.
   *
   * The same observation as `Unchosen` with a `no_matching_item` failure — the
   * list rendered, and nothing in it carried the tokens asked for. What differs
   * is that a person has since met this state, changed nothing, and confirmed
   * that it is the application answering rather than the automation failing, and
   * an Amendment wrote that into the document as `onNoMatch: { outcome: ... }`.
   *
   * It is a separate constructor rather than a flag on `Unchosen` because the
   * two travel opposite ways out of the engine: this one is a *result*, on the
   * success channel, and nothing is allowed to turn it back into a failure by
   * forgetting to check a boolean.
   */
  | {
      readonly _tag: "Declared"
      readonly code: string
      /** Why this is the answer, in the same words the failure would have used. */
      readonly because: string
    }

export interface ChoiceContext {
  readonly inputs: ResolvedInputs
  /** The state the Step observed. Selection is made against this and no other. */
  readonly tree: AccessibilityNode
  readonly url: string
}

/**
 * Names a value in prose without leaking it.
 *
 * An input is sensitive unless the Artifact says otherwise in writing
 * (ADR-0008), so the default here is the careful one: a parameter is described
 * rather than quoted unless it was explicitly declared safe to print. A constant
 * is Artifact text and always quotable; a Step reading is screen text and named
 * by the Step that read it.
 */
const describeWanted = (inputs: ResolvedInputs, ref: ValueRef, wanted: string): string => {
  switch (ref.from) {
    case "parameter":
      return inputs.get(ref.name)?.sensitive === false
        ? JSON.stringify(wanted)
        : `the value of parameter ${ref.name}`
    case "constant":
      return JSON.stringify(wanted)
    case "step":
      return `what step ${ref.step} read`
  }
}

/**
 * The Target naming one item of a list.
 *
 * `exact: true` because the label came off the live screen a moment ago, so
 * there is nothing to be gained from a containment fallback and a great deal to
 * be lost: `Savings` containing-matching both `Primary Savings` and `Regular
 * Savings` is precisely the ambiguity selection just finished resolving. The
 * list's own scope is carried over, so a same-named control elsewhere on the
 * screen cannot be pressed by accident.
 */
const targetForItem = (list: ItemList, label: string): Target => ({
  role: list.itemRole,
  name: label,
  exact: true,
  ...(list.within === undefined ? {} : { within: list.within })
})

/**
 * Reads the live list and decides which item the parameter meant.
 *
 * `wanted` is resolved by the caller, because `resolveValue` is the single place
 * a `ValueRef` becomes text and ticket 08 turns that into the one explicit
 * unwrap of a `Redacted`.
 */
export const chooseItem = (
  context: ChoiceContext,
  action: SelectFromListAction,
  wanted: string
): Choice => {
  const said = describeWanted(context.inputs, action.match.against, wanted)
  const list = describeItemList(action.list)
  const selection = selectFromTree(context.tree, {
    list: action.list,
    wanted,
    describedAs: said
  })

  switch (selection._tag) {
    case "Selected":
      return {
        _tag: "Chosen",
        target: targetForItem(action.list, selection.item.label),
        label: selection.item.label,
        rationale: selection.rationale
      }

    case "NoMatch": {
      // The one place a document's classification of this state is read. A
      // Capability that has learned what an empty match means returns it as an
      // answer; one that has not stops, and the Recovery Ladder takes over.
      const declared = noMatchOutcome(action.onNoMatch)
      if (declared !== undefined) {
        return {
          _tag: "Declared",
          code: declared,
          because: `${selection.rationale}; the capability declares that state as ${declared}`
        }
      }
      return {
        _tag: "Unchosen",
        failure: {
          reason: "no_matching_item",
          code: noMatchCode(action.onNoMatch),
          list,
          items: selection.items.map((item) => item.label),
          url: context.url,
          expected: `one of the ${list} to carry every token of ${said}`,
          observed: selection.rationale
        }
      }
    }

    case "AmbiguousMatch":
      return {
        _tag: "Unchosen",
        failure: {
          reason: "ambiguous_match",
          code: action.onMultiple.escalate,
          list,
          candidates: selection.matches.map((match) => match.label),
          url: context.url,
          expected: `exactly one of the ${list} to carry every token of ${said}`,
          observed: selection.rationale
        }
      }
  }
}
