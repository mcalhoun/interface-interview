# Outcome classification is derived from human behaviour

Whether an unfamiliar state is a Business Outcome, a Recoverable Condition or a Requires-Human Outcome comes from what an Operator actually had to do to resolve it. Nothing at all, something reversible, or something requiring authority. It does not come from a configuration file naming known states in advance.

## Considered options

Pre-declaring in Policy that supervisor authorization needs a human is simpler, and we rejected it. It smuggles the answer in as configuration, so the system discovers nothing, and any state nobody thought of stays unclassifiable.

## Consequences

Requires-Human Outcomes are write-once. No later Intervention can downgrade one to a Business Outcome, so seeing a privileged decision a hundred times never turns it into an automated one. Learning that a state needs a person makes Replay fail fast with the right reason and routing. It never makes the state automatable.

The evidence must support that classification. An empty operator action list or a note saying "nothing changed" cannot establish that no manual interaction occurred. Before promoting a Business Outcome, the handoff must establish that observation alone sufficed; before resuming a resolved workflow, the executor verifies its expected state. An unverified return does not justify an unattended amendment.

A compiled discovery may also preserve an unrecorded manual dependency, explicitly marked `basis: discovery_intervention` under ADR-0012. This records what automation has not demonstrated; it does not infer domain authority from a handoff alone.

Amendment requires an executor-supplied failure cause bound to the same capability, version and step. A checkpoint failure after a selection is not evidence that the selection found no match. Older intervention records without this cause remain historical evidence and cannot authorize a new learned rule.
