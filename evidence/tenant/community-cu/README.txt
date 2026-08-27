One capability, two institutions running the same vendor product.

Produced by: bun run test/support/drive-the-tenant-override.ts
Base capability: member.account-balance@1.2.0, unchanged by any of this.

SPEC's second-tenant table, and what each row actually cost:

  Member # rather than Member Number     absorbed, no override
  Regular Savings / Share Draft          absorbed, no override
  no iframe on account detail            absorbed, no override
  the submit button reads Find           ONE confirmed override

01-before.events.jsonl
  The base document against community-cu with nothing configured. The first two
  steps hold — the shortened field caption is absorbed by token matching on the
  accessible name — and the run fails with target_missing on the submit control.
  That is tenant drift being detected: an ordinary replay failure, by the same
  mechanism as everything else (ADR-0006).

02-onboarding.events.jsonl
  The same run attended, with assisted recovery on. assist.request, a policy.check
  for assist, then assist.target_proposal naming Find at confidence 0.90. Nothing
  was pressed: the run paused, a person read the proposal and confirmed it, and the
  intervention.resolve event carries confirmProposal=confirmed.

  The model's judgement here is scripted. See NO-MODEL-DROVE-THIS.txt.

03-after.events.jsonl
  community-cu again with the confirmed delta in force. The override.applied event
  at the top of the log says which document executed. Success, both balances read.

04-heritage-core.events.jsonl
  The same base document, unchanged, against the first institution. Success. No
  override.applied event, because there is no delta: nothing about onboarding the
  second tenant touched the first.

The equivalent commands a person runs:

  bun run replay member.account-balance --memberId 12345 --tenant community-cu
  bun run replay member.account-balance --memberId 12345 --tenant community-cu --assist --handoff --headed
  bun run replay member.account-balance --memberId 12345 --tenant community-cu
  bun run replay member.account-balance --memberId 12345
