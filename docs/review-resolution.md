# Review resolution

This checklist reconciles the independent assignment review at commit
`60b4519da023abbec6141c0b41eb128df61ddb5a` and the comparison supplied as
`pasted-text.txt`, both reviewed on September 8, 2026. Their baseline was 417
passing tests; that is historical evidence, not the final count for this change.

This pass reproduced and repaired further boundary defects after the initial
review. The final suite passes **509 tests across 50 files**; typecheck and the
fresh installation pass. Historical test counts and evidence remain in their original
bundles; they do not establish the behavior of subsequent edits.

[Verification and source fingerprint](../evidence/verification/2026-09-08-final/README.md)
identify the tested source. Changes are uncommitted and have not been published
or submitted. The PDF's submission directions were treated as deliverable
instructions, not permission to publish or email.

## Additional pass: integration boundaries

| Finding | Required behavior and regression evidence |
| --- | --- |
| Entry URL query/fragment values leaked into discovery evidence and constants | Register URL components before evidence. Compile an entry location containing private values as a required sensitive parameter without a default; reject private literals anywhere in the compiled document. `discovery-entry-privacy.test.ts`, CLI round trip. |
| Manual discovery steps disappeared from the saved flow | Preserve an explicit human dependency and next-state checkpoint; fresh replay requests the missing work and verifies return. Refuse compilation without a later observable state. `discovery-intervention-artifact.test.ts`, ADR-0012. |
| Child-frame navigation returned the old screen | Track requested/started/completed frame navigation, drain renderer protocol events and cancel pending native loads on timeout. `surface-navigation.test.ts`, existing deadline and origin suites. |
| A later checkpoint failure was learned as no matching account | Bind amendments to the executor's actual failure cause, capability, version and step. Historical unbound records cannot supply the missing proof. `amendment-failure-binding.test.ts`. |
| Terminal evidence errors left a successful result | Failed final structured observation or run-end write produces `evidence_failed`, retaining scrubbed prior result context. Optional screenshot absence remains nonfatal. `replay-final-evidence.test.ts`. |
| Replay entry URL components escaped redaction after redirect | Register runtime and observed URL components in replay, including sensitive compound inputs. `replay-url-privacy.test.ts`; original independent redirect probe rechecked with zero leaks. |
| Operator-completed missing action was executed again | Check the returned state before retrying; continue when manual completion satisfies the checkpoint or outcome. Retain retry for a restored control and report the actual returned state. `replay-manual-completion.test.ts`; five real-browser cases pass. |
| CLI learning forgot secrets observed during replay | Preserve the live evidence scrubber for amendment and override persistence; reject a proposal containing a known screen value. `cli-replay-persistence-privacy.test.ts`; real CLI/operator composition refuses the unsafe override. |
| Three optional stretch features exceeded the brief | Removed the catalog implementation, command and demo act. Retained assisted fallback and cross-tenant reuse; the no-key demo now completes eight acts. |

## Reproduced defects and required behavior

