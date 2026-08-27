# One Recovery Ladder serves learning, escalation and Tenant drift

Discovering a new Business Outcome, discovering that a state permanently needs a person, and adapting a Capability to a Tenant whose UI differs all run through one escalation path: deterministic Replay, then Assisted Recovery, then Intervention, then Amendment. They look like three problems. They are one.

## Consequences

Tenant drift needs no detection mechanism of its own. It shows up as an ordinary Replay failure, and the ladder adapts to it doing its normal job, which answers per-tenant version drift better than a configuration file does. Tenant Overrides are therefore discovered and confirmed, never hand-written.
