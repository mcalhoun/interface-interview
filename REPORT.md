# Report

A model drives a real legacy banking UI once, and the successful run becomes a
typed, versioned Capability Artifact. From then on the capability is replayed
with no model in the decision loop at all. `bun run demo` is the whole arc in one
command; `README.md` runs any part of it on its own.

**One thing first, because it changes how the rest should be read.** The
`OPENAI_API_KEY` in the environment this was built in is revoked, verified as an
HTTP 401 from `api.openai.com`. So **there is no genuine model-driven discovery
run in this repository**, and the brief says that is the one thing that cannot be
stubbed. `evidence/discovery/scripted-model-no-llm-drove-this/` is the real
discovery loop driving a real Chromium against the real fixture under the real
shipped policy, with a hand-written stand-in where the model's judgement goes, in
a directory carrying a file named `NO-MODEL-DROVE-THIS.txt`. The compiled
artifact derives from that run. The consultations in `evidence/assist/` and
`evidence/tenant/community-cu/` are scripted the same way, and
`member.account-balance@1.2.0` and the tenant override were driven by scripted
*operators* rather than by a person at a keyboard, because there is nobody at
this one.

`--assist` does reach OpenAI for real: a genuine round trip, `InvalidKey` back,
an `assist.declined` event naming it, and degradation to exactly the failure the
run would have had without the rung. Act 7 of the demo prints that log line. The
wiring is proven; the judgement is not. With a working key the gap closes in one
command and no code change:
`bun run discover "Look up the savings account balance of member 12345"`.

## Architecture

Two modes over one surface. Discovery has a model in the loop; replay does not,
and the type system enforces it. The replay engine's effect requires
`SurfaceAdapter | Policy | Evidence | Session` and nothing else, so a code path
reaching for a language model does not compile (ADR-0003). That was checked
negatively: adding `LanguageModel` to the engine broke two assertions in
`test/replay-has-no-model.test.ts`, then it was reverted. A README sentence, a
runtime flag or an unset environment variable all survive somebody adding a model
call in six months. A type error does not. That property is why Effect 4 was
worth its cost, and the cost was real: thin docs and unreliable recall of a
release-candidate API.

The Surface Adapter has eight methods and none returns markup or accepts a
selector (ADR-0001). Observation is Playwright's accessibility snapshot plus the
URL and frame list. Playwright's own role and label locators would have worked
and were rejected anyway, because leaving markup reachable makes "this survives a
surface with no clean DOM" an assertion nobody can check. The cost is stated, not
hedged: a control the accessibility tree cannot express is genuinely unreachable,
and the answer to that is a finding written up, not selectors put back quietly.

Discovery adds `LanguageModel` openly, and the toolkit it hands the model is a
vocabulary rather than an executor: `disableToolCallResolution: true`, every
handler `Effect.die`. There is no code path from a tool call to a browser.

Every action in both modes passes one chokepoint, `authorised` in `engine.ts`,
and a test counts the adapter call sites in the replay package so a sixth fails
the suite. That test caught a real bypass: a checkpoint's `targetReads` assertion
reached the adapter directly, so under a policy denying `extract` a checkpoint
could still read. It is closed structurally, by giving checkpoint evaluation a
`Perception` type with no acting method on it and a reader the engine hands over
only after authorising that read.

## Artifact schema

YAML, one immutable file per version, at `artifacts/<capability>/<version>.yaml`.
`Bun.YAML` ships with the runtime so it costs no dependency, and the deciding
factor was that an artifact is a review document: every target carries a
paragraph of `robustness` prose, and a diff between two versions has to be
readable by whoever approves it. JSON turns both into escaped one-liners. That
argument also forced a small block-style emitter, since `Bun.YAML.stringify`
would put a whole capability on one line. `latest` resolves by sorting the
directory; there is deliberately no index file, because that is a second source
of truth for a question the listing already answers.

**No origin appears anywhere**, and a test greps every stored file for
`https?://`. `entry` is a path and the base URL is a replay parameter, which is
what lets one vendor-level capability serve every institution.