| Finding | Resolution and evidence | Status |
| --- | --- | --- |
| Allowed outer origin authorized forbidden iframe actions; link/form/redirect destinations were unchecked | Browser predicate plus initial-request and Chromium redirect interception; checks all live frame origins before observation and actions. `test/surface-origin-boundary.test.ts` covers forbidden and permitted frames, POST bodies and redirect chains. ADR-0011 records the boundary. | Locally verified, 37 surface/abstraction tests passed |
| Goal values leaked before dynamic registration and through serialized trajectories | Private goal remains in memory; discovery redaction and export boundaries separate raw runtime context from diagnostics. `test/discovery-privacy.test.ts`. | Verified in the full suite |
| Discovery detected stuck states without a live operator handoff | Discovery uses Session ownership and the same live browser; operator takeover/resume coverage in `test/discovery-handoff.test.ts`. | Verified by actual CLI handoff tests and live-browser integration |
| `discover --json` banners broke the documented compilation pipeline | JSON mode produces a checked compilation envelope; human status belongs on stderr. Compile accepts the staged artifact and rejects legacy raw trajectories. `test/cli-contracts.test.ts`. | Verified by command-level round trip and real replay |
| Normal return form lost evidence of supervisor action | Learning considers observed changes, preserves mutation evidence and checks returned state. `test/operator-learning.test.ts` covers supervisor release without a separate note and rejects unsupported unattended learning. | Verified in the full suite |
| Live discovery rerun replayed an older immutable artifact | Driver preflights run/version collisions and preserves prior evidence; the new run must replay its exact compiled document. `test/discovery-evidence-driver.test.ts` covers planning and collisions. | Verified by fresh live discovery, immutable-source receipt and completed outcome chain |
| No-key assistance exposed provider/configuration internals | Stable public diagnostic in `packages/agent/src/assist.ts`; `test/assist-diagnostics.test.ts` and CLI coverage. | Verified in the full suite |
| Replay stdout exposed sensitive identifiers in observed URLs | Replay CLI renders failure diagnostics through the run's redaction boundary. `test/cli-contracts.test.ts`. | Verified in the full suite |
| Discovery timeout only checked between operations | A wall-clock deadline bounds a silent provider too. `test/discovery-deadline.test.ts`. | Verified in the full suite |

## Assignment and evidence packaging

| Finding | Resolution or explicit limit | Status |
| --- | --- | --- |
| REPORT exceeded the requested short write-up | Rewritten to a short design report under exactly the seven required headings. | Verified locally |
| Desktop seam was insufficiently concrete | REPORT describes Windows UI Automation/macOS Accessibility roles, actions, window handles, entry mapping and unsupported controls. | Addressed at required design scope |
| Default README discovery example selected a model known to fail the goal | Commands explicitly use `--model gpt-4.1`; provider default now matches. Historical mini-model limitations remain identified; the new genuine run completed in five actions. | Verified by the fresh genuine run |
| Discovered artifact had no outcome handling; taxonomy proof used another artifact | Preserve the exact discovered artifact, show replay, then record and verify a provenance-linked outcome amendment and its exceptional-state replay. Do not attribute hand-written outcomes to discovery. | Verified in the linked fresh bundle and its completion manifest |
| Matching discovered-artifact replay log was absent from committed evidence | Bundle discovery, compiled YAML, exact replay and any later amendment together. | Verified in the linked fresh bundle and its completion manifest |
| Discovery events omitted the model name | Current run metadata records `gpt-4.1` and OpenAI in `run.start`; scripted providers identify themselves. Earlier bundles retain their original metadata. | Verified in the fresh live bundle |
| No raw model transcript | Keep useful decisions, accepted actions and safe provider metadata. Raw prompts can contain sensitive goal or screen text and are deliberately not persisted merely to strengthen provenance. | Adjudicated privacy boundary |
| Validation-error state lacked a fixture and handling | The fixture renders nonnumeric member validation; recorded confirmation adds `INPUT_VALIDATION_ERROR` to the same discovered artifact. Actual CLI replay returns that outcome with exit 0. | Verified on discovered capability version 1.8.0 |
| Account-type metadata contradicted blanket sensitive treatment | Distinguish public UI category labels from member identifiers through explicit artifact intent and deployment declassification policy. Fresh YAML declares the public category; policy explicitly approves that named capability. Unknown parameters and unapproved goal vocabulary stay sensitive. | Verified in fresh YAML, policy and sensitivity tests |
| Handoff demonstrations used scripted operators | Mechanism remains real; README/REPORT disclose scripting. Do not claim a human completed the demonstration at a keyboard. | Accepted disclosed demonstration limit |
| Screenshots contain unredacted synthetic data | Binary attachments are disabled by default; built-in synthetic runs opt in. External --baseUrl runs persist accessibility evidence without screenshot bytes. ADR-0010 records that enabled pixels remain unredacted. | Accepted synthetic-demo limit; production restriction remains |
| More stretch work than the brief requested | Remove the optional catalog; retain assistance and tenant reuse as the two stretch goals. Approval and stability scoring remain cuts. | Verified: two retained stretch goals |
| Fresh installation and live provider verification were not repeated by the first reviewer | Record final setup/check commands and distinguish them from historical reviewer results. | Verified by clean installation, typecheck and actual CLI replay |

