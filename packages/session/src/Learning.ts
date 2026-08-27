/**
 * What an Intervention taught, derived from what the Operator actually did.
 *
 * This module is ADR-0004 made executable:
 *
 * > Whether an unfamiliar state is a Business Outcome, a Recoverable Condition
 * > or a Requires-Human Outcome comes from what an Operator actually had to do
 * > to resolve it. Nothing at all, something reversible, or something requiring
 * > authority. It does not come from a configuration file naming known states in
 * > advance.
 *
 * SPEC's table, with the columns it is built from:
 *
 * | What they did       | The one question   | Learned as                       |
 * | ------------------- | ------------------ | -------------------------------- |
 * | nothing             | automation handles | `business_outcome`, declarable   |
 * | acted               | automation handles | `recoverable` rule, declarable   |
 * | acted               | always stop here   | `requires_human`, always-escalate|
 *
 * ## Why it takes two inputs and not one
 *
 * The Operator is asked exactly one question — should automation handle this
 * itself next time? — and that question cannot distinguish rows one and two on
 * its own, because the answer to both is yes. What separates them is evidence
 * the system already holds and did not have to ask for: the `actions` list.
 *
 * An Operator who observed a screen and returned control without touching
 * anything has demonstrated that the state is terminal and observational. There
 * is nothing to automate *doing*, so what automation should "handle" is
 * recognising it and reporting it — a Business Outcome. An Operator who did
 * something has demonstrated the opposite, and what automation would handle is
 * the remedy they performed.
 *
 * That asymmetry is the whole reason the classification is trustworthy. The
 * declarable half comes from behaviour, which nobody can fake by picking the
 * wrong radio button; the question only resolves the ambiguity behaviour leaves.
 * Reversing it — asking the Operator to name the class outright — is the
 * "smuggling the answer in as configuration" ADR-0004 exists to refuse.
 *
 * ## Where this ends up
 *
 * A `Learned` is an input to an Amendment and nothing else. It says what an
 * episode demonstrated; whether a document may take that on is a separate
 * question, answered by the ratchet in `@cua/artifact` — `atLeastAsStrictAs`
 * over the same `LearnedClass` this returns. Deriving a classification and being
 * allowed to write it down are kept apart on purpose: SPEC's write-once rule is
 * a property of the Artifact, not of the person at the terminal, and an Operator
 * confirming something the document may not accept has to be refused rather than
 * obeyed.
 */

import type { LearnedClass } from "@cua/artifact"
import type { InterventionRecord } from "./Intervention.ts"

/**
 * What an Intervention taught, or why it taught nothing.
 *
 * `nothing_learned` is a first-class member rather than an `undefined`, because
 * most Interventions teach nothing and the reason they did is worth reading. An
 * episode nobody attended, an Operator who was not asked, and an Operator who
 * said "always stop here" after fixing it by hand are three different facts, and
 * only the third is a `requires_human`.
 */
export type Learned =
  | {
      readonly _tag: "Learned"
      readonly learnedClass: LearnedClass
      /** The sentence that goes into the Amendment's provenance. */
      readonly because: string
    }
  | { readonly _tag: "NothingLearned"; readonly why: string }

/**
 * Read one closed Intervention record and say what it taught.
 *
 * Total, and deliberately dull. Every branch is one row of SPEC's table or one
 * reason there is no row, and nothing here consults the Artifact, the screen or
 * the failure — the whole input is what a person did and what they answered.
 */
export const classify = (record: InterventionRecord): Learned => {
  if (record.classification === undefined) {
    return { _tag: "NothingLearned", why: "the intervention is still open" }
  }
  if (record.classification === "unattended") {
    return {
      _tag: "NothingLearned",
      why: "nobody took control before the wait expired, so nothing was demonstrated"
    }
  }

  const operator = record.operator ?? "(unnamed)"
  const touched = record.actions.length > 0

  switch (record.nextTime) {
    case "not_asked":
      return {
        _tag: "NothingLearned",
        why: "control was returned without anybody being asked how to treat this state"
      }

    case "always_stop_here":
      // Rows two and three are separated here, and this is the half that needs
      // the guard. Saying "always stop here" about a state you did not touch is
      // not a Requires-Human Outcome: you have shown the state is observational
      // and then declined to let automation observe it, which is a preference
      // rather than a finding. It is refused rather than silently recorded,
      // because a `requires_human` entry can never be downgraded afterwards.
      return touched
        ? {
            _tag: "Learned",
            learnedClass: "requires_human",
            because:
              `${operator} resolved this by acting on the live session and confirmed that ` +
              `automation should always stop here rather than repeat what they did`
          }
        : {
            _tag: "NothingLearned",
            why:
              "the operator changed nothing and then asked automation to always stop, which " +
              "demonstrates an observational state rather than one needing authority"
          }

    case "automation_handles_it":
      return touched
        ? {
            _tag: "Learned",
            learnedClass: "recoverable",
            because:
              `${operator} returned the session to the expected state by hand and confirmed ` +
              `that automation should do the same thing itself next time`
          }
        : {
            // The row this ticket is built on. Nothing was done, and the person
            // who resolved it says automation should handle it — so the state is
            // terminal, observational, and an answer rather than a stop.
            _tag: "Learned",
            learnedClass: "business_outcome",
            because:
              `${operator} took control, observed the screen, changed nothing, and confirmed ` +
              `that automation should treat this state as an answer next time`
          }
  }
}

/** How the one question reads on the operator interface and in a report. */
export const THE_QUESTION =
  "Next time automation meets this state, should it handle it itself?"
