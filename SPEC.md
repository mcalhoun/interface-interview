# Spec: computer-use automation system

Take-home for interface.ai. Ready to implement. Every decision below carries its reasoning, because the brief asks us to defend each one.

---

## Problem statement

Banks and credit unions run back-office applications with no API. The only way in is to drive the UI the way a human operator does. So an AI agent that needs to answer "what is member 12345's savings balance?" has two bad options. It can re-reason about the screens on every call, which is slow, expensive and impossible to reproduce. Or an engineer can hand-write automation for each institution, of which there are hundreds, each running around twenty apps, many of them the same vendor product wearing different configuration.

Neither scales. The first is unreliable and unauditable. The second is unmaintainable.

There is a harder problem underneath. Automation that only works on the happy path is not usable in production. Real runs hit "member not found", permission denials, unexpected confirmation dialogs, session expiry and slow loads. A system that treats all of those as crashes is worse than useless, because it cannot tell the caller the difference between the app saying no and the automation breaking. And when something genuinely cannot be decided safely, a person has to be able to step into the same live session, sort it out, and hand control back.

## Solution

Two sharply separated execution modes.

Discovery uses a model to drive a real application until a natural-language goal is met, then compiles that successful run into a typed, versioned, parameterized capability artifact.

Replay executes that artifact deterministically, with no model in the decision loop, and returns a structured result the caller can branch on.

Around those two modes sit the four things that make this usable in a regulated environment. An error taxonomy that separates business outcomes from recoverable conditions from hard failures. A policy engine every action passes through. Sensitive-value handling that keeps runtime data out of artifacts and logs by construction. And a human handoff that transfers ownership of the live session and takes it back.

The central mechanism is a three-rung recovery ladder. When deterministic replay cannot proceed:

```
deterministic replay
      │ step unresolvable
      ▼
bounded assisted recovery   ── model may CLASSIFY state. May NOT act.
      │ low confidence, or authority-class state
      ▼
human intervention          ── takes the live session, resolves, confirms meaning
      │
      ▼
artifact amendment          ── new immutable version
```

That same ladder handles three problems that look different and are not: learning a new business outcome, learning that a state permanently requires a human, and adapting a capability to a tenant whose UI differs. One mechanism, three demonstrations.

---

## User stories

### Discovery

1. As a capability author, I want to give the system a natural-language goal and a target URL, so that I do not write automation code by hand.
2. As a capability author, I want the agent to drive a real browser and actually complete the goal, so that the artifact is grounded in something that demonstrably worked.
3. As a capability author, I want the agent to choose from a constrained action vocabulary rather than emit arbitrary code, so that every action it takes is reviewable and policy-checkable.
4. As a capability author, I want discovery to work against a legacy UI with table layouts, no test IDs and iframes, so that the system is useful on the applications that actually lack APIs.
5. As a capability author, I want the agent to infer which values in my goal are parameters, so that I do not declare an input schema before the system knows what the screens need.
6. As a capability author, I want the agent to read the application to discover a parameter's legal values, so that the capability's contract reflects the real domain rather than my guesses.
7. As a capability author, I want discovery to stop rather than flail when it gets stuck, so that a failed run costs bounded time and money.
8. As a capability author, I want to know why discovery stopped, so that I can decide whether to retry, change the goal, or step in.
9. As a capability author, I want discovery to record its reasoning next to its actions, so that I can audit how the flow was arrived at.
10. As a capability author, I want a successful run to emit an artifact automatically, so that nothing is transcribed by hand between learning and using.

### The artifact

11. As a reviewer, I want the artifact to be human-readable, so that I can approve a capability before it runs unattended against a production system.
12. As a reviewer, I want the artifact to declare its inputs with types and sensitivity, so that I can see what data flows into it.
13. As a reviewer, I want the artifact to declare its outputs and their shape, so that I know what a caller receives.
14. As a reviewer, I want the artifact to declare the business outcomes it knows about, so that I can see the capability's domain contract and not just its steps.
15. As a reviewer, I want every step to carry an explicit checkpoint, so that I can see the run verifies it reached the state it intended.
16. As a reviewer, I want each target to record how it is identified and why that strategy was chosen, so that I can judge whether it still works next month.
17. As a reviewer, I want artifacts versioned immutably, so that I can diff two versions and see exactly what changed.
18. As a compliance reviewer, I want certainty that no runtime value is embedded in an artifact, so that a stored capability never becomes a data-leak vector.
19. As a caller, I want the artifact independent of the raw model transcript, so that a capability is a contract rather than a recording.

