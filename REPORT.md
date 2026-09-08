## Architecture

This is my solution to the computer-use automation assignment. I chose to build a backend automation system and a fictional banking application with two tenants, Heritage Core and Community CU. Both run the same application code with different branding, control labels and balance layouts. All data is synthetic.

The task is to find a member, open an account and return its balances. Discovery uses a language model to operate the live UI. Compilation records the successful flow as a typed, versioned capability. Replay executes that capability without asking a model to choose actions. I used nested tables, ambiguous captions and complete page reloads to test control selection and verification after navigation.

I chose TypeScript and Effect to make service dependencies explicit. Ordinary replay requires browser access, policy, evidence and session ownership, but no model service. Tests check both that dependency boundary and the production configuration. Optional model assistance is a separate path with distinct evidence. Bun runs the commands and local application; files hold capabilities and run evidence. A database or queue would add deployment work without helping demonstrate this flow. [ADR-0003](docs/adr/0003-no-model-in-replay-proven-by-service-requirements.md) explains the replay dependency checks and their limits.

I used the Effect 4 release candidate for its shared model-provider, HTTP, schema and sensitive-value types. The cost was sparse documentation and the need to check APIs against installed definitions. [ADR-0002](docs/adr/0002-effect-4-release-candidate-as-the-application-framework.md) records that tradeoff.

The browser adapter uses Playwright and Chromium. It exposes accessibility observations and operations on controls described by role, name, caption and region. I kept CSS selectors and application markup out of the automation contract. This makes missing accessibility information a limitation I have to address explicitly, as recorded in [ADR-0001](docs/adr/0001-accessibility-tree-is-the-only-observation-channel.md).

The [live discovery bundle](evidence/discovery/live-2026-09-08T14-45-52-190Z-132a40d2/manifest.json) links a genuine `gpt-4.1` run to its compiled capability and successful replay. The repeatable demo uses scripted model decisions, so it can run without a key.

## Artifact schema

A capability is an immutable YAML version with typed inputs and outputs, ordered steps, checkpoints and declared business outcomes. Each step explains its intent. Each target records how to find the control and why that strategy should survive another invocation. YAML makes those decisions available for review without requiring the reader to reconstruct a model conversation.

Values identify their source: a parameter, a constant or an earlier extraction. The member number becomes a required input, and balances become money outputs with an amount and currency. Entry paths remain independent of the deployment's origin. Schema validation checks references between inputs, steps, outputs and outcomes. Every step needs a checkpoint because a completed click does not prove the expected screen appeared.

Discovery owns the private goal, observed values and growing registry of secrets. It compiles before releasing that context and rejects known private values in both executable fields and prose, including quoted text. Callers receive scrubbed diagnostics and a checked compilation result. The separate compile command validates the artifact and assigns public naming metadata; it cannot repeat checks against private values that no longer exist in memory. Its envelope is neither signed nor an approval record. [ADR-0008](docs/adr/0008-parameters-are-sensitive-by-default-and-literals-cannot-be-baked-in.md) explains the private-data checks and why discovery owns them.

When discovery needs manual work, the artifact retains that dependency under [ADR-0012](docs/adr/0012-discovery-interventions-remain-in-the-artifact.md). Replay requests help if the required checkpoint does not hold and checks the operator's result before continuing. Query and fragment values in entry URLs become required sensitive parameters without defaults. A single successful discovery does not establish unseen business outcomes, recovery rules or valid input formats. Those need further evidence.

## Determinism & error handling

Replay follows the saved steps and resolves controls against fresh accessibility observations. Account selection matches every word in the requested account type against labels in the account list. "Savings" can match "Regular Savings." If two accounts match, replay stops and reports both candidates. Choosing the first would risk returning the wrong balance. [ADR-0007](docs/adr/0007-selection-matches-by-token-subset-against-a-discovered-set.md) records this matching rule.

Checkpoints verify the resulting screen and extracted values. The checkpoint module owns observation and read authorization, checks session ownership while polling and repeats policy checks when the page changes. Bounded polling handles delayed content, including the balance panel, without involving a model.

The result contract distinguishes success with outputs, business outcomes, hard failures and intervention requests. A missing member returns `MEMBER_NOT_FOUND`. A known System Busy screen can trigger a declared remedy. Session expiry can recover when credentials and policy permit it. An ambiguous target or prohibited action stops with the step, expected state and observed state.

Replay checks the checkpoint, declared outcomes and recovery rules before requesting help. With assistance explicitly enabled, it can first make one bounded model consultation. The model may classify the stopped state using declared outcome codes, but it cannot operate the UI or invent a new code. The result records that assistance, its confidence and the proposal reference. [ADR-0005](docs/adr/0005-assisted-recovery-may-classify-but-never-act.md) defines what this consultation may do.

Retries require an argument that repeating the action is safe. These balance lookups read records. A future capability that posts a transaction would need to handle uncertain completion before attempting that transaction again.

## Heterogeneity & multi-tenant

Heritage Core puts balances inside an unnamed iframe. Community CU renders them inline. Frame traversal belongs to the browser adapter, so the capability describes the balance control without naming a frame. Browser references stay inside the adapter.

