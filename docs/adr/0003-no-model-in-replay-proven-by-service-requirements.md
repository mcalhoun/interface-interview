# No model in Replay, proven by service requirements

Replay must never consult a model, and we prove it structurally rather than by convention. The Replay engine's effect requires only the Surface Adapter, Policy, Evidence and Session services, so any code path reaching for the language model fails to compile. A second check over Evidence files confirms no decision event appears in a Replay run.

## Consequences

The guarantee cannot rot. A sentence in a README, a runtime assertion, an unset environment variable: each of those survives someone adding a model call six months from now. A type error does not. This is the concrete reason ADR-0002 was worth its cost.