### Deterministic replay

20. As an AI agent, I want to invoke a saved capability by name with typed arguments, so that I get work done without reasoning about a UI.
21. As an AI agent, I want replay to return the same result for the same inputs, so that I can build on it reliably.
22. As a platform engineer, I want it to be provably impossible for replay to call a model, so that the production path's cost and latency are predictable.
23. As an AI agent, I want a structured result that distinguishes success, business outcome, intervention and failure, so that I branch correctly instead of parsing an error string.
24. As an AI agent, I want "no such member" to come back as a business outcome, so that I do not treat a legitimate answer as a crash.
25. As an AI agent, I want typed outputs, a balance as an amount plus currency rather than a scraped string, so that I use the value without re-parsing it.
26. As a platform operator, I want replay to retry transient conditions like slow loads, so that a blip does not become a page.
27. As a platform operator, I want a mid-flow session expiry recovered from and the run resumed, so that long flows are not lost to re-auth.
28. As a platform engineer, I want a target matching two elements to stop the run, so that the system never silently guesses which control to press.
29. As a debugging engineer, I want a failure to tell me the step, what was expected and what was observed, so that I diagnose without re-running.
30. As a caller, I want replay to validate my inputs against the declared schema before touching a browser, so that bad calls fail fast and cheap.

### The recovery ladder

31. As a platform engineer, I want an unresolvable step to attempt bounded assisted recovery before waking a human, so that people are not paged for things the system can work out.
32. As a security reviewer, I want the assisted-recovery model structurally incapable of acting on the page, so that a hallucination cannot cause an unintended action.
33. As a platform engineer, I want assisted recovery limited to a single step and a single attempt, so that it never becomes an open-ended agent loop in production.
34. As an auditor, I want every assisted-recovery proposal recorded as evidence with its confidence and rationale, so that the decision trail is complete.
35. As a reviewer, I want an assisted-recovery proposal to need human confirmation before it changes an artifact, so that a model never silently alters a capability.
36. As a caller, I want a confidently classified state to return an outcome immediately, so that the call completes rather than blocking on a person.
37. As a caller, I want an assisted result plainly marked as assisted, with its confidence and a pointer to the evidence, so that I can tell a deterministic answer from a proposed one.
38. As a platform engineer, I want an assisted result never counted as deterministic, so that reliability scoring is not inflated by model-proposed outcomes.

### Escalation and handoff

39. As an operator, I want to be told when a run needs me, with the capability, the step, the current screen and the reason, so that I have enough context to act.
40. As an operator, I want to take control of the same live browser session the automation was using, so that I continue the work rather than starting over.
41. As an operator, I want the automation unable to act while I hold control, so that we cannot fight over the same session.
42. As an operator, I want to hand control back and have the run continue from where it paused, so that my intervention does not waste the work already done.
43. As an auditor, I want a record of who took control, what they did and when they returned it, so that manual actions on financial systems are attributable.
44. As an operator, I want to be asked once whether automation should handle this state itself next time, so that my judgment is captured rather than lost.
45. As a platform engineer, I want session ownership modelled as an explicit state, so that "who is in control" is always answerable rather than implied.

### Learning

46. As a capability author, I want a state a human resolved without acting to become a declarable business outcome, so that the capability learns its own domain contract.
47. As a security reviewer, I want a state that required authority recorded as permanently needing a human, so that repetition never turns a privileged decision into an automated one.
48. As a security reviewer, I want that classification to move one way only, so that a later run cannot downgrade a human-required state to automatic.
49. As a capability author, I want the reason a state escalates learned too, so that later runs fail fast with a precise reason instead of burning a stuck-detection cycle.
50. As a reviewer, I want each new artifact version linked to the intervention record that justified it, so that every change has provenance.

### Multi-tenant

