# Parameters are sensitive by default, and Goal literals cannot be baked in

Every parameter discovered from a Goal counts as sensitive unless Policy allowlists it otherwise. Artifact compilation fails outright if a value marked as fixed matches text from the Goal.

## Consequences

We never ask a model to judge what counts as PII in regulated financial data. "Capability Artifacts contain no runtime values" stops being a claim in a README and becomes something the compiler enforces. The cost is the occasional false positive on a genuinely fixed value that happens to echo the Goal, and we take that trade happily. A rejected artifact is a much better failure than a leaked member identifier.

The compiler needs the private Goal and discovered values to perform those checks, so it runs before that context is erased. Discovery may export a staged artifact envelope after the checks pass. A later compile command validates the staged artifact schema; it cannot repeat the private-data checks from a scrubbed diagnostic trajectory. The envelope marker records the producing workflow, but is neither a signature nor reviewer approval.

Known-value scrubbing is not a general secret detector. Screenshot pixels are outside that text boundary, as recorded in ADR-0010.

Entry query and fragment values are runtime inputs. Discovery registers URL credentials and values before logging, stores a required sensitive `entryPath` parameter without a default, and retains only the pathname in public entry metadata. Observed URL values and known screen or operator secrets join the same in-memory compiler gate. A later model-proposed navigation carrying private URL values is refused before execution; the model must use stable paths and visible controls. Very short private values can conservatively cause compilation refusal when they collide with otherwise harmless text.
