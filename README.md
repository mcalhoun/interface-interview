# Computer-use automation for back-office banking

Back-office banking applications have no API. The only way in is to drive the UI
the way an operator does. This system does that twice over, in two sharply
separated modes.

**Discovery** gives a model a natural-language goal and lets it drive a real
application until the goal is met, then compiles that successful run into a
typed, versioned Capability Artifact.

**Replay** executes that artifact deterministically, with no model in the
decision loop at all, and returns a structured result a caller can branch on.

Around those sit an error taxonomy that tells the application saying no apart
from the automation breaking, a policy engine every action passes through, a
sensitive-value discipline that keeps runtime data out of artifacts and logs by
construction, and a handoff that gives a person the live browser session and
takes it back.

`REPORT.md` argues every decision. `SPEC.md` is what was planned. `CONTEXT.md`
is the vocabulary. `docs/adr/` holds ten decision records.

---

## Read this before anything else

**The `OPENAI_API_KEY` available in the environment this was built in is
revoked.** It is well formed and dead: `api.openai.com/v1/models` returns HTTP
401 for it, and so does the Responses API.

The consequence is worth stating plainly, because the brief says a real
model-driven discovery run is the one thing that cannot be stubbed:

- **There is no genuine model-driven discovery run in this repository.** What is
  committed at `evidence/discovery/scripted-model-no-llm-drove-this/` is the real
  discovery loop driving a real Chromium against the real fixture under the real
  shipped policy, with a hand-written stand-in where the model's judgement goes.
  The directory carries a file called `NO-MODEL-DROVE-THIS.txt` so it cannot be
  mistaken for a model run. The compiled artifact at
  `artifacts/member.account-balance.discovered/1.0.0.yaml` was compiled from that
  trajectory, and its own `summary` says so.
- The assisted-recovery consultations in `evidence/assist/` and
  `evidence/tenant/community-cu/` are scripted the same way, and labelled the
  same way.
- **`--assist` does reach OpenAI for real.** `bun run replay
  member.account-balance --memberId 88888 --version 1.0.0 --assist` makes a
  genuine HTTP call, gets `InvalidKey` back, records `assist.declined` naming it,
  and degrades to exactly the failure the run would have had without the rung.
  Act 7 of `bun run demo` shows that log line. The wiring is proven. The
  judgement is not.
- Two of the arcs are driven by a scripted **operator** rather than a scripted
  model, because there is nobody at the keyboard in an unattended environment.
  The operator posts to the real operator interface over HTTP and acts in the
  automation's own browser window, which is what a handoff is. The equivalent
  human command is printed beside each one.

**With a working key, closing the discovery gap is one command and no code
change:**

```
bun run discover "Look up the savings account balance of member 12345"
```

The provider is a `Layer` swap behind `effect/unstable/ai`, and `--assist`
already builds the real provider through the same call site a test's scripted
model goes through.

---

## Setup