51. As a platform engineer, I want a capability discovered against one institution to work against another running the same vendor product, so that we do not re-record per tenant.
52. As a platform engineer, I want cosmetic label differences absorbed by the matching strategy rather than configured, so that most tenants need no work at all.
53. As a platform engineer, I want a genuinely incompatible control to surface as an ordinary replay failure, so that tenant drift is detected by the same mechanism as everything else.
54. As a tenant onboarder, I want a new tenant's adaptation produced by the recovery ladder and confirmed by a human, so that overrides are discovered rather than hand-written.
55. As a reviewer, I want tenant overrides stored as scoped deltas against the base capability, so that the vendor-level capability stays single-sourced.

### Safety and data

56. As a security reviewer, I want an explicit allowlist of origins and action types, so that the agent cannot act outside sanctioned boundaries.
57. As a security reviewer, I want every action in both modes to pass the policy engine before execution, so that there is one chokepoint rather than scattered checks.
58. As a security reviewer, I want risky or irreversible actions handled conservatively by default, so that the failure mode is a stopped run rather than a moved balance.
59. As a compliance reviewer, I want sensitive values kept out of logs by construction, so that redaction does not depend on every call site remembering.
60. As a compliance reviewer, I want a test that fails if any sensitive literal appears in any artifact or evidence file, so that the claim is falsifiable rather than asserted.
61. As a compliance reviewer, I want the limits of redaction stated plainly, so that I am not misled about what is protected.

### Evidence

62. As a debugging engineer, I want every run to emit a structured event log, so that I reconstruct what happened without a screen recording.
63. As an auditor, I want evidence to join discovery, replay and intervention records by run and session, so that a full story is reconstructable.
64. As a reviewer, I want a machine-checkable assertion that no replay evidence contains a model decision, so that the claim is verifiable from artifacts alone.
65. As a debugging engineer, I want a screenshot at the point of failure, so that I see what the automation saw.
66. As an evaluator, I want one command that runs the whole story end to end and prints where the evidence landed, so that I assess the system without assembling it myself.

---

## Implementation decisions

### Stack and structure

Bun 1.4 as the runtime, Effect 4 (`4.0.0-rc.112`) as the application framework, Playwright 1.62 as the first surface driver, TypeScript throughout. Effect 4 is a release candidate. Its monopackage carries `unstable/ai`, `unstable/cli`, `unstable/http` and core `Schema` and `Redacted`, so the dependency surface stays small, but we verify API usage against shipped type definitions rather than recall. Playwright on Bun is confirmed working: launch, CDP, frame traversal, teardown.

Seven workspace packages (`agent`, `artifact`, `replay`, `surface`, `policy`, `session`, `evidence`) plus `apps/legacy-core` and `apps/operator`. Package boundaries are the architectural claim. The stronger enforcement, though, comes from the Effect service graph: `replay` requires the `SurfaceAdapter` service and never the Playwright implementation, and the compiler checks that.

Model access goes through `effect/unstable/ai/LanguageModel`. Provider choice is a `Layer` swap between `@effect/ai-anthropic` and `@effect/ai-openai`, both at matching RC versions. We hand-roll no provider abstraction.

### Surface abstraction, accessibility tree only

`SurfaceAdapter` exposes `observe`, `resolveTarget`, `click`, `fill`, `extract`, `waitFor` and `captureEvidence`. The DOM is not reachable through it. `observe` returns a `SurfaceState` built from Playwright's `ariaSnapshot()` plus URL and frame list. No method returns HTML, and none accepts a CSS selector.

This is a hard constraint rather than a preference. A model that cannot see markup cannot emit a selector, so the claim that this design survives a surface with no clean DOM is structurally true instead of aspirational. It is also what turns an accessibility-tree or desktop adapter into a swap rather than a rewrite.

Verified on a table-based page with no test IDs: `ariaSnapshot()` yields `row "Member Number Search"`, `cell`, `textbox "Member Number"`, `button "Search"`. Semantic structure survives hostile markup.

### Target representation

Targets are logical. Role, accessible name, label, `textNear`, plus optional `within` (scope to an ancestor accessibility node) and `nth`. Each target records the strategy chosen and why, since the brief asks for reasoning about robustness as part of the artifact.

`textNear` proximity is computed over the accessibility tree, not the DOM, so the escape hatch does not sneak markup coupling back in.

### Discovery agent

Observe, decide, act, with the action vocabulary expressed as an Effect `Toolkit`. The runtime validates arguments against Schema, so a malformed or out-of-vocabulary action is not representable rather than caught by hand-written parsing.

