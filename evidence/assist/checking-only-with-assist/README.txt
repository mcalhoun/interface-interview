EVIDENCE FOR RUN checking-only-with-assist
=============================================

This is a demo artifact over SYNTHETIC data from the mock Heritage Core
application. No real member data exists anywhere in this system.

WHAT IS REDACTED
----------------
events.jsonl and every accessibility snapshot in it pass a scrub at the single
point where evidence is serialised. Values of these parameters were replaced:
  memberId

Two placeholders appear, and they mean different things:

  [redacted:<name>]   the literal value was found in text read off the screen
                      (an accessibility snapshot, a URL, a quoted control value)
                      and was taken out.
  <redacted:<name>>   a value the system was holding was serialised, and the
                      Redacted wrapper stopped it. Nothing leaked.

A placeholder can appear in the middle of a longer identifier — Heritage Core's
account number embeds the member number, so it reads 00000[redacted:memberId]-S01.
That is the substitution working, not a bug. Redaction is by literal occurrence,
with no minimum length and no attempt to guess field boundaries, because a rule
that skipped short or embedded matches would be a hole with a number on it.

Sensitivity policy: deny-first, with 1 reviewed exception(s): member.account-balance.accountType

WHAT IS NOT REDACTED
--------------------
Screenshots are NOT redacted. Every *.png in this directory is stored exactly as
captured, and they contain rendered member identifiers and account balances.
They do not pass the scrubber and nothing masks them.

This is a stated limit, not an oversight. Redacting pixels properly means
optical recognition of known values over a screenshot, which is a larger problem
than this system needs to solve, and a half-implementation that missed a
rendering would be worse than an honest gap: it would imply a protection that
was not there. So the limit is written down here, where someone looking at the
screenshot will see it, and the mitigation is that these files are over
synthetic data and stay in this directory.

See docs/adr/0010-evidence-screenshots-are-not-redacted.md.
