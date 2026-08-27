/**
 * Heritage Core's routing table.
 *
 * Every route is a GET that returns a complete HTML document. There is no JSON
 * endpoint, no partial response and no way to reach the data except by rendering
 * a page, which is the point: this stands in for a system with no API.
 */

import { findAccount, findMember } from "./members.ts"
import {
  accountDetailPage,
  accountDetailPanel,
  crossReferencePage,
  memberDetailPage,
  memberNotFoundPage,
  memberSearchPage,
  systemMessagePage
} from "./render.ts"

const html = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=iso-8859-1",
      // A cached page would hide a full page load, and full page loads are the
      // behaviour later tickets have to cope with.
      "cache-control": "no-store"
    }
  })

export const handle = (request: Request): Response => {
  const url = new URL(request.url)

  switch (url.pathname) {
    case "/":
    case "/search":
      return html(memberSearchPage())

    case "/member": {
      const memberNumber = (url.searchParams.get("memberNumber") ?? "").trim()

      // Nothing was searched for, so nothing was answered. An operator error, and
      // the only case on this route that is not a domain answer.
      if (memberNumber === "") return html(systemMessagePage("No member number entered."), 400)

      const member = findMember(memberNumber)

      // The search ran and the answer is that no such member exists. That is a
      // fact about the membership, not a fault, so it is served the way the real
      // system serves it: HTTP 200 and an ordinary screen. Classifying this
      // correctly is only possible by reading that screen.
      if (member === undefined) return html(memberNotFoundPage(memberNumber))

      return html(memberDetailPage(member))
    }

    case "/xref":
      return html(crossReferencePage(url.searchParams.get("legacyMemberNumber") ?? ""))

    case "/account":
    case "/account/panel": {
      const member = findMember(url.searchParams.get("memberNumber") ?? "")
      const account =
        member === undefined
          ? undefined
          : findAccount(member, url.searchParams.get("accountNumber") ?? "")
      if (member === undefined || account === undefined) {
        return html(systemMessagePage("Account could not be retrieved."), 404)
      }
      return html(
        url.pathname === "/account"
          ? accountDetailPage(member, account)
          : accountDetailPanel(member, account)
      )
    }

    default:
      return html(systemMessagePage(`No transaction is mapped to ${url.pathname}.`), 404)
  }
}
