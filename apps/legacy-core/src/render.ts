/**
 * Heritage Core's markup.
 *
 * Every page here is deliberately hostile to automation, because this app is the
 * fixture every later ticket is tested against. The rules, all of which are load
 * bearing:
 *
 *   - HTML 4.01 Transitional, `<font>` tags and `bgcolor`, nested layout tables.
 *   - No `id`, `class`, `data-*`, `aria-*` or `role` attribute anywhere, so there
 *     is nothing a test-id or CSS strategy could grab hold of.
 *   - No `<script>` on any page. Nothing renders client side; every transition is
 *     a full page load driven by a GET form or an `<a href>`.
 *   - No `<label>`. Form controls get their accessible name from `title`, the way
 *     a 1990s tooltip would have supplied it, and the visible caption beside a
 *     control is an unassociated `<td>`.
 *   - Content sits several layout tables deep. Chromium exposes those layout
 *     tables as real `table`/`row`/`cell` nodes too, so an observed accessibility
 *     tree carries the same text repeated at every enclosing level. A Target has
 *     to survive that noise rather than a tidy tree, which is the realistic case.
 *
 * See docs/adr/0001-accessibility-tree-is-the-only-observation-channel.md.
 */

import type { Account, Member } from "./members.ts"

export const DOCTYPE =
  '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">'

export const escape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

const query = (params: Record<string, string>): string =>
  Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&amp;")

/** Small grey caption text, the way the whole application labels things. */
export const caption = (text: string): string =>
  `<font face="Arial" size="2" color="#000000">${escape(text)}</font>`

/** The banner and status strip wrapped around every full page. */
export const shell = (title: string, body: string): string => `${DOCTYPE}
<html>
<head>
<title>${escape(title)}</title>
<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
</head>
<body bgcolor="#d4d0c8" topmargin="0" leftmargin="0" marginwidth="0" marginheight="0">
<table width="780" border="0" cellpadding="0" cellspacing="0">
<tr><td bgcolor="#000080" height="26">&nbsp;<font face="Arial" size="3" color="#ffffff"><b>HERITAGE CORE</b></font>&nbsp;&nbsp;<font face="Arial" size="2" color="#c0c0c0">Member Services</font></td></tr>
<tr><td bgcolor="#808080" height="18">&nbsp;<font face="Arial" size="1" color="#ffffff">MSS 4.02.11&nbsp;&nbsp;|&nbsp;&nbsp;TELLER OPR001&nbsp;&nbsp;|&nbsp;&nbsp;BRANCH 001&nbsp;&nbsp;|&nbsp;&nbsp;F1 HELP&nbsp;&nbsp;F3 EXIT</font></td></tr>
<tr><td height="10">&nbsp;</td></tr>
<tr><td>
<table width="100%" border="0" cellpadding="6" cellspacing="0"><tr><td>
${body}
</td></tr></table>
</td></tr>
<tr><td height="14">&nbsp;</td></tr>
<tr><td bgcolor="#808080" height="18">&nbsp;<font face="Arial" size="1" color="#ffffff">HERITAGE FINANCIAL SYSTEMS INC&nbsp;&nbsp;ALL TRANSACTIONS LOGGED</font></td></tr>
</table>
</body>
</html>
`

/**
 * Member Search.
 *
 * Two panels, on purpose. `Member Number` in the search panel is the field that
 * works; `Member Number (Legacy)` in the cross-reference panel is a near
 * duplicate that a name match on "Member Number" also hits. A Target that says
 * only `textbox "Member Number"` is genuinely ambiguous here, which is what
 * gives `within` and `nth` disambiguation something real to resolve.
 */
