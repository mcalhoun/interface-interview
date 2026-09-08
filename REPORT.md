## Architecture

Discovery gives a language model a goal and a live application to operate. A successful run becomes a typed Capability Artifact. Replay executes that artifact without asking a model to choose actions. Heritage Core, the local target, uses nested layout tables, ambiguous captions, full page loads and an unnamed iframe. All member data is synthetic.

TypeScript and Effect express the boundary between the two modes. The deterministic engine requires Surface Adapter, Policy, Evidence and Session services. Its service requirements exclude the language model; optional assisted classification is supplied separately. The CLI composes those services. Bun runs the application and stores artifacts and evidence as files. A database or queue would add deployment work without improving this demonstration.

The Surface Adapter exposes observation and operations on logical Targets. Its implementation uses accessibility snapshots and accessibility references, never CSS selectors or markup reads. This makes missing accessibility information a visible limitation rather than an invitation to add application-specific selectors. See ADR-0001 and ADR-0003. The historical live discovery evidence is under `evidence/discovery/gpt-4.1-drove-this/`; it identifies `gpt-4.1` separately from scripted model tests.

## Artifact schema

Each YAML document has a capability name, immutable version, typed inputs and outputs, ordered steps, checkpoints and declared outcomes. Each step states its intent. Each Target includes its matching strategy and a written robustness argument, so a reviewer can assess why the same control should be found on another invocation.

Values record whether they come from an input parameter, a constant or an earlier extraction. This prevents a member number from becoming a fixed string in a reusable flow. Entry locations are paths; deployment supplies the origin. Parsing checks references between parameters, steps, outputs and outcomes. Every step needs a checkpoint, because a successful click alone does not prove the intended screen appeared.

Compilation runs while the private goal and discovered values remain in memory. It rejects literals and prose that retain those values. Discovery's JSON export is a checked artifact envelope, separate from its scrubbed diagnostic trajectory. The later compile command validates that staged artifact; it cannot repeat private-data checks after their inputs have been erased. The envelope is provenance metadata, not a cryptographic signature or an approval decision.

A resumed discovery intervention becomes an explicit human dependency in the artifact. Replay requests the missing manual work if the next-state checkpoint fails, then verifies the operator's result. It never invents omitted actions. Entry URLs containing query or fragment values become required sensitive runtime parameters without defaults.

A single successful run supplies no evidence for unseen business states. Their classification requires a separately verified amendment. Compilation does not invent recovery rules or infer input formats from one example.

## Determinism & error handling

Replay resolves each Target against a fresh accessibility snapshot, applies explicit matching rules and checks the resulting state. List selection compares an input against labels in a named region. Ambiguous matches stop with candidate descriptions; the engine does not choose an arbitrary account. Bounded polling accommodates delayed loads without adding model decisions.

The result contract separates success with outputs, expected business outcomes, hard failures and requests for intervention. `MEMBER_NOT_FOUND` is a business answer. A transient overlay can trigger a declared remedy. An expired session can recover when credentials and policy permit it. An ambiguous Target or prohibited action stops with the step, expectation and observed state.

The recovery order is checkpoint evaluation, declared business outcomes, declared recovery, an optional bounded classification consultation, then human intervention. The consultation cannot act or invent a new outcome code. An assisted result is marked as assisted. Retrying an action that could commit a change requires an explicit repeatability justification; recovering a screen is not permission to repeat an uncertain transaction.

## Heterogeneity & multi-tenant

The implemented adapter already handles legacy web structure. Frame traversal stays inside it, so artifacts describe the account control without recording a frame name. The observation type contains accessibility structure, location and frame metadata; raw Playwright references never enter the artifact.

A desktop adapter would obtain roles, names, values and ancestry from Windows UI Automation or macOS Accessibility, resolve the same Targets, and invoke controls through those APIs. It would translate entry locations into an application launch or window selection and keep window handles inside the adapter. Session ownership would govern that same live desktop session. This is a design seam, not implemented desktop support. Controls absent from those accessibility APIs remain unsupported; adding vision or coordinates would require an explicit new targeting contract.