The model sees the accessibility YAML, current URL and frame list. No screenshots in the decision loop. Vision in the loop would invalidate the proof that the accessibility tree alone suffices, and that proof is the point. Screenshots are still captured every step for evidence and the operator UI. Long flows can switch to sending a diff from the previous snapshot to keep the transcript small.

Stuck detection fires on any of: two repeats of a normalized snapshot hash, three consecutive actions producing no state change, twenty steps, 120 seconds, repeated target-resolution failure, or the agent's own `escalate`. Hash-based cycle detection is the one that earns its keep, because looping is the actual failure mode of these loops. Whichever trigger fired goes on the intervention record.

### Parameter discovery through provenance

`fill` cannot take a bare string. Every value carries provenance:

```
value:
  | { kind: "goalDerived"; name: string; literal: string }
  | { kind: "uiDerived";  fromStep: string }
  | { kind: "constant";   literal: string }
```

An agent typing a member number emits `{ kind: "goalDerived", name: "memberId", literal: "12345" }`. It names the semantic role it inferred from the goal text and the field's label. The compiler then derives inputs mechanically. Each distinct `goalDerived.name` becomes a declared input, each use becomes a parameter reference, and the literal is thrown away. Inputs get discovered by the model with no human-supplied schema and no second compile-time model call.

Two invariants are enforced rather than encouraged.

Sensitivity is default-deny. Every discovered parameter is sensitive unless a policy rule allowlists it. We do not delegate PII classification in regulated financial data to a model.

A `constant` colliding with the goal is a compile error. If a `constant` literal appears as a substring of the discovery goal, artifact emission fails. That closes the hole where a lazily-tagged action bakes a member ID into a stored capability, and turns "artifacts contain no runtime values" into a property the compiler enforces.

### Selection as a discovered rule

Choosing among a list of items, accounts in this case, is a generic `selectFromList` action whose parameters are all discovered:

```yaml
- id: open-account
  action:
    type: selectFromList
    list:
      within: { role: table, labelledBy: "Accounts" }
      itemRole: link
    match:
      against: { parameter: accountType }
      strategy: tokenSubset
  onNoMatch:  { escalate: NO_MATCHING_ITEM }
  onMultiple: { escalate: AMBIGUOUS_MATCH }

inputs:
  accountType:
    type: enum
    values: ["Primary Savings", "Checking"]   # read off the page during discovery
    default: "Primary Savings"                # goal said "savings"
    discoveredFrom: "goal term 'savings' ⊂ label 'Primary Savings'"
```

Nothing there is hardcoded in source. The agent read the account list to get the enum, and matched the goal's word against the labels to pick the default. The goal-term-to-label inference happens once, at discovery, by the model, and gets recorded. That is the project's central thesis applied one level down.

`tokenSubset` matching is deterministic and generalizes across tenants for free. A tenant labelling the account `Regular Savings` still matches `savings`. Multi-tenant reuse therefore falls out of the matching design rather than arriving as configuration.

Worth stating plainly, because it is easy to over-read: determinism means no model in the loop, not no logic. Replay reads the live account list and matches by token. Same list, same parameter, same choice, every time.

### Artifact storage

Immutable versioned files, one per version, plus a small index resolving `latest`. Interventions live separately, and each names the version it produced.

Immutability makes "reviewable before production use" demonstrable. Diffing `1.0.0` against `1.1.0` shows exactly one outcome entry added, sitting next to the intervention record that justified it. A single mutable file with git history hides that in a place the evaluator has to go looking for.

### Error taxonomy and classification

Four result classes: `success`, `business_outcome`, `intervention_required`, `failure`.

Classification is not a config file naming known states, because that smuggles the answer in as configuration. A state's class comes from what a human had to do to resolve it, which is evidence we already record.

| Human's actions during handoff | Meaning | Learned as |
| --- | --- | --- |
| None. Observed, returned control | Terminal, observational | `business_outcome`, declarable |
| Actions returning the session to the expected checkpoint | Recoverable | `recoverable` rule, declarable |
| Actions requiring authority, or a control whose consequence is not derivable from the screen | A permissions problem, not a UI problem | `requires_human`, declared as always-escalate |

