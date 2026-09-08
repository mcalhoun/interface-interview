# Computer-use automation for back-office banking

This project operates legacy banking applications that expose no API. Discovery
uses a language model to complete a goal against a live application. It compiles
the successful run into a typed, versioned Capability Artifact. Replay executes
that artifact without a model choosing actions and returns structured outputs,
a business outcome, a failure or an intervention request.

The implemented target is Heritage Core, a local application with synthetic
member data. Its nested tables, ambiguous captions, full page loads and unnamed
iframe exercise legacy targeting. The adapter observes accessibility structure;
artifacts contain no CSS selectors or browser references.

## How this solves the assignment

The assignment asks for a backend that learns to operate an application with no
API, saves that knowledge as a reusable capability, and executes it reliably for
later callers. Our concrete task is to look up a member, open their savings
account and return its available and current balances. Heritage Core lets us
exercise that flow and its exceptional states without using real banking data.

The complete path works as follows:

1. A caller supplies a natural-language goal and an application entry point.
   Discovery observes the live accessibility tree, asks the model for the next
   action, checks Policy and executes it through the browser adapter. Step and
   time limits, repeated unproductive states and dead ends bound the run.
2. After success, the compiler turns the observed actions into a versioned YAML
   capability. It records typed inputs, typed outputs, target descriptions,
   robustness reasoning and a Checkpoint for every Step. The member number
   becomes a required `memberId` input. Balances become money outputs with an
   amount and currency. The saved document contains the flow, not the model
   conversation.
3. A later caller invokes that capability by name with a fresh `memberId`.
   Replay resolves controls from the current accessibility tree, supplies the
   input and checks each resulting state. Ordinary Replay has no model service
   dependency. A successful click alone cannot establish success.
4. When the application answers differently, Replay checks declared business
   outcomes and recovery rules. A missing member returns `MEMBER_NOT_FOUND`;
   a known transient condition can recover; an ambiguous control stops with
   the Step, expected state and observed state. One successful discovery does
   not invent handling for exceptions it never encountered.
5. If the run needs a person, it pauses the same browser Session and raises an
   Intervention with the stopping context. The Operator takes ownership, works
   in that window and returns control. Automation cannot act while the Operator
   owns it. Replay verifies the returned screen before continuing. Confirmed
   learning can create a new Artifact version or a Tenant Override; it cannot
   overwrite an existing Artifact or bypass the run's privacy checks.

The retained [live discovery and replay bundle](evidence/discovery/live-2026-09-08T14-45-52-190Z-132a40d2/manifest.json)
links a genuine `gpt-4.1` run to the exact
[compiled capability](artifacts/member.account-balance.discovered/1.5.0.yaml).
Later recorded interventions extend that capability through version `1.8.0`
with verified business outcomes. The
[handoff proof](evidence/verification/2026-09-08-architecture/README.md)
includes successful and blocked returns plus an agent-operated native UI run.
These establish different parts of the project. The repeatable demo uses
scripted model decisions and Operator judgment; the retained discovery bundle
provides the required live-model evidence.

### Core requirement coverage

The section numbers below follow the assignment PDF.

| Requirement | How we implemented it | Where to inspect it |
| --- | --- | --- |
| 3.1 Goal-driven agent loop | A bounded observe, decide and act loop drives real Chromium through accessibility roles, names and regions. The fixture includes nested tables, ambiguous captions and an unnamed iframe. | [Discovery workflow](packages/agent/src/discovery.ts), [agent loop](packages/agent/src/loop.ts) |
| 3.2 Structured capability | Immutable YAML versions declare inputs, outputs, ordered actions, target strategies and Checkpoints. Schema checks reject invalid references. Compilation checks private values before discarding the run's private context. | [Artifact schema](packages/artifact/src/CapabilityArtifact.ts), [saved example](artifacts/member.account-balance.discovered/1.5.0.yaml) |
| 3.3 Deterministic replay and errors | Replay follows the saved flow without model decisions. Checkpoint owns observation and permitted reads. Replay distinguishes business outcomes from failures, tries declared recovery and requests intervention when needed. | [Replay engine](packages/replay/src/engine.ts), [result contract](packages/replay/src/ReplayResult.ts), [Checkpoint](packages/replay/src/checkpoint.ts) |
| 3.4 Safety and policy | Policy allows specific origins and action types, and risky actions require a written justification. The browser checks frames and network destinations, including redirects. A live secret registry protects text Evidence and learned documents, including quoted values. | [Deployment policy](policies/default.yaml), [text redaction](packages/evidence/src/Scrub.ts), [run-bound learning](packages/replay/src/learning.ts) |
| 3.5 Evidence and observability | Structured events record actions, decisions, checkpoints, outcomes and ownership changes. Accessibility observations provide failure context. Synthetic fixture runs also retain screenshots. | [Verification bundle](evidence/verification/2026-09-08-architecture/README.md), [Evidence writer](packages/evidence/src/EvidenceWriter.ts) |
| 3.6 Human escalation and handoff | A token-protected local interface exposes the request and transfers the original live Session to the Operator. It records observed field changes and confirmed actions. Return requires screen verification; an unresolved request stops the run. | [Manual walkthrough](docs/human-handoff.md), [acceptance tests](test/human-handoff-acceptance.test.ts) |
| 3.7 Heterogeneity and tenant reuse | Artifacts describe logical controls while the Surface Adapter owns browser details. Deployment supplies the origin. A confirmed override handles a second tenant's changed controls against a specific base version. Desktop execution has a documented adapter design but is not implemented. | [Adapter contract](packages/surface/src/SurfaceAdapter.ts), [tenant demonstration](test/second-tenant-and-discovered-override.test.ts), [extension design](REPORT.md#heterogeneity--multi-tenant) |

