# Architecture and human handoff verification

Tested source: `5fabc36a95daf55e3c045d3dc67d9a64ff99cec4`. The [source manifest](source-files.sha256) identifies 182 source, configuration and Artifact files. [Verification details](verification.json) record commands, results and review provenance.

| Check | Result |
| --- | --- |
| Full suite | [547 tests passed across 55 files](tests.txt) |
| Typecheck | Passed on the same implementation |
| Eight-act demo without a model key | Completed, exit 0; 39 text Evidence files scanned with no tested private values found |
| Final handoff acceptance | [Both completed and blocked cases passed](handoff-tests.txt) |
| Independent review | All three tasks and their integration passed; privacy review included 5,550 overlapping-value cases |

The three changes put learning persistence behind the run's live scrubber, place read authorization inside Checkpoint evaluation, and let Discovery compile before releasing private context. Review found quoted-value leaks in both learning and Discovery; the final tests include those counterexamples and their fixes.

## Human handoff

The [manual walkthrough](../../../docs/human-handoff.md) provides `bun run demo:handoff`, exact fixture actions and the assignment section 3.6 coverage table.

- [Completed proof](completed/receipt.json): a scripted Operator took the same real Chromium Session, changed the supervisor fields, clicked Authorize and returned control. Competing Replay was refused while the Operator held control. The `open-account` Checkpoint held after return, then Replay produced the expected balances.
- [Blocked proof](blocked/receipt.json): the Operator returned an unresolved request; the run ended with `intervention_required`.
- [Native UI proof](native-ui/receipt.json): Codex used the actual operator page and original headed Google Chrome for Testing window through accessibility UI tools. The interface showed all five ownership transitions and Replay completed successfully. This run occurred after the Checkpoint refactor while the remaining privacy work was finishing; the two automated proofs above used the final committed source.

Each receipt links its original run events. All events within each run retain one Session ID. The three event logs were scanned for the synthetic member and supervisor values; none appeared. The native run's final image was visually checked against the returned balances.

These are agent-performed or scripted Operator demonstrations. They do not claim a person was at the keyboard. Screenshot pixels remain unredacted under the explicit synthetic-fixture exception. All retained screenshots come from that fixture.

The existing [live-model discovery bundle](../../discovery/live-2026-09-08T14-45-52-190Z-132a40d2/manifest.json) remains unchanged and matches the canonical 1.5.0 Artifact. No new live model invocation was needed for these refactors. Earlier verification bundles remain historical records.
