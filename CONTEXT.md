# Computer-Use Automation System

A system that lets an AI agent operate back-office banking applications that expose no API. A model discovers how to accomplish a goal against a real UI once. The successful run becomes a reusable, typed capability, replayed deterministically from then on.

## Language

### Execution modes

**Discovery**:
The mode in which a model drives a live surface to accomplish a goal for the first time. Produces a Capability Artifact.
_Avoid_: recording, training, learning mode

**Replay**:
The mode in which a saved Capability Artifact runs against a live surface with no model deciding anything. The production path.
_Avoid_: playback, execution mode, running

**Goal**:
The natural-language statement of what should be accomplished, given to Discovery. The source from which input parameters are inferred.
_Avoid_: prompt, task, instruction

### Capabilities

**Capability**:
A named, callable unit of work an AI agent can invoke with typed arguments, backed by a Capability Artifact. The vendor-level concept, so one Capability serves many Tenants.
_Avoid_: skill, tool, automation, macro

**Capability Artifact**:
The typed, versioned, human-readable document describing how a Capability is carried out: its inputs, outputs, steps, checkpoints and known outcomes. Immutable once written.
_Avoid_: script, recording, flow, playbook, definition

**Step**:
One named unit within a Capability Artifact, pairing an Action with the Checkpoint that confirms it landed.
_Avoid_: instruction, command, node

**Action**:
A single operation performed against a Surface, drawn from a fixed vocabulary. What gets done.
_Avoid_: event, interaction, command

**Checkpoint**:
The condition asserted after an Action to confirm the intended state was actually reached. Distinct from the Action merely not throwing.
_Avoid_: assertion, verification, wait

**Provenance**:
The recorded origin of a value used in an Action. Derived from the Goal, read from an earlier screen, or genuinely fixed. What makes parameter discovery mechanical rather than guessed.
_Avoid_: source, lineage, binding

### Surfaces

**Surface**:
An application as it can be perceived and operated. A legacy web app, an accessibility tree, a desktop application. What a Capability acts upon.
_Avoid_: page, app, browser, UI

**Surface Adapter**:
The component that translates Actions and Targets into operations on one concrete kind of Surface. The seam that keeps Capability Artifacts free of browser-specific detail.
_Avoid_: driver, backend, executor

**Target**:
A logical description of a control to act upon, written in terms an operator would recognise. Role, accessible name, nearby text. Never markup position or coordinates.
_Avoid_: selector, locator, element, node

**Surface State**:
What the system perceives of a Surface at one moment: its accessibility structure, location and frames. The only thing Discovery ever sees.
_Avoid_: snapshot, DOM, page state, screen

**Selection**:
Choosing one of the items a Surface currently offers by matching a parameter against their labels by token subset. Distinct from resolving a Target: a Target says which control, a Selection works out which control from a list read at Replay time. The legal values are read off the page during Discovery, never written into source.
_Avoid_: filter, lookup, search, pick

### Outcomes

**Business Outcome**:
An expected result of the application's own domain that the caller needs to know about, such as a member not existing. A legitimate answer, never a failure.
_Avoid_: error, exception, negative result

**Recoverable Condition**:
A transient state the system knows how to get past on its own. A slow load, a dismissable interstitial, an expired session. The run continues afterwards.
_Avoid_: retry, glitch, soft error

**Hard Failure**:
A condition that stops the run and demands a person look at the system rather than the record. An ambiguous Target, an unreachable Surface, an invalid Artifact, a Policy violation.
_Avoid_: crash, exception, fatal error

**Requires-Human Outcome**:
A state learned to permanently need a person, because resolving it demanded authority rather than perception. Recorded so Replay escalates immediately and precisely, never so it can proceed.
_Avoid_: blocked, manual step, unsupported

### Escalation

**Recovery Ladder**:
The ordered escalation from deterministic Replay, to bounded Assisted Recovery, to human Intervention, to Artifact Amendment. One mechanism serving outcome learning, escalation learning and Tenant adaptation alike.
_Avoid_: fallback chain, error handling, retry strategy

**Assisted Recovery**:
A single, bounded consultation of a model when Replay cannot proceed. It may propose what a state means. It may never act on the Surface.
_Avoid_: fallback, self-healing, auto-repair

**Intervention**:
The episode in which automation stops, a person takes the live Session, resolves the state, and returns control. Includes the record of what they did.
_Avoid_: escalation, handoff, manual override, human-in-the-loop

**Operator**:
The person who receives an Intervention and holds the Session while resolving it.
_Avoid_: user, admin, agent, human

**Session**:
The single live browser context a run operates in, which passes intact between automation and Operator. Never a fresh one for the human.
_Avoid_: browser, context, connection

**Control Owner**:
Which party, automation or Operator, is currently permitted to act on a Session. Always answerable, never implied.
_Avoid_: lock, state, mode

**Amendment**:
The promotion of something learned during an Intervention into a new Capability Artifact version. Requires human confirmation, and links to the Intervention that justified it.
_Avoid_: update, patch, edit, revision

**Stuck**:
The condition in which Discovery is making no progress, cycling through states it has already seen, acting without effect, or running out its bounds, and must stop rather than continue.
_Avoid_: hung, looping, failed

### Environment

**Tenant**:
One customer institution. Many Tenants run the same vendor product, configured, branded and versioned differently.
_Avoid_: customer, client, org, instance

**Tenant Override**:
A scoped delta against a Capability Artifact, covering a difference a Tenant's Surface presents that matching cannot absorb. Discovered through the Recovery Ladder, never hand-written.
_Avoid_: config, customization, variant, patch

**Policy**:
The explicit statement of what the system may do: which origins, which Actions, and how conservatively risky ones get treated. Every Action passes through it in both modes.
_Avoid_: rules, permissions, guardrails, allowlist

**Evidence**:
The structured record of what happened during a run. Decisions, actions, checkpoints, outcomes, interventions, enough to reconstruct and audit it afterwards.
_Avoid_: logs, trace, history, audit trail
