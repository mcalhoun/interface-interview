/**
 * Which parameters Policy allows to appear in Evidence in the clear.
 *
 * ADR-0008: "Every parameter discovered from a Goal counts as sensitive unless
 * Policy allowlists it otherwise." So the authority sits here rather than in the
 * Artifact. An Artifact is a discovered document — from ticket 11 onward a model
 * writes it — and a document that can declassify itself is not a control. It gets
 * to *request* clear treatment with `sensitive: false`; this file is the second
 * signature, and `classifySensitive` in `@cua/artifact` requires both.
 *
 * ## Why this is data and not a service
 *
 * `prepareInputs` is a pure `Result` that requires no services, which is how "a
 * bad call never opens a browser" is a property of the signature rather than of
 * statement order (SPEC user story 30). Handing it a `Policy` service would undo
 * that. So the sensitivity half of Policy is a plain value, read before anything
 * is provided, and `declassifierFor` narrows it to the predicate
 * `prepareInputs` takes. Nothing here imports `@cua/artifact`: the predicate type
 * is structural, so the dependency runs one way.
 *
 * ## Ticket 07
 *
 * The origin allowlist and action-type risk classification belong beside this, as
 * one reviewable configuration document rather than two. `Policy.ts` holds the
 * runtime chokepoint; this holds the first piece of its configuration.
 */

/** One approved exception to "everything is sensitive", and the reason for it. */
export interface Declassification {
  /** The Capability the exception is scoped to. Never workspace-wide. */
  readonly capability: string
  readonly parameter: string
  /**
   * Why a reviewer signed this off. Required, and it lands in the run's Evidence
   * note — an allowlist entry with no stated reason is the one nobody can audit.
   */
  readonly because: string
}

export interface SensitivityPolicy {
  readonly declassified: ReadonlyArray<Declassification>
  /** One line for the Evidence record, so a run says what policy it ran under. */
  readonly summary: string
}

/**
 * The deny-first policy: nothing is declassified.
 *
 * This is what the system ships with, and what any construction that forgets to
 * pass a policy gets. Every parameter of every Capability is scrubbed out of text
 * Evidence.
 */
export const nothingDeclassified: SensitivityPolicy = {
  declassified: [],
  summary: "deny-first: every parameter is treated as sensitive (ADR-0008)"
}

/**
 * A policy with named exceptions.
 *
 * Exceptions are per Capability and per parameter. A parameter that is harmless
 * in one Capability is not thereby harmless in another, and a wildcard would make
 * the next Capability inherit a decision nobody made about it.
 */
export const declassifying = (
  declassified: ReadonlyArray<Declassification>
): SensitivityPolicy => ({
  declassified,
  summary:
    declassified.length === 0
      ? nothingDeclassified.summary
      : `deny-first, with ${declassified.length} reviewed exception(s): ${
        declassified.map((entry) => `${entry.capability}.${entry.parameter}`).join(", ")
      }`
})

/**
 * The predicate `prepareInputs` takes, narrowed to one Capability.
 *
 * Returning `true` means "Policy is content for this value to appear in Evidence
 * in the clear". It is only half the decision — the Artifact still has to have
 * asked.
 */
export const declassifierFor = (
  policy: SensitivityPolicy,
  capability: string
): (parameter: string) => boolean =>
(parameter) =>
  policy.declassified.some(
    (entry) => entry.capability === capability && entry.parameter === parameter
  )

/**
 * The policy every entry point uses.
 *
 * One entry, and it earns its place. Everything about a member stays sensitive:
 * the identifier, and by consequence the account number that embeds it.
 *
 * `accountType` is different in kind. It is the name of a product an institution
 * offers, it is on every screenshot of the account list already, and it says
 * nothing about who the member is. Scrubbing it would also be actively harmful
 * here, because scrubbing replaces literal occurrences: treating "Savings" as
 * secret would blank the word out of the account list in the accessibility tree,
 * which is the one part of the Evidence that shows what the selection was
 * choosing between and why it chose. A control that destroys the record of its
 * own decision is not protecting anything.
 */
export const sensitivityPolicy: SensitivityPolicy = declassifying([
  {
    capability: "member.account-balance",
    parameter: "accountType",
    because:
      "A product label the institution prints on the account list itself, carrying " +
      "nothing about the member. Scrubbing it by literal occurrence would erase the " +
      "list the selection matched against, destroying the evidence of the choice."
  }
])