You need [Bun](https://bun.sh) 1.4 or later. Nothing else: no database, no
container, no service to stand up, and no API key for anything below except the
two commands that consult a model.

```bash
bun install --frozen-lockfile
bunx playwright install chromium      # downloads a browser, once
```

Then:

```bash
bun run demo
```

That is the whole setup. Verified from a fresh clone.

### Running without live services

There are none to run against. Every command below starts the mock legacy
application (`apps/legacy-core`, a Bun HTTP server) in-process on a free port and
drives it in a real headless Chromium. `--baseUrl` points a run at something else
if you have one.

The mock is deliberately hostile: server-rendered nested layout tables, no test
IDs, no `<label>` elements, accessible names that come only from `title`
attributes, full page loads, and Account Detail inside an unnamed iframe. That is
the fixture the whole design is measured against.

### Keys

`OPENAI_API_KEY` is read only by `packages/agent/src/provider.ts`, the one file
in the workspace that names a vendor. Exactly two things use it:

| Command | Without a key |
| --- | --- |
| `bun run discover "<goal>"` | fails on turn one with a structured `AuthenticationError`, before a browser opens |
| `bun run replay ... --assist` | the consultation reports `AssistUnavailable`, the run records `assist.declined`, and falls through to the person it was already going to reach |

Nothing else in the system can reach a model. `bun run demo`, the full test
suite, and every replay command below run with no key set.

---

## The one command

```bash
bun run demo
```

Nine acts, unattended, under half a minute, printing the command a person would
run and where the evidence landed for each:

1. **The catalog** an agent reads before calling anything.
2. **Discovery**: a sentence becomes a capability, and the compiled document is
   replayed unedited.
3. **Replay**: the same call twice, compared field by field.
4. **The taxonomy**: a business outcome, a transient condition, a mid-flow
   session expiry. Two of the three exit 0.
5. **Escalation**: a person takes the live session, acts, hands it back, and the
   run finishes.
6. **Learning**: the two amendments side by side, then the before and after of
   each, driven live.
7. **The assisted rung**, with the revoked key and then with a scripted one.
8. **A second institution** running the same vendor product.
9. **Safety**: a scan over everything the demo just wrote.

Everything it writes goes under `evidence/demo/`, which it clears first. It never
writes to `artifacts/`, `overrides/`, or the committed evidence directories.

---

## The exact commands

Nothing below needs anything running first.

### Capabilities

```bash
bun run catalog                        # every stored capability as a callable signature
bun run catalog member.account-balance # one of them, with its full prose
bun run catalog --json                 # the same signatures, for a calling agent
```

### Replay

```bash
# the happy path
bun run replay member.account-balance --memberId 12345
#   -> availableBalance: 4182.55 USD, currentBalance: 4382.55 USD

# a different account, same document, no configuration
bun run replay member.account-balance --memberId 12345 --accountType Checking
#   -> 1204.18 USD

# a member whose institution labels the account differently, same document again
bun run replay member.account-balance --memberId 22222
#   -> 812.40 USD

# the application answering, not the automation breaking. exit 0
bun run replay member.account-balance --memberId 99999
#   -> MEMBER_NOT_FOUND

# a state learned from an intervention. exit 0, nobody involved
bun run replay member.account-balance --memberId 88888
#   -> NO_MATCHING_ITEM

# ... and the version before anybody had met it. exit 1
bun run replay member.account-balance --memberId 88888 --version 1.0.0
#   -> FAILURE no_matching_item, listing everything that was on offer

# a state learned to permanently need a person. exit 1, routed rather than reported
bun run replay member.account-balance --memberId 77777
#   -> INTERVENTION REQUIRED, escalate: OPEN_ACCOUNT_REQUIRES_HUMAN

# a slow load and a transient overlay, recovered from
bun run replay member.account-balance --memberId 55555
#   -> SUCCESS, "(recovered from TRANSIENT_OVERLAY)"

# a session that expires mid-flow, re-authenticated, resumed at the same step
bun run replay member.account-balance --memberId 12345 \
  --operatorPassword HERITAGE --expireSessionAfter 2
#   -> SUCCESS, "(recovered from SESSION_EXPIRED)"

# ... with no credentials to recover with. exit 1
bun run replay member.account-balance --memberId 12345 --expireSessionAfter 2
#   -> FAILURE recovery_exhausted

# two accounts match. never a coin flip. exit 1
bun run replay member.account-balance --memberId 33333
#   -> FAILURE ambiguous_match, listing both candidates

# the second institution, with its one confirmed delta
bun run replay member.account-balance --memberId 12345 --tenant community-cu
#   -> SUCCESS 4182.55 USD, applying overrides/community-cu/member.account-balance.yaml

# the document a model wrote, callable by name like any other
bun run replay member.account-balance.discovered --memberId 12345
#   -> 4182.55 USD
```

Useful switches: `--json` prints the whole `ReplayResult`; `--headed` shows the
browser; `--version <ver>` pins a version; `--policy read-only` runs under the
other shipped policy and refuses at the first `fill`; `--baseUrl <url>` points at
a real installation.

### A person in the loop

Two windows. In the first:

```bash
bun run replay member.account-balance --memberId 77777 --version 1.1.0 --headed --handoff
```

It pauses, prints the operator interface URL, and leaves a visible browser on the
screen it stopped at. Open the URL, take control, release the supervisor hold in
that browser window, note what you did — including the supervisor id and override
code you typed, so this run's evidence redacts them from here on — and hand
control back. The run finishes, cuts `member.account-balance@1.2.0` and prints
the diff.

The printed URL carries a token minted for that run, and every request needs it.
Open the link rather than the bare `http://127.0.0.1:4180`, which answers 401 on
purpose: a cross-origin form POST is not blocked by the same-origin policy, so
without a token any page open in your browser could take a paused session and
hand it back with an answer you did not give — and that answer is what writes a
durable amendment to a capability.

`bun run replay ... --memberId 88888 --version 1.0.0 --headed --handoff` is the
other direction: take control, change nothing, and answer yes. That cuts
`1.1.0`. Both versions are already in the tree, and the store is append-only, so
a second run reports the refusal instead of overwriting. Add `--noAmend` to
demonstrate the handoff without cutting anything.

### Discovery (needs a key)

```bash
bun run discover "Look up the savings account balance of member 12345"
bun run discover "..." --headed --emit member.account-balance.discovered --artifactVersion 1.1.0
bun run compile <trajectory.json> --capability <name>
```

### The mock application and the surface

```bash
bun run app                                 # http://127.0.0.1:4173
bun run app --tenant community-cu           # the second institution
bun run surface observe /                   # what the system perceives, as YAML
bun run surface resolve / --role textbox --name "Member Num"
#   -> ambiguous, with the two candidates and the two ways to disambiguate
```

### Checks

```bash
bun run typecheck    # clean
bun run test         # 352 tests across 27 files, ~18s, real browsers throughout
```

The suite drives a real Chromium against the real mock application. No browser is
stubbed anywhere. The only substitution in the whole suite is the model, at
`LanguageModel.make`, which is the same provider hook `@effect/ai-openai` fills.

---

## What is on disk

```
apps/legacy-core/     the mock: Heritage Core Member Services, and a second tenant
apps/operator/        the operator interface a paused run points a person at
packages/surface/     the Surface Adapter. Accessibility tree only, no DOM, no selectors
packages/artifact/    the Capability Artifact schema, store, catalog and amendments
packages/replay/      the deterministic engine, the recovery ladder, the result contract
packages/agent/       discovery, the compiler, the provider, the assist toolkit
packages/policy/      origins, action risk, sensitivity, recovery repeatability
packages/session/     control ownership, handoff, what an intervention taught
packages/evidence/    the event log, the schema it validates against, the scrubber
artifacts/            stored capabilities, one immutable file per version
overrides/            tenant deltas, discovered and confirmed, never hand-written
policies/             what the system may do. Two: default, and read-only
evidence/             committed runs (see below), plus whatever you run yourself
docs/adr/             ten decision records
demo.ts               `bun run demo`
```

`evidence/` is gitignored, because every run makes another directory. Four sets
are committed as deliverables with `git add -f`:

| Directory | What is in it |
| --- | --- |
| `evidence/discovery/scripted-model-no-llm-drove-this/` | a discovery run: the loop, a real browser, a scripted model. Read `NO-MODEL-DROVE-THIS.txt` first |
| `evidence/learning/` | the two amendments, and a README framing them against each other. **This is the centrepiece** |
| `evidence/tenant/community-cu/` | onboarding a second institution, four runs, one confirmed delta |
| `evidence/assist/` | the assisted rung, with and without |

If you read one thing in `evidence/`, read `evidence/learning/README.txt` and
then the two diffs beside it. One operator met a state and changed nothing, so
the capability learned to answer it unattended. Another met a state and resolved
it by exercising authority, so the capability learned to always stop there. Same
mechanism, same question, opposite conclusions, and what separates them is not
the answer.

---

## Known gaps

Stated here as well as in `REPORT.md`, because a gap only found in a report is a
gap somebody meant to hide.

- **No genuine model-driven discovery run.** See the top of this file.
- **Screenshots are not redacted.** They render member numbers and balances as
  captured. Text evidence is scrubbed; pixels are not. `evidence/*/README.txt`
  says so in every directory, and the exclusion is one line in
  `test/support/secret-scan.ts` so it is findable rather than silent.
- **The assisted confidence floor is a constant** (0.75), not a policy field.
- **`awaitingReview` in the catalog over-flags.** It is derived from `authored ==
  discovered`, so a compiled capability a person has since read still shows the
  flag. There is nowhere in the schema to record a review.
- **`unsafeRepeats` is coarse.** It treats every step in an artifact as one an
  `at-step` recovery rule might fire at, because nothing says which steps a
  `detect` matches, and it treats every remedy action of a rule with `attempts`
  above one as repeated, because nothing says which attempt clears it.
- **`1.2.0` and the tenant override were produced by scripted operators**, not by
  a person at a keyboard. Everything else about those runs is real.