## Standards and maintainability

| Finding | Resolution or adjudication | Status |
| --- | --- | --- |
| CONTEXT banned names already used for handoff/page/snapshot | It now distinguishes Intervention records from handoff control transfer, browser pages, accessibility snapshots and ownership snapshots. Existing accurate identifiers remain. | Addressed |
| ReplayResult claimed reachable variants were unimplemented | Header now describes all four reachable result variants and explicit assisted outcomes. | Addressed |
| Stale unwrap count and nonexistent `runCheckpoint` reference | Replaced fixed counts with named runtime boundaries and linked source tests; checkpoint commentary reflects the current recovery order. | Addressed in the final source |
| Obsolete ticket-history comments | Removed tracker chronology while retaining explanations of invariants and failure modes. Emitted-JavaScript comparison verified the comments-only edits. | Initial 37-file comparison verified; agent/engine cleanup completed separately; final CLI sweep found no obsolete ticket references |
| TextPresent used inconsistent case/whitespace semantics | Checkpoints now share normalization with surface conditions. `test/checkpoint-text.test.ts`. | Verified in the full suite |
| Repeated `steps.find(id)` calls | Lookups occur in separate amendment/override operations over small immutable step lists. Each operation performs a short, total linear lookup; an indexing layer would add state without changing observed behavior. | Adjudicated: no demonstrated defect; retain straightforward lookup |
| Repeated argv parsers and untested CLIs | CLI composition moved to `apps/cli`; common argument parsing and command-level regression tests added. | Verified in the full suite |
| Three switches over proposal verbs | Different validation, description and execution responsibilities may legitimately switch over a closed union. Consolidation must remove duplicated policy, not merely reduce switch count. | Adjudicated: preserve distinct responsibilities |
| Replay engine owns several concerns | Public diagnostics extracted; CLI dependencies moved out. The remaining nested workflow shares explicit ownership, evidence and recovery state. Separate public diagnostics and CLI composition remove concrete boundary problems; further file splitting is not required by the PDF or a demonstrated bug. | Adjudicated after concrete boundary fixes |
| Bare outcome/step/version strings despite schema names | Schema validation at boundaries remains the runtime guarantee. Branded internal identifiers may help future API work, but a broad type rewrite needs a concrete misuse to prevent. | Adjudicated design improvement, not demonstrated runtime defect |
| Four `as never` casts in the discovery loop | Removed from current loop implementation. | Verified by final typecheck |
| Replay package depended on agent/operator for its CLI | Executable composition lives in `apps/cli`; package dependencies now reflect deterministic replay. `test/workspace-dependencies.test.ts`. | Verified in the full suite |
| Demo imported support from test directories | Runtime demonstration support moved to `apps/demo/src/support`; tests consume it there. | Verified: no-key demo exits 0 |
| Value.ts constituent schemas had unused exports | ParameterRef, ConstantRef and StepRef remain needed by ValueRef but are now module-local. No external callers or index exports existed. ValueRef and describeValueRef stay public. | Verified; 46 artifact/privacy/no-model tests passed |
| Unused public openAiProvider export | Provider remains available through the provider map; narrowing the incidental export is owned with the provider/CLI change. | Verified: implementation is module-local; provider map remains public |
| ADR-0003 overstated what service requirements prove | Clarified that signatures and tested default composition establish model-free ordinary replay; injected assisted callbacks are separately authorized and labeled. | Addressed |
| `docs/agents/issue-tracker.md` was absent | The cited review-skill helper file is not a PDF deliverable. This checklist records actual findings without inventing an external tracker or installing another workflow. | Adjudicated |

## PDF criterion coverage

