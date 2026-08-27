/**
 * A `SurfaceAdapter` backed by Playwright and Chromium.
 *
 * Two things are worth knowing before changing anything here.
 *
 * First, the only observation call is `page.ariaSnapshot({ mode: "ai" })`.
 * `page.accessibility.snapshot()` was removed from Playwright and does not
 * exist. The `ai` mode earns its keep twice over: it tags each node with a
 * `[ref=...]` accessibility handle, and it inlines the contents of iframes, so
 * Heritage Core's unnamed Account Detail frame is simply part of the tree.
 *
 * Second, acting happens through `aria-ref`, Playwright's own accessibility
 * handle, and nowhere else. There is exactly one call to `page.locator` in this
 * file and it can only ever be handed an `aria-ref`, which a test asserts. That
 * is what keeps "no selectors" a property of the code rather than a convention.
 * Refs are valid only for the snapshot that produced them, so every action takes
 * a fresh snapshot and resolves against it; a ref never outlives a call.
 */

import { Effect, Layer } from "effect"
import { type Browser, type Locator, type Page, chromium } from "playwright"
import {
  type ObservedNode,
  type TreeIndex,
  annotateFrames,
  formatAccessibilityTree,
  indexTree,
  nodeText,
  normalise,
  parseAccessibilityTree,
  withoutRefs
} from "./AccessibilityTree.ts"
import { type Resolution, readTextOf, resolveTargetIn } from "./resolution.ts"
import {
  type FrameDescriptor,
  type SurfaceCondition,
  type SurfaceState,
  type TargetResolution,
  type WaitOptions,
  SurfaceAdapter,
  SurfaceTimeout,
  SurfaceUnavailable,
  TargetAmbiguous,
  TargetNotFound,
  describeCondition
} from "./SurfaceAdapter.ts"
import { type Target, describeTarget } from "./Target.ts"

export interface PlaywrightSurfaceOptions {
  readonly headless?: boolean
  /** Opened as soon as the Surface comes up, so a caller starts somewhere. */
  readonly startUrl?: string
  /** Bound on a single Playwright interaction. Not the bound on `waitFor`. */
  readonly actionTimeoutMillis?: number
}

const MAIN_FRAME = "main"

/**
 * The only place a Playwright locator is constructed in this package.
 *
 * It takes an accessibility ref and nothing else. There is deliberately no
 * overload, no string parameter and no way to reach this with a selector.
 */
const nodeLocator = (page: Page, ref: string): Locator => page.locator(`aria-ref=${ref}`)

