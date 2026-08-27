A language model drove this run
===============================

Produced by: bun run test/support/drive-the-discovery-run.ts
Model:       gpt-4.1, through @effect/ai-openai, over the OpenAI Responses API
Goal:        "Look up the savings account balance of member 12345"

The same run through the CLI, which does everything above except name its own
evidence directory — it uses a timestamp — and except replaying the document
afterwards:

    bun run discover "Look up the savings account balance of member 12345" \
      --model gpt-4.1 --emit member.account-balance.discovered

Nothing here is scripted. The judgement is a real model's, the browser is a
real headless Chromium, the application is the real Heritage Core fixture on
an ephemeral port, the policy is the shipped policies/default.yaml, and the
evidence was written by the real writer with the real scrubber.

What it shows
-------------

The loop reached the goal in 4 steps from a seven-word action vocabulary, and every
step in events.jsonl reads in the same order:

  decide        the model's proposal, with the rationale it gave for it
  policy.check  the chokepoint, before anything touched the browser
  action        what the adapter actually did, and how the Target resolved
  observe       the screen afterwards

3 proposal(s) were refused and corrected rather than ending the
run. Each is a `decide` event in the log, and each names what to change:

  fill (rejected): the intent quotes the value this run was given for memberId. The intent is copied into the stored capability word for word, so say what the step does without memberId in the sentence.
  click (rejected): nothing on the screen answers to button "Search" within table "Member Number Search". scoped to 0 table node(s). no region on this screen is headed that way: the regions this screen offers are "HERITAGE CORE Member Services", "Member Search", "Member Number Search", "Cross-Reference Lookup". Name one of those, or drop within and name the control on its own.
  succeed (rejected): the summary or an output description repeats what this run read at availableBalance. That is one run's answer, not the capability's: say what the output means and let the value come from the run that asks for it.

The model never saw a screenshot. Screenshots are captured per step and go to
this directory; what entered the prompt was the accessibility tree (ADR-0001).

What it produced
----------------

    artifacts/member.account-balance.discovered/1.0.0.yaml

compiled in the same process, and then replayed unedited by the engine that
has no model in it at all:

    availableBalance: 4182.55 USD

The whole chain is one run: a sentence, a live model, a trajectory, a compiled
document, and a deterministic replay of that document.

The word that was recorded
--------------------------

The goal says "savings". This institution's screen says "Primary Savings".
What the artifact records as the selection default is the goal's word, and the
matched label is reported but not recorded:

    default: "savings"   matched: "Primary Savings"

That is what lets the same document serve an institution labelling the account
"Regular Savings" with no override and no second artifact.

Redaction
---------

Discovery cannot know its sensitive values in advance — its only input is a
sentence, and which parameters exist is what the run is there to find out. So
a value is registered with the scrubber at proposal time, before the policy
check, before the action, and before the decide event that first quotes it.

grep for the member number over everything this run wrote — events.jsonl and
the writer's own redaction note, kept beside this file as
discovery-run.README.txt — returns nothing. It reads [redacted:memberId]
wherever the application rendered it back, including inside the account number
that embeds it.

It does appear in this file, twice: in the goal sentence and in the command that
reproduces the run. Those are words a person types, not values the system
recorded, and this file is a note rather than a record.

The screenshots are not redacted and render the member number and the balances
as captured. That is a stated limit rather than an oversight; see
discovery-run.README.txt beside this file, and ADR-0010.
