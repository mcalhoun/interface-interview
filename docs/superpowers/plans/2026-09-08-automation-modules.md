# Automation modules implementation plan

> For agentic workers: use superpowers:subagent-driven-development for implementation and independent review of each task.

Goal: implement the three accepted architecture recommendations and make the assignment's human handoff demonstrable.

Architecture: retain the run's growing secret registry through learning and Discovery compilation. Let Checkpoint evaluation own permission checks. Keep the existing Session, Surface Adapter, Policy, Evidence, compiler and immutable file storage behavior.

Tech stack: Bun 1.4, TypeScript 5.9, Effect 4.0.0-rc.112, Playwright and Vitest.

Spec: the user's accepted architecture report, CONTEXT.md, docs/adr/0001 through 0012, and section 3.6 on page 5 of the supplied assignment PDF. A text extraction is at /tmp/interface-assignment.txt. The report is /var/folders/n7/58y6vxbj30vd6gjq4pk1d55m0000gn/T/architecture-review-20260908-115415.html.

## Global constraints

- Ordinary Replay has no model dependency or consultation.
- Every automated Action passes Policy and Session ownership checks.
- Surface observation remains accessibility-only; browser origin enforcement stays active.
- Intervention transfers control of the same live Session. A returned answer alone does not certify completion.
- Human confirmation, failure binding to capability/version/Step, and immutable Artifact versions remain required for learning.
- Preserve every resumed Discovery Intervention in the compiled Artifact.
- Never serialize raw private compiler inputs. Screenshots remain disabled except for explicit synthetic-fixture opt-in.
- Use the existing real Chromium fixture in integration tests. Only model decisions and scripted Operator judgment may be substituted, and evidence must disclose that substitution.
- Apply unslop to all new prose and UI copy.
- Do not send email, publish, or submit the assignment.

## Task 1: learning belongs to the run

Files: packages/replay/src/learning.ts and index.ts, apps/cli/src/replay.ts, apps/demo/src/support/handoff-harness.ts and the four learning drivers; test/run-learning.test.ts.

Consumes: the base CapabilityArtifact, closed InterventionRecord, Evidence.scrub and existing Artifact/Override writers.
Produces: a run-bound learning object captured while Evidence is available. Its Amendment and Tenant Override operations propose, check and persist results together. Callers choose directories and public metadata but cannot replace the run scrubber. Preserve pure proposal functions for focused domain tests.

- [x] Write a regression using real Evidence and a temporary directory. Register an additional screen/Operator secret after creating the run-bound learning object. Propose an otherwise valid learned document containing that secret. Expect refusal and no file. The missing run-bound operation must cause the first failure.
- [x] Add a successful confirmed-learning case. Read the saved Artifact back and verify its Intervention provenance and version; repeat and expect collision refusal.
- [x] Implement the run-bound module, migrate CLI and demo call sites, and remove their input-only scrubber reconstruction and proposal/write sequences.
- [x] Run the focused checks and typecheck:

```sh
bun run test test/run-learning.test.ts test/cli-replay-persistence-privacy.test.ts test/learning-a-business-outcome.test.ts test/learning-that-a-state-needs-a-human.test.ts test/second-tenant-and-discovered-override.test.ts
bun run typecheck
```

- [x] Commit only task files and submit the diff for independent review.

## Task 2: Checkpoint owns permitted evaluation

Files: packages/replay/src/checkpoint.ts, engine.ts, index.ts; test/checkpoint-authorization.test.ts; test/replay-has-no-model.test.ts if its acting-call placement check changes.

Consumes: existing Surface Adapter, Policy, Session, Evidence and resolved input/read state.
Produces: a Checkpoint evaluator that observes the current page, authorizes all control reads and evaluates the requested Checkpoint. Ordinary Step verification, recovery detection and post-Handoff checks use it. The engine no longer enumerates assertion kinds to preauthorize them.

- [x] Write tests through the owned Checkpoint interface for denial in outcome branches and recovery detection, and reauthorization after a page change. Verify denial prevents extraction with real Chromium.
- [x] Run the new tests and confirm they fail before implementation.
- [x] Move permission preparation into the Checkpoint module. Keep intended-state precedence, bounded polling, Evidence and failure reporting. Replace implementation-placement tests with observable denial tests while retaining model-free dependency checks.
- [x] Run focused checks and typecheck:

```sh
bun run test test/checkpoint-authorization.test.ts test/policy-engine.test.ts test/recoverable-conditions.test.ts test/replay-has-no-model.test.ts test/replay-failure-reporting.test.ts
bun run typecheck
```

- [x] Commit only task files and submit the diff for independent review.

## Task 3: Discovery owns private compilation context

Files: packages/agent/src/discovery.ts, loop.ts, Trajectory.ts, compile.ts, index.ts; apps/cli/src/discover.ts and discovery demo callers; Discovery privacy tests.

Consumes: Goal, entry, run configuration and existing Surface/model/Session dependencies.
Produces: one public Discovery workflow that constructs and shares the secret registry, runs Discovery, compiles before private context is discarded, and returns explicit safe diagnostics plus an optional checked compilation result. Internal compiler tests may still use the private Trajectory type.

- [x] Add a test that runs the public workflow with a private entry URL and model prose, serializes the result, and checks that secrets are absent while Replay requires a fresh entry value. Verify failure before implementation.
- [x] Implement the workflow and migrate executable callers. Remove their registry wiring and manual compilation sequencing. Avoid exposing private Trajectory or its scrubber through the new result.
- [x] Preserve Discovery Handoff and compiled human dependencies.
- [x] Run focused checks and typecheck:

```sh
bun run test test/discovery-entry-privacy.test.ts test/discovery-privacy.test.ts test/discovery-handoff.test.ts test/discovery-intervention-artifact.test.ts test/artifact-compiler.test.ts test/cli-contracts.test.ts
bun run typecheck
```

- [x] Commit only task files and submit the diff for independent review.

## Task 4: demonstrate the assignment's handoff

Files: README.md, REPORT.md, docs/human-handoff.md, demo command and relevant integration tests if needed. Store fresh proof under evidence/verification/ with explicit provenance.

- [x] Compare page 5 section 3.6 with the current operator interface and tests. Identify context, same-session control, manual actions, return, verification, ownership and Evidence checks.
- [x] Provide one documented command that launches a headed fixture and operator interface, stops at a reproducible state, explains the exact manual action, and resumes only after verification. Include a blocked-return path.
- [x] Verify the complete path in real Chromium and retain run events and a concise evidence receipt. Clearly label scripted Operator input as scripted.
- [x] Check the existing live-model discovery evidence and preserve it. The PDF's submission/email instruction is not authorization to submit.
- [x] Run full tests, typecheck and a final independent review. Update the plan and documentation with actual outcomes.

```sh
bun run typecheck
bun run test
```

## Verified result

All four tasks are complete. The final source is `5fabc36a95daf55e3c045d3dc67d9a64ff99cec4`: 547 tests passed across 55 files, typecheck passed, and the eight-act demo completed without a model key. Independent task and integration reviews passed. The final retained handoff proof passes both completed and blocked cases. The native UI was also operated in the original headed Chromium Session.

Review found and resolved quoted-secret leaks in learned documents, Discovery diagnostics and Evidence. Regression tests cover nested quotations, trailing whitespace and overlapping raw/encoded values. No domain-model or ADR decision changed.

See [verification evidence](../../../evidence/verification/2026-09-08-architecture/README.md) and [manual walkthrough](../../human-handoff.md). No publication or assignment submission was performed.
