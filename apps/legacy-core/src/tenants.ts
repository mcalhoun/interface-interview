/**
 * The second institution.
 *
 * One vendor product, two customers. Heritage Financial Systems sells Member
 * Services to credit unions, and each one brands it, renames its fields from the
 * label table, calls its products what its members call them, and takes or
 * declines the optional framed account panel. None of that is a fork of the
 * product: it is the same 4.02.11 with a different configuration record, which
 * is exactly the situation SPEC's multi-tenant story is about.
 *
 * ## What a Tenant is allowed to differ in, and why it is these four things
 *
 * The four differences below are SPEC's table, and they were chosen because
 * three of them cost this system nothing and one of them costs it an Override.
 * That ratio is the argument:
 *
 * | Difference                                | Absorbed by                          |
 * | ----------------------------------------- | ------------------------------------ |
 * | `Member #` rather than `Member Number`     | token matching on the accessible name |
 * | `Regular Savings` / `Share Draft`          | `tokenSubset` selection (ADR-0007)   |
 * | account detail rendered inline, no iframe  | targeting was never frame-aware      |
 * | the submit button reads `Find`             | **nothing. This one needs an override** |
 *
 * `Find` and `Search` share no token in either direction, so no matching rule
 * that is not simply guessing can connect them. That is the point of it being
 * here: a fixture where everything is absorbed would prove only that the
 * differences were chosen to be absorbable.
 *
 * ## What is deliberately *not* configurable
 *
 * The panel headings — `Member Number Search`, `Share and Deposit Accounts` —
 * and the screen names, because in the real product those come from the vendor's
 * transaction catalogue rather than from the tenant's label table. A field
 * caption is a tenant's to set; the name of the transaction is not. That split
 * is not a convenience for this repository: it is what makes a scoped Target
 * (`within: { name: "Member Number Search" }`) worth writing in the first place,
 * and a fixture that let a tenant rename everything would be testing a different
 * product.
 */

/** Which institution's installation a page is being rendered for. */
export interface Tenant {
  /** The key `--tenant` takes, and the directory an Override is stored under. */
  readonly key: string
  /** The institution, as it reads in the banner. */
  readonly institution: string
  /** The strip under the banner: release, teller, branch. */
  readonly statusStrip: string
  /** How the copyright line at the foot of every screen reads. */
  readonly footer: string
  /** The prefix on every page's `<title>`. */
  readonly titlePrefix: string
  /**
   * What this institution calls the member number field on Member Search.
   *
   * The caption beside the control and the control's own `title` — which is
   * where its accessible name comes from, this application having no `<label>`
   * anywhere — are the same string, because that is how the label table works.
   */
  readonly memberNumberLabel: string
  /** What the search panel's submit button reads. */
  readonly searchButtonLabel: string
  /**
   * Whether Account Detail puts the figures in an iframe.
   *
   * Optional in the product, and the second tenant declined it. Nothing in a
   * Capability's Targets mentions frames, so this difference is invisible to
   * automation — which is a claim worth being able to test rather than assert.
   */
  readonly accountDetailInFrame: boolean
  /**
   * This institution's name for each product, keyed by the vendor's own.
   *
   * A missing entry means the tenant kept the vendor's wording, which is the
   * commonest case in the real product and the reason this is a lookup rather
   * than a total mapping.
   */
  readonly accountNames: Readonly<Record<string, string>>
}

export const HERITAGE_CORE: Tenant = {
  key: "heritage-core",
  institution: "HERITAGE CORE",
  statusStrip: "MSS 4.02.11&nbsp;&nbsp;|&nbsp;&nbsp;TELLER OPR001&nbsp;&nbsp;|&nbsp;&nbsp;BRANCH 001&nbsp;&nbsp;|&nbsp;&nbsp;F1 HELP&nbsp;&nbsp;F3 EXIT",
  footer: "HERITAGE FINANCIAL SYSTEMS INC&nbsp;&nbsp;ALL TRANSACTIONS LOGGED",
  titlePrefix: "Heritage Core",
  memberNumberLabel: "Member Number",
  searchButtonLabel: "Search",
  accountDetailInFrame: true,
  accountNames: {}
}

/**
 * Community Credit Union, running the same 4.02.11.
 *
 * Every field below is a configuration record a real institution would have
 * filled in differently, and none of it is a code change to the product.
 */
export const COMMUNITY_CU: Tenant = {
  key: "community-cu",
  institution: "COMMUNITY CU",
  statusStrip: "MSS 4.02.11&nbsp;&nbsp;|&nbsp;&nbsp;TELLER CCU014&nbsp;&nbsp;|&nbsp;&nbsp;BRANCH 004&nbsp;&nbsp;|&nbsp;&nbsp;F1 HELP&nbsp;&nbsp;F3 EXIT",
  footer: "HERITAGE FINANCIAL SYSTEMS INC&nbsp;&nbsp;ALL TRANSACTIONS LOGGED",
  titlePrefix: "Community CU",
  // Shorter, the way a screen laid out for a narrower caption column ends up.
  memberNumberLabel: "Member #",
  // The one difference no matching rule can absorb. "Find" and "Search" have no
  // token in common, and pretending otherwise would be guessing.
  searchButtonLabel: "Find",
  accountDetailInFrame: false,
  accountNames: {
    "Primary Savings": "Regular Savings",
    "Regular Savings": "Share Savings",
    Checking: "Share Draft",
    "Checking Account": "Share Draft"
  }
}

export const TENANTS: ReadonlyArray<Tenant> = [HERITAGE_CORE, COMMUNITY_CU]

export const DEFAULT_TENANT = HERITAGE_CORE.key

/**
 * The Tenant a key names, or Heritage Core.
 *
 * Unknown keys fall back rather than failing, because this is a fixture and the
 * failure a wrong `--tenant` should produce is "the differences you expected are
 * not there", visibly, rather than a stack trace at startup.
 */
export const tenantFor = (key: string | undefined): Tenant =>
  TENANTS.find((tenant) => tenant.key === key) ?? HERITAGE_CORE

/** What this institution calls the product the vendor calls `description`. */
export const accountNameFor = (tenant: Tenant, description: string): string =>
  tenant.accountNames[description] ?? description
