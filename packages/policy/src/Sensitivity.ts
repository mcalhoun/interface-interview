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
// ---------------------------------------------------------------------------
// The other half: text that is nobody's parameter
// ---------------------------------------------------------------------------

/**
 * One screen field whose *value* is personal, wherever it is read.
 *
 * ## Why a second mechanism at all
 *
 * Everything above is about **parameters**: values a caller supplied, which the
 * system holds as `Redacted` and knows the characters of before a browser opens.
 * That covers the member number. It does not cover the member's *name*, which no
 * caller supplied, which arrives off a screen as ordinary text, and which is
 * personal data the moment it is written into an event log. A scrubber that only
 * knows declared inputs cannot see it, and until this existed it did not.
 *
 * ## Why not simply treat all screen text as sensitive
 *
 * Because scrubbing is by literal occurrence with no field boundaries, and the
 * accessibility tree is the record of what the automation perceived. Redacting
 * all of it would leave an evidence file that proves nothing about anything --
 * including, specifically, the account list a `selectFromList` matched against,
 * which is the one part of the log that shows *why* a choice was made. The
 * `accountType` exception below exists for exactly that reason and a blanket
 * rule would swallow it and every argument for it.
 *
 * ## So: named fields, and what that honestly is
 *
 * A declared list of captions, reviewable in one file, whose adjacent value is
 * treated as sensitive on every screen it appears on. That is a **denylist**,
 * and it is worth saying so plainly rather than dressing it as deny-first: a
 * personal field on a screen nobody has looked at yet is not covered until
 * somebody adds it here. The alternative -- an allowlist over free text read off
 * an application nobody controls -- is not a rule that can be written.
 *
 * What makes it defensible rather than merely convenient is where it bites.
 * Redaction happens at the single serialisation point (`EvidenceWriter.record`),
 * the registration happens before the event that would first carry the value, and
 * the same set scrubs the text of an assisted-recovery consultation. So adding a
 * caption here covers the log, the screenshot note, the consultation and every
 * later mention, all at once; and `test/sensitive-data.test.ts` fails if a run
 * writes one of these values in the clear, so a regression is loud.
 */
export interface PersonalField {
  /** The caption as the application renders it, e.g. `Member Name`. */
  readonly caption: string
  /** What the placeholder is called: `[redacted:memberName]`. */
  readonly label: string
  /** Why this field is personal. An entry without one is one nobody can audit. */
  readonly because: string
}

/**
 * The fields this system treats as personal wherever a screen shows them.
 *
 * Two entries, and both are about *who the member is* rather than about what
 * they hold. Balances are deliberately not here: they are the answer the
 * capability exists to produce, they are already in the caller's hands, and a
 * run whose evidence cannot show the figure it returned proves nothing.
 */
export const personalFields: ReadonlyArray<PersonalField> = [
  {
    caption: "Member Name",
    label: "memberName",
    because:
      "A natural person's name, read off the account record. Nobody passed it in, so no " +
      "declared input covers it, and it is the single most identifying string on any of " +
      "these screens."
  },
  {
    caption: "Tax ID",
    label: "taxId",
    because:
      "A government identifier. Heritage Core renders it masked, which is the application's " +
      "choice and not a control this system owns: the last four digits are still enough to " +
      "confirm an identity somebody already half-knows."
  }
]

/** The captions to look for on a screen. What the engine hands the surface. */
export const personalCaptions: ReadonlyArray<string> = personalFields.map(
  (field) => field.caption
)

/** The placeholder label for a caption, or `undefined` if it is not declared. */
export const personalLabelFor = (caption: string): string | undefined =>
  personalFields.find((field) => field.caption === caption)?.label

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
