# Human handoff video proof

[Watch the 40-second video](https://github.com/user-attachments/assets/bd44bf29-4424-434d-be28-df105e95caa3), uploaded with `gh pr create --attach` to [PR #2](https://github.com/mcalhoun/interface-interview/pull/2).

The recording shows the real Heritage Core application beside the real operator web form. The Operator actions are scripted. Replay, Policy, Session ownership and the browser adapter are the actual implementations. The recorder adds browser video capture options; it does not replace their behavior.

The request begins at the supervisor hold in `member.account-balance@1.1.0`. The Operator takes the original Session, enters synthetic supervisor values, clicks Authorize, confirms the action and returns control. The account screen remains in the same browser throughout. The final operator page shows all five ownership transitions.

The recording's assertions verify:

- A competing Replay cannot act while the Operator owns the Session. Its [separate event log](competing-replay/events.jsonl) records `control_lost`.
- The Session observes both changed supervisor fields and records the confirmed action.
- The `open-account` Checkpoint holds after `intervention.resolve`.
- Replay returns available balance `2730.11 USD` and current balance `2905.60 USD`.
- Every event in the main run retains one Session ID, and its text contains none of the tested raw member or supervisor values.

The [receipt](receipt.json) contains source revision `146b9b3b0c8ee709db46b3baf1a0c390529c1779`, timestamps, ownership history, result and video hashes. The [main event log](run/events.jsonl) supports the recording. The recorded implementation matches all 182 files in the prior [tested source manifest](../2026-09-08-architecture/source-files.sha256). PR review later improved refusal diagnostics, avoided decoding fully redacted quoted text, and tightened tests. Further fixes kept supervisor demo diffs aligned with stored Artifacts and preserved full action text for privacy checks during learning. These changes did not change the handoff behavior shown here.

Review found that the original recorder could accept a missing return event or missing Session IDs. The saved evidence contains both. [verify.mjs](verify.mjs) requires a non-empty receipt Session ID, the same ID on every event, and a held account Checkpoint after an explicit return event. It also verifies that six altered evidence cases fail these checks. Run `bun evidence/verification/2026-09-08-handoff-video/verify.mjs` from the repository root. The original recording script remains unchanged to preserve its provenance.

Both browser recordings run at original speed and are aligned using page-creation timestamps. Labels and captions identify the views and describe assertions that passed during the run. The final frames are held briefly so the result can be read. No application state was fabricated. The uploaded MP4 was fetched and its SHA-256 matched the local file byte for byte. It has H.264 video and no audio.

This is explicitly synthetic data. Pixels are unredacted. The recording captures only the two browser pages, not the desktop. The operator token travels in request headers and appears in neither the video nor this receipt.

The exact recording and rendering scripts are retained as [record.mjs](record.mjs) and [render.py](render.py), with [captions](captions.ass). They ran from `.scratch/hil-video-v2/` at the repository root; their relative imports and output paths refer to that location. They are provenance snapshots, not new production commands. The raw browser captures remain local; the published MP4 is hosted as a GitHub attachment rather than committed as a binary.
