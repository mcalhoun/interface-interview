/**
 * The Operator surface: what a person sees when a run pauses, and how they take
 * and return ownership of the live Session.
 *
 * ## Deliberately plain
 *
 * Server-rendered HTML, form posts, no client-side anything. The interface is
 * a control interface. An Operator does the actual work in the browser window the automation
 * was already driving, not in here. This page tells them where that window is,
 * what stopped, what order to do things in, and gives them the buttons that move
 * the Control Owner state machine. That is the whole job.
 *
 * ## What the first real person needed and did not get
 *
 * They could not find the application. Playwright opens a separate macOS
 * application called **Google Chrome for Testing**, and this page said only that
 * "the live browser window for this session is already on that screen". It names
 * the application now, and says where to look for it, because nothing here can
 * raise a window: the browser is behind the `SurfaceAdapter` seam, which by
 * ADR-0001 has eight methods and none of them is "focus yourself", and shelling
 * out to activate an application by name can just as easily launch a second copy
 * of it in front of the one that matters.
 *
 * They also had no way to say they were stuck, and the page led with a wall of
 * machine-written prose that quoted a previous operator's words in a way that
 * read as instructions for this run. Both are fixed below: `blocked` is a real
 * answer, and everything written before this run is behind a heading that says
 * so.
 *
 * ## Why it lives in the same process
 *
 * ADR-0009. A Session is a live browser handle, so a second process would mean
 * shipping the handle or building a broker, and neither demonstrates anything the
 * direct approach does not. `Bun.serve` because `@effect/platform-bun` at this RC
 * exports no HTTP server — the same reason Heritage Core is a bare `Bun.serve`.
 *
 * ## What it does not decide
 *
 * Every route here is a thin call onto `SessionControl`. The interface holds no
 * state of its own and enforces no rule of its own: taking control of a session
 * nobody paused is refused by the state machine, not by a disabled button. A
 * guard that lives in a form is a guard that anyone with `curl` walks around.
 *
 * ## What it does decide: who is allowed to ask
 *
 * That is a different question from what is allowed to happen, and it is the one
 * thing this file must answer for itself, because there is nobody else to ask.
 *
 * The interface listens on a loopback port. Authentication and origin checks
 * matter because any page open in the operator's browser can submit a form here.
 * A form submission is not
 * subject to the same-origin policy, and the attacker does not need to read the
 * response to do damage. Return-of-control is what writes durable Capability
 * amendments (ADR-0004) and tenant overrides (ADR-0006), carrying an operator's
 * name and their answer to "should automation handle this next time". Forged
 * metadata there feeds a one-way classification ratchet. "It is only localhost"
 * is not a defence against the browser the operator is sitting in front of.
 *
 * Three things, and deliberately no more:
 *
 * 1. **A per-run token**, 32 random bytes, minted when the interface starts and
 *    never written to Evidence. Every request carries it -- in the query string
 *    of the URL the run prints, in a hidden field on every form, or in an
 *    `x-operator-token` header for anything scripted. Compared in constant time.
 * 2. **`Origin` and `Sec-Fetch-Site` are checked** on state-changing requests
 *    and a cross-site one is refused. A token in a URL can leak by `Referer`, so
 *    the token alone is not enough; the fetch metadata is what a cross-origin
 *    form post cannot forge from a page.
 * 3. **The token is required on `GET /` and `GET /state` too.** They are
 *    read-only, and the argument for leaving them open does not survive contact
 *    with what they contain: `GET /` renders the token into every form on the
 *    page, so an open `/` hands the credential to anything that can guess the
 *    port, and the other two measures then protect nothing. `/state` carries the
 *    paused screen's accessibility tree -- the same banking screen content the
 *    Evidence scrubber exists to keep out of files. A person following the
 *    printed link is unaffected, because the link carries the token.
 *
 * What this is not: an auth system. There are no accounts, no sessions, no
 * expiry and no revocation, and there should not be -- this is one person, one
 * machine, one run. The bar it has to clear is that a random web page cannot
 * drive it, and a per-run secret the page never sees clears it.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { Effect } from "effect"
import type { Scope } from "effect/Scope"
import {
  type ControlReturnClassification,
  type HandoffSnapshot,
  type InterventionRecord,
  type NextTimeAnswer,
  type OwnerTransition,
  type ProposalAnswer,
  SessionControl,
  THE_PROPOSAL_QUESTION,
  THE_QUESTION,
  describeOwner
} from "@cua/session"

export const DEFAULT_OPERATOR_PORT = 4180

export interface OperatorInterfaceOptions {
  readonly control: SessionControl["Service"]
  /** `0` asks the OS for a free port, which is what tests should pass. */
  readonly port?: number
  readonly hostname?: string
}