A `Step` is `{ id, intent, action, checkpoint }`, both `intent` and `checkpoint`
required. An optional checkpoint is exactly how "the action did not throw"
becomes the success criterion, which is how automation ends up confidently on the
wrong screen. Actions are five verbs, and every value carries provenance
(`{from: parameter}`, `{from: constant}`, `{from: step}`) spelled with a plain
`from:` discriminator, because a person reads this. A `Target` is the adapter's
fields plus `strategy` and `robustness`, and a test enforces that the robustness
argument runs past eighty characters.

Referential integrity is checked at parse time, in both directions: a value
naming an undeclared input is rejected, and so is a declared outcome no branch
can reach. The second matters more than it looks. A documented outcome nothing
produces is a claim a reviewer approves and a caller writes dead code against.

The compiler emits documents that must pass that same parser, so an invalid
artifact is a compiler bug rather than a stored file. Three further gates run
first: no fixed literal may echo a goal term, none may contain a value the run
typed, and the finished YAML, prose included, is scanned for both. No refusal
quotes the value it found, because a leak report that repeats the leak lands in a
terminal, a CI log and a ticket.

What the compiler will not invent matters as much. No `pattern` on a string
input, because one run saw one value and `^[0-9]{5}$` inferred from `12345`
rejects the first six-digit member. No outcomes and no recovery rules, because
both are learned from what a person had to do. And no capability name, because a
name generated from the goal puts the goal's words, values included, into the
catalog.

## Determinism & error handling

Determinism means no model in the loop, not no logic. Replay still reads the live
account list and matches a parameter against the labels: same list, same
parameter, same choice, every time. Two `--json` runs of the same call are
byte-identical once `runId`, `sessionId` and `evidenceDirectory` are removed, and
act 3 of the demo does that comparison in front of you.

`replayCapability` returns `Effect<ReplayResult, never, ...>`. The `never` is the
point: every outcome is a value to branch on. Four classes, and the taxonomy's
whole job is telling the application saying no apart from the automation
breaking. A business outcome exits zero and reports no failure anywhere, and that
is structural: the step runner returns a reached outcome on the *success*
channel. Routing it through `Effect.fail` would have been two lines shorter and
would have made every mechanism that handles errors also handle domain answers by
accident.

Every failure member carries `stepId`, `stepIntent`, `expected` and `observed`,
enforced by the constructor rather than by convention, so a failure is
diagnosable without re-running. A target matching two or more controls is a hard
failure, never a coin flip, and the report names every candidate with its ordinal
and enclosing region, the two things that always differ and both of which paste
straight back into the target. Zero matches is a different fact and enters the
ladder, because a missing control is as likely to be domain truth as breakage.

```
expect -> declared Business Outcomes -> declared Recoverable Conditions -> one bounded assisted consultation -> a person
```

Three of those four arrows are compile-time facts rather than statement order.
Only a failed-checkpoint verdict leaves checkpoint evaluation, so nothing
downstream can mistake a domain answer for a fault; `attemptRecovery` is the only
expression producing the value `attemptAssist` takes, and `attemptAssist` the
only one producing the value the handoff takes. Escalating before every rung has
had its turn does not type-check.

The ordering is argued too. Business outcomes sit above recovery because a
declared outcome is the application answering, and a recovery rule whose `detect`
also matched the member-not-found screen would spend the run's budget retrying a
question already answered and then report a hard failure for a run that
succeeded. Recovery sits above the person because waking somebody for something
the system can get past is what the ladder exists to avoid. Every recovery ends
by re-evaluating the checkpoint rather than assuming the remedy worked, and the
interstitial case proves that matters: the first Continue click succeeds, and the
screen that comes back is another interstitial.

Inputs are validated by a pure `Result` before any service is provided, so a bad
call cannot have opened a browser: five browser processes before a rejected call,
five after.

## Heterogeneity & multi-tenant

The claim is that reuse falls out of the matching rule rather than arriving as
configuration, and the fixture is built to make that falsifiable.

