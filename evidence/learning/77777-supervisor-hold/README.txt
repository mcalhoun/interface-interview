A capability learning that a state permanently needs a person
=============================================================

Member 77777's savings account sits under a supervisor hold. Everything up to
the last screen behaves exactly as it does for an ordinary member; the panel
inside the iframe then says ACCOUNT RESTRICTED - SUPERVISOR AUTHORIZATION
REQUIRED, and the figures the capability came for are not on the page at all.

Nothing about that is broken, and nothing about it is a domain answer either.
Getting past it takes *authority*, not perception: no longer wait, no cleverer
selector and no model reading the screen resolves it. Somebody with a supervisor
id and an override code has to say so.

Read this beside evidence/learning/88888-checking-only/. Same mechanism, same one
question, opposite lessons — and the two diffs side by side are the point.


The five files
--------------

intervention-run.events.jsonl
    One replay of 77777 at 1.1.0, attended. Read it in order:

      - `checkpoint` at `open-account` — verdict `failed`. The action landed on
        exactly the right account; the balance cell is simply not there.
      - `intervention.raise` — and note what it says. "expected exactly one cell
        labelled Available Balance; observed nothing matched". That is the whole
        of what the system could tell the operator before it had met this state:
        a diagnosis to perform.
      - two `intervention.human_action` events. The first is r.mensah taking
        control. The second is what they *did* — "entered supervisor override
        for SUP-HOLD-02" — and it is the second one that carries the meaning.
        Ticket 13's episode has no equivalent, because that operator changed
        nothing, and that difference is the entire classification (ADR-0004).
      - `intervention.resolve` — control handed back with two separate answers:
        `classification: "resolved"` (this run CAN carry on, because a person
        acted) and `nextTime: "always_stop_here"` (the answer to the one
        question). One field could not have carried both.
      - `checkpoint` at `open-account` again — `held`. The balances rendered.
      - `run.end` — `success`. The run finished, and it finished because a
        person with authority was there. That is what makes the lesson worth
        learning rather than obvious.

intervention-run.final.png
    The screen at the end of that run: the balances, with the line "Restriction
    SUP-HOLD-02 overridden by supervisor ..." beneath them, naming the id the
    supervisor typed. The events file renders that id as
    [redacted:supervisorId], because an operator credential is registered with
    the scrubber before it is typed, so this file does not repeat it either.

1.1.0-to-1.2.0.diff
    What that episode taught the capability. Two hunks, and the striking thing
    about it is what is NOT in it:

      - the version number;
      - a new `requiresHuman:` section with one entry, keyed by a code derived
        from the step, naming the step, and carrying a `discoveredFrom` that
        names the intervention id, the session, the run, who held it, HOW MANY
        ACTIONS THEY RECORDED and what they were, and the question they were
        asked.

    Every removed line in the whole diff is `-version: 1.1.0`. Nothing else was
    taken away and nothing else was changed: no step, no target, no bound, no
    declared outcome. Learning that a state needs a person adds a place the run
    must stop and removes nothing — it never learns to proceed.

    Compare with 88888's diff, which turns `escalate: NO_MATCHING_ITEM` into
    `outcome: NO_MATCHING_ITEM`. That one made an unattended run finish where it
    used to stop. This one makes a run that already stopped stop *better*.

after-learning.events.jsonl
    The same member, replayed again, unattended, at the learned version.

      - the same four steps, and `open-account`'s checkpoint still `failed` —
        because the screen is unchanged and the automation still cannot read a
        balance that is not there. Nothing was learned about the screen.
      - NO `intervention.*` event of any kind. Nobody was paused and nobody was
        summoned: there was nobody there. An Intervention is an episode in which
        a person takes the session, and no episode happened.
      - NO `recovery.*` event. Every declared rule looked once, recognised
        nothing, and the classified entry answered instead of a person having to.
      - `run.end` — `intervention_required (OPEN_ACCOUNT_REQUIRES_HUMAN)`, with
        the reason "A person with authority is required: Open the account the
        caller asked for, whichever of them that is."

    Before the amendment the same unattended run said `failure` /
    `checkpoint_failed`, which in this system's taxonomy means "the automation is
    broken, page someone". Now it says "a person is required", under a code a
    caller routes on. That is the routing half of SPEC's "fail fast with the
    right reason and routing".

after-learning.final.png
    The screen the run stopped on. The supervisor hold, exactly as it was.


What is actually faster, and what is not
----------------------------------------

Honest accounting, because the phrase "fail fast" invites the wrong reading.

The checkpoint's own bound is still waited out — about 2.5 seconds, visible as
`waitedMillis` on the `checkpoint` event. It has to be. Member 55555's balance
panel is genuinely late at this same step, and a run that stopped waiting because
the document had classified something would have traded a real recovery for the
appearance of speed.

