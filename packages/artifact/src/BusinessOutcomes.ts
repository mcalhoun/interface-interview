/**
 * The Business Outcomes a Capability knows about: its domain contract for the
 * answers that are not the happy path.
 *
 * CONTEXT.md: a Business Outcome is "an expected result of the application's own
 * domain that the caller needs to know about, such as a member not existing. A
 * legitimate answer, never a failure." The brief calls confusing one for a
 * failure the most common design mistake in this problem, and this module is
 * where the distinction is made structural rather than remembered.
 *
 * ## Why they are declared here rather than inferred
 *
 * The engine never decides that a screen means `MEMBER_NOT_FOUND`. It cannot: it
 * has no model, no heuristics and no list of known error phrases. It only checks
 * whether a condition an Artifact wrote down in advance is true right now.
 *
 * That is the constraint SPEC's error taxonomy imposes. A state becomes a
 * Business Outcome because of *what a human did when they met it* — observed it,
 * returned control, changed nothing — and that judgement is recorded into the
 * Artifact where a reviewer can see it and a diff can show it changing. Inferring
 * the class at run time from the shape of a page would smuggle the answer in as
 * cleverness; putting it in a config file the engine consults would smuggle it in
 * as configuration. Both make the classification unreviewable.
 *
 * So an outcome exists in exactly two halves, and both are in the Artifact:
 *
 *   - **the declaration**, here, saying what the code means to a caller;
 *   - **the branch**, on a Checkpoint (`orOutcome` in `Checkpoint.ts`), saying
 *     what has to be observed for that code to be the answer.
 *
 * `parseArtifact` refuses an Artifact where either half is missing, so a code a
 * caller could receive is always documented and a documented code is always
 * reachable.
 *
 * ## Seam for ticket 14 (requires-human states)
 *
 * SPEC's third class — a state learned to permanently need a person — is
 * declared the same way and lives beside this one, as `requiresHuman:` on the
 * Artifact. It is deliberately *not* modelled as an outcome with a flag: entries
 * there are write-once and can never be downgraded to a Business Outcome, and a
 * separate section is what makes that rule enforceable by looking at a diff.
 */

import { Schema } from "effect"

/**
 * The code a caller branches on: `MEMBER_NOT_FOUND`, `ACCOUNT_RESTRICTED`.
 *
 * Constrained to SCREAMING_SNAKE_CASE because it is an identifier in someone
 * else's `switch`, not a message. The prose that a human reads lives in `title`
 * and `summary`, which frees the code to stay stable while the wording improves.
 */
export const OutcomeCode = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/))
export type OutcomeCode = typeof OutcomeCode.Type

/**
 * What one code means. Written for two readers who never meet: the reviewer
 * approving the Artifact, and the agent that receives the code.
 */
export const OutcomeDeclaration = Schema.Struct({
  /**
   * One line, in the caller's terms, and the `detail` of the Replay result. It
   * says what is true of the domain, not what the automation did — "no member
   * record exists for the number searched", never "the checkpoint did not hold".
   */
  title: Schema.String,
  /**
   * Prose for whoever approves this Capability: what this state is, why it is a
   * legitimate answer rather than a fault, and what a caller should do about it.
   */
  summary: Schema.String,
  /**
   * How this outcome came to be declared — the Discovery run or the Intervention
   * that produced it, and who confirmed it.
   *
   * SPEC turns an Intervention in which the Operator observed and changed nothing
   * into a declarable Business Outcome. Recording the provenance is what makes
   * that promotion auditable rather than a document that quietly grew a section.
   */
  discoveredFrom: Schema.optional(Schema.String)
})
export type OutcomeDeclaration = typeof OutcomeDeclaration.Type

/** Every Business Outcome this Capability can return, keyed by code. */
export const OutcomeDeclarations = Schema.Record(OutcomeCode, OutcomeDeclaration)
export type OutcomeDeclarations = typeof OutcomeDeclarations.Type