export interface OperatorInterface {
  /** e.g. `http://127.0.0.1:4180`, with no trailing slash. */
  readonly origin: string
  readonly port: number
  /**
   * This run's token. Required on every request.
   *
   * Minted here, held in memory, and never recorded: it is a credential for one
   * process's lifetime, and an Evidence file that contained it would outlive the
   * thing it protects. A scripted operator sends it as `x-operator-token`.
   */
  readonly token: string
  /**
   * The URL to give a person: the origin with the token on it. This is what the
   * CLI prints and what `announce` says again at the moment of the pause.
   */
  readonly url: string
}

/**
 * Serve the operator interface for one run, and register it with the Session.
 *
 * Registering is what makes `Session.handoffAvailable` true, and it is scoped:
 * when the Scope closes the interface detaches, so a run whose operator window
 * has gone away reports a Hard Failure rather than pausing for somebody who is no
 * longer there.
 */
export const serveOperator = (
  options: OperatorInterfaceOptions
): Effect.Effect<OperatorInterface, never, Scope> =>
  Effect.gen(function* () {
    const { control } = options

    // 32 bytes from the OS. Minted per run, not per install: a token in a config
    // file is a token that outlives the session it protects and gets committed.
    const token = randomBytes(32).toString("base64url")

    const server = yield* Effect.acquireRelease(
      Effect.sync(() => {
        // The handler needs the interface's own origin to check `Origin`
        // against, and the origin is not known until `Bun.serve` has bound a
        // port -- which is always, with `port: 0`. Reading it through a `let`
        // rather than closing over the server keeps that dependency one-way and
        // avoids naming Bun's generic server type.
        let origin = ""
        const running = Bun.serve({
          port: options.port ?? DEFAULT_OPERATOR_PORT,
          hostname: options.hostname ?? "127.0.0.1",
          fetch: (request) => Effect.runPromise(route(control, request, token, origin))
        })
        origin = running.url.origin
        return running
      }),
      (running) => Effect.promise(() => running.stop(true))
    )

    const origin = server.url.origin
    const url = `${origin}/?t=${token}`
    // The *tokenised* URL is what gets attached, because it is the one an
    // Operator can actually use: `announce` prints this at the moment of the
    // pause and a bare origin would send them to a 401.
    yield* Effect.acquireRelease(control.attach(url), () => control.detach)

    return { origin, port: Number(server.url.port), token, url }
  })

// ---------------------------------------------------------------------------
// Who is allowed to ask
// ---------------------------------------------------------------------------

/**
 * Constant-time equality over secrets of unequal length.
 *
 * `timingSafeEqual` throws on a length mismatch, and branching on the length
 * first leaks it. Hashing both sides gives two 32-byte buffers whatever arrived,
 * so the comparison is the same shape for every input.
 */
const sameSecret = (given: string, expected: string): boolean =>
  timingSafeEqual(
    createHash("sha256").update(given).digest(),
    createHash("sha256").update(expected).digest()
  )

/** Where a token may arrive: the printed link, a form, or a scripted header. */
const tokenOf = (request: Request, url: URL, form: FormData | undefined): string =>
  request.headers.get("x-operator-token") ??
  (form === undefined ? undefined : (form.get("token") as string | null)) ??
  url.searchParams.get("t") ??
  ""

