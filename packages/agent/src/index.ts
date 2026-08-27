/**
 * The Discovery agent: the one place in this system where a model drives.
 *
 * Given a Goal in a sentence and a place to start, it observes a live Surface,
 * decides one action, has that action checked by Policy, executes it, and
 * observes again — until the Goal is met or a stopping condition fires. What it
 * produces is a `Trajectory`, which ticket 11 compiles into a reviewable
 * Capability Artifact.
 *
 * Read in this order:
 *
 *   `Vocabulary.ts`   what the model may propose, and why the toolkit cannot act
 *   `Provenance.ts`   where a typed value came from, and the checks with teeth
 *   `Selection.ts`    the one mistake that would silently break multi-tenant reuse
 *   `Stuck.ts`        knowing when to stop, which matters as much as finishing
 *   `loop.ts`         observe -> decide -> check -> act
 *   `Trajectory.ts`   what ticket 11 reads
 *
 * Three claims this package is built to make checkable rather than assert:
 *
 *   - **No screenshots reach the decision loop** (ADR-0001). `prompt.ts` builds
 *     text and has no branch that could attach an image. Screenshots are captured
 *     every step and written to Evidence for a person.
 *   - **The provider is a Layer swap.** `provider.ts` is the only file that names
 *     OpenAI; the loop imports `LanguageModel` and nothing else.
 *   - **The toolkit is a vocabulary, not an executor.** Tool-call resolution is
 *     disabled and every handler dies, so a proposal reaches the Surface only
 *     through the Policy gate in `loop.ts`.
 */

export type { GoalDerivedValue, MistaggedValue, ProvenancedValue } from "./Provenance.ts"
export {
  ProvenancedValue as ProvenancedValueSchema,
  checkProvenance,
  describeProvenance
} from "./Provenance.ts"

export type { ProposedSelection, UnusableSelection } from "./Selection.ts"
export { checkSelection, matchedLabel } from "./Selection.ts"

export type {
  DiscoveryVerb,
  Proposal,
  SurfaceVerb,
  UndecodableProposal
} from "./Vocabulary.ts"
export {
  DISCOVERY_VERBS,
  SURFACE_VERBS,
  discoveryToolkit,
  discoveryTools,
  isSurfaceVerb,
  isUndecodable,
  proposalFrom
} from "./Vocabulary.ts"

export type { StuckBounds, StuckDetector, StuckObservation, StuckTrigger } from "./Stuck.ts"
export {
  DEFAULT_BOUNDS,
  STUCK_TRIGGERS,
  describeTrigger,
  escalated,
  normaliseForHashing,
  stateSignature,
  stuckDetector
} from "./Stuck.ts"

export type {
  DiscoveredOutput,
  DiscoveredParameter,
  DiscoveredSelection,
  DiscoveryConclusion,
  DiscoveryStep,
  StepOutcome,
  Trajectory
} from "./Trajectory.ts"
export { isCompilable, parameterNames } from "./Trajectory.ts"

export type { DiscoveredSecrets } from "./redaction.ts"
export { asSecret, discoveredSecrets } from "./redaction.ts"

export type { ObservationOptions, StepSummary } from "./prompt.ts"
export { SYSTEM_INSTRUCTIONS, decisionPrompt, observation } from "./prompt.ts"

// Note what is NOT re-exported: the OpenAI layer by name. A caller asks for a
// provider by name through `providerFor`, so `provider.ts` stays the only file in
// the workspace that names a vendor — which is what makes "switching providers is
// a Layer swap" a checkable claim rather than a description.
export type { ProviderName, ProviderOptions } from "./provider.ts"
export {
  API_KEY_VARIABLE,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  PROVIDER_NAMES,
  PROVIDERS,
  isProviderName,
  providerFor
} from "./provider.ts"

export type { DiscoveryOptions } from "./loop.ts"
export { DiscoveryFailed, discover } from "./loop.ts"