Every declared recoverable condition still gets its one look, for the same
reason: a mid-flow session expiry strands a run at exactly this step, and
`SESSION_EXPIRED` still recognises it, still signs back on, and still finishes
unattended at 1.2.0. There is a test on precisely that.

What the classification removes is the *diagnosis*. Before: a generic escalation,
and a person working out from an expected/observed pair what they are looking at.
After: the sentence somebody who already solved this wrote down, under a code,
with the diagnostic still attached underneath — and, unattended, the difference
between "route this to a person" and "page an engineer".


The rule that only tightens
---------------------------

The entry is write-once. There is no answer, no operator and no number of
repetitions that turns it back into a business outcome:

  - `classificationOf` reads `requiresHuman:` before `outcomes:`, so the ratchet
    sees the stricter classification first;
  - `declareLearnedNoMatch` refuses when `atLeastAsStrictAs("business_outcome",
    "requires_human")` is false, which it always is;
  - `parseArtifact` refuses a document that files one code under both sections,
    so the downgrade cannot be spelled by hand either.

A test attempts the downgrade a hundred times, with an episode of exactly the
shape that DID teach 88888 a business outcome, and is refused a hundred times.
Frequency is not evidence of safety.

The other half of the guarantee is upstream of all that, in `classify`: an
operator who recorded actions on the live session cannot produce
`business_outcome` from ANY answer to the one question. The declarable half of
the classification comes from behaviour the system recorded without asking, which
is what makes it unfakeable by radio button.


Reproducing it
--------------

The whole arc, with a person:

    # 1. Before the amendment, unattended: a hard failure, and a generic one.
    bun run replay member.account-balance --memberId 77777 --version 1.1.0

    # 2. Attended, in a visible browser. Take control at the printed URL, fill
    #    Supervisor ID (any) and Authorization Code (any four digits) in the
    #    live window, press Authorize, note what you did, and hand control back
    #    answering "always stop here" to the one question. A new version is
    #    written and the diff is printed.
    bun run replay member.account-balance --memberId 77777 --version 1.1.0 \
      --handoff --headed

    # 3. After. Unattended, nobody involved.
    bun run replay member.account-balance --memberId 77777

Step 2 will refuse to write 1.2.0 a second time — artifacts are immutable, and an
amendment is a new file rather than an edit. Pass `--amendTo 1.4.0` to watch it
produce another one, or `--noAmend` to drive the handoff without cutting a
version.

The files in this directory were not produced by step 2, and that is worth being
straight about. Releasing the hold means acting in the live browser window, and
there was no person available to do it in the environment this was built in. So
they came from `test/support/drive-the-supervisor-hold.ts`, which is step 2 with
a scripted operator and everything else real: one Heritage Core, one Chromium,
one Session, the shipped policy, the operator interface over HTTP, the real
evidence writer with the real scrubber. The "person" fills the two fields and
presses Authorize in the automation's own browser window, which is what ADR-0009
says a handoff is. Rerun it with:

    bun run test/support/drive-the-supervisor-hold.ts


What this is not
----------------

It is not "77777 is a requires-human member". What was declared is a *state* —
the checkpoint at one step not holding — and not a member. The same member's
checking account, which carries no hold, still returns its balance at 1.2.0:

    bun run replay member.account-balance --memberId 77777 --accountType Checking

And it is not "this capability escalates more now". Every other member behaves
exactly as it did: 12345 succeeds, 99999 returns MEMBER_NOT_FOUND, 88888 returns
the business outcome learned at 1.1.0, 33333 is still a hard failure naming both
candidates, and a session expiry still recovers unattended.


Redaction
---------

Synthetic data throughout: these are demo artifacts over a mock application, and
no real member data exists anywhere in this system.

The member number is a declared sensitive input, so it appears nowhere in either
events file, nowhere in the diff, and nowhere in the stored 1.2.0 — `grep 77777`
over all of them returns nothing, and `[redacted:memberId]` appears where the
application rendered it back at us. `intervention-run.README.txt` is the
redaction note that run wrote for itself, unedited.

The amendment is held to the same rule by the same mechanism: the finished
document passes through the run's own evidence scrubber before it is returned,
and an amendment that would carry a sensitive value is refused — with a message
that does not repeat what it found. Which is why the operator's own sentence,
quoted verbatim in the 1.2.0 summary, does not contain the member number.

The screenshots are not pixel-redacted. That is a stated limit rather than a
half-solved problem; SPEC names it, and screenshots go only to /evidence. See
docs/adr/0010-evidence-screenshots-are-not-redacted.md.
