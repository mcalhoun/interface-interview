What is in here, and what is not
================================

Every run of this system writes one directory of Evidence: an `events.jsonl`
validated against a schema on write, a screenshot, and a `README.txt` stating
what was redacted and what was not. `/evidence` is gitignored because day-to-day
runs would otherwise fill the tree. Four sets are committed anyway, with
`git add -f`, because they are deliverables:

  discovery/scripted-model-no-llm-drove-this/
      A discovery run: the real loop, a real Chromium, the real Heritage Core
      fixture, the shipped policy, the real evidence writer. Read
      NO-MODEL-DROVE-THIS.txt first. The model's judgement is scripted, because
      the OPENAI_API_KEY in this environment is revoked (HTTP 401 against
      api.openai.com/v1/models). `artifacts/member.account-balance.discovered/`
      was compiled from the trajectory here.

  learning/
      The centrepiece. Two interventions, one mechanism, opposite conclusions.
      Start with learning/README.txt, then read the two diffs side by side.

  tenant/community-cu/
      Onboarding a second institution running the same vendor product. Four
      runs: the base document failing, the ladder producing a proposal, a person
      confirming it, and the same capability succeeding at both institutions.
      The consultation's judgement is scripted; see NO-MODEL-DROVE-THIS.txt.

  assist/
      The assisted rung, with and without. Same run, same screen, and the
      difference between a state a capability stops on and one it can answer.
      Scripted the same way, labelled the same way.

`bun run demo` writes everything it produces under `demo/`, which it clears
first. It never writes to the four directories above.

Screenshots are NOT redacted
----------------------------

Text evidence, meaning the accessibility snapshots and the event log, is scrubbed
at the single point where an event is serialised. Three kinds of value go:

  * this run's own declared sensitive parameters, known before it started;
  * fields a screen showed that Policy calls personal -- a member's name, a tax
    id. Nobody passed those in, so no declaration covers them; the captions are
    declared in packages/policy/src/Sensitivity.ts, which also argues for why
    that list is a short denylist rather than all screen text;
  * anything an Operator said they typed into the live application while holding
    the session. A supervisor override code is a credential no capability
    declared, and the operator interface asks for it so the scrubber can be told.

Screenshots are stored as captured, so they render member numbers, member names
and balances in the clear. That is a stated limit rather than an oversight; see
docs/adr/0010-evidence-screenshots-are-not-redacted.md. Everything here is
synthetic data against a mock application.

The scrub is field-blind and matches by literal occurrence, so it cuts across
identifiers: Heritage Core's account number embeds the member number, and the
evidence reads `00000[redacted:memberId]-S01`. A run supplying the operator
password `HERITAGE` renders the application's own banner as
`[redacted:operatorPassword] CORE`. Both are the design working. Illegible
evidence is recoverable; a leaked identifier is not.

Two placeholder spellings, and they mean different things
---------------------------------------------------------

  [redacted:memberId]    the characters were found in text that came off the
                         screen and were taken out. This is the scrubber.

  <redacted:memberId>    a value we were holding was serialised, and the
                         Redacted type stopped it. Nothing leaked.
