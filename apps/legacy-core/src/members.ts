/**
 * The member book Heritage Core serves from.
 *
 * | Number  | What the screen does                          | Added at  |
 * | ------- | --------------------------------------------- | --------- |
 * | `12345` | A normal member with two accounts             | ticket 01 |
 * | `22222` | Accounts labelled `Regular Savings`           | ticket 09 |
 * | `33333` | Two savings accounts, so selection is ambiguous | ticket 09 |
 * | `99999` | Not on file: the Member Not Found screen      | ticket 04 |
 * | `88888` | Checking only, no savings                     | ticket 12 |
 * | `77777` | Restricted, needs supervisor authorisation    | ticket 13 |
 * | `55555` | Slow load behind a transient overlay          | ticket 06 |
 *
 * `22222` and `33333` differ from the happy path only in how their accounts are
 * *labelled*, which is the point: label variation is what a second Tenant
 * actually looks like, and the claim under test is that token-subset selection
 * absorbs it with no Override and no second Artifact.
 *
 * `99999` is not an entry below and never will be. It is well-formed, it passes
 * the search field's own validation, and it is simply not a member — which is
 * what the search is being asked. The book answers that question with `undefined`
 * and the route turns it into a screen; there is no "known absent" list, because
 * a real core has no such thing either and a typo has to reach the same answer.
 * `99999` is the number SPEC names for the scenario and the one the tests use.
 */

export interface Account {
  /** Displayed verbatim; the value an operator would read back over the phone. */
  readonly accountNumber: string
  /** What the account is called on screen, e.g. `Primary Savings`. */
  readonly description: string
  readonly type: string
  readonly openedOn: string
  readonly status: string
  readonly availableBalance: string
  readonly currentBalance: string
  readonly lastActivityOn: string
}

export interface Member {
  readonly memberNumber: string
  readonly name: string
  readonly memberSince: string
  readonly status: string
  /** Already masked at rest. Heritage Core never renders a full tax id. */
  readonly taxIdMasked: string
  readonly branch: string
  readonly accounts: ReadonlyArray<Account>
}

const HAPPY_PATH: Member = {
  memberNumber: "12345",
  name: "MARGARET T HOLLOWAY",
  memberSince: "03/14/1998",
  status: "Active",
  taxIdMasked: "xxx-xx-4419",
  branch: "001 - MAIN OFFICE",
  accounts: [
    {
      accountNumber: "0000012345-S01",
      description: "Primary Savings",
      type: "SAVINGS",
      openedOn: "03/14/1998",
      status: "Active",
      availableBalance: "$4,182.55",
      currentBalance: "$4,382.55",
      lastActivityOn: "08/24/2026"
    },
    {
      accountNumber: "0000012345-D10",
      description: "Checking",
      type: "DRAFT",
      openedOn: "06/02/2004",
      status: "Active",
      availableBalance: "$1,204.18",
      currentBalance: "$1,204.18",
      lastActivityOn: "08/26/2026"
    }
  ]
}

/**
 * A member whose institution names the same products differently.
 *
 * `Regular Savings` where the happy path says `Primary Savings`, and
 * `Checking Account` where it says `Checking`. Nothing else about the screen
 * changes — which is exactly the situation ticket 16 will meet with a second
 * Tenant, arriving early so the matching rule can be shown to handle it before
 * anything is built on the assumption that it does.
 *
 * `savings` is a token of `Regular Savings`, so the shipped Artifact's recorded
 * default selects this member's savings account with no configuration anywhere.
 * `Primary Savings` is *not* a token subset of it, and is a clean no-match.
 */
const LABEL_VARIANT: Member = {
  memberNumber: "22222",
  name: "DESMOND A OKAFOR",
  memberSince: "11/02/2011",
  status: "Active",
  taxIdMasked: "xxx-xx-7730",
  branch: "004 - EASTGATE",
  accounts: [
    {
      accountNumber: "0000022222-S01",
      description: "Regular Savings",
      type: "SAVINGS",
      openedOn: "11/02/2011",
      status: "Active",
      availableBalance: "$812.40",
      currentBalance: "$812.40",
      lastActivityOn: "08/21/2026"
    },
    {
      accountNumber: "0000022222-D10",
      description: "Checking Account",
      type: "DRAFT",
      openedOn: "11/02/2011",
      status: "Active",
      availableBalance: "$3,905.62",
      currentBalance: "$3,955.62",
      lastActivityOn: "08/25/2026"
    }
  ]
}

/**
 * A member holding two savings accounts.
 *
 * Ordinary in a credit union and fatal to a matching rule that guesses:
 * `savings` is a token subset of both `Primary Savings` and `Regular Savings`,
 * so there is no defensible way to pick one. ADR-0007 makes that a Hard Failure
 * listing both candidates rather than a coin flip, and this member is what
 * proves the rule is enforced rather than asserted.
 */
const TWO_SAVINGS: Member = {
  memberNumber: "33333",
  name: "PRISCILLA J VANTERPOOL",
  memberSince: "07/19/1989",
  status: "Active",
  taxIdMasked: "xxx-xx-2064",
  branch: "001 - MAIN OFFICE",
  accounts: [
    {
      accountNumber: "0000033333-S01",
      description: "Primary Savings",
      type: "SAVINGS",
      openedOn: "07/19/1989",
      status: "Active",
      availableBalance: "$15,004.00",
      currentBalance: "$15,004.00",
      lastActivityOn: "08/12/2026"
    },
    {
      accountNumber: "0000033333-S02",
      description: "Regular Savings",
      type: "SAVINGS",
      openedOn: "02/28/2003",
      status: "Active",
      availableBalance: "$260.13",
      currentBalance: "$260.13",
      lastActivityOn: "07/30/2026"
    },
    {
      accountNumber: "0000033333-D10",
      description: "Checking",
      type: "DRAFT",
      openedOn: "02/28/2003",
      status: "Active",
      availableBalance: "$78.91",
      currentBalance: "$78.91",
      lastActivityOn: "08/26/2026"
    }
  ]
}

const MEMBERS: ReadonlyMap<string, Member> = new Map(
  [HAPPY_PATH, LABEL_VARIANT, TWO_SAVINGS].map((member) => [member.memberNumber, member])
)

export const findMember = (memberNumber: string): Member | undefined =>
  MEMBERS.get(memberNumber.trim())

export const findAccount = (member: Member, accountNumber: string): Account | undefined =>
  member.accounts.find((account) => account.accountNumber === accountNumber.trim())
