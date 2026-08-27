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
      const memberNumber = url.searchParams.get("memberNumber") ?? ""
      const member = findMember(memberNumber)
      if (member === undefined) {
        return html(
          systemMessagePage(
            memberNumber.trim() === ""
              ? "No member number entered."
              : `Member number ${memberNumber.trim()} could not be retrieved.`
          ),
          404
        )
      }
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
      // Supervisor credentials ride on the query string of the panel document
      // itself, so releasing a hold is one full page load inside the iframe and
      // this server keeps no session state. The outer Account Detail page never
      // navigates while it happens.
      return html(
        url.pathname === "/account"
          ? accountDetailPage(member, account)
          : accountDetailPanel(member, account, {
              supervisorId: url.searchParams.get("supervisorId") ?? "",
              authorizationCode: url.searchParams.get("authorizationCode") ?? ""
            })
      )
    }

    default:
      return html(systemMessagePage(`No transaction is mapped to ${url.pathname}.`), 404)
  }
}