Community CU also changes the member field, account names and search button. The existing matching rules handle the field variation and savings labels. "Find" does not match "Search," so replay stops. A confirmed [tenant override](config/tenant-overrides/community-cu/member.account-balance.yaml) replaces that target name against capability version `1.2.0`. It leaves the shared artifact unchanged. This demonstrates reuse across two configurations, including a difference that requires review. [ADR-0006](docs/adr/0006-one-recovery-ladder-serves-learning-escalation-and-tenant-drift.md) explains why tenant differences use the same failure, intervention and amendment path as other stopped runs.

A desktop adapter would obtain roles, names, values and ancestry through Windows UI Automation or macOS Accessibility. It would resolve the same target descriptions, translate entry locations into application or window selection and retain native handles internally. Session ownership would still control who may act. I have not implemented that adapter. Controls missing from those accessibility APIs would need a new targeting strategy, such as vision or coordinates.

At larger scale, I would record vendor versions, run representative tenant cases and require approval before promoting overrides. Matching and checkpoint failures currently expose tenant differences during replay. Two local configurations do not establish reliability across hundreds of institutions.

## Escalation & handoff

Discovery has time and step limits and stops on repeated unproductive states or dead ends. Replay requests intervention when its declared handling cannot establish a safe result. The request includes the goal or capability, stopping step, reason and evidence. Without an operator interface, the process returns a structured stopped result.

I kept handoff local and in one process, following [ADR-0009](docs/adr/0009-handoff-runs-in-one-process-on-a-headed-browser.md). The run pauses, and a token-protected operator page lets a person take ownership of the original visible Chromium session. Automation cannot act while that person owns it. The session records ownership changes, observed field changes and the operator's account of the work. An unresolved return stops the run.

Returning control does not establish success. Replay checks the screen to determine whether the operator completed the stopped action or restored the control needed to attempt it. The supervisor-hold demo makes this concrete. Balances remain unavailable until the operator releases the hold; reporting success in the operator form alone cannot complete the lookup.

Learning requires a recorded intervention tied to the same capability, version, step and failure cause. Work that exercises authority can teach the capability to request a person next time. A business-outcome amendment needs evidence that observation alone was sufficient. Empty notes cannot establish that nobody changed the screen, and a blocked return teaches no unattended rule. [ADR-0004](docs/adr/0004-outcome-classification-is-derived-from-human-behaviour.md) explains how the recorded work constrains that classification.

Amendments and tenant overrides retain access to the run's live scrubber when they validate and save. This protects known values discovered during later screens or operator work. Saving still requires confirmation and cannot overwrite an existing artifact version.

The [manual walkthrough](docs/human-handoff.md) explains `bun run demo:handoff`. The [retained handoff proof](evidence/verification/2026-09-08-architecture/README.md) covers completed and blocked returns, refusal of competing replay and an agent-operated native UI run. The [video receipt](evidence/verification/2026-09-08-handoff-video/README.md) links the recording to its events. These recorded operator actions are scripted or agent-performed, not demonstrations of a person at the keyboard.

## Safety

Policy lists permitted origins and action types. Risky operations need a written justification; missing or malformed policy stops the run. The browser checks network destinations, iframe loads and redirect hops before sending requests. It also checks frame origins before observation and action. Without an explicit origin policy, the adapter permits only its supplied starting origin. With neither a policy nor a starting origin, it denies network access. [ADR-0011](docs/adr/0011-origin-policy-is-enforced-at-the-browser-boundary.md) explains why checking only the top-level page would miss forbidden frames and redirects.

Inputs are sensitive by default. Treating an input as public requires both an artifact declaration and deployment policy. Text evidence, exported diagnostics and learned documents pass through redaction checks. Private values are available where needed to operate the application, but the raw goal stays in memory. Known-value scrubbing cannot identify every secret on an unfamiliar page.

Binary capture is disabled by default. The synthetic fixture commands explicitly allow unredacted screenshots; external `--baseUrl` runs retain scrubbed accessibility evidence without screenshot bytes. Text scans do not check pixels. [ADR-0010](docs/adr/0010-evidence-screenshots-are-not-redacted.md) records the screenshot default and synthetic-data exception. Screenshot masking remains unimplemented, and policy currently restricts origins and action types rather than individual routes.

## Cuts

I left out desktop execution, remote co-browsing, distributed session ownership, production storage and artifact approval. The fictional bank also has simulated authentication. Building those systems would take effort away from the assignment's discovery, replay and handoff requirements. The local browser and file storage let a reviewer run those paths without deploying infrastructure.

I kept two stretch goals, bounded assisted classification and tenant reuse. Capabilities remain callable by name with typed arguments through replay; I removed the optional catalog. Before using real records, I would address unknown sensitive data, screenshot protection and deployment-specific policy. Before broader rollout, I would add artifact approval, repeated replay trials and audited tenant promotion.

The [September 8 review report](evidence/verification/2026-09-08-pr-review/README.md) records 553 passing tests across 56 files and a passing typecheck against its source manifest. The [discovery completion manifest](evidence/discovery/live-2026-09-08T14-45-52-190Z-132a40d2/completion-2026-09-08T14-46-08-572Z-9d350a19/manifest.json) records outcome amendments through version `1.8.0` and replays for success, no matching account, missing member and invalid input. Those runs establish the recorded cases. They do not establish broad model reliability or production readiness.