The operator UI resolves the ambiguity between rows two and three with a single question at return-of-control: should automation do what you just did, or always stop here? That is a per-case judgment by the person who resolved it, the way real runbooks form, not an upfront policy.

Learning a `requires_human` state does not make it automatable. It makes replay fail fast with the right reason and routing instead of burning a stuck-detection cycle to reach a generic unknown state. The system learns that it must escalate and why. It never learns to proceed. These entries are write-once: no later intervention can downgrade one to `business_outcome`. The rule only tightens.

Target resolution: two or more matches is a hard failure, never a coin flip, and the failure reports all candidates. Zero matches retries fallback strategies and then enters the ladder, because a missing control is as likely to be domain truth as breakage, and telling those apart is exactly the question being escalated.

### Assisted recovery

One rung sits between deterministic replay and a person. Bounded to a single step and a single attempt, policy-checked, and structurally incapable of acting: the fallback model's toolkit contains no `click` or `fill`, only a classification proposal of `{ proposedOutcome, confidence, rationale }`. It reads the accessibility snapshot and says what it thinks the state means.

A confident classification returns an outcome to the caller immediately, so nobody is blocked at replay time. The result is tagged as assisted, carrying `assisted: true`, the confidence and a reference to the proposal in evidence, so a caller can always tell a deterministic outcome from a proposed one. An assisted result never counts as deterministic for reliability or approval purposes.

Promotion of that proposal into the artifact still requires human confirmation, so the write-once rule holds and a bad model call cannot silently change a capability. Authority-class states are never proposable as automatable. Off by default, enabled with `--assist`.

### Session and handoff

Single process. The replay CLI launches a headed browser. On pause it starts a `Bun.serve` operator UI, prints the URL, and blocks on an Effect `Deferred` that the resume endpoint resolves. The human operates the actual browser window. The session is the browser handle, so splitting processes would mean shipping the handle or building a broker, and neither demonstrates anything.

Ownership is an explicit state machine, `AUTOMATION → PAUSED → HUMAN → RESUME_REQUESTED → AUTOMATION`, enforced by a guard in the adapter that throws if the engine acts while the human holds control. That guard is what makes the transfer real instead of decorative.

`SessionManager` sits behind an interface. In-memory today, brokered when a second process needs it.

### Policy engine

Allowlisted origins and action types, with risky or irreversible actions handled conservatively by default. Every action from either mode passes through it before reaching the adapter. One chokepoint, not scattered checks.

### Sensitive data

Sensitive inputs are `Redacted<string>` end to end. The type refuses to serialize or print, and unwrapping needs an explicit call that is greppable and auditable. Redaction stops depending on every call site remembering.

Text evidence, meaning accessibility snapshots and event logs, passes a scrub replacing known sensitive parameter values with a labelled placeholder, at the single point where evidence gets serialized.

Screenshots are a stated limit. They contain rendered member IDs and balances, and we do not redact them. They go only to `/evidence`, which carries a note that these are demo artifacts over synthetic data. Pixel redaction is named as a known gap with a mitigation rather than half-solved.

### Evidence

One `events.jsonl` per run. Event kinds: `run.start`, `observe`, `decide` (discovery only), `policy.check`, `action`, `checkpoint`, `outcome`, `assist.request`, `assist.proposal`, `intervention.raise`, `intervention.human_action`, `intervention.resolve`, `run.end`. Assisted recovery gets its own kinds rather than reusing `decide`, so consulting a model during replay can never hide behind a discovery-shaped event. Every event carries run, session and step identifiers, so discovery, replay and intervention records join up.

Schema validates the union on write. That makes the evidence itself a contract, and makes "no model decided anything in replay" assertable by a test over the files.

### Proving no model runs in replay

The primary proof is the type system. The replay engine's effect requires `SurfaceAdapter | Policy | Evidence | Session` and nothing else. `LanguageModel` is absent from the replay layer, so any code path reaching for it fails to compile. The secondary proof is an evidence assertion: a replay run contains no `decide` event at all, and no `assist.*` event unless assisted recovery was explicitly enabled for that run. Both go in the write-up. The first is an argument available only because of the Effect choice.

### Mock application

Server-rendered, table-based layout, no semantic markup, no test IDs, full page loads. Account Detail sits inside an iframe. Duplicate label-ish fields exist so that `within` and `nth` disambiguation is exercised rather than theoretical. A session-expiry toggle forces re-auth mid-flow. Framesets are excluded, since they teach the same lesson as the iframe with more 1990s edge cases and no extra credit.