/**
 * Why a request is being turned away, or `undefined` if it is not.
 *
 * Ordered so the cheap structural check comes first: a cross-site POST is
 * refused before the token is even looked at, so a page that has somehow
 * obtained the token by `Referer` still cannot drive the interface from an
 * `<iframe>` or a hidden form.
 */
const refusalFor = (
  request: Request,
  url: URL,
  form: FormData | undefined,
  token: string,
  origin: string
): string | undefined => {
  const changing = request.method !== "GET" && request.method !== "HEAD"

  if (changing) {
    // Set by the browser, not by the page. `cross-site` and `same-site` are both
    // refused: nothing legitimate posts here except this interface's own forms.
    const site = request.headers.get("sec-fetch-site")
    if (site !== null && site !== "same-origin" && site !== "none") {
      return `cross-site request refused (Sec-Fetch-Site: ${site})`
    }
    // `Origin` on a form POST is set by the browser, not the page. Two values are
    // legitimate here and neither is forgeable by another site.
    //
    // The first is this interface's own origin. The second is the literal string
    // "null", which is what a browser sends when the document's referrer policy
    // is `no-referrer` -- which every page here sets, deliberately, so the token
    // in the address bar cannot leak by `Referer`. An opaque origin is only
    // trustworthy alongside `Sec-Fetch-Site`, checked above and unforgeable by a
    // page, so "null" is accepted only when fetch metadata already said the
    // request came from here. A cross-site post carries `cross-site` and was
    // refused before reaching this line.
    //
    // This cost a real operator a working handoff: the referrer policy and the
    // origin check were each correct and together refused every form on the page.
    const from = request.headers.get("origin")
    const opaqueFromHere = from === "null" && (site === "same-origin" || site === "none")
    if (from !== null && from !== origin && !opaqueFromHere) {
      return `request from ${from} refused; this interface only accepts ${origin}`
    }
  }

  const given = tokenOf(request, url, form)
  if (given === "" || !sameSecret(given, token)) {
    return "this operator interface needs the token from the URL the run printed"
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const route = (
  control: SessionControl["Service"],
  request: Request,
  token: string,
  origin: string
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const posting = request.method === "POST"
    // Read once: a `Request` body is a stream. The token may be in it, so this
    // has to happen before the check rather than after it.
    const form = posting
      ? yield* Effect.promise(() => request.formData().catch(() => new FormData()))
      : undefined

    const refusal = refusalFor(request, url, form, token, origin)
    if (refusal !== undefined) return unauthorised(refusal)

    if (url.pathname === "/state") {
      const snapshot = yield* control.snapshot
      return json(snapshot)
    }

    if (posting) {
      const field = (name: string): string => String(form?.get(name) ?? "").trim()

      // The name is passed through exactly as typed, blanks included. An empty
      // one used to become "(unnamed)" here, which is how a run driven by a real
      // person came to record a privileged decision attributed to nobody. The
      // state machine refuses it now, and this interface's job is to ask the
      // question and report the refusal, not to invent an answer.
      const action =
        url.pathname === "/take"
          ? control.takeControl(field("operator"))
          : url.pathname === "/note"
            ? control.noteAction({
                detail: field("detail") === "" ? "(no detail given)" : field("detail")
              })
            : url.pathname === "/return"
              ? control.returnControl({
                  operator: field("operator"),
                  classification: classificationOf(field("classification")),
                  detail: field("detail"),
                  actionTaken: field("actionTaken") === "true",
                  nextTime: nextTimeOf(field("nextTime")),
                  confirmProposal: confirmProposalOf(field("confirmProposal"))
                })
              : undefined

      if (action === undefined) return notFound(url.pathname, token)

      // A refused transition is shown, not swallowed. Someone who posts a
      // take-control form twice should be told the session is already theirs
      // rather than watching the page reload as if it worked.
      return yield* action.pipe(
        Effect.as(seeOther(`/?t=${token}`)),
        Effect.catch((problem) => Effect.succeed(refused(problem.message, token)))
      )
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const snapshot = yield* control.snapshot
      return html(dashboard(snapshot, token))
    }

    return notFound(url.pathname, token)
  })

/**
 * What the Operator said about whether the run can carry on.
 *
 * Three answers now. `blocked` is the honest one that had no spelling until a
 * real person needed it: the request made no sense, the screen was not the one
 * described, they could not do it. Anything unrecognised is `unresolved`, which
 * is the careful direction: a malformed post must never read as "carry on".
 */
const classificationOf = (value: string): ControlReturnClassification =>
  value === "resolved" ? "resolved" : value === "blocked" ? "blocked" : "unresolved"

/**
 * The one question's answer, read off the form.
 *
 * Anything that is not one of the two answers is `not_asked`, which is the
 * careful direction. A malformed post, a `curl` that omitted the field, or a
 * future form that renames it all close the episode having learned nothing —
 * rather than being read as a confirmation nobody gave. An Amendment is a
 * durable change to a Capability's contract and this is the field that
 * authorises one, so guessing here would be guessing about the wrong thing.
 */
const nextTimeOf = (value: string): NextTimeAnswer =>
  value === "automation_handles_it" || value === "always_stop_here" ? value : "not_asked"

/**
 * The second question's answer, read off the form the same careful way.
 *
 * Anything that is not one of the two answers is `not_asked`, which matters more
 * here than it does above: this is the field a stored Tenant Override rests on,
 * and a form that did not render the question at all — because there was no
 * proposal to render — must never produce a confirmation. `curl` cannot confirm
 * a correspondence that was never proposed either, because the Override is built
 * from the proposal on the *Intervention* and this answer together.
 */
const confirmProposalOf = (value: string): ProposalAnswer =>
  value === "confirmed" || value === "rejected" ? value : "not_asked"

/** How the second answer reads back on a closed episode. */
const describeConfirmation = (answer: ProposalAnswer): string => {
  switch (answer) {
    case "confirmed":
      return "Confirmed."
    case "rejected":
      return "Rejected."
    case "not_asked":
      return "Not asked."
  }
}

/** How an answer reads back on a closed episode. */
const describeAnswer = (answer: NextTimeAnswer): string => {
  switch (answer) {
    case "automation_handles_it":
      return "Yes."
    case "always_stop_here":
      return "No, always stop."
    case "not_asked":
      return "Not answered."
  }
}

const html = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  })

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value, undefined, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  })