export const memberSearchPage = (): string =>
  shell(
    "Heritage Core - Member Search",
    `<table width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td>
<font face="Arial" size="2"><b>Member Search</b></font>
</td></tr></table>
<br>
<form method="get" action="/member">
<table width="100%" border="1" cellpadding="4" cellspacing="0" bordercolor="#808080">
<tr bgcolor="#c0c0c0"><td colspan="3"><font face="Arial" size="2"><b>Member Number Search</b></font></td></tr>
<tr bgcolor="#ffffff">
<td width="180">${caption("Member Number")}</td>
<td><input type="text" name="memberNumber" size="14" maxlength="10" title="Member Number"></td>
<td width="140"><input type="submit" value="Search"></td>
</tr>
<tr bgcolor="#ffffff">
<td>${caption("Branch")}</td>
<td><input type="text" name="branch" size="6" maxlength="3" value="001" title="Branch"></td>
<td>&nbsp;</td>
</tr>
</table>
</form>
<br>
<form method="get" action="/xref">
<table width="100%" border="1" cellpadding="4" cellspacing="0" bordercolor="#808080">
<tr bgcolor="#c0c0c0"><td colspan="3"><font face="Arial" size="2"><b>Cross-Reference Lookup</b></font></td></tr>
<tr bgcolor="#ffffff">
<td width="180">${caption("Member Number (Legacy)")}</td>
<td><input type="text" name="legacyMemberNumber" size="14" maxlength="12" title="Member Number (Legacy)"></td>
<td width="140"><input type="submit" value="Look Up"></td>
</tr>
</table>
</form>
<br>
<font face="Arial" size="1" color="#404040">Legacy member numbers were retired at conversion. Use Member Number Search for all current members.</font>`
  )

/** Member Detail. Accounts are links; balances are not shown until Account Detail. */
export const memberDetailPage = (member: Member): string =>
  shell(
    `Heritage Core - Member ${member.memberNumber}`,
    `<table width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td>
<font face="Arial" size="2"><b>Member Detail</b></font>
</td></tr></table>
<br>
<table width="100%" border="1" cellpadding="4" cellspacing="0" bordercolor="#808080">
<tr bgcolor="#c0c0c0"><td colspan="4"><font face="Arial" size="2"><b>Member Record</b></font></td></tr>
<tr bgcolor="#ffffff">
<td width="140">${caption("Member Number")}</td><td width="240">${caption(member.memberNumber)}</td>
<td width="140">${caption("Member Name")}</td><td>${caption(member.name)}</td>
</tr>
<tr bgcolor="#ffffff">
<td>${caption("Member Since")}</td><td>${caption(member.memberSince)}</td>
<td>${caption("Status")}</td><td>${caption(member.status)}</td>
</tr>
<tr bgcolor="#ffffff">
<td>${caption("Tax ID")}</td><td>${caption(member.taxIdMasked)}</td>
<td>${caption("Branch")}</td><td>${caption(member.branch)}</td>
</tr>
</table>
<br>
<table width="100%" border="1" cellpadding="4" cellspacing="0" bordercolor="#808080">
<tr bgcolor="#c0c0c0"><td colspan="5"><font face="Arial" size="2"><b>Share and Deposit Accounts</b></font></td></tr>
<tr bgcolor="#e0e0e0">
<td width="220">${caption("Account")}</td>
<td width="180">${caption("Account Number")}</td>
<td width="100">${caption("Type")}</td>
<td width="110">${caption("Opened")}</td>
<td>${caption("Status")}</td>
</tr>
${member.accounts.map((account) => accountRow(member, account)).join("\n")}
</table>
<br>
<font face="Arial" size="2"><a href="/">Return to Member Search</a></font>`
  )

const accountRow = (member: Member, account: Account): string => {
  const href = `/account?${query({
    memberNumber: member.memberNumber,
    accountNumber: account.accountNumber
  })}`
  return `<tr bgcolor="#ffffff">
<td><font face="Arial" size="2"><a href="${href}">${escape(account.description)}</a></font></td>
<td>${caption(account.accountNumber)}</td>
<td>${caption(account.type)}</td>
<td>${caption(account.openedOn)}</td>
<td>${caption(account.status)}</td>
</tr>`
}

/**
 * Account Detail. The outer page carries only chrome; every figure an operator
 * came for lives in a separate document inside the iframe, so nothing about this
 * screen is readable without traversing a frame boundary.
 */
