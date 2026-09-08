# Assignment verification — September 8, 2026

The reviewed local source is identified by [source-files.sha256](source-files.sha256), whose SHA-256 is `6123cbdfe167687fe3551043f3a6f4a31dba0ea9041e058c2db27cd1a6562c79`. Baseline commit: `60b4519da023abbec6141c0b41eb128df61ddb5a`. Changes are uncommitted; nothing was published or submitted.

| Check | Result |
| --- | --- |
| Full automated suite | **494 passed across 43 files**, no failures |
| Typecheck | Passed |
| Clean frozen installation | Passed in an isolated directory, without credential files |
| Clean-install typecheck and actual CLI replays | Passed: success plus three business outcomes on the same discovered capability, version 1.4.0 |
| Demo with model key removed | Exit 0 |
| Independent review | Both residual findings reproduced, repaired, and independently rechecked |
| Text scan of fresh live evidence | 39 files checked; no tested identifiers or configured provider key found |

The [live bundle](../../discovery/live-2026-09-08T13-36-29-223Z-9972cdc9/manifest.json) preserves a genuine `gpt-4.1` discovery, its exact compiled artifact and replay. The initial follow-up amendment failed because the discovered capability lacked the reviewed public account-category policy exception. The policy was corrected; the original evidence was retained. The driver checked the saved artifact and appended a completion attempt without another model call.

That completion learns three outcomes from recorded interventions, through versions 1.2.0–1.4.0. The final artifact returns normal success, `NO_MATCHING_ITEM`, `MEMBER_NOT_FOUND` and `INPUT_VALIDATION_ERROR`, all without a model. SHA manifests bind the saved documents to the evidence copies. Operator judgments are scripted; Chromium, the application, HTTP operator interface and ownership transfer are real.

Discovery handoff and CLI round-trip coverage use scripted model responses and real browsers. They establish runtime contracts, not model reliability. The independent delayed-page probe stopped in 155 ms for a 150 ms budget (previously 2,027 ms). Native queued click/fill and navigation tests prove no delayed mutation occurs after returning control.

Pixel masking remains the explicit ADR-0010 cut. The 19 PNGs in this live bundle contain synthetic fixture data and were excluded from text scanning. Binary persistence defaults off; external-application commands retain scrubbed accessibility evidence. The saved demo transcript masks its synthetic example input literals. Test and demo transcripts have trailing whitespace normalized.

[Detailed findings and criterion mapping](../../../docs/review-resolution.md). Test, typecheck, installation, replay, demo and live-run records are stored beside this file. Historical evidence remains historical; no old log was rewritten to claim a different provider or result.