export const layer = (
  options: PlaywrightSurfaceOptions = {}
): Layer.Layer<SurfaceAdapter, SurfaceUnavailable> =>
  Layer.effect(
    SurfaceAdapter,
    Effect.gen(function* () {
      const actionTimeout = options.actionTimeoutMillis ?? 10_000

      const browser = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => chromium.launch({ headless: options.headless ?? true }),
          catch: (cause) =>
            new SurfaceUnavailable({ action: "launch", reason: String(cause) })
        }),
        (browser: Browser) => Effect.promise(() => browser.close())
      )

      const page = yield* Effect.tryPromise({
        try: async () => {
          const created = await browser.newPage()
          created.setDefaultTimeout(actionTimeout)
          return created
        },
        catch: (cause) => new SurfaceUnavailable({ action: "newPage", reason: String(cause) })
      })

      /** Wraps a Playwright promise so a browser failure is a typed one. */
      const attempt = <A>(action: string, run: () => Promise<A>) =>
        Effect.tryPromise({
          try: run,
          catch: (cause) => new SurfaceUnavailable({ action, reason: String(cause) })
        })

      const frameDescriptors = (): ReadonlyArray<FrameDescriptor> =>
        page.frames().map((frame, position) => ({
          name: position === 0 ? MAIN_FRAME : frame.name(),
          url: frame.url(),
          isMain: position === 0
        }))

      /**
       * One observation, kept in two forms: the indexed tree resolution needs,
       * and the ref-free Surface State a caller is allowed to see.
       */
      const snapshot = Effect.gen(function* () {
        const yaml = yield* attempt("observe", () => page.ariaSnapshot({ mode: "ai" }))
        const title = yield* attempt("observe", () => page.title())
        const frames = frameDescriptors()
        const named = annotateFrames(
          parseAccessibilityTree(yaml),
          frames.filter((frame) => !frame.isMain).map((frame) => frame.name)
        )
        const index = indexTree(named, MAIN_FRAME)
        const tree = withoutRefs(named)
        const state: SurfaceState = {
          url: page.url(),
          title,
          frames,
          tree,
          accessibility: formatAccessibilityTree(tree),
          observedAt: new Date().toISOString()
        }
        return { index, state } as const
      })

      const observe = snapshot.pipe(Effect.map((observation) => observation.state))

      /** Turns a resolution into either a node with its ref, or a typed failure. */
      const decide = (
        target: Target,
        resolution: Resolution
      ): Effect.Effect<
        { readonly node: ObservedNode; readonly report: TargetResolution },
        TargetNotFound | TargetAmbiguous
      > => {
        switch (resolution._tag) {
          case "NotFound":
            return Effect.fail(
              new TargetNotFound({
                target: describeTarget(target),
                rationale: resolution.rationale,
                considered: resolution.considered,
                remedy: resolution.remedy,
                ...(resolution.narrowedBy === undefined
                  ? {}
                  : { narrowedBy: resolution.narrowedBy })
              })
            )
          case "Ambiguous":
            return Effect.fail(
              new TargetAmbiguous({
                target: describeTarget(target),
                rationale: resolution.rationale,
                remedy: resolution.remedy,
                matches: resolution.matches
              })
            )
          case "Resolved":
            return Effect.succeed({
              node: resolution.node,
              report: {
                target,
                match: resolution.match,
                strategies: resolution.strategies,
                rationale: resolution.rationale,
                considered: resolution.considered,
                alternatives: resolution.alternatives
              }
            })
        }
      }

      const locate = Effect.fn("SurfaceAdapter.locate")(function* (target: Target) {
        const { index, state } = yield* snapshot
        const resolution = resolveTargetIn(index, target)
        const decided = yield* decide(target, resolution)
        return { ...decided, state } as const
      })

      const resolveTarget = Effect.fn("SurfaceAdapter.resolveTarget")(function* (target: Target) {
        const located = yield* locate(target)
        return located.report
      })

      /**
       * A ref only means something to the frame that produced it, and Heritage
       * Core navigates on every interaction, so hand the handle straight to
       * Playwright and never store it.
       */
      const actOn = Effect.fn("SurfaceAdapter.actOn")(function* (
        target: Target,
        action: string,
        run: (locator: Locator) => Promise<void>
      ) {
        const located = yield* locate(target)
        const ref = located.node.ref
        if (ref === undefined) {
          return yield* new TargetNotFound({
            target: describeTarget(target),
            rationale: "the accessibility tree offers no handle for that node",
            considered: located.report.considered,
            remedy:
              "that node describes the screen rather than being something to operate; " +
              "name the control itself"
          })
        }
        yield* attempt(action, () => run(nodeLocator(page, ref)))
        // Every transition in a system like this is a full page load, so settle
        // before reporting what the Surface now looks like.
        yield* attempt(action, () => page.waitForLoadState("load"))
        return yield* observe
      })

      const satisfied = (index: TreeIndex, condition: SurfaceCondition): boolean => {
        switch (condition._tag) {
          case "TargetPresent":
            return resolveTargetIn(index, condition.target)._tag === "Resolved"
          case "TargetAbsent":
            return resolveTargetIn(index, condition.target)._tag === "NotFound"
          case "TextPresent":
            return normalise(nodeText(index.root)).includes(normalise(condition.text))
          case "TextAbsent":
            return !normalise(nodeText(index.root)).includes(normalise(condition.text))
        }
      }

      const waitFor = Effect.fn("SurfaceAdapter.waitFor")(function* (
        condition: SurfaceCondition,
        waitOptions: WaitOptions = {}
      ) {
        const timeout = waitOptions.timeoutMillis ?? 10_000
        const interval = waitOptions.intervalMillis ?? 250
        // Counting attempts rather than reading a clock keeps the wait bounded
        // in a way a test can reason about.
        const attempts = Math.max(1, Math.ceil(timeout / interval))
        for (let round = 0; round < attempts; round += 1) {
          const { index, state } = yield* snapshot
          if (satisfied(index, condition)) return state
          if (round < attempts - 1) yield* Effect.sleep(interval)
        }
        return yield* new SurfaceTimeout({
          condition: describeCondition(condition),
          waitedMillis: timeout
        })
      })

      const adapter = SurfaceAdapter.of({
        navigate: Effect.fn("SurfaceAdapter.navigate")(function* (url: string) {
          yield* attempt("navigate", () => page.goto(url, { waitUntil: "load" }).then(() => undefined))
          return yield* observe
        }),

        observe,

        resolveTarget,

        click: (target) => actOn(target, "click", (locator) => locator.click()),

        fill: (target, value) => actOn(target, "fill", (locator) => locator.fill(value)),

        extract: Effect.fn("SurfaceAdapter.extract")(function* (target: Target) {
          const located = yield* locate(target)
          return readTextOf(located.node)
        }),

        waitFor,

        captureEvidence: Effect.gen(function* () {
          const state = yield* observe
          const screenshot = yield* attempt("captureEvidence", () =>
            page.screenshot({ fullPage: true })
          )
          return {
            capturedAt: new Date().toISOString(),
            state,
            screenshot: new Uint8Array(screenshot)
          }
        })
      })

      if (options.startUrl !== undefined) yield* adapter.navigate(options.startUrl)

      return adapter
    })
  )