const seeOther = (location: string): Response =>
  new Response(undefined, { status: 303, headers: { location } })

const notFound = (pathname: string, token: string): Response =>
  html(
    page(
      "Not found",
      `<p>No operator route at ${escape(pathname)}.</p>${backLink(token)}`
    ),
    404
  )

const refused = (message: string, token: string): Response =>
  html(
    page("Refused", `<p class="refused">${escape(message)}</p>${backLink(token)}`),
    409
  )

/**
 * The 401, and it says how to get in rather than merely that you are not.
 *
 * Deliberately identical whether the token was wrong, missing, or the request
 * was cross-site: a page probing the port learns nothing from the difference,
 * and the person who mistyped a URL needs the same sentence either way. No token
 * appears anywhere on it -- this is the response an unauthenticated caller gets,
 * so it is the last place to put the credential.
 */
const unauthorised = (why: string): Response =>
  html(
    page(
      "Not this session",
      `<p class="refused">${escape(why)}</p>
<p class="note">The run that owns this session printed a URL with a token on it, both when it
  started and again at the moment it paused. Open that link. This interface belongs to one run
  on this machine and has nothing to offer anybody else.</p>`
    ),
    401
  )

const backLink = (token: string): string =>
  `<p><a href="/?t=${escape(token)}">Back to the session</a></p>`

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const escape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

