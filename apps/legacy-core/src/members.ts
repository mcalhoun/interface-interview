/**
 * The member book Heritage Core serves from.
 *
 * | Number  | What the screen does                          | Added at  |
 * | ------- | --------------------------------------------- | --------- |
 * | `12345` | A normal member with two accounts             | ticket 01 |
 * | `99999` | Not on file: the Member Not Found screen       | ticket 04 |
 * | `88888` | Checking only, no savings                     | ticket 12 |
 * | `77777` | Restricted, needs supervisor authorisation    | ticket 13 |
 * | `55555` | Slow load behind a transient overlay          | ticket 06 |
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

const MEMBERS: ReadonlyMap<string, Member> = new Map([[HAPPY_PATH.memberNumber, HAPPY_PATH]])

export const findMember = (memberNumber: string): Member | undefined =>
  MEMBERS.get(memberNumber.trim())

export const findAccount = (member: Member, accountNumber: string): Account | undefined =>
  member.accounts.find((account) => account.accountNumber === accountNumber.trim())