| Criterion | Current evidence and limits |
| --- | --- |
| 3.1 Goal-driven discovery | Genuine five-action `gpt-4.1` run on the live fixture; deadline, cycle, no-effect and step-limit tests; real discovery handoff. |
| 3.2 Typed reusable artifact | Exact compiled 1.5.0 YAML; parameters, outputs, checkpoints, locator rationale and immutable versions; privacy gate; recorded manual dependencies. |
| 3.3 Deterministic replay and error taxonomy | Model-free ordinary replay; final 1.8.0 success plus no-match, member-not-found and validation outcomes; recoverable dialog/session/slow-load tests and explicit hard failures. |
| 3.4 Safety and privacy | Configurable action/origin policy; frame/redirect enforcement; risky-action restrictions; known-value redaction through evidence, CLI and persistence; external screenshot suppression. ADR-0010's synthetic pixels and unknown-data limits remain explicit. |
| 3.5 Evidence | Structured what/why decisions, actions, checks and interventions; scrubbed accessibility as the richer failure signal; final evidence-write failure changes the result. |
| 3.6 Live takeover and return | Same-browser ownership transfer in discovery and replay; HTTP operator surface; manual action records, checked return and preserved discovery dependency. Operators in automated demonstrations are scripted. |
| 3.7 Heterogeneity and reuse | Surface abstraction handles the legacy iframe fixture; REPORT specifies desktop accessibility/operation/window seam; version-bound tenant override demonstrates reuse. Desktop execution is design-only as permitted. |
| 4–5 Complete vertical slice | Real goal → discovery → exact artifact replay → recorded outcome learning → same final artifact with success and three outcomes; real session escalation mechanism. |
| 6 Deliverables | README setup, key/no-key paths and exact commands; REPORT under the seven required headings; live discovery and replay evidence with copied artifacts. Public publication/submission remains outside this local task. |
| 8 Stretch scope | Exactly two retained: bounded assisted classification and cross-tenant reuse. |

## ADR comparison

| ADR | Current contract |
| --- | --- |
| 0001 Accessibility | No selectors or browser handles in Targets; unsupported inaccessible controls remain an explicit limitation. |
| 0002 Effect | Framework choice and type boundaries; no absolute claim about arbitrary injected callbacks. |
| 0003 Model-free replay | Ordinary replay services/composition exclude model calls; opt-in assisted results are labeled. |
| 0004 Human-derived learning | Actual executor cause and recorded operator evidence govern amendments; manual dependencies use distinct provenance. |
| 0005 Assisted classification | Bounded consultation can classify only; no acting tools or silent artifact promotion. |
| 0006 Shared recovery ladder | Runtime failures feed the same bounded handling, intervention and confirmed amendment path for learning and tenant drift. |
| 0007 Selection | Deterministic token-subset matching against the discovered set; ambiguous matches fail explicitly. |
| 0008 Sensitive parameters | Sensitive-by-default values, explicit declassification, shared dynamic scrubber and compiler/persistence gates. |
| 0009 One-process handoff | Real ownership transfer on the same browser; return is verified rather than trusting the operator's claim. |
| 0010 Screenshots | Pixels remain unredacted only for explicitly enabled synthetic demonstrations. Binary evidence defaults off; external commands keep scrubbed accessibility. |
| 0011 Origin boundary | Browser enforces frame and network destinations, including redirect hops, before acting outside allowed origins. |
| 0012 Discovery intervention | Missing manual work remains an explicit dependency in the compiled artifact; replay verifies its resulting state. |

## Final evidence

- [Verification record](../evidence/verification/2026-09-08-final/README.md): current source fingerprint, full suite, clean installation and CLI checks.
- [Fresh live bundle](../evidence/discovery/live-2026-09-08T14-45-52-190Z-132a40d2/manifest.json): genuine discovery and exact 1.5.0 artifact replay.
- [Completed learning chain](../evidence/discovery/live-2026-09-08T14-45-52-190Z-132a40d2/completion-2026-09-08T14-46-08-572Z-9d350a19/manifest.json): recorded amendments through 1.8.0, then success and three business outcomes on that version.

Historical evidence remains unchanged. A successful live model run, a scripted
model regression and a scripted operator handoff establish different facts.
Screenshot masking, desktop execution, remote co-browsing and production approval
infrastructure remain explicit cuts, not claimed implementations.
