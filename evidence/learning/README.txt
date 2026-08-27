The same mechanism learning two opposite lessons
================================================

One question, asked once, of the person who just resolved a state: "Next time
automation meets this state, should it handle it itself?"

One amendment mechanism, which can write exactly two shapes of change and
nothing else. One ratchet, which only ever tightens. Two directories here, and
between them the whole argument for why a system like this can be allowed to
change its own capabilities.

  88888-checking-only/
      Member 88888 holds a checking account and no savings account. An operator
      met the state, looked at it, and CHANGED NOTHING. That is the evidence
      it is terminal and observational, so v1.1.0 declares it a Business
      Outcome: the run that used to stop now answers, unattended, and exits 0.

          -      escalate: NO_MATCHING_ITEM
          +      outcome: NO_MATCHING_ITEM

  77777-supervisor-hold/
      Member 77777's savings account is held pending supervisor authorization.
      An operator met the state and RESOLVED IT BY ACTING — a supervisor id, an
      override code, Authorize. That is the evidence it takes authority rather
      than perception, so v1.2.0 declares it a state automation must never
      handle itself: the run still stops, but now under a code, with the
      sentence somebody who already solved it wrote, routed to a person instead
      of reported as breakage.

          +requiresHuman:
          +  OPEN_ACCOUNT_REQUIRES_HUMAN:
          +    step: open-account

Read the two diffs side by side. They are the same mechanism, given the same
question, arriving at opposite conclusions — and what separates them is not the
answer. It is what the person did before answering.

The answer alone could not have separated them, and this is the part worth
dwelling on. Both operators were asked one question. What made 88888 declarable
and 77777 permanent is a fact the system recorded without asking anybody: whether
the intervention's `actions` list is empty. An operator who had to act cannot
produce a Business Outcome from any answer at all, so the direction that costs a
person forever is reachable by a radio button and the direction that makes a run
unattended is not.

Neither direction is reversible downward. A requires-human entry is write-once:
no later intervention downgrades one, however many times somebody resolves it,
because frequency is not evidence of safety. See the last section of
77777-supervisor-hold/README.txt for the three places that is enforced.

docs/adr/0004-outcome-classification-is-derived-from-human-behaviour.md is the
decision both of these are an instance of.