Fixture routes serve hostile markup variants, so target-resolution edge cases are test data rather than a new code seam.

Scenarios:

| Member ID | State | Class |
| --- | --- | --- |
| `12345` | Normal | success |
| `99999` | Member not found | business outcome, discovered at v1.0.0 |
| `88888` | Checking only, no savings | intervention, then learned, business outcome at v1.1.0 |
| `77777` | Account restricted, supervisor authorization | intervention, then learned, still intervention at v1.2.0 |
| `55555` | Slow load, transient overlay | recoverable, wait and retry, nothing learned |
| any + expiry toggle | Session expired mid-flow | recoverable, re-auth then resume the step |

Second tenant `community-cu`, same vendor product:

| Difference | Outcome | Why |
| --- | --- | --- |
| `Member #` rather than `Member Number` | absorbed, no override | token match on `Member` |
| `Regular Savings` and `Share Draft` | absorbed, no override | `savings` ⊂ `Regular Savings` |
| Submit button reads `Find`, not `Search` | needs an override | no token overlap, genuinely unresolvable |
| No iframe on account detail | absorbed, no override | targeting is frame-agnostic |

We do not hand-write the override. Replay against `community-cu` fails to resolve the submit control, the ladder fires, assisted recovery proposes `Find`, a human confirms once, and the confirmation gets written as a scoped tenant delta recording how it was discovered and who confirmed it. Tenant drift is detected because replay fails, and adaptation is the recovery ladder doing its ordinary job.

### Capability catalog

Saved artifacts are exposed as a catalog of callable capabilities with typed signatures, discoverable and invocable by name. Small, and it closes the framing loop. The agent-facing product decides what to do. This system is how it does it.

### CLI

```
bun run app                                          # mock legacy core
bun run app --tenant community-cu                    # second tenant variant
bun run discover --goal "..." --target <url>
bun run replay <capability> --memberId 12345
bun run replay <capability> --memberId 12345 --accountType Checking
bun run replay <capability> --memberId 88888 [--assist]
bun run operator                                     # meaningful while a run is paused
bun run catalog                                      # list callable capabilities
bun run demo                                         # the full arc, unattended
```

`bun run demo` runs the whole story and prints evidence paths as it goes. Evaluators read many submissions. One command that produces the full narrative unattended is worth more than a README describing it.

---

## Testing decisions

A good test here asserts on externally observable behavior. The structured result a caller receives, the files on disk, whether the thing compiles. It never asserts on internal call sequences. The result contract, the artifact and the evidence are the product, so they are what the tests should pin.

### Seams

One new code seam, plus one that exists for product reasons anyway.

The public capability API and CLI, driven against the real mock application. Tests call discover and replay, then assert on `ReplayResult` and emitted evidence. This is the highest seam available and it covers the taxonomy, the ladder, determinism, redaction, handoff and tenant adaptation as external behavior. Real Playwright, real browser, real mock app. The mock app is the test fixture, so no browser stubbing happens anywhere.

The `LanguageModel` layer. Already a seam, because provider choice is a product requirement. Tests reuse it to supply deterministic assisted-recovery proposals, so no test-only abstraction gets introduced.

Target-resolution edge cases (zero matches, multiple matches, duplicate labels, iframe traversal, `within` and `nth` disambiguation) run through fixture routes on the mock app. Hostile markup is test data, not test plumbing.

### What gets tested

Artifact schema round-trip. Parse, serialize, re-parse, and reject malformed artifacts with useful errors. A pure function over a public export, so no seam is needed.

Replay across all six scenarios, asserting the exact result class and payload. Success with typed outputs, `MEMBER_NOT_FOUND`, the escalation and post-learning behavior for `88888` and `77777`, transient recovery for `55555`, session-expiry recovery mid-flow.

Determinism. Repeated replay of the same inputs yields identical outputs and an identical step sequence.

No model in replay, by typecheck. A test composes the replay layer without `LanguageModel` and fails to compile if the requirement ever appears. Backed by an assertion over replay evidence: no `decide` event ever, and no `assist.*` event unless assist was explicitly enabled for that run.

