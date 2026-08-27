# Evidence screenshots are not redacted

We redact sensitive values from event logs and accessibility snapshots at the single point where Evidence gets serialised. Screenshots we store as captured, so they contain rendered member identifiers and balances.

## Consequences

Screenshot redaction is a stated limit rather than a solved problem. Doing it properly means masking known values under optical recognition, which is more than this job needs. So screenshots go only to the evidence directory, over synthetic data, and the gap is written down where a reviewer will find it. Naming the limit is the honest position. Implying that pixels are protected would not be.
