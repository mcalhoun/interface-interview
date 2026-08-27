# Handoff runs in one process, on a headed browser

An Operator takes control by using the same visible browser window the automation was driving. The run pauses in-process and waits for the resume signal from a small local operator interface. There is no co-browsing console, no screencast, no cross-process session broker.

## Considered options

We looked at relaying screenshots and input through an operator page, and at attaching a second client over the debugging protocol. Both lose. A Session is a live browser handle, so splitting processes means either shipping the handle around or building a broker, and neither one demonstrates anything the direct approach does not.

## Consequences

Control transfer is real rather than simulated. The part that carries weight is the Control Owner state machine: the adapter throws if automation acts while an Operator holds the Session. Scaling out later means putting the Session behind a broker, and nothing above that seam changes.
