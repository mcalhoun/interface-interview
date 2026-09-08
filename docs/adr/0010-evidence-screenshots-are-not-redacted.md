# Evidence screenshots are not redacted

Text evidence passes through the run's scrubber. Screenshot pixels are stored
as captured when explicitly enabled, and can contain member identifiers and
balances. Pixel masking is not implemented.

## Default and synthetic exception

EvidenceWriter disables binary attachments by default. A caller must explicitly
set `allowUnredactedScreenshots: true` to enable the synthetic-data exception.
The built-in fixture commands and demo opt in because their data is synthetic.
Commands targeting an external `--baseUrl` do not opt in; they retain scrubbed
accessibility evidence without persisting screenshot bytes.

## Consequences

The default prevents accidental binary persistence. Opt-in does not redact
pixels or establish that an external application contains safe data. A deployment
must verify masking before enabling screenshots over real records. Passing a
text-evidence scan is not evidence that enabled screenshots are safe.
