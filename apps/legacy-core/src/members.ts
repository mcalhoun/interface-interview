/**
 * The member book Heritage Core serves from.
 *
 * Only member `12345`, the happy path, exists at this point. Later tickets add
 * `99999`, `88888`, `77777` and `55555` alongside it.
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
