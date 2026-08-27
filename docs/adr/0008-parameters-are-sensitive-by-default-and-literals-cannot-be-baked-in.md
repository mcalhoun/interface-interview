# Parameters are sensitive by default, and Goal literals cannot be baked in

Every parameter discovered from a Goal counts as sensitive unless Policy allowlists it otherwise. Artifact compilation fails outright if a value marked as fixed matches text from the Goal.

## Consequences

We never ask a model to judge what counts as PII in regulated financial data. "Capability Artifacts contain no runtime values" stops being a claim in a README and becomes something the compiler enforces. The cost is the occasional false positive on a genuinely fixed value that happens to echo the Goal, and we take that trade happily. A rejected artifact is a much better failure than a leaked member identifier.
