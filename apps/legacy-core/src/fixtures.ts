/**
 * Heritage Core's hostile screens: the ones that exist so Target resolution has
 * something hard to be right about.
 *
 * These are fixture *routes*, not test plumbing. They are served by the same
 * server, obey the same house rules as `render.ts` (HTML 4.01, no `id`, `class`,
 * `data-*`, `aria-*` or `role`, no `<label>`, no `<script>`, accessible names
 * from `title`, captions in unassociated `<td>`s), and can be looked at by hand:
 *
 *     bun run surface observe /fixtures/duplicate-labels
 *     bun run surface resolve /fixtures/frames --role cell --label "Posted Balance"
 *
 * They are reachable only by URL. Nothing in the product screens links to them,
 * because a fixture that changes what an operator sees on Member Search would
 * stop being a fixture and start being a lie about the application.
 *
 * Three hazards, one screen each, because each defeats a different rule:
 *
 *   - `/fixtures/duplicate-labels` defeats exact-name matching. Three panels
 *     carry a genuinely identical `textbox "Amount"`; there is no better name to
 *     match on, so only `within` or `nth` can decide.
 *   - `/fixtures/nested-tables` defeats naive containment. The figure sits six
 *     layout tables deep and every enclosing level repeats its text, so a match
 *     returns a stack of nodes that are all literally correct.
 *   - `/fixtures/frames` defeats frame-blind resolution. Two identically shaped
 *     documents in two iframes make a single Target ambiguous *across a frame
 *     boundary*, where the only thing telling the candidates apart is which
 *     document each lives in.
 */

import { DOCTYPE, caption, escape, shell } from "./render.ts"

/** The panels on `/fixtures/duplicate-labels`. Distinct headings, identical rows. */
const TRANSFER_PANELS = [
  { heading: "Scheduled Transfer", reference: "SCH-1001", posted: "$250.00" },
  { heading: "Recurring Transfer", reference: "REC-2002", posted: "$1,375.40" },
  { heading: "One-Time Transfer", reference: "ONE-3003", posted: "$92.15" }
] as const

/** The two documents behind `/fixtures/frames`. */
const LEDGERS = {
  A: { heading: "Ledger A", frame: "ledgerone", posted: "$1,204.00", pending: "$18.75" },
  B: { heading: "Ledger B", frame: "ledgertwo", posted: "$9,870.55", pending: "$430.10" }
} as const

export type LedgerKey = keyof typeof LEDGERS

export const isLedgerKey = (value: string): value is LedgerKey => value === "A" || value === "B"

/**
 * The fixture index. Not linked from anywhere in the product, so that observing
 * Member Search sees exactly what ticket 01 built and nothing else.
 */
export const fixtureIndexPage = (): string =>
  shell(
    "Heritage Core - Diagnostic Screens",
    `<table width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td>
<font face="Arial" size="2"><b>Diagnostic Screens</b></font>
</td></tr></table>
<br>
<table width="100%" border="1" cellpadding="4" cellspacing="0" bordercolor="#808080">
<tr bgcolor="#c0c0c0"><td colspan="2"><font face="Arial" size="2"><b>Screens</b></font></td></tr>
<tr bgcolor="#ffffff"><td width="220"><font face="Arial" size="2"><a href="/fixtures/duplicate-labels">Transfer Queue</a></font></td><td>${caption(
      "Three panels whose controls carry identical names."
    )}</td></tr>
<tr bgcolor="#ffffff"><td><font face="Arial" size="2"><a href="/fixtures/nested-tables">Settlement Detail</a></font></td><td>${caption(
      "One figure six layout tables deep."
    )}</td></tr>
<tr bgcolor="#ffffff"><td><font face="Arial" size="2"><a href="/fixtures/frames">Dual Ledger</a></font></td><td>${caption(
      "Two ledgers, two frames, one set of captions."
    )}</td></tr>
</table>
<br>
<font face="Arial" size="2"><a href="/">Return to Member Search</a></font>`
  )

/**
 * Transfer Queue: duplicate labels with no tiebreaker in the name.
 *
 * Every panel holds `textbox "Amount"`, `textbox "Memo"` and `button "Post"`,
 * with the caption `Amount` beside each field. That is the case the Member
 * Search decoy cannot make, because there `Member Number (Legacy)` differs from
 * `Member Number` and an exact match separates them. Here nothing does: role,
 * accessible name and caption are all identical three times over, so a Target
 * either names the panel it means or counts.
 *
 * `Reference` differs per panel, which is how a test proves it acted on the
 * panel it asked for rather than a panel that happened to look right.
 */