Selection matches by token subset in one direction: every token of the wanted
value must appear in the label. `savings` is inside both `Primary Savings` and
`Regular Savings`, so a short goal term travels between institutions;
`Primary Savings` is not inside `Regular Savings`, so one institution's long
label never silently becomes another's. Target resolution has the mirror rung for
captions, because a tenant's caption for a *field* tends to be shorter than the
vendor's (`Member #` for `Member Number`) while its label for a *product* tends
to be longer. That rung runs only when the candidate set is already empty, so
nothing that resolved before resolves differently now, which is what makes adding
it to a system whose whole claim is determinism safe.

The most load-bearing consequence is what gets recorded as a selection's default.
The spec's own sketch writes `default: "Primary Savings"`, and taken literally
that cannot work at an institution labelling the account `Regular Savings`. So
the default records **the goal's own word**, `savings`, and `discoveredFrom`
records the inference the model made once. The provenance check guarantees it:
the goal says "savings" and never "primary", so `Primary Savings` fails the
goal-token test and cannot be recorded. That one rule is why the second
institution needed no artifact change.

Of the four ways `community-cu` differs, three cost nothing. The shortened
caption is absorbed by the name-token rung; `Regular Savings` and `Share Draft`
by token subset, with zero code; account detail not being in an iframe because a
target has nowhere to name a frame, so the same target reads the same figure off
a framed panel and an inline one. The fourth, a submit button reading `Find`
rather than `Search`, shares no token in either direction and is genuinely
unresolvable. It surfaces as an ordinary `target_missing` replay failure,
detected by the same mechanism as everything else (ADR-0006).

The override is then produced by the ladder doing its ordinary job. Assisted
recovery names `Find` from a closed enumeration of the controls actually on the
screen, nothing presses it, the run pauses anyway, and a person confirms it once.
`proposeOverride` requires both halves: without the proposal a person typing a
control name would be hand-writing an override, and without the confirmation a
model's guess about a banking screen would outlive the run. The delta expresses
one shape of change, a control's name on a step that already names one. It
records `was` as well as the new name, so applying it to a later base version
whose target moved is refused rather than silently pointing somewhere else. It is
append-only per step, and it lives under `overrides/`, so a reviewer can see that
onboarding an institution moved no file the vendor capability is made of.

One real bug came out of the second institution, and it is the kind this design
should expect. Playwright single-quotes an accessibility node whose head contains
`#`, because `#` opens a YAML comment, and the snapshot parser read only
double-quoted scalars. One punctuation mark in one tenant's label table looked
like a whole institution's worth of unresolvable controls.

## Escalation & handoff

One process, one headed browser (ADR-0009). A session is a live browser handle,
so splitting processes means shipping the handle around or building a broker, and
neither demonstrates anything the direct approach does not.

Ownership is an explicit state machine over one `Ref`, exposed as two interfaces.
`Session` is what the engine requires; `SessionControl` is the person's half, and
the engine cannot reach it, so **there is no expression in the executor that
hands control back to itself**. The transition history is a list rather than a
sampled value, because `RESUME_REQUESTED` is real but brief: completing the
deferred resumes the parked fiber immediately, so polling `owner` can never
observe it.

Resume semantics differ by why the run stopped, and the difference is not
cosmetic. A failed checkpoint re-asks the checkpoint, because the action already
landed and what changed is the state, by hand. A blocked action re-attempts the
whole step, because the action never ran and re-asking the checkpoint would fail
for the reason it was always going to fail. An unattended run escalates to
nobody: it reports the hard failure it always did, because escalating into an
empty room names a person as responsible for a run nobody can see.

What an intervention teaches comes from **what the operator did**, not from a
config file naming known states (ADR-0004). One question is asked once, at return
of control: should automation handle this itself next time? That question alone
cannot separate a recoverable state from an authority one, because both operators
answer it the same way. What separates them is a fact the system recorded without
asking anybody, namely whether the intervention's action list is empty. An
operator who had to act cannot produce a business outcome from any answer at all.
So the direction that costs a person forever is reachable by a radio button, and
the direction that makes a run unattended is not.

