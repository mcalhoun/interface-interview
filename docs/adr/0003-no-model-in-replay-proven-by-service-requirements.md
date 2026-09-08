# No model in deterministic Replay, checked by service requirements

The deterministic Replay engine requires Surface Adapter, Policy, Evidence and
Session services. Its type tests reject an added LanguageModel requirement, and
its evidence tests reject discovery decision events in an ordinary replay.

Optional assisted classification is a separate, explicit path. A supplied advisor
may internally call a model without exposing LanguageModel in the engine's own
service requirements. An assisted outcome is marked and its consultation has
separate evidence events. The default replay path has no such advisor.

## Consequences

The type signature checks a useful dependency boundary, but it does not prove
that arbitrary injected callbacks can never call a model. The guarantee for
ordinary replay rests on both that boundary and the tested production
composition. Evidence distinguishes deterministic execution from opt-in
assistance, so an assisted result cannot silently count as deterministic success.