export const duplicateLabelsPage = (): string =>
  shell(
    "Heritage Core - Transfer Queue",
    `<table width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td>
<font face="Arial" size="2"><b>Transfer Queue</b></font>
</td></tr></table>
<br>
${TRANSFER_PANELS.map(transferPanel).join("\n<br>\n")}
<br>
<font face="Arial" size="1" color="#404040">Amounts are keyed per instruction. Posting one instruction does not post the others.</font>
<br>
<font face="Arial" size="2"><a href="/fixtures">Return to Diagnostic Screens</a></font>`
  )

const transferPanel = (panel: (typeof TRANSFER_PANELS)[number]): string =>
  `<form method="get" action="/fixtures/duplicate-labels">
<table width="100%" border="1" cellpadding="4" cellspacing="0" bordercolor="#808080">
<tr bgcolor="#c0c0c0"><td colspan="3"><font face="Arial" size="2"><b>${escape(panel.heading)}</b></font></td></tr>
<tr bgcolor="#ffffff">
<td width="180">${caption("Reference")}</td>
<td>${caption(panel.reference)}</td>
<td width="140">${caption("Last Posted " + panel.posted)}</td>
</tr>
<tr bgcolor="#ffffff">
<td>${caption("Amount")}</td>
<td><input type="text" name="amount" size="14" maxlength="12" title="Amount"></td>
<td><input type="submit" value="Post"></td>
</tr>
<tr bgcolor="#ffffff">
<td>${caption("Memo")}</td>
<td><input type="text" name="memo" size="24" maxlength="40" title="Memo"></td>
<td>&nbsp;</td>
</tr>
</table>
</form>`

/**
 * Settlement Detail: one figure, six layout tables deep.
 *
 * Chromium does not treat a layout table as presentational, so each enclosing
 * `cell` here is a real node whose text is the whole of its subtree. A Target
 * that matched on containment alone would find the figure at every level from
 * the outermost wrapper down, and every one of those matches would be true.
 * Only the innermost is useful, and only discarding enclosing candidates gets
 * there.
 *
 * `Gross Settlement` sits at a shallower depth than `Net Settlement` in a
 * separate nest, so the two are not distinguishable by depth alone.
 */
export const nestedTablesPage = (): string =>
  shell(
    "Heritage Core - Settlement Detail",
    `<table width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td>
<font face="Arial" size="2"><b>Settlement Detail</b></font>
</td></tr></table>
<br>
<table width="100%" border="1" cellpadding="4" cellspacing="0" bordercolor="#808080">
<tr bgcolor="#c0c0c0"><td><font face="Arial" size="2"><b>Daily Settlement</b></font></td></tr>
<tr bgcolor="#ffffff"><td>
${nest(3, valueRow("Gross Settlement", "$22,750.00"))}
</td></tr>
<tr bgcolor="#ffffff"><td>
${nest(6, valueRow("Net Settlement", "$18,204.36"))}
</td></tr>
<tr bgcolor="#ffffff"><td>
${nest(4, valueRow("Settlement Status", "BALANCED"))}
</td></tr>
<tr bgcolor="#ffffff"><td>
${wrappedValueRow("Suspense Total", "$41.28")}
</td></tr>
<tr bgcolor="#ffffff"><td>
${splitRunRow("Batch Reference", "Clearing Batch ", "77104", " settled")}
</td></tr>
</table>
<br>
<font face="Arial" size="2"><a href="/fixtures">Return to Diagnostic Screens</a></font>`
  )

/** Wraps a fragment in `depth` further layout tables, the way this app grew. */
const nest = (depth: number, inner: string): string =>
  depth === 0
    ? inner
    : `<table width="100%" border="0" cellpadding="2" cellspacing="0"><tr><td>
${nest(depth - 1, inner)}
</td></tr></table>`

const valueRow = (label: string, value: string): string =>
  `<table width="100%" border="0" cellpadding="2" cellspacing="0">
<tr><td width="200">${caption(label)}</td><td>${caption(value)}</td></tr>
</table>`

/**
 * The same caption-and-value row, except the value cell holds a further table
 * rather than the figure itself.
 *
 * The caption and the figure are now two table nestings apart with no markup
 * relating them, so nothing but position within the row they share can associate
 * the two. It is the worst case for reading a caption-and-value layout, and it
 * is what this application does whenever a figure needed its own alignment.
 */
