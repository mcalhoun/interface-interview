/**
 * The member book Heritage Core serves from.
 *
 * `12345` is the happy path. `55555` holds exactly the same shape of record and
 * differs only in how the application *serves* it — behind a transient
 * interstitial and with a late balance panel — so a run against it exercises the
 * same Capability Artifact and can only differ in what it had to get past. See
 * `conditions.ts`. Later tickets add `99999`, `88888` and `77777`.
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
 * The member whose record the application is slow and awkward about serving.
 *
 * Nothing here says so: the record is ordinary, and the difficulty lives entirely
 * in `conditions.ts`. That separation is the point. A transient condition is a
 * property of a moment, not of a member, and a fixture that baked it into the
 * data would be testing a different thing.
 */
const TRANSIENT: Member = {
  memberNumber: "55555",
  name: "DELPHINE R OKONKWO",
  memberSince: "11/02/2011",
  status: "Active",
  taxIdMasked: "xxx-xx-7730",
  branch: "004 - RIVERSIDE",
  accounts: [
    {
      accountNumber: "0000055555-S01",
      description: "Primary Savings",
      type: "SAVINGS",
      openedOn: "11/02/2011",
      status: "Active",
      availableBalance: "$917.40",
      currentBalance: "$1,117.40",
      lastActivityOn: "08/25/2026"
    },
    {
      accountNumber: "0000055555-D10",
      description: "Checking",
      type: "DRAFT",
      openedOn: "01/19/2016",
      status: "Active",
      availableBalance: "$233.06",
      currentBalance: "$233.06",
      lastActivityOn: "08/26/2026"
    }
  ]
}

const MEMBERS: ReadonlyMap<string, Member> = new Map(
  [HAPPY_PATH, TRANSIENT].map((member) => [member.memberNumber, member])
)

export const findMember = (memberNumber: string): Member | undefined =>
  MEMBERS.get(memberNumber.trim())

export const findAccount = (member: Member, accountNumber: string): Account | undefined =>
  member.accounts.find((account) => account.accountNumber === accountNumber.trim())