Redaction. Walk every artifact and evidence file, and fail if any sensitive literal appears. A filesystem grep that makes the safety claim falsifiable rather than asserted, and the highest value-per-line test in the suite.

Target resolution via fixture routes. Zero matches enters the ladder, two or more is a hard failure listing candidates, `within` and `nth` disambiguate correctly.

Compiler invariants. A `constant` value colliding with the goal text fails artifact emission, and parameters default to sensitive.

The write-once rule. An attempt to downgrade a `requires_human` outcome to a business outcome is rejected.

The ownership guard. An engine action attempted while the session owner is `HUMAN` throws.

Tenant adaptation. Replay against `community-cu` absorbs the cosmetic differences with no override and fails only on the submit control.

`@effect/vitest` throughout. This repository is greenfield with no prior art, so these tests set the conventions.

### Deliberately untested

Discovery against a live model. It is slow, it costs money, and it is non-deterministic. Discovery is evidenced instead by a genuine recorded run in `/evidence`, which is what the brief actually asks for. A mocked-model discovery test would prove only that the mock works.

---

## Out of scope

| Not built | Seam left behind | What comes next |
| --- | --- | --- |
| Desktop or OS-level adapter | `SurfaceAdapter`, and accessibility-only observation means no DOM assumptions to unwind | UIAutomation or AXAPI adapter behind the same interface |
| Real-time co-browsing console | Ownership state machine is real, only the transport is mocked | CDP screencast to an operator canvas with input relay |
| Screenshot redaction | Text evidence is scrubbed, pixels are not | OCR-based masking of known parameter values |
| Persistence beyond files | Artifact and evidence writers sit behind interfaces | Object store plus index, artifacts stay immutably versioned |
| Multi-process session brokering | Single process today | Session broker, the handle becomes a reference |
| Live-model discovery test | Real run evidenced instead | Recorded-fixture replay of a transcript |
| Code generation from artifacts | | Emit a page object or test file from a capability |
| Confidence scoring and approval gating | Versioning and review are in place | Score replay reliability, gate unattended replay on draft to approved |
| Multi-run stability signal | | Replay N times, diff outcomes, feed the approval gate |
| Concurrency and parallel replay | Nothing is shared between runs | Session pool |
| Framesets beyond iframes | | Same targeting, no new mechanism |

Also out of scope: queues, clusters, databases, containers. In-memory state and local files are enough, and the brief penalizes infrastructure that demonstrates nothing.

---

## Further notes

**Scope discipline.** The brief says to pick at most one or two stretch goals, and states plainly that feature breadth is not rewarded. Assisted fallback and cross-tenant reuse have collapsed into a single mechanism, one recovery ladder demonstrated against three different problems, so they read as depth rather than breadth. The capability catalog is the only addition beyond that. Everything else on the stretch list is named in Out of scope along with what we would build, which the brief explicitly asks for.

**Primary risk: Effect 4 is a release candidate.** Documentation is thin and model knowledge of the API is weak, so implementation must check shipped type definitions rather than trust recall, and some API usage will be wrong before it is right. The payoff makes it worth the friction. `unstable/ai` as the provider seam, `Redacted` as core, and layer requirements as machine-checked proof that no model runs in production. That last one is an argument no other stack makes available.

**Secondary risk: accessibility-only observation could turn out insufficient** on some screen the mock app makes deliberately hostile. It is verified working on table-based markup with no test IDs and across iframes. If a case defeats it, the right response is to record it in the write-up as a finding about the approach's limits, not to quietly put DOM selectors back. The constraint carries the whole design argument.

**Build order.** Core types and artifact schema first, then the mock application, then the surface adapter, then deterministic replay end to end. Replay must work before any model is involved. Then discovery, policy, handoff, the recovery ladder, and the second tenant. Replay before discovery is deliberate: it forces the artifact schema to be genuinely executable before anything starts generating one.

**Deliverables.** `README.md` with setup, keys and the exact demo commands. `REPORT.md` using the seven required headings verbatim: Architecture, Artifact schema, Determinism & error handling, Heterogeneity & multi-tenant, Escalation & handoff, Safety, Cuts. `/evidence` containing a genuine model-driven discovery run plus successful, business-outcome and escalation replays. A public git repository, which this directory now is locally but does not yet have a remote.
