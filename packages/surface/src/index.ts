/**
 * The SurfaceAdapter service and its Playwright implementation.
 *
 * Observation is the accessibility tree only: no method returns markup and none
 * accepts a selector. See
 * docs/adr/0001-accessibility-tree-is-the-only-observation-channel.md.
 */

export type { AccessibilityNode } from "./AccessibilityTree.ts"
export {
  describeNode,
  formatAccessibilityTree,
  nodeText,
  normalise,
  ownText,
  parseAccessibilityTree,
  walk
} from "./AccessibilityTree.ts"

export type {
  AmbiguousTarget,
  LabelledValue,
  ListDescription,
  ListItem,
  OfferedControl,
  Resolution,
  ResolvedTarget,
  Selection,
  SelectionRequest,
  TargetMatch,
  TargetStrategy,
  UnresolvedTarget
} from "./resolution.ts"
export {
  controlsOfferedIn,
  describeMatch,
  isTokenSubsetOf,
  labelOf,
  labelledValuesIn,
  listItemsIn,
  readTextOf,
  regionOf,
  resolveTargetIn,
  selectFrom,
  selectFromTree,
  tokensOf
} from "./resolution.ts"

export type { Target, TargetScope } from "./Target.ts"
export { describeTarget, Target as TargetSchema, TargetScope as TargetScopeSchema } from "./Target.ts"

export type {
  FrameDescriptor,
  SurfaceAdapterService,
  SurfaceCondition,
  SurfaceEvidence,
  SurfaceState,
  TargetFailure,
  TargetResolution,
  WaitOptions
} from "./SurfaceAdapter.ts"
export {
  describeCondition,
  SurfaceAdapter,
  SurfaceCondition as SurfaceConditionSchema,
  SurfaceTimeout,
  SurfaceUnavailable,
  TargetAmbiguous,
  TargetNotFound,
  targetAbsent,
  targetPresent,
  textAbsent,
  textPresent
} from "./SurfaceAdapter.ts"

export type { PlaywrightSurfaceOptions } from "./PlaywrightSurface.ts"
export { layer as playwrightSurface } from "./PlaywrightSurface.ts"