const STYLE = `
body { font: 14px/1.5 -apple-system, Segoe UI, sans-serif; margin: 2rem auto; max-width: 60rem; color: #111; }
h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin-top: 2rem; }
.owner { display: inline-block; padding: .2rem .6rem; border: 1px solid #333; font-weight: bold; letter-spacing: .05em; }
table { border-collapse: collapse; margin: 1rem 0; width: 100%; }
th, td { border: 1px solid #ccc; padding: .4rem .6rem; text-align: left; vertical-align: top; }
th { width: 12rem; background: #f4f4f4; font-weight: normal; color: #555; }
pre { background: #f7f7f7; border: 1px solid #ddd; padding: .8rem; overflow: auto; max-height: 22rem; font-size: 12px; }
form { border: 1px solid #ccc; padding: 1rem; margin: 1rem 0; }
fieldset { border: 1px solid #999; padding: .6rem 1rem; margin: 1rem 0; }
legend { font-weight: bold; padding: 0 .4rem; }
label { display: block; margin: .5rem 0; }
input[type=text] { width: 24rem; padding: .3rem; }
.refused { color: #900; font-weight: bold; }
.note { color: #555; }
.reason { font-size: 1.05rem; font-weight: bold; margin: .6rem 0; }
.where { border: 2px solid #333; padding: .2rem 1rem 1rem; margin: 1.5rem 0; background: #fbfbf6; }
.where h2 { margin-top: 1rem; }
ol { padding-left: 1.4rem; } ol li { margin: .4rem 0; }
li.done { color: #777; text-decoration: line-through; }
details { margin: 1rem 0; }
summary { cursor: pointer; font-weight: bold; }
code { word-break: break-all; }
`

const page = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${
  escape(title)
}</title><style>${STYLE}</style></head>
<body>${body}</body>
</html>
`

/**
 * The token, as a hidden field on every form.
 *
 * On the form rather than on the form's `action`, so that submitting does not
 * put the credential in the address bar of the page that renders next -- the
 * same argument that made Heritage Core's supervisor override a POST. The
 * `no-referrer` meta above covers the one place it does appear, which is the
 * address bar of the link the run printed.
 */
const tokenField = (token: string): string =>
  `<input type="hidden" name="token" value="${escape(token)}">`

const dashboard = (snapshot: HandoffSnapshot, token: string): string => {
  const heading = `<h1>Operator &mdash; session ${escape(snapshot.sessionId)}</h1>
<p>Control owner: <span class="owner">${escape(snapshot.ownerLabel)}</span></p>`

  const body =
    snapshot.pending === undefined
      ? `<p class="note">Nothing is paused. This page becomes useful when a run stops and
         raises an Intervention: it is where you take the live browser session, and where
         you hand it back.</p>`
      : pendingPanel(snapshot, token)

  return page(
    `Operator — ${snapshot.ownerLabel}`,
    heading + body + resolvedList(snapshot.resolved) + trail(snapshot.history)
  )
}

/**
 * Every change of hands, oldest first.
 *
 * On the page because "who has this session, and how did it get to them" is the
 * question an Operator arriving mid-episode actually has, and answering it from
 * a log file afterwards is not the same as answering it.
 */
const trail = (history: ReadonlyArray<OwnerTransition>): string =>
  `<h2>Change of hands</h2><table>${
    history
      .map(
        (entry) =>
          `<tr><th>${escape(describeOwner(entry.owner))}</th><td>${escape(entry.at)} &mdash; ${
            escape(entry.by)
          }</td></tr>`
      )
      .join("")
  }</table>`

/**
 * The name of the application the live browser window belongs to.
 *
 * Not "your browser" and not "that screen". Playwright drives its own Chromium
 * build, which on macOS is a separate application in the Dock called exactly
 * this, so a person who has been told to look at "the browser" looks at the one
 * they already had open and finds nothing. It is a constant rather than prose so
 * that the page, the terminal and this comment cannot drift apart.
 */
export const BROWSER_APPLICATION = "Google Chrome for Testing"

/** Where to work, said plainly, above everything else on the page. */
const whereToWork = (url: string): string =>
  `<div class="where">
<h2>Where the application is</h2>
<p>Not in this page. This page moves the session between you and the automation;
  the work happens in the browser window the automation was driving.</p>
