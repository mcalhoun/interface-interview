# Assisted Recovery may classify, but never act

When Replay cannot resolve a step, one bounded consultation of a model is allowed before an Operator gets involved. Its toolkit contains no acting operations at all. It returns a proposed meaning, a confidence and a rationale, and nothing else.

## Consequences

A hallucination cannot cause an unintended action on a banking system, because acting is not representable. Confident classifications return an outcome to the caller straight away, so nobody is paged for something the system can work out on its own. Promoting that proposal into a Capability Artifact still needs human confirmation, so a model can never silently alter a Capability. That is what keeps "no model in the production decision loop" (ADR-0003) literally true while still avoiding pointless escalations.

An assisted outcome is still an outcome a model chose, so the result carries an explicit assisted marker, its confidence, and a reference to the proposal in Evidence. A caller can always tell a deterministic answer from a proposed one, and an assisted result never counts as deterministic for reliability purposes. Assisted Recovery also emits its own Evidence event kinds rather than reusing Discovery's, so a model consulted during Replay cannot hide behind a Discovery-shaped record.
