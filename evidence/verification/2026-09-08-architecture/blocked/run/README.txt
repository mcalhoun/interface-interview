EVIDENCE FOR RUN handoff-blocked
===================================

This run explicitly opted into unredacted screenshots over SYNTHETIC fixture data.

WHAT IS REDACTED
----------------
events.jsonl and every accessibility snapshot in it pass a scrub at the single
point where evidence is serialised. Values of these parameters were replaced:
  memberId

Discovery also removes goal terms from diagnostic text before the model's first
proposal, except terms explicitly approved by the caller's public vocabulary.
This protects names and credentials that the run never reaches a field to type.

Two further kinds of value are redacted as they are observed:

  * fields a screen showed that Policy calls personal -- a member's name, a tax
    id. These are nobody's parameter; they arrive as ordinary text off the
    application. The list of captions is declared and argued for in
    packages/policy/src/Sensitivity.ts, and it is a denylist: a personal field on
    a screen nobody has looked at yet is not covered until somebody adds it.
  * anything a person typed into the live application during an Intervention. A
    supervisor id or an override code is a credential no Capability declared.
    Nobody is asked to retype these: the paused session watches the screen it
    handed over -- the value a control is holding, and the query string a
    submitted form produced -- and registers what changed. Registration happens
    before the event that would first quote the value, so the note an operator
    writes about what they did is redacted too. The intervention.observed events
    in events.jsonl name the fields this happened for.

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

Sensitivity policy: deny-first, with 2 reviewed exception(s): member.account-balance.accountType, member.account-balance.discovered.accountType

WHAT IS NOT REDACTED
--------------------
Screenshots are NOT redacted. PNG files are stored as captured under the explicit synthetic-data exception. They can contain rendered identifiers and balances.

Pixel redaction is not implemented. ADR-0010 permits unredacted fixture proof;
it does not establish that screenshots of an external application are safe.

See docs/adr/0010-evidence-screenshots-are-not-redacted.md.
