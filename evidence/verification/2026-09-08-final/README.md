# Final assignment verification — September 8, 2026

The tested source is identified by [source-files.sha256](source-files.sha256): **174 source, configuration and artifact files**, manifest SHA-256 `8e2d910044dc6aea66675753024bbfaed8184e64f3c67f90dd178b1575f656c8`. Baseline commit: `60b4519da023abbec6141c0b41eb128df61ddb5a`. All listed files also match the clean-install copy byte for byte. Changes are uncommitted.

| Check | Result |
| --- | --- |
| Full suite | **509 tests passed across 50 files**, no failures |
| Typecheck | Passed |
| Fresh frozen installation | Passed in an isolated directory without credential files |
| Clean-install CLI, model keys removed | Version 1.8.0 returned success, `NO_MATCHING_ITEM`, `MEMBER_NOT_FOUND` and `INPUT_VALIDATION_ERROR`; all exit 0 |
| No-key demonstration | All eight acts completed, exit 0 |
| Independent recheck | Original redirected-token probe now succeeds without token leakage; seven URL/manual-completion tests pass; live CLI scrubber reaches both persistence gates |
| Live evidence privacy scan | 35 text files, zero tested identifier/key leaks; 17 synthetic PNGs excluded explicitly |
| Artifact provenance | All four 1.5.0–1.8.0 evidence copies match canonical files and manifest hashes |

The [fresh live bundle](../../discovery/live-2026-09-08T14-45-52-190Z-132a40d2/manifest.json) records a genuine five-action `gpt-4.1` discovery with OpenAI/model metadata. Its exact compiled 1.5.0 artifact replayed successfully. Recorded interventions then produced 1.6.0–1.8.0; the same final version returned success and three business outcomes. Operator judgments are scripted; the browser, fixture and HTTP ownership transfers are real.

The final URL-redaction, manual-completion and CLI-persistence fixes followed that live run. The current-source suite and clean-install replays verify those changes; the model was not rerun for them. The no-key eight-act demo was also rerun after those fixes. These timing boundaries distinguish each piece of evidence rather than attributing a newer source state to an older log.

Screenshot pixels remain unredacted under ADR-0010's explicitly enabled synthetic-data exception. External commands disable screenshot persistence and retain scrubbed accessibility evidence. The final success PNG was visually inspected and shows the synthetic account and matching balances. Text scanning does not validate pixels or establish general detection of unknown personal data. The saved demo transcript masks its synthetic example inputs; log trailing whitespace is normalized.

[PDF and ADR comparison](../../../docs/review-resolution.md) maps every core criterion and records the resolved findings and intentional cuts. The initial 417-test report and earlier 494-test verification are historical. No evidence from those runs was rewritten, and no publication or email submission was performed.