The two diffs in `evidence/learning/` are the centrepiece and should be read side
by side. Member 88888 holds a checking account and no savings account; an
operator looked and changed nothing, so `1.1.0` reclassifies the state as a
business outcome, and the removed lines in the entire diff are exactly
`-escalate: NO_MATCHING_ITEM` and `-version: 1.0.0`. Member 77777's account is
under a supervisor hold; an operator resolved it by exercising authority, so
`1.2.0` adds a `requiresHuman:` entry and the only removed line in the whole diff
is `-version: 1.1.0`. Tests assert those exact removed sets, so an amendment that
quietly retuned a bound or rewrote a target would fail them.

Two narrownesses hold that up. The amendment mechanism can write two shapes of
change and cannot add a step, move a target or retune a bound. And a code is
never renamed across a promotion, because letting whoever is on shift name a
capability's vocabulary is the answer smuggled in by another route. A
requires-human code is derived from the step id for the same reason, which is why
it reads `OPEN_ACCOUNT_REQUIRES_HUMAN` and not something prettier.

A `requiresHuman:` entry carries no `detect:` assertions, and must not. A person
resolves a state by clicking in Chromium and nothing records that structurally,
so deriving a detection rule from whatever tree the run happened to capture would
be the automation deciding what a screen means. The recognition rule is the one
thing the document already knows: which step's checkpoint reached it. The stated
cost is that a *different* unrecognised state at that step reports the same code,
which is correct anyway, since both need a person.

The ratchet only tightens, enforced in three independent places, and one test
attempts the downgrade a hundred times and gets a hundred refusals: frequency is
not evidence of safety. Assisted recovery never proposes an authority-class
state, and when a step is already in `requiresHuman:` the model is not consulted
at all, which is stronger than filtering its candidate list.

## Safety

**Policy.** Nothing is permitted that is not written down. There is no allow-all
layer in the codebase to fall back to, and a missing or malformed policy file
stops the run rather than degrading to a default. A risky action cannot be
permitted silently: `click` and `fill` need a written justification of at least
sixty characters or the file does not load, and that justification is carried
into every verdict allowing one, so the reviewer's argument sits next to the
record of the action happening. Risk classification lives in code, not in the
file, because a policy that could reclassify `click` as safe would make the split
worthless. Origins are matched on parsed scheme, host and port, never on URL
text, and both ends are checked: every action against the page it happens on, and
a navigation additionally against where it goes. The chokepoint is demonstrated
behaviourally: a real run under `actions: []`, with a counting wrapper around the
real adapter, asks for six steps and touches the browser zero times.

**The assisted rung.** "Cannot act" is three independent structures, not a flag.
The toolkit has no acting verb, and a test renders every tool's JSON Schema and
asserts no property is named target, selector, css, xpath, path, url, value,
role, label, click, action or coordinates. The proposable answers are a
`Schema.Literals` enumeration built per consultation from the artifact's own
codes, or from controls read off the live screen, so an invented answer fails
validation before the loop sees it. And the reply type cannot describe an action:
widening it is the only way to break ADR-0005, and it has to be done in that one
file. The rung is bounded to one step, one attempt and one answer, with the
budget spent *before* the advisor is called, so a consultation that dies has
still used it. A confident classification returns an outcome marked `assisted`
with its confidence and a pointer to the proposal in evidence, and never counts
as deterministic. Nothing it returns is written to `artifacts/`: promotion takes
an intervention record, and only a human handoff produces one.

**Sensitive data.** Every parameter is sensitive unless the artifact says
otherwise in writing *and* policy allowlists it, and the shipped allowlist is
empty (ADR-0008). We do not ask a model to judge what counts as PII in regulated
financial data. A resolved input is `Redacted<string>` always, not conditionally
on a boolean somebody wrote in a YAML file, and exactly two places unwrap one:
the scrubber, which must know the characters to find them, and a `fill`, which
must know them to type them. A test walks every source file and asserts that list
exactly. The evidence writer's scrubber is a **required** constructor argument
rather than a defaulted one, because a default is a decision made silently by
every call site that forgets.

The claim is falsifiable rather than asserted: the redaction test walks every file
a run produced plus every stored artifact and override, and fails if a member
number appears. It was verified in both directions. Neutering the scrubber
produces five leaking lines reported by file and line, and a member number
planted in three places in a copy of a real evidence directory is found in all
three.