<p>That window belongs to a separate application called
  <b>${escape(BROWSER_APPLICATION)}</b>. It is its own icon in the Dock and its own
  entry in the application switcher, next to your ordinary browser rather than
  inside it. Bring it to the front and you will find it showing:</p>
<p><code>${escape(url)}</code></p>
<p class="note">This page cannot raise that window for you. It talks to the
  session, not to the browser.</p>
</div>`

/** The order to do things in, which was nowhere on the page before. */
const theOrder = (held: boolean): string =>
  `<h2>What to do, in order</h2>
<ol>
<li${held ? ' class="done"' : ""}>Take control of the session. Automation is paused and cannot act.</li>
<li>Do the work in ${escape(BROWSER_APPLICATION)}. Nothing you do there needs to be
  typed in here: the session watches the screen, and any value you type into it is
  redacted from this run's evidence from the moment it appears.</li>
<li>In the return form, describe what you did or what stopped you. Confirm any
  action you took, including clicks that did not involve typing.</li>
<li>Hand control back, saying whether the run can carry on and what automation
  should do next time.</li>
</ol>`

const pendingPanel = (snapshot: HandoffSnapshot, token: string): string => {
  const record = snapshot.pending!
  const it = record.intervention
  const held = snapshot.owner === "operator"

  const facts = `<h2>Why the run stopped</h2>
<p class="reason">${escape(it.reason)}</p>
${paragraphs(it.detail)
    .map((part) => `<p>${escape(part)}</p>`)
    .join("\n")}
<table>
<tr><th>Capability</th><td>${escape(it.capability)}@${escape(it.version)}</td></tr>
<tr><th>Step</th><td><code>${escape(it.stepId)}</code> &mdash; ${escape(it.stepIntent)}</td></tr>
<tr><th>Screen</th><td>${escape(it.url)}</td></tr>
<tr><th>Raised</th><td>${escape(it.raisedAt)}</td></tr>
<tr><th>Run</th><td><code>${escape(it.runId)}</code></td></tr>
</table>`

  return (
    facts +
    whereToWork(it.url) +
    theOrder(held) +
    proposalPanel(record) +
    (held ? holdingControls(record, token) : takeControls(token)) +
    doneSoFar(record) +
    background(it.background) +
    `<details><summary>What the automation could see</summary>
<pre>${escape(it.accessibility)}</pre></details>`
  )
}

/** Prose arrives with blank lines in it, and a table cell turned them into a wall. */
const paragraphs = (text: string): ReadonlyArray<string> =>
  text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part !== "")

/**
 * Everything written about this state before this run started.
 *
 * Behind a heading that says so, and that is the whole change. A Step whose state
 * an earlier episode classified carries the summary somebody wrote at the time,
 * quoting what *that* operator said they did. Rendered as the detail of the thing
 * that just stopped, it reads as a set of instructions for the person now on
 * shift, which is exactly wrong: it is context about the state, written by
 * somebody who is not here, and they may have met a different screen under the
 * same code. Most interventions have none of this and the block is simply absent.
 */
const background = (written: string | undefined): string => {
  const parts = written === undefined ? [] : paragraphs(written)
  if (parts.length === 0) return ""
  return `<details><summary>Background on this state, written before this run</summary>
<p class="note">Context, not instructions. This was written by whoever met this
  state before, and the screen in front of you now may not be the one they saw.</p>
${parts.map((part) => `<p>${escape(part)}</p>`).join("\n")}
</details>`
}

/** What the Operator said they did, and what the session saw them type. */
const doneSoFar = (record: InterventionRecord): string => {
  const actions =
    record.actions.length === 0
      ? ""
      : `<table>${
          record.actions
            .map(
              (action) => `<tr><th>${escape(action.at)}</th><td>${action.kind === "note" ? "Note: " : "Confirmed action: "}${escape(action.detail)}</td></tr>`
            )
            .join("")
        }</table>`
  const observed =
    record.observed.length === 0
      ? ""
      : `<p class="note">This session observed changes in ${
          escape(record.observed.join(", "))
        }. Those values are redacted from this run's evidence from the moment they
        appeared, wherever they turn up afterwards &mdash; in a URL, in a field the
        screen echoes back, in your own note. Nothing kept the characters; only the
        field names are on the record.</p>`
  if (actions === "" && observed === "") return ""
  return `<h2>What has been done</h2>${actions}${observed}`
}

const takeControls = (token: string): string =>
  `<h2>Take control</h2>
