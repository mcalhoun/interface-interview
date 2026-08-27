/**
 * The member book Heritage Core serves from.
 *
 * `12345` is the happy path. `77777` is ticket 12's: a member whose savings
 * account sits under a supervisor hold, so the figures the automation came for
 * are simply not on the screen until somebody with authority releases them.
 *
 * The shape of that state is the whole reason it is the Intervention trigger.
 * It is not a broken page and not a missing record — it is the application
 * working correctly and refusing. Getting past it needs *authority*, not better
 * perception, so no amount of waiting, retrying or cleverer target matching
 * resolves it. That is what separates it from a Recoverable Condition and from
 * a Business Outcome, and it is why a person has to hold the session.
 *
 * Later tickets add `99999`, `88888` and `55555` alongside these.
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
  /** Present when the figures are withheld pending supervisor authorization. */
  readonly restriction?: Restriction
}

/**
 * A supervisor hold on one account.
 *
 * Per account rather than per member, deliberately: `77777`'s checking account
 * is perfectly ordinary. That stops "this member is restricted" from being a
 * shortcut readable at the Member Detail screen, so the run has to get all the
 * way to the last screen before it discovers it cannot finish — which is where
 * flows actually fail.
 */
export interface Restriction {
  /** What the institution calls this hold. The Operator quotes it back. */
  readonly code: string
  /** The sentence the screen shows in place of the figures. */
  readonly notice: string
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
 * Ticket 12's member: savings held, checking not.
 *
 * Everything up to and including Account Detail behaves exactly as it does for
 * `12345`. The screen that finally differs is the one inside the iframe.
 */
const SUPERVISOR_HOLD: Member = {
  memberNumber: "77777",
  name: "DOUGLAS R FAIRWEATHER",
  memberSince: "11/09/2011",
  status: "Active",
  taxIdMasked: "xxx-xx-8802",
  branch: "004 - RIVERSIDE",
  accounts: [
    {
      accountNumber: "0000077777-S01",
      description: "Primary Savings",
      type: "SAVINGS",
      openedOn: "11/09/2011",
      status: "Restricted",
      availableBalance: "$2,730.11",
      currentBalance: "$2,905.60",
      lastActivityOn: "08/21/2026",
      restriction: {
        code: "SUP-HOLD-02",
        notice:
          "Balances are withheld on this account pending supervisor authorization. A supervisor must enter an override code to display the account."
      }
    },
    {
      accountNumber: "0000077777-D10",
      description: "Checking",
      type: "DRAFT",
      openedOn: "02/17/2015",
      status: "Active",
      availableBalance: "$318.42",
      currentBalance: "$318.42",
      lastActivityOn: "08/25/2026"
    }
  ]
}

const MEMBERS: ReadonlyMap<string, Member> = new Map(
  [HAPPY_PATH, SUPERVISOR_HOLD].map((member) => [member.memberNumber, member])
)

/** What a supervisor typed into the override panel. Both halves are required. */
export interface AuthorizationAttempt {
  readonly supervisorId: string
  readonly authorizationCode: string
}

/**
 * Whether an override attempt releases the hold.
 *
 * A non-empty supervisor id and a four-digit code. Heritage Core validates the
 * shape and nothing else: what the fixture has to demonstrate is that *a person
 * holding a code* is required, not that the code is interesting.
 */
export const authorizationAccepted = (attempt: AuthorizationAttempt): boolean =>
  attempt.supervisorId.trim() !== "" && /^[0-9]{4}$/.test(attempt.authorizationCode.trim())

/** Whether an override was attempted at all, well formed or not. */
export const authorizationAttempted = (attempt: AuthorizationAttempt): boolean =>
  attempt.supervisorId.trim() !== "" || attempt.authorizationCode.trim() !== ""

export const findMember = (memberNumber: string): Member | undefined =>
  MEMBERS.get(memberNumber.trim())

export const findAccount = (member: Member, accountNumber: string): Account | undefined =>
  member.accounts.find((account) => account.accountNumber === accountNumber.trim())