const wrappedValueRow = (label: string, value: string): string =>
  `<table width="100%" border="0" cellpadding="2" cellspacing="0">
<tr><td width="200">${caption(label)}</td>
<td><table width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td>${caption(
    value
  )}</td></tr></table></td></tr>
</table>`

/**
 * A cell whose text is split across inline runs, the way this application marks
 * a code out in bold mid-sentence.
 *
 * This is the shape that makes the enclosing-duplicate rule earn its keep.
 * Chromium gives the cell an accessible name aggregating all three runs *and*
 * exposes the runs as child nodes, so a partial name match answers with the cell
 * and with the run inside it — two nodes, both genuinely correct, one containing
 * the other. Only discarding the enclosing candidate leaves one.
 */
const splitRunRow = (label: string, lead: string, code: string, trail: string): string =>
  `<table width="100%" border="0" cellpadding="2" cellspacing="0">
<tr><td width="200">${caption(label)}</td>
<td><font face="Arial" size="2">${escape(lead)}</font><b><font face="Arial" size="2">${escape(
    code
  )}</font></b><font face="Arial" size="2">${escape(trail)}</font></td></tr>
</table>`

/**
 * Dual Ledger: two iframes, one set of captions.
 *
 * Ticket 01's Account Detail proves a Target can reach *into* a frame without
 * naming one. This proves the harder half: with two frames the same Target
 * reaches into both, and the run has to stop and say which document each
 * candidate came from. A Target still says nothing about frames — `within` names
 * the ledger's heading, which happens to be inside one of them.
 */
export const dualLedgerPage = (): string =>
  shell(
    "Heritage Core - Dual Ledger",
    `<table width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td>
<font face="Arial" size="2"><b>Dual Ledger</b></font>
</td></tr></table>
<br>
<table width="100%" border="0" cellpadding="0" cellspacing="0">
<tr>
<td width="50%"><iframe src="/fixtures/frames/panel?ledger=A" name="${LEDGERS.A.frame}" width="100%" height="220" frameborder="1" scrolling="auto" marginwidth="0" marginheight="0"></iframe></td>
<td width="50%"><iframe src="/fixtures/frames/panel?ledger=B" name="${LEDGERS.B.frame}" width="100%" height="220" frameborder="1" scrolling="auto" marginwidth="0" marginheight="0"></iframe></td>
</tr>
</table>
<br>
<font face="Arial" size="2"><a href="/fixtures">Return to Diagnostic Screens</a></font>`
  )

/**
 * One ledger's document, as it appears inside its iframe.
 *
 * The hidden `ledger` field is what makes `Post` land back on this same panel.
 * The route needs `ledger=A|B` to know which document to render, and a GET form
 * submits only its own fields — so without it, pressing `Post` in either frame
 * navigated to `/fixtures/frames/panel?adjustment=...` and got a 404. A fixture
 * whose only control is a dead end teaches the wrong thing about the fixture.
 */
export const ledgerPanel = (key: LedgerKey): string => {
  const ledger = LEDGERS[key]
  return `${DOCTYPE}
<html>
<head>
<title>${escape(ledger.heading)}</title>
<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
</head>
<body bgcolor="#ffffff" topmargin="4" leftmargin="4" marginwidth="0" marginheight="0">
<form method="get" action="/fixtures/frames/panel">
<input type="hidden" name="ledger" value="${key}">
<table width="100%" border="1" cellpadding="4" cellspacing="0" bordercolor="#808080">
<tr bgcolor="#c0c0c0"><td colspan="2"><font face="Arial" size="2"><b>${escape(ledger.heading)}</b></font></td></tr>
<tr bgcolor="#ffffff"><td width="160">${caption("Posted Balance")}</td><td>${caption(ledger.posted)}</td></tr>
<tr bgcolor="#ffffff"><td>${caption("Pending Balance")}</td><td>${caption(ledger.pending)}</td></tr>
<tr bgcolor="#ffffff"><td>${caption("Adjustment")}</td><td><input type="text" name="adjustment" size="12" maxlength="12" title="Adjustment"></td></tr>
<tr bgcolor="#ffffff"><td>&nbsp;</td><td><input type="submit" value="Post"></td></tr>
</table>
</form>
</body>
</html>
`
}