<form method="post" action="/take">
${tokenField(token)}
<label>Your name
  <input type="text" name="operator" placeholder="j.okafor" required autofocus></label>
<p class="note">Required, and a real one. What is decided here is written into this
  capability's record with the name on it, and a decision attributed to nobody is
  worse than no decision at all.</p>
<button type="submit">Take control of this session</button>
</form>`

const holdingControls = (record: InterventionRecord, token: string): string =>
  `<h2>You hold this session</h2>
<p class="note">Taken by ${escape(record.operator ?? "")} at ${
    escape(record.tookControlAt ?? "")
  }. The automation cannot act until you hand it back.</p>
<form method="post" action="/return">
${tokenField(token)}
<input type="hidden" name="operator" value="${escape(record.operator ?? "")}">
<fieldset>
<legend>Can the run carry on?</legend>
<label><input type="radio" name="classification" value="resolved" checked>
  Yes &mdash; the screen is ready, resume the run from this step</label>
<label><input type="radio" name="classification" value="unresolved">
  No &mdash; this needs a person, and the run should say so and stop</label>
<label><input type="radio" name="classification" value="blocked">
  I could not do this &mdash; the request made no sense, the screen was not what it
  says here, or it is beyond me. Say what stopped you below</label>
</fieldset>
<label>What you did, or what stopped you
  <input type="text" name="detail" placeholder="released the hold as an authorized supervisor"></label>
<label><input type="checkbox" name="actionTaken" value="true">
  I changed the live session, including by clicking a control. My description above says what I did.</label>
<p class="note">Leave unchecked if you only observed. Field changes the session saw already
  count as actions; this confirmation also records actions that did not involve typing.</p>
${theQuestion(record)}
${theProposalQuestion(record)}
<button type="submit">Return control</button>
</form>`

/**
 * The one question, and the only new thing on this page.
 *
 * SPEC gives the operator interface exactly one job beyond moving the state
 * machine: resolve, per case, how automation should treat the state that stopped
 * it. It is asked here, at return-of-control, because this is the only moment at
 * which the person answering has actually seen the state — an upfront policy is
 * written by somebody who has not.
 *
 * What is deliberately *not* asked: what to call the state, which class it
 * belongs to, or what prose to put in the Capability. Naming it would let
 * whoever is on shift redefine a document's contract, and asking for the class
 * outright would make the classification a preference rather than a finding. The
 * class is derived from this answer together with whether they did anything
 * (`classify`, ADR-0004), and the prose is written from the record.
 *
 * The line above the radios says what the system observed them do, because that
 * is the other input to the derivation and they should be able to see it. An
 * Operator who fixed something by hand can describe and confirm it in this same
 * return form before answering.
 *
 * The default is "I would rather not say". A page that arrived pre-answered
 * would make the commonest outcome of all — somebody hitting the button without
 * reading — into a durable change to a Capability's contract.
 */
const theQuestion = (record: InterventionRecord): string => {
  const confirmed = record.actions.filter((action) => action.kind !== "note").length
  const done = confirmed === 0
    ? "No action has been confirmed yet. Notes alone do not count as changes."
    : `You have confirmed ${confirmed} action(s) on this session.`
  const seen =
    record.observed.length === 0
      ? ""
      : ` The session observed changes in ${
          escape(record.observed.join(", "))
        }. These changes count as action evidence; the values are redacted.`

  return `<fieldset>
<legend>${escape(THE_QUESTION)}</legend>
<p class="note">${escape(done)}${seen} That, and your answer, are together what decide
  whether this state can be declared in the capability itself. Describe and confirm
  any additional action above before returning control.</p>
