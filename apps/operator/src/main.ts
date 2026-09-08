/**
 * `bun run operator` — where the operator interface actually is.
 *
 * SPEC lists this command with the note "meaningful while a run is paused", and
 * under ADR-0009 that note is the whole answer: a Session is a live browser
 * handle held by the run, so the interface is served *by* the paused run, in the
 * same process, and there is nothing for a separate process to attach to.
 *
 * A command that pretended otherwise — starting a second server that could never
 * see a session — would be worse than one that explains itself. So this prints
 * how to get an operator interface, which is by attending a run.
 */

import { DEFAULT_OPERATOR_PORT } from "./index.ts"

console.log(
  [
    "The operator interface is served by a paused run, in that run's own process.",
    "",
    "A Session is a live browser handle. Under ADR-0009 handoff happens in one",
    "process on a headed browser, so there is no second process to start and no",
    "session broker to attach to: the run itself serves the page and blocks on a",
    "Deferred that its return-of-control endpoint completes.",
    "",
    "To get one, attend a run:",
    "",
    "  bun run replay member.account-balance --memberId 77777 --headed --handoff",
    "",
    `It prints its operator URL (default port ${DEFAULT_OPERATOR_PORT}) as it starts, and prints it`,
    "again, loudly, at the moment it pauses. Member 77777's savings account is",
    "under a supervisor hold, so that run pauses at the last step and waits.",
    "",
    "That URL carries a token, minted per run and required on every request. Open",
    "the link the run printed; the bare origin answers 401 on purpose. The token is",
    "there because a form POST is not subject to the same-origin policy, so without",
    "one any page open in the operator's browser could take control of a paused",
    "session and hand it back with an operator name and an answer nobody gave --",
    "and that answer is what writes a durable amendment to a capability.",
    "",
    "Anything the operator interface can do, it does to that run's session only."
  ].join("\n")
)
