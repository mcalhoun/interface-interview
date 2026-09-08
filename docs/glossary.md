# Computer-Use Automation System

A system that lets an AI agent operate back-office banking applications that expose no API. A model discovers how to accomplish a goal against a real UI once. The successful run becomes a reusable, typed capability, replayed deterministically from then on.

## Language

These terms distinguish domain concepts. They are not bans on accurate technical
names in adapters, protocols or public interfaces. A browser has pages; an
accessibility observation is a snapshot; a session can expose an ownership
snapshot. Keep existing names when they describe those facts clearly.

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
An application as it can be perceived and operated, whether a legacy web app or a desktop application. What a Capability acts upon. An accessibility tree is an observation of that Surface.
A browser **page** is a concrete document within a web Surface. Fields such as `ActionRequest.page` carry its URL; they do not introduce another domain concept.

**Surface Adapter**:
The component that translates Actions and Targets into operations on one concrete kind of Surface. The seam that keeps Capability Artifacts free of browser-specific detail.
_Avoid_: driver, backend, executor

**Target**:
A logical description of a control to act upon, written in terms an operator would recognise. Role, accessible name, nearby text. Never markup position or coordinates.
_Avoid_: selector, locator, element, node

**Surface State**:
What the system perceives of a Surface at one moment: its accessibility structure, location and frames. A browser accessibility **snapshot** supplies this observation. Discovery receives the permitted, scrubbed projection; raw markup is not an observation channel. A **screen** is an ordinary description of what an operator sees.

**Selection**:
Choosing one of the items a Surface currently offers by matching a parameter against their labels by token subset. Distinct from resolving a Target: a Target says which control, a Selection works out which control from a list read at Replay time. The legal values are read off the page during Discovery, never written into source.
_Avoid_: filter, lookup, search, pick

### Outcomes

**Business Outcome**:
An expected result of the application's own domain that the caller needs to know about, such as a member not existing. A legitimate answer, never a failure. Always declared in the Capability Artifact and recognised by a condition written there in advance, never inferred at run time from the shape of a screen.
_Avoid_: error, exception, negative result

**Recoverable Condition**:
A transient state the system knows how to get past on its own. A slow load, a dismissable interstitial, an expired session. The run continues afterwards.
_Avoid_: retry, glitch, soft error

**Hard Failure**:
A condition that stops the run and demands a person look at the system rather than the record. An ambiguous Target, an unreachable Surface, an invalid Artifact, a Policy violation.
_Avoid_: crash, exception, fatal error

**Requires-Human Outcome**:
A state learned to permanently need a person because resolving it required authority, or because the consequence of a control could not be determined from the screen. Recorded as `requires_human` so Replay requests a person with the reason for stopping. Learning this state does not authorize automation to proceed.
_Avoid_: blocked, manual step, unsupported

### Escalation

**Recovery Ladder**:
The ordered escalation from deterministic Replay, to bounded Assisted Recovery, to human Intervention, to Artifact Amendment. One mechanism serving outcome learning, escalation learning and Tenant adaptation alike.
_Avoid_: fallback chain, error handling, retry strategy

**Assisted Recovery**:
A single, bounded consultation of a model when Replay cannot proceed. It may propose what a state means. It may never act on the Surface.
_Avoid_: fallback, self-healing, auto-repair

**Intervention**:
The episode in which automation stops and asks a person to resolve a state. Its **intervention record** preserves the request, control transfers, operator notes and observed changes. An Operator who cannot proceed closes the episode as blocked, which teaches nothing about how to handle the state unattended.

**Handoff**:
The mechanism that transfers control of the same live Session between automation and Operator. It implements part of an Intervention, but is distinct from the record of that episode. Names such as `Handoff`, `handoffSession` and `--handoff` describe this mechanism.

**Ownership snapshot**:
A read of the current Control Owner and associated handoff state. Distinct from a Surface State or accessibility snapshot; it describes who may act, not what the application displays.

**Operator**:
The person who receives an Intervention and holds the Session while resolving it.
_Avoid_: user, admin, agent, human

**Session**:
The live execution context a run operates in, which passes intact between automation and Operator. The implemented Session uses one browser context; a future desktop adapter would retain its application/window context. Handoff never creates a fresh application session for the human.

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
The explicit statement of what the system may do: which origins, which Actions, and how conservatively risky ones get treated. Every Action passes through it in both modes. The **origin allowlist** is one component; the browser enforces it at the network and frame boundary as well as the engine checking Action permission.

**Evidence**:
The structured record of what happened during a run: decisions, actions, checkpoints, outcomes and interventions. Event **logs**, scrubbed accessibility snapshots and screenshots are concrete evidence formats. Screenshot pixels are not redacted in this synthetic demonstration; see ADR-0010.