Vendor-level artifacts remain independent of tenant origins. A confirmed Tenant Override changes a scoped target against a particular base version; a second institution need not copy the entire flow. Unexpected matching or checkpoint failures expose differences for review. The implementation demonstrates one tenant variant. A production rollout would additionally record vendor versions, replay representative tenant cases and require approval before promoting an override.

## Escalation & handoff

`bun run demo:handoff` launches a repeatable headed demonstration. The [walkthrough](docs/human-handoff.md) maps it to assignment section 3.6 and explains how a person takes control, releases a synthetic supervisor hold and returns the same Session. `bun run verify:handoff` checks the transfer and blocked-return paths with a scripted Operator against real Chromium.

Discovery stops on bounded time or steps, repeated unproductive states and dead ends. Replay escalates when declared handling cannot establish a safe result. An Intervention carries the goal or capability, stopping step, reason and evidence. Without an available operator interface, the process returns a structured stopped result instead of waiting indefinitely.

Handoff transfers ownership of the same live session. Automation pauses; an Operator takes the visible Chromium window through a token-protected local interface, works there and returns control. The ownership state machine rejects conflicting transitions and automation actions while the Operator owns the session. The intervention record preserves notes, observed changes and the transfer history. An operator who cannot proceed can return a blocked answer.

Resumption verifies the resulting screen. A person's claim of success does not replace the checkpoint. A stopped action and an action whose checkpoint failed also need different resume behavior: the returned checkpoint determines whether a person completed the stopped action or merely restored its control.

Learning requires a recorded intervention and an executor-supplied failure cause bound to the same capability, version and step. An authority-requiring intervention can teach the capability to request a person next time. A business-outcome amendment requires evidence that observation alone sufficed. An empty free-text action list cannot prove that nobody changed the screen. Existing automated handoff demonstrations use scripted operators through the real interface; they do not establish that a person completed those demonstrations at a keyboard.

## Safety

Policy is deny-first. It names allowed origins and action types; risky operations need written justification. Missing or malformed policy stops the run. Origins are compared by parsed scheme, host and port. The browser also gates network requests, including iframe loads and redirect hops, before sending them. Frame origins are checked before observation and targeted operations. A policy violation stops the surface. Without an explicit browser predicate, only the supplied starting origin is permitted; without either, network access is denied.

Parameters are sensitive by default. Declassification requires both artifact intent and deployment policy. Text evidence, exported diagnostics and compiler output pass through redaction boundaries; the raw goal stays in memory. Sensitive values are revealed only where necessary to operate the application. Scrubbing known values is not a general detector for every possible secret on an arbitrary page.

Binary evidence is disabled by default. Built-in synthetic fixture commands and the demo explicitly opt into unredacted screenshots under ADR-0010. External `--baseUrl` runs retain scrubbed accessibility evidence without persisting screenshot bytes. Enabled fixture screenshots can contain synthetic identifiers and balances. Masking remains unimplemented; enabling screenshots for real records requires verified protection.

## Cuts

Desktop execution, remote co-browsing, distributed session ownership and production storage are unimplemented. The local session and file interfaces leave room for them without requiring infrastructure now. Stronger detection of unknown sensitive data and masking before enabling screenshots come before deployment against real records.

The two retained stretch goals are assisted fallback and tenant reuse. The optional catalog was removed to keep this scope within the brief; capabilities remain callable by name with typed arguments through replay. The first operational additions would be artifact approval, bounded stability trials, deployment-specific policy and audited tenant rollout. Assisted classification and tenant overrides demonstrate those boundaries but do not establish broad model reliability. The September 8 evidence bundle links a genuine `gpt-4.1` discovery to its exact artifact, deterministic replay and recorded outcome amendments through version 1.8.0. That same version replays ordinary success, no matching account, member not found and input validation. Operator judgment is scripted; the live browser and ownership transfer are real. See [verification](evidence/verification/2026-09-08-final/README.md) for the final suite and clean-install results.
