/**
 * Heritage Core's routing table.
 *
 * Every route is a GET that returns a complete HTML document. There is no JSON
 * endpoint, no partial response and no way to reach the data except by rendering
 * a page, which is the point: this stands in for a system with no API.
 *
 * The router is built around a `TransientState` rather than being a bare
 * function, because three of the behaviours it has to reproduce are ones that
 * answer differently the second time you ask. See `conditions.ts` for what those
 * are and why each one is shaped the way it is. With a default state the table
 * below behaves exactly as it did before any of them existed.
 */

import type { TransientState } from "./conditions.ts"
import { transientState } from "./conditions.ts"
import {
  dualLedgerPage,
  duplicateLabelsPage,
  fixtureIndexPage,
  isLedgerKey,
  ledgerPanel,
  nestedTablesPage
} from "./fixtures.ts"
import { findAccount, findMember } from "./members.ts"
import { type Tenant, HERITAGE_CORE } from "./tenants.ts"
import {
  accountDetailPage,
  accountDetailPanel,
  crossReferencePage,
  memberDetailPage,
  memberNotFoundPage,
  memberSearchPage,
  signOnPage,
  systemBusyPage,
  systemMessagePage
} from "./render.ts"

const html = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=iso-8859-1",
      // A cached page would hide a full page load, and full page loads are the
      // behaviour later tickets have to cope with. It is also what makes a
      // transient condition observable: an unchanged URL has to be re-fetched.
      "cache-control": "no-store"
    }
  })

/**
 * The screens an operator navigates. A request to one of these is what the
 * session-expiry toggle counts, so the count means "screens visited" rather than
 * "bytes fetched" and does not drift when a browser asks for a favicon.
 *
 * The diagnostic fixtures under `/fixtures` are deliberately absent: they exist
 * to exercise target resolution, and letting them move a session-expiry counter
 * would couple two unrelated hazards.
 */
const PAGE_ROUTES = new Set(["/", "/search", "/member", "/account", "/account/panel", "/xref"])

export type Router = (request: Request) => Promise<Response>

/**
 * `tenant` is the institution this installation belongs to. It changes nothing
 * about the routing table — the two tenants run the same product and answer the
 * same URLs — only what the pages say. Defaulting to Heritage Core is what keeps
 * every existing caller byte-identical.
 */
export const router = (
  state: TransientState = transientState(),
  tenant: Tenant = HERITAGE_CORE
): Router => {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const pathname = url.pathname

    // Not a screen. Answered before anything is counted, so a browser's own
    // incidental requests cannot move the session-expiry toggle.
    if (pathname === "/favicon.ico") return new Response(null, { status: 204 })

    if (pathname === "/signon") {
      // Any password will do — this is a mock and there is no credential store
      // behind it — but an *empty* one is refused, so an automation that could
      // not supply one stays signed out and its recovery genuinely runs out of
      // attempts instead of being waved through.
      if ((url.searchParams.get("password") ?? "").trim() === "") {
        return html(signOnPage(tenant))
      }
      state.signOn()
      return Response.redirect(new URL("/", url).toString(), 302)
    }

    if (PAGE_ROUTES.has(pathname)) state.notePageRequest()

    // Once the session has timed out every screen says so, whatever was asked
    // for. A run that walks into this is stranded rather than merely delayed.
    if (state.isSignedOut() && PAGE_ROUTES.has(pathname)) return html(signOnPage(tenant))

    switch (pathname) {
      case "/":
      case "/search":
        return html(memberSearchPage(tenant))

      case "/member": {
        const memberNumber = (url.searchParams.get("memberNumber") ?? "").trim()

        // Nothing was searched for, so nothing was answered. An operator error, and
        // the only case on this route that is not a domain answer.
        if (memberNumber === "") {
          return html(systemMessagePage("No member number entered.", tenant), 400)
        }

        const member = findMember(memberNumber)

        // The search ran and the answer is that no such member exists. That is a
        // fact about the membership, not a fault, so it is served the way the real
        // system serves it: HTTP 200 and an ordinary screen. Classifying this
        // correctly is only possible by reading that screen.
        if (member === undefined) return html(memberNotFoundPage(memberNumber, tenant))

        // A real record exists; the host is just not ready to hand it over yet.
        // HTTP 200, a perfectly well-formed page, and not the one that was asked
        // for — the failure mode nothing raises an exception about.
        if (state.takeOverlay(member.memberNumber)) {
          return html(systemBusyPage(member.memberNumber, tenant))
        }

        return html(memberDetailPage(member, tenant))
      }

      case "/xref":
        return html(crossReferencePage(url.searchParams.get("legacyMemberNumber") ?? "", tenant))

      case "/account":
      case "/account/panel": {
        const member = findMember(url.searchParams.get("memberNumber") ?? "")
        const account =
          member === undefined
            ? undefined
            : findAccount(member, url.searchParams.get("accountNumber") ?? "")
        if (member === undefined || account === undefined) {
          return html(systemMessagePage("Account could not be retrieved.", tenant), 404)
        }
        // A tenant that renders the panel inline posts its supervisor override
        // back to this route rather than to the panel document, so the
        // credentials are read here as well. On a framed tenant they are always
        // absent and the branch below is the one that reads them.
        const attempt = {
          supervisorId: url.searchParams.get("supervisorId") ?? "",
          authorizationCode: url.searchParams.get("authorizationCode") ?? ""
        }
        if (pathname === "/account") {
          return html(accountDetailPage(member, account, tenant, attempt))
        }

        // The slow load. Nothing is wrong with this response; it is late. The
        // right answer to lateness is waiting, which is what a Checkpoint's
        // bounded poll already is, so no recovery is declared for it.
        const delay = state.panelDelayMillis(member.memberNumber)
        if (delay > 0) await Bun.sleep(delay)

        // Supervisor credentials ride on the query string of the panel document
        // itself, so releasing a hold is one full page load inside the iframe and
        // this server keeps no session state. The outer Account Detail page never
        // navigates while it happens.
        return html(accountDetailPanel(member, account, attempt, tenant))
      }

      // The diagnostic screens. Deliberately not linked from any product page: see
      // the module comment in `fixtures.ts`.
      case "/fixtures":
        return html(fixtureIndexPage())

      case "/fixtures/duplicate-labels":
        return html(duplicateLabelsPage())

      case "/fixtures/nested-tables":
        return html(nestedTablesPage())

      case "/fixtures/frames":
        return html(dualLedgerPage())

      case "/fixtures/frames/panel": {
        const ledger = url.searchParams.get("ledger") ?? ""
        if (!isLedgerKey(ledger)) {
          return html(systemMessagePage(`No ledger ${ledger} is defined.`, tenant), 404)
        }
        return html(ledgerPanel(ledger))
      }

      default:
        return html(systemMessagePage(`No transaction is mapped to ${pathname}.`, tenant), 404)
    }
  }
}