Runtime schemas validate the capability contract. TypeScript and Effect make
service dependencies explicit, including the separation between Discovery's model and
Replay's deterministic execution. A single process and file storage are enough
to demonstrate the full flow. Queues, distributed ownership and production
storage would add operational work without testing the core design decisions.

This is a working local implementation with stated limits. Policy currently
works at origin and action-type granularity, not individual routes. Known-value
scrubbing cannot identify every possible secret on an unfamiliar screen, and
screenshot masking is unimplemented. External application runs disable binary
capture. The [evidence and limits](#evidence-and-its-limits) section distinguishes
implemented behavior, scripted demonstrations and future work.

[REPORT.md](REPORT.md) gives the fuller rationale and cuts under the assignment's
seven required headings. [CONTEXT.md](CONTEXT.md) defines the vocabulary.
[SPEC.md](SPEC.md) is the original plan; [docs/adr/](docs/adr/) records the
architecture decisions.

## Setup

Install [Bun](https://bun.sh) 1.4 or later, then:

```bash
bun install --frozen-lockfile
bunx playwright install chromium
bun run typecheck
bun run test
```

No database, container or separately running application is required. Commands
start Heritage Core on an available local port. `--baseUrl <url>` selects another
installation, whose origin must be allowed by the chosen policy.

Real discovery needs `OPENAI_API_KEY` in the environment. Keep credentials out of
tracked files. The deterministic demo and tests can run without a key. Replay's
optional `--assist` consultation needs a key; unavailable assistance produces a
structured refusal and leaves the normal failure or handoff path available.

The commands below explicitly select `gpt-4.1`, which completed the September 8 live
demonstration and is the configured default. Historical attempts with
`gpt-4.1-mini` did not finish this goal. A model name is not a guarantee that a
new run will follow the same steps or pass compilation.

## Discover, compile and replay

This is the live end-to-end path. It calls the model and drives real Chromium.
Use synthetic identifiers only.

```bash
bun run discover "Look up the savings account balance of member 12345" \
  --model gpt-4.1 --json > checked-run.json

bun run compile checked-run.json \
  --capability member.account-balance.local

bun run replay member.account-balance.local --memberId 12345 --json
```

Run compilation only after discovery exits successfully. For a shell pipeline,
join the commands with `&&` so a refused discovery cannot feed compilation.
Artifact storage is append-only. Choose a new capability name or version when
repeating this example after it has already written a document.

`discover --json` writes a checked compilation envelope to standard output.
Human-readable status goes to standard error. Private-data compiler checks run
inside discovery, while the raw goal and parameter values are still in memory.
The workflow returns scrubbed diagnostics separately from its checked artifact;
its private trajectory stays inside Discovery.
`compile` validates the staged artifact and applies the requested public naming
metadata. It rejects legacy raw-trajectory input. The envelope's marker is not a
signature, and it does not establish reviewer approval or let another process
repeat checks against values that were deliberately erased.

To compile and store directly during discovery:

```bash
bun run discover "Look up the savings account balance of member 12345" \
  --model gpt-4.1 --headed \
  --emit member.account-balance.local --artifactVersion 1.1.0
```

One happy-path discovery does not demonstrate how the application answers every
exception. The compiler does not invent outcomes it never observed. A discovered
artifact needs a verified outcome amendment before it can classify an unfamiliar
business state as a legitimate answer.

## Run the deterministic demonstration

```bash
bun run demo
```

The demo covers scripted discovery, repeated replay,
business outcomes, recoverable conditions, handoff, learning, optional assistance,
a tenant variant and a text-evidence scan. It prints commands and evidence paths.
It writes under `evidence/demo/`, clearing that directory first.

The demo's discovery model is scripted so this command can run without a key.
Its operator demonstrations send requests to the real local operator interface
and use the same session as automation. They are automated demonstrations of the
mechanism, not recordings of a person at a keyboard. The assistance act may call
the real provider when a key is present; otherwise it records the declined
consultation. Neither scripted discovery nor scripted assistance establishes that
a live model succeeded.

The two retained stretch goals are bounded assisted recovery and cross-tenant
reuse. Named invocation with typed inputs and outputs remains part of core replay.

## Invoke existing capabilities

```bash
# Success with declared balance outputs
bun run replay member.account-balance --memberId 12345
bun run replay member.account-balance --memberId 12345 --accountType Checking
bun run replay member.account-balance --memberId 22222

# Known business outcomes, exit 0
bun run replay member.account-balance --memberId 99999
bun run replay member.account-balance --memberId 88888

# Ambiguous match, exit 1
bun run replay member.account-balance --memberId 33333

# Transient condition, recovered automatically
bun run replay member.account-balance --memberId 55555

# Mid-flow expiry with synthetic credentials for recovery
bun run replay member.account-balance --memberId 12345 \
  --operatorPassword HERITAGE --expireSessionAfter 2

# Recovery cannot complete without those credentials
bun run replay member.account-balance --memberId 12345 --expireSessionAfter 2

# A learned state that requires a person
bun run replay member.account-balance --memberId 77777

# A confirmed override for another institution
bun run replay member.account-balance --memberId 12345 --tenant community-cu

# The same model-discovered capability, after recorded outcome learning
bun run replay member.account-balance.discovered --version 1.8.0 --memberId 12345
bun run replay member.account-balance.discovered --version 1.8.0 --memberId 99999
bun run replay member.account-balance.discovered --version 1.8.0 --memberId BAD-INPUT
```

Useful switches are `--json`, `--headed`, `--version <version>`,
`--policy <name-or-path>` and `--baseUrl <url>`. The shipped `read-only` policy
refuses the first fill because it permits only navigation and extraction.

Policies govern action types and origins. Production construction passes the
compiled policy's origin predicate into the browser adapter. The adapter also
checks actual frame origins and network destinations, including redirect hops,
before transmitting requests. A denied origin stops the surface. Standalone
adapter construction without a predicate permits only its `startUrl` origin;
without either option, it denies network access. Cross-origin frames and assets
must therefore be explicitly allowed.

## Transfer control to a person

[Watch the 40-second handoff recording](https://github.com/user-attachments/assets/bd44bf29-4424-434d-be28-df105e95caa3).
It shows the application and operator interface side by side: Replay pauses,
the Operator takes the same Session, releases the supervisor hold and returns
control, then Replay verifies the screen and returns both balances.

[![Watch the handoff video: the original account session and completed ownership history](evidence/verification/2026-09-08-handoff-video/preview.png)](https://github.com/user-attachments/assets/bd44bf29-4424-434d-be28-df105e95caa3)

The recording uses real Chromium and the real operator form with scripted
Operator actions. Only synthetic fixture values appear. The
[recording receipt and event logs](evidence/verification/2026-09-08-handoff-video/README.md)
identify the source revision, verify ownership exclusion and link the uploaded
video. The video is attached to [PR #2](https://github.com/mcalhoun/interface-interview/pull/2)
using GitHub CLI's `--attach` feature.

For the repeatable manual demo, run `bun run demo:handoff`. Follow the [human handoff walkthrough](docs/human-handoff.md) for the exact controls and synthetic supervisor values. `bun run verify:handoff` checks the same-session transfer, ownership exclusion, recorded actions, verified completion and blocked return in real Chromium. Its Operator is scripted.

```bash
bun run replay member.account-balance --memberId 77777 \
  --version 1.1.0 --headed --handoff --noAmend
```

Discovery can use the same ownership mechanism:

```bash
bun run discover "Look up the savings account balance of member 12345" \
  --model gpt-4.1 --headed --handoff
```

Discovery allows one intervention per run and keeps its original step and time
budgets. Native browser actions time out before yielding control; an expired
budget ends the automated portion after the operator returns.

The run pauses and prints a token-bearing operator URL. Open that complete URL,
give your name and take control. Work in the existing **Google Chrome for
Testing** window, where automation stopped. Release the synthetic supervisor
hold, record what you did and return control. The engine checks the resulting
screen before continuing. Returning a success answer alone cannot satisfy the
checkpoint.

If you cannot resolve the state, return a blocked answer. That ends the episode
without learning an unattended rule. The operator interface rejects requests
without the run's token, including access to its bare local origin.

`--noAmend` exercises the handoff without writing another artifact. Removing it
allows an eligible, verified intervention to propose a new version. Existing
versions cannot be overwritten. The checking-only example uses member `88888`
and version `1.0.0`; it illustrates a business answer that may require observation
without a manual application change. Promotion depends on recorded evidence,
not on an empty notes field or an unverified claim that the screen was unchanged.

Discovery handoff uses the same live-session ownership mechanism. A stopped
unattended run returns a structured result; it does not leave a hidden browser
waiting for an operator who has no interface.

## Inspect the application and adapter

```bash
bun run app
bun run app --tenant community-cu
bun run surface observe /
bun run surface resolve / --role textbox --name "Member Num"
```

The standalone application uses port 4173. Surface commands start their own
fixture. The last command demonstrates an ambiguous control and reports the
candidates instead of choosing one.

## Source and checks

```text
apps/cli/            executable composition for discovery, compilation and replay
apps/legacy-core/    Heritage Core and the tenant variant
apps/operator/       the local interface for taking and returning control
packages/surface/   accessibility observation, targeting and browser origin boundary
packages/artifact/  capability schema, store and amendments
packages/replay/    deterministic engine, recovery and result contract
packages/agent/     discovery, compiler, provider and assisted classification
packages/policy/    origins, action risk, sensitivity and repeatability
packages/session/   control ownership, interventions and learning
packages/evidence/  structured events and text redaction
artifacts/          one immutable YAML file per capability version
overrides/          confirmed tenant deltas
policies/           default and read-only deployment policies
apps/demo/           demo support and evidence drivers
test/               automated checks
docs/adr/           architecture decision records
```

```bash
bun run typecheck
bun run test
```

The test command reports the current counts. Browser integration tests launch
real Chromium against the fixture. Scripted model layers provide deterministic
proposals for tests; they do not replace the required live-model demonstration.

## Evidence and its limits

The [latest verification report](evidence/verification/2026-09-08-architecture/README.md)
records 547 passing tests across 55 files, a passing typecheck, the eight-act
demo without a model key and the completed and blocked handoff proofs. Its
source manifest identifies the tested implementation.

The [earlier September 8 verification report](evidence/verification/2026-09-08-final/README.md)
records the preceding 509-test suite, a clean installation and model-free replay
checks. It remains evidence for that earlier source state.

The [fresh discovery bundle](evidence/discovery/live-2026-09-08T14-45-52-190Z-132a40d2/manifest.json)
links a genuine `gpt-4.1` run to its exact compiled `1.5.0` artifact and replay.
Recorded operator interventions produce versions `1.6.0` through `1.8.0`.
Final `1.8.0` replays return success, `NO_MATCHING_ITEM`, `MEMBER_NOT_FOUND`
and `INPUT_VALIDATION_ERROR`. Operator judgment is scripted; the browser,
application and ownership transfer are real. Artifact summaries retain the
original discovery account; subsequent outcome declarations contain the added
evidence and confirmation.

Additional historical evidence sets are:

| Directory | What it demonstrates |
| --- | --- |
| `evidence/discovery/gpt-4.1-drove-this/` | Historical live discovery and its compiled artifact; read `README.txt` for provenance |
| `evidence/learning/` | Business-outcome and requires-human amendments |
| `evidence/tenant/community-cu/` | A tenant difference and confirmed override |
| `evidence/assist/` | Accepted and declined assisted-classification paths |

The assistance and tenant proposals in those historical demonstrations use
scripted models. Some operator arcs are scripted too. Their individual READMEs
identify what was substituted. Generated evidence is normally gitignored;
submission evidence must be deliberately included.

To generate a new live discovery and replay bundle:

```bash
bun run apps/demo/src/support/drive-the-discovery-run.ts
```

The driver refuses version or evidence collisions before contacting the model.
If a later verification stage fails, `--resume <bundle-directory>` checks the
saved artifact against its compilation receipt and SHA before appending a new
completion attempt. It never silently falls back to another artifact or deletes
a previous run. The fresh run records both provider and model in `run.start`. Earlier bundles
retain their original metadata and are historical evidence.

Binary evidence is disabled by default. The built-in synthetic fixture commands
and demo explicitly opt into unredacted screenshots. External `--baseUrl` runs
retain scrubbed accessibility evidence and do not persist screenshot bytes.
Enabled fixture screenshots can contain synthetic identifiers and balances;
text scans do not cover their pixels. See
[ADR-0010](docs/adr/0010-evidence-screenshots-are-not-redacted.md).
Screenshot masking remains unimplemented. Known-value text scrubbing also does
not identify every possible secret on an arbitrary screen.

Desktop execution, remote co-browsing, production storage, artifact approval and
broad multi-tenant rollout remain outside the implementation. REPORT.md explains
the relevant seams and the next work.