The costs are stated rather than hidden. The scrub is field-blind and by literal
occurrence, so an account number embedding the member number reads
`00000[redacted:memberId]-S01`, and a run supplying the operator password
`HERITAGE` renders the application's own banner as `[redacted:operatorPassword]
CORE`. Illegible evidence is recoverable; a leaked identifier is not.

**Screenshots are not redacted** (ADR-0010). They render member numbers and
balances exactly as captured. Every evidence directory's `README.txt` says so,
and the exclusion is by file extension in one named constant, so the exception is
a line of code a reviewer can find rather than a silent absence. Pixel masking
under optical recognition is more than this job needs, and implying that pixels
are protected would be worse than the honest gap.

## Cuts

Everything here was a decision rather than an oversight.

| Not built | Seam left behind | What comes next |
| --- | --- | --- |
| **A genuine model-driven discovery run** | the provider is a `Layer` swap, and `--assist` proves the round trip | one command with a working key, then delete the scripted evidence directory |
| **Screenshot redaction** | text evidence is scrubbed at one point; pixels are excluded by extension in one place | mask known parameter values under optical recognition |
| **A person at the keyboard for two arcs** | the operator interface is real HTTP and the harness posts to it | run the two `--handoff` commands in the README by hand |
| Desktop or OS-level adapter | `SurfaceAdapter`, with no DOM assumptions to unwind | UIAutomation or AXAPI behind the same eight methods |
| Real-time co-browsing console | the ownership state machine is real; only the transport is local | CDP screencast to an operator canvas with input relay |
| Multi-process session brokering | single process, `Session` behind an interface | a broker: the handle becomes a reference, nothing above the seam changes |
| Persistence beyond files | artifact and evidence writers sit behind interfaces | object store plus index, still immutably versioned |
| Live-model discovery test | the `LanguageModel` layer is already a product seam | recorded-fixture replay of a real transcript |
| Confidence scoring and approval gating | `awaitingReview` is derived from `authored` and **over-flags**: a compiled capability a person has read still shows it | a `reviewedBy`/`approvedAt` pair, gating unattended replay |
| Multi-run stability signal | determinism is asserted over two runs, not scored over many | replay N times, diff outcomes, feed the approval gate |
| A per-deployment assist confidence floor | `AssistOptions.floor` exists and nothing passes it, so the floor is the constant 0.75 | a field in the policy document beside the assist justification |
| Narrowing `unsafeRepeats` | **coarse**: every step counts as one an `at-step` rule might fire at and every remedy action of a rule with `attempts` above one counts as repeated, because nothing says which steps a `detect` matches or which attempt clears it | a schema field scoping a recovery rule to steps |
| Path-level policy rules, rate limits, per-capability scoping | the origin allowlist constrains where the browser may go, not which endpoint inside an origin | fine for mutations behind a `click`, not for a legacy app with mutating GETs |
| Recovery on the action-blocked path | the assisted rung already serves both paths | a rule would have to say which path its `detect` is written for |
| A prettier caller-facing code for a learned state | codes are derived, never supplied | a hand-written version cut by whoever owns the contract |
| Tenants and version diffs in the catalog | the catalog is a view over the directory and holds no state | list tenants with a confirmed delta; render one version against another |
| Concurrency, parallel replay, code generation, framesets | nothing is shared between runs | a session pool; emit a page object from a capability; same targeting for framesets |
| `effect/unstable/cli` | argv parsing is hand-rolled in four small CLIs | add a platform package for `FileSystem`, `Terminal` and `Stdio` |

Also out of scope, named in the spec before anything was written: queues,
clusters, databases and containers. In-memory state and local files are enough,
and infrastructure that demonstrates nothing is worse than none.

Two smaller things are visible in the code and are deliberate.
`SurfaceAdapter.waitFor` is built, tested and unused, because checkpoint
evaluation turned out to already be a bounded poll. And `uiDerived` values are
accepted by the schema and handled by the compiler, but the discovery loop
returns a correction rather than typing an earlier reading, because no capability
here needs one.