<label><input type="radio" name="nextTime" value="automation_handles_it">
  Yes &mdash; automation should handle this state itself next time</label>
<label><input type="radio" name="nextTime" value="always_stop_here">
  No &mdash; automation should always stop here and ask for a person</label>
<label><input type="radio" name="nextTime" value="not_asked" checked>
  I would rather not say &mdash; change nothing about this capability</label>
</fieldset>`
}

/**
 * What assisted recovery suggested about the control it could not find.
 *
 * Shown above the tree rather than below it, because it is the first thing the
 * person arriving needs: the automation is not lost, it is looking for a button
 * this institution calls something else, and here is the candidate. It is framed
 * as a suggestion in the copy as well as in the code — nothing has been pressed,
 * and nothing will be until this page gets an answer.
 */
const proposalPanel = (record: InterventionRecord): string => {
  const proposal = record.intervention.proposal
  if (proposal === undefined) return ""
  return `<h2>What assisted recovery suggested</h2>
<table>
<tr><th>Looking for</th><td>${escape(proposal.forTarget)}</td></tr>
<tr><th>Proposed</th><td><b>${escape(proposal.control)}</b> on this screen</td></tr>
<tr><th>Confidence</th><td>${proposal.confidence.toFixed(2)}</td></tr>
<tr><th>Why</th><td>${escape(proposal.rationale)}</td></tr>
<tr><th>Recorded at</th><td><code>${escape(proposal.proposalRef)}</code></td></tr>
</table>
<p class="note">Nothing was pressed. A model read the screen and named a control; whether
  that is the right one is the question below, and the answer is what gets written down.</p>`
}

/**
 * The second question, asked only when there is a proposal on the Intervention.
 *
 * Conditional on purpose, and it is the difference between this and the question
 * above it. "What should automation do next time it meets this state" is well
 * posed at every return of control. "Is this control the correspondent of that
 * one" is not a question at all unless something proposed a correspondent, and a
 * form that asked it anyway would be inviting an answer about nothing.
 *
 * The default is again "I would rather not say", for the reason the other
 * default is: the commonest thing anybody does with a form is submit it without
 * reading, and that must not write a Tenant Override.
 */
const theProposalQuestion = (record: InterventionRecord): string => {
  const proposal = record.intervention.proposal
  if (proposal === undefined) return ""
  return `<fieldset>
<legend>${escape(THE_PROPOSAL_QUESTION)}</legend>
<p class="note">Answering yes writes a tenant override: from then on this capability looks
  for ${escape(JSON.stringify(proposal.control))} at this institution and for
  ${escape(JSON.stringify(proposal.forTarget))} everywhere else. The capability itself is not
  changed.</p>
<label><input type="radio" name="confirmProposal" value="confirmed">
  Yes &mdash; ${escape(proposal.control)} is the control this step needs here</label>
<label><input type="radio" name="confirmProposal" value="rejected">
  No &mdash; that is not it</label>
<label><input type="radio" name="confirmProposal" value="not_asked" checked>
  I would rather not say &mdash; write nothing</label>
</fieldset>`
}

const resolvedList = (records: ReadonlyArray<InterventionRecord>): string =>
  records.length === 0
    ? ""
    : `<h2>Closed interventions</h2><table>${
        records
          .map(
            (record) => `<tr><th>${escape(record.intervention.stepId)}</th><td>${
              escape(record.classification ?? "(open)")
            } by ${escape(record.operator ?? "(nobody)")} at ${
              escape(record.returnedAt ?? "")
            } &mdash; ${escape(record.detail ?? "")}<br>${
              escape(`${THE_QUESTION} ${describeAnswer(record.nextTime)}`)
            }${
              record.intervention.proposal === undefined
                ? ""
                : `<br>${escape(
                    `${THE_PROPOSAL_QUESTION} ${describeConfirmation(record.confirmProposal)}`
                  )}`
            }</td></tr>`
          )
          .join("")
      }</table>`
