/**
 * The transient states Heritage Core puts in an automation's way, and the only
 * mutable state the application has.
 *
 * Everything else in this app is a pure function of the request. These three
 * behaviours are not, because a *transient* condition is by definition one that
 * answers differently the second time you ask. That is the whole reason ticket 06
 * exists: a system that retried a pure function would only ever get the same
 * answer back.
 *
 * Three behaviours, deliberately failing in three different ways:
 *
 *   1. **A transient overlay.** Member `55555`'s record answers with a "System
 *      Busy" interstitial for its first couple of requests before the real record
 *      appears. Waiting does not clear it — the screen is static, with no script
 *      and no meta refresh — so an automation has to *act*: press Continue and
 *      look again. This blocks cleanly at a step boundary.
 *
 *   2. **A slow load.** Member `55555`'s Account Detail panel takes most of a
 *      second to come back. Nothing is wrong; it is just late. Acting would be
 *      the wrong response and waiting is the right one, which is why this one is
 *      absorbed by the Checkpoint's own bounded poll rather than by a declared
 *      recovery. Waiting is what a Checkpoint already is.
 *
 *   3. **A session expiry toggle.** After a configured number of page requests
 *      the teller session times out, and every screen answers with Sign On until
 *      somebody signs back in. Signing on returns the operator to Member Search,
 *      not to where they were — so this one strands a run mid-flow, somewhere it
 *      did not expect to be, and getting past it means both re-authenticating and
 *      getting back to the step that was interrupted.
 *
 * The expiry is a one-shot: signing on disarms it for good. A toggle that re-armed
 * itself would make an unrecoverable loop rather than a recoverable condition, and
 * an unrecoverable loop is a different ticket's problem.
 */

/** The member whose record arrives late and behind an interstitial. */
export const TRANSIENT_MEMBER = "55555"

/** How many times `55555`'s record answers "System Busy" before it answers. */
export const DEFAULT_OVERLAY_RESPONSES = 2

/** How late `55555`'s balance panel is. Under a Checkpoint's default bound. */
export const DEFAULT_PANEL_DELAY_MILLIS = 900

export interface TransientOptions {
  /**
   * Arm a one-shot session expiry once this many page requests have been served.
   * Omitted, the session never expires. This is the toggle: it is expressed in
   * requests rather than in routes so that it fires part-way through *any* flow
   * rather than one the mock knows about in advance.
   */
  readonly expireSessionAfter?: number
  readonly overlayResponses?: number
  readonly panelDelayMillis?: number
}

export interface TransientState {
  /**
   * Counts one page request against the expiry toggle. Called for the routes an
   * operator navigates, never for the browser's own incidental requests, so the
   * count means "screens visited" rather than "bytes fetched".
   */
  readonly notePageRequest: () => void
  /** True while the teller session has timed out and every screen says so. */
  readonly isSignedOut: () => boolean
  /** Sign back on. Disarms the toggle permanently and resets the counter. */
  readonly signOn: () => void
  /**
   * Whether this request for a member's record should answer with the busy
   * interstitial. Consumes one, so the next request gets closer to the record.
   */
  readonly takeOverlay: (memberNumber: string) => boolean
  /** How long this member's balance panel takes to come back, in milliseconds. */
  readonly panelDelayMillis: (memberNumber: string) => number
  /** Page requests served so far. Read by tests to explain what fired when. */
  readonly pageRequests: () => number
}

export const transientState = (options: TransientOptions = {}): TransientState => {
  const overlayResponses = options.overlayResponses ?? DEFAULT_OVERLAY_RESPONSES
  const panelDelay = options.panelDelayMillis ?? DEFAULT_PANEL_DELAY_MILLIS

  let pageRequests = 0
  let expiryArmed = options.expireSessionAfter !== undefined
  let signedOut = false
  const overlaysLeft = new Map<string, number>()

  return {
    notePageRequest: () => {
      pageRequests += 1
      if (expiryArmed && pageRequests > options.expireSessionAfter!) signedOut = true
    },
    isSignedOut: () => signedOut,
    signOn: () => {
      signedOut = false
      expiryArmed = false
      pageRequests = 0
    },
    takeOverlay: (memberNumber) => {
      if (memberNumber !== TRANSIENT_MEMBER || overlayResponses <= 0) return false
      const left = overlaysLeft.get(memberNumber) ?? overlayResponses
      if (left <= 0) return false
      overlaysLeft.set(memberNumber, left - 1)
      return true
    },
    panelDelayMillis: (memberNumber) => (memberNumber === TRANSIENT_MEMBER ? panelDelay : 0),
    pageRequests: () => pageRequests
  }
}
