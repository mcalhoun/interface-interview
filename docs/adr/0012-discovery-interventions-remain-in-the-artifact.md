# Discovery interventions remain in the artifact

A successful discovery can depend on work performed by an Operator. Recording only the model's actions would make an incomplete artifact appear ready for unattended replay.

The trajectory retains every resumed intervention boundary, identified by the preceding recorded step and the intervention ID. An empty action list cannot prove that the person did nothing. The compiler records a `requiresHuman` declaration with `basis: discovery_intervention` and a checkpoint for the next recorded action's required state. If no subsequent observable action exists, compilation refuses until discovery supplies that evidence.

Replay executes the recorded action. If the post-intervention checkpoint already holds, it proceeds normally. Otherwise it routes the same live session to a person and verifies that checkpoint after return. It never invents or repeats unrecorded human actions.

## Relationship to learned authority

A discovery dependency means that automation has not demonstrated the missing work. It does not assert that the banking action requires special authority. The explicit basis distinguishes it from the authority classification derived under ADR-0004. Both preserve a human boundary and cannot silently become an unattended business outcome.

This reuses the existing checkpoint and session interfaces. It adds no browser-specific action, coordinate recording, or model decision to replay. Real-browser tests cover interventions after a fill and after a click, unattended routing, and completion after a second operator performs the required work.
