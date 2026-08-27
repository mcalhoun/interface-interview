# Effect 4 (release candidate) as the application framework

We build on `effect@4.0.0-rc.112` rather than the stable 3.x line. The 4.x monopackage carries the model-provider abstraction, CLI, HTTP and schema support in one dependency, and its `Redacted` type is core, so sensitive-value handling and provider-agnosticism become properties of the framework instead of things we write.

## Consequences

Docs are thin and model recall of the API is unreliable. Implementation has to check the shipped type definitions rather than trust memory, and some API usage will be wrong before it is right. What makes it worth the friction is ADR-0003: service requirements turn into machine-checked proof that no model runs in the production path. No other stack we considered offers that.