export const accountDetailPage = (member: Member, account: Account): string => {
  const src = `/account/panel?${query({
    memberNumber: member.memberNumber,
    accountNumber: account.accountNumber
  })}`
  return shell(
    `Heritage Core - Account ${account.accountNumber}`,
    `<table width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td>
<font face="Arial" size="2"><b>Account Detail</b></font>
</td></tr></table>
<br>
<table width="100%" border="0" cellpadding="0" cellspacing="0">
<tr><td>
<iframe src="${src}" name="acctdetail" width="100%" height="270" frameborder="1" scrolling="auto" marginwidth="0" marginheight="0"></iframe>
</td></tr>
</table>
<br>
<font face="Arial" size="2"><a href="/member?${query({ memberNumber: member.memberNumber })}">Return to Member Detail</a></font>`
  )
}

/** The document that lives inside the Account Detail iframe. */
export const accountDetailPanel = (member: Member, account: Account): string => `${DOCTYPE}
<html>
<head>
<title>Account Detail Panel</title>
<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
</head>
<body bgcolor="#ffffff" topmargin="4" leftmargin="4" marginwidth="0" marginheight="0">
<table width="100%" border="1" cellpadding="4" cellspacing="0" bordercolor="#808080">
<tr bgcolor="#c0c0c0"><td colspan="2"><font face="Arial" size="2"><b>${escape(account.description)}</b></font></td></tr>
<tr bgcolor="#ffffff"><td width="200">${caption("Account Number")}</td><td>${caption(account.accountNumber)}</td></tr>
<tr bgcolor="#ffffff"><td>${caption("Account Type")}</td><td>${caption(account.type)}</td></tr>
<tr bgcolor="#ffffff"><td>${caption("Member Number")}</td><td>${caption(member.memberNumber)}</td></tr>
<tr bgcolor="#ffffff"><td>${caption("Available Balance")}</td><td>${caption(account.availableBalance)}</td></tr>
<tr bgcolor="#ffffff"><td>${caption("Current Balance")}</td><td>${caption(account.currentBalance)}</td></tr>
<tr bgcolor="#ffffff"><td>${caption("Status")}</td><td>${caption(account.status)}</td></tr>
<tr bgcolor="#ffffff"><td>${caption("Last Activity")}</td><td>${caption(account.lastActivityOn)}</td></tr>
</table>
</body>
</html>
`

/** Cross-reference lookup result. Legacy numbers were retired at conversion. */
export const crossReferencePage = (legacyMemberNumber: string): string =>
  shell(
    "Heritage Core - Cross-Reference Lookup",
    `<table width="100%" border="1" cellpadding="4" cellspacing="0" bordercolor="#808080">
<tr bgcolor="#c0c0c0"><td><font face="Arial" size="2"><b>Cross-Reference Lookup</b></font></td></tr>
<tr bgcolor="#ffffff"><td>${caption(
      legacyMemberNumber.trim() === ""
        ? "No legacy member number entered."
        : `No cross-reference record on file for legacy member number ${legacyMemberNumber.trim()}.`
    )}</td></tr>
</table>
<br>
<font face="Arial" size="2"><a href="/">Return to Member Search</a></font>`
  )

/**
 * The system message page. Heritage Core answers every unusable request this way.
 * Ticket 04 owns what a genuinely absent member looks like as a Business Outcome;
 * this is only the generic fallback so the server always answers something.
 */
export const systemMessagePage = (message: string): string =>
  shell(
    "Heritage Core - System Message",
    `<table width="100%" border="1" cellpadding="4" cellspacing="0" bordercolor="#808080">
<tr bgcolor="#c0c0c0"><td><font face="Arial" size="2"><b>System Message</b></font></td></tr>
<tr bgcolor="#ffffff"><td>${caption(message)}</td></tr>
</table>
<br>
<font face="Arial" size="2"><a href="/">Return to Member Search</a></font>`
  )
