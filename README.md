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

[REPORT.md](REPORT.md) explains the design and cuts under the assignment's seven
headings. [CONTEXT.md](CONTEXT.md) defines the vocabulary. [SPEC.md](SPEC.md) is the
original plan; [docs/adr/](docs/adr/) records the architecture decisions.

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
The exported artifact is separate from the scrubbed diagnostic trajectory.
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

The [September 8 verification report](evidence/verification/2026-09-08-final/README.md)
records 509 passing tests, a clean installation and model-free replay checks.

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
