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
                  detail: field("detail") === "" ? "(no detail given)" : field("detail"),
                  nextTime: nextTimeOf(field("nextTime")),
                  confirmProposal: confirmProposalOf(field("confirmProposal"))
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
fieldset { border: 1px solid #999; padding: .6rem 1rem; margin: 1rem 0; }
legend { font-weight: bold; padding: 0 .4rem; }
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
${proposalPanel(record)}
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
${theQuestion(record)}
${theProposalQuestion(record)}
<button type="submit">Return control</button>
</form>`
    : `<h2>Take control</h2>
<form method="post" action="/take">
<label>Your name <input type="text" name="operator" placeholder="j.okafor"></label>
<button type="submit">Take control of this session</button>
</form>`

  return facts + actions + controls
}

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
 * Operator who fixed something by hand and did not record it can say so with the
 * form above before answering.
 *
 * The default is "I would rather not say". A page that arrived pre-answered
 * would make the commonest outcome of all — somebody hitting the button without
 * reading — into a durable change to a Capability's contract.
 */
const theQuestion = (record: InterventionRecord): string => {
  const observed =
    record.actions.length === 0
      ? "You have not recorded doing anything to this session."
      : `You have recorded ${record.actions.length} action(s) on this session.`

  return `<fieldset>
<legend>${escape(THE_QUESTION)}</legend>
<p class="note">${escape(observed)} That, and your answer, are together what decide
  whether this state can be declared in the capability itself.</p>
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
