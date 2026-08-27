A capability learning its own domain contract
=============================================

Member 88888 exists and holds a checking account. It holds no savings account,
so the row `member.account-balance` came for is simply not on the screen. That
looks exactly like breakage and is not: the UI is fine, the account list rendered
in full, and the domain said no.

Nothing on the page tells those two apart. That is the point. The difference is
not perceivable, so it cannot be inferred by a cleverer selector or a model
reading the screen — it has to be learned from what a person did when they met
it.

These files are one real run of that, in a real browser, plus the run that came
after it. Both were produced by the commands below with nothing edited by hand
afterwards.


The four files
--------------

intervention-run.events.jsonl
    The first replay of 88888, attended. Read it in order:

      - `action` / `checkpoint` events for the first three steps, all held
      - `intervention.raise` at `open-account` — the selection read the live
        list, found one link ("Checking"), and nothing in it carried every token
        of the account type asked for. The run stopped and asked for a person
        rather than reporting a hard failure.
      - `intervention.human_action` — j.okafor took control. Exactly one of
        these, and it is the taking. There is no second one, because the
        operator did not do anything, and *that is the evidence the state is
        terminal and observational* (ADR-0004).
      - `intervention.resolve` — control handed back, carrying two separate
        answers: `classification: "unresolved"` (this run cannot continue —
        there is no savings account for anyone to conjure into existence) and
        `nextTime: "automation_handles_it"` (the answer to the one question the
        operator interface asks).
      - `run.end` — `intervention_required`. Not a failure. A person was needed
        and a person came; nothing was produced, and nothing is broken.

intervention-run.final.png
    The screen the operator was looking at. One account row.

1.0.0-to-1.1.0.diff
    What that episode taught the capability. Three hunks:

      - the version number;
      - a new `outcomes:` entry, whose `discoveredFrom` names the intervention
        id, the session, the run, the step, who held it, that they recorded no
        actions, and the question they were asked;
      - `escalate: NO_MATCHING_ITEM` becoming `outcome: NO_MATCHING_ITEM`.

    That last pair of lines is the whole of what was learned. The code did not
    change — the artifact's author had already named this state — and what
    changed is its *classification*: from "we do not know what this means, stop
    and ask somebody" to "this is the application answering". Renaming it at
    intervention time would have let whoever was on shift redefine a
    capability's contract, which is the thing ADR-0004 exists to refuse.

    Both sides of the diff are rendered by the same formatter, so it is a diff
    of what the two versions *mean* rather than of how they are laid out. The
    stored 1.0.0 carries a lot of comment prose that YAML parsing drops, and
    diffing the two files would have buried these lines under all of it.

after-learning.events.jsonl
    The same member, replayed again, unattended, immediately afterwards. No
    `intervention.*` event of any kind. `open-account` reaches
    `outcome: NO_MATCHING_ITEM`, the two reading steps are `not_reached`, and
    `run.end` says `business_outcome`. The CLI exits 0.

    There is no `action` event for `open-account` in this file, and there should
    not be: nothing was pressed, no target was resolved, and Policy was never
    asked, because there was nothing to ask about.


Reproducing it
--------------

    # 1. Before the amendment: nobody watching, so it is a hard failure.
    bun run replay member.account-balance --memberId 88888 --version 1.0.0

    # 2. Attended. Take control at the printed URL, change nothing, hand it
    #    back answering "yes" to the one question. A new version is written and
    #    the diff is printed.
    bun run replay member.account-balance --memberId 88888 --version 1.0.0 \
      --handoff --headed

    # 3. After. Unattended, nobody involved, exits 0.
    bun run replay member.account-balance --memberId 88888

Step 2 will refuse to write 1.1.0 a second time — artifacts are immutable, and
an amendment is a new file rather than an edit. Pass `--amendTo 1.3.0` to watch
it produce another one, or `--noAmend` to drive the handoff without cutting a
version.

The files in this directory were not produced by step 2, and that is worth being
straight about. There was nobody at the keyboard in the environment this was
built in, so they came from `test/support/drive-the-checking-only-outcome.ts`,
which is step 2 with a scripted operator and everything else real: one Heritage
Core, one Chromium, one Session, the shipped policy, the operator interface over
HTTP, the real evidence writer with the real scrubber. The "person" takes
control, does nothing, and hands it back answering the one question. Rerun it
with:

    bun run test/support/drive-the-checking-only-outcome.ts

`1.0.0-to-1.1.0.diff` is rendered from the two versions on disk rather than from
that run's own proposal, and the driver says so when it writes it. The shipped
1.1.0 was cut by an earlier episode and an Artifact store is immutable, so a
re-run cannot replace it and should not print a diff no stored document matches.
What the driver does check is that the same episode still classifies the same
way: it runs the amendment mechanism over its own intervention and prints the
class it learned.


What this is not
----------------

It is not "88888 is a business outcome". The amendment declared a *state* — a
selection that matched nothing at that step — and not a member. Asking the same
member for the account they do hold still returns a balance:

    bun run replay member.account-balance --memberId 88888 --accountType Checking

And it did not make the capability more forgiving in general. Two accounts both
matching is still a hard failure that names both, at the learned version as
before it, because SPEC allows only one of the two selection failures to be
learned and the schema has no spelling for the other.

Redaction
---------

Synthetic data throughout: these are demo artifacts over a mock application, and
no real member data exists anywhere in this system.

The member number is a declared sensitive input, so it appears nowhere in either
events file — `grep 88888` on them returns nothing, and `[redacted:memberId]`
appears where the application rendered it back at us. `intervention-run.README.txt`
is the redaction note the run wrote for itself, unedited.

The amendment is held to the same rule, by the same mechanism: the finished
document is passed through the run's own Evidence scrubber before it is
returned, and an amendment that would carry a sensitive value is refused — with
a message that does not repeat what it found. Which is why the operator's own
sentence, quoted verbatim in the 1.1.0 summary, does not contain the member
number.

The screenshot is not pixel-redacted. That is a stated limit rather than a
half-solved problem; SPEC names it, and screenshots go only to /evidence.
