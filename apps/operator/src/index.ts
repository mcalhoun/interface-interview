/**
 * The Operator surface: what a person sees when a run pauses, and how they take
 * and return ownership of the live Session.
 *
 * ## Deliberately plain
 *
 * Server-rendered HTML, form posts, no client-side anything. The interface is
 * not the interesting part of this ticket and pretending otherwise would hide
 * what is: an Operator does the actual work in the browser window the automation
 * was already driving, not in here. This page tells them where to look, what
 * stopped, and gives them the two buttons that move the Control Owner state
 * machine. That is the whole job.
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
 */

import { Effect } from "effect"
import type { Scope } from "effect/Scope"
import {
  type ControlReturnClassification,
  type HandoffSnapshot,
  type InterventionRecord,
  type OwnerTransition,
  SessionControl,
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
  /** e.g. `http://127.0.0.1:4180`, with no trailing slash. Printed on pause. */
  readonly origin: string
  readonly port: number
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

    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: options.port ?? DEFAULT_OPERATOR_PORT,
          hostname: options.hostname ?? "127.0.0.1",
          fetch: (request) => Effect.runPromise(route(control, request))
        })
      ),
      (running) => Effect.promise(() => running.stop(true))
    )

    const origin = server.url.origin
    yield* Effect.acquireRelease(control.attach(origin), () => control.detach)

    return { origin, port: Number(server.url.port) }
  })

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const route = (
  control: SessionControl["Service"],
  request: Request
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const url = new URL(request.url)

    if (url.pathname === "/state") {
      const snapshot = yield* control.snapshot
      return json(snapshot)
    }

    if (request.method === "POST") {
      const form = yield* Effect.promise(() => request.formData())
      const field = (name: string): string => String(form.get(name) ?? "").trim()

      const action =
        url.pathname === "/take"
          ? control.takeControl(field("operator") === "" ? "(unnamed)" : field("operator"))
          : url.pathname === "/note"
            ? control.noteAction(field("detail") === "" ? "(no detail given)" : field("detail"))
            : url.pathname === "/return"
              ? control.returnControl({
                  operator: field("operator") === "" ? "(unnamed)" : field("operator"),
                  classification: classificationOf(field("classification")),
                  detail: field("detail") === "" ? "(no detail given)" : field("detail")
                })
              : undefined

      if (action === undefined) return notFound(url.pathname)

      // A refused transition is shown, not swallowed. Someone who posts a
      // take-control form twice should be told the session is already theirs
      // rather than watching the page reload as if it worked.
      return yield* action.pipe(
        Effect.as(seeOther("/")),
        Effect.catch((problem) => Effect.succeed(refused(problem.message)))
      )
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const snapshot = yield* control.snapshot
      return html(dashboard(snapshot))
    }

    return notFound(url.pathname)
  })

const classificationOf = (value: string): ControlReturnClassification =>
  value === "resolved" ? "resolved" : "unresolved"

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

const notFound = (pathname: string): Response =>
  html(page("Not found", `<p>No operator route at ${escape(pathname)}.</p>`), 404)

const refused = (message: string): Response =>
  html(
    page(
      "Refused",
      `<p class="refused">${escape(message)}</p><p><a href="/">Back to the session</a></p>`
    ),
    409
  )

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
label { display: block; margin: .5rem 0; }
input[type=text] { width: 24rem; padding: .3rem; }
.refused { color: #900; font-weight: bold; }
.note { color: #555; }
`

const page = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escape(title)}</title><style>${STYLE}</style></head>
<body>${body}</body>
</html>
`

const dashboard = (snapshot: HandoffSnapshot): string => {
  const heading = `<h1>Operator &mdash; session ${escape(snapshot.sessionId)}</h1>
<p>Control owner: <span class="owner">${escape(snapshot.ownerLabel)}</span></p>`

  const body =
    snapshot.pending === undefined
      ? `<p class="note">Nothing is paused. This page becomes useful when a run stops and
         raises an Intervention.</p>`
      : pendingPanel(snapshot)

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

const pendingPanel = (snapshot: HandoffSnapshot): string => {
  const record = snapshot.pending!
  const it = record.intervention
  const held = snapshot.owner === "operator"

  const facts = `<h2>Why the run stopped</h2>
<table>
<tr><th>Capability</th><td>${escape(it.capability)}@${escape(it.version)}</td></tr>
<tr><th>Step</th><td><code>${escape(it.stepId)}</code> &mdash; ${escape(it.stepIntent)}</td></tr>
<tr><th>Reason</th><td>${escape(it.reason)}</td></tr>
<tr><th>Detail</th><td>${escape(it.detail)}</td></tr>
<tr><th>Screen</th><td>${escape(it.url)}</td></tr>
<tr><th>Raised</th><td>${escape(it.raisedAt)}</td></tr>
<tr><th>Run</th><td><code>${escape(it.runId)}</code></td></tr>
</table>
<p class="note">The live browser window for this session is already on that screen.
Work in it directly &mdash; this page does not drive the browser.</p>
<h2>What the automation could see</h2>
<pre>${escape(it.accessibility)}</pre>`

  const actions = record.actions.length === 0
    ? ""
    : `<h2>What has been done</h2><table>${
        record.actions
          .map((action) => `<tr><th>${escape(action.at)}</th><td>${escape(action.detail)}</td></tr>`)
          .join("")
      }</table>`

  const controls = held
    ? `<h2>You hold this session</h2>
<p class="note">Taken by ${escape(record.operator ?? "(unnamed)")} at ${
        escape(record.tookControlAt ?? "")
      }. The automation cannot act until you hand it back.</p>
<form method="post" action="/note">
<label>Something you did <input type="text" name="detail" placeholder="entered supervisor override SUP-HOLD-02"></label>
<button type="submit">Record it</button>
</form>
<form method="post" action="/return">
<input type="hidden" name="operator" value="${escape(record.operator ?? "")}">
<label><input type="radio" name="classification" value="resolved" checked>
  Resolved &mdash; the screen is ready, resume the run from this step</label>
<label><input type="radio" name="classification" value="unresolved">
  Not resolved &mdash; end the run and report that a person is needed</label>
<label>What you did <input type="text" name="detail" placeholder="authorized the account as supervisor SUP7"></label>
<button type="submit">Return control</button>
</form>`
    : `<h2>Take control</h2>
<form method="post" action="/take">
<label>Your name <input type="text" name="operator" placeholder="j.okafor"></label>
<button type="submit">Take control of this session</button>
</form>`

  return facts + actions + controls
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
            } &mdash; ${escape(record.detail ?? "")}</td></tr>`
          )
          .join("")
      }</table>`
