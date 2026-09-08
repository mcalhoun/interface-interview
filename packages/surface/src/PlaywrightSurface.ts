/**
 * A `SurfaceAdapter` backed by Playwright and Chromium.
 *
 * Two things are worth knowing before changing anything here.
 *
 * First, the only observation call is `page.ariaSnapshot({ mode: "ai", timeout })`.
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
import { type Browser, type CDPSession, type Frame, type Locator, type Page, chromium } from "playwright"
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
  /** Deployment origin gate. Without one, only startUrl's origin is permitted;
   * without either option, every network origin is denied. */
  readonly authorizeOrigin?: (url: string) => boolean
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
      let deadlineAt: number | undefined
      const deadlineFailure = () => new SurfaceUnavailable({
        action: "deadline", reason: "surface operation deadline expired"
      })
      const operationTimeout = (): number => {
        const remaining = deadlineAt === undefined ? actionTimeout : deadlineAt - Date.now()
        if (remaining <= 0) throw deadlineFailure()
        // Playwright treats zero as unbounded, so never pass an exhausted budget.
        return Math.max(1, Math.min(actionTimeout, remaining))
      }

      const browser = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => chromium.launch({ headless: options.headless ?? true }),
          catch: (cause) =>
            new SurfaceUnavailable({ action: "launch", reason: String(cause) })
        }),
        (browser: Browser) => Effect.promise(() => browser.close())
      )

      const startOrigin = (() => {
        try {
          return options.startUrl === undefined ? undefined : new URL(options.startUrl).origin
        } catch {
          return undefined
        }
      })()
      const authorized = (url: string): boolean => {
        try {
          const parsed = new URL(url)
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
          return options.authorizeOrigin?.(url) ??
            (startOrigin !== undefined && parsed.origin === startOrigin)
        } catch {
          return false
        }
      }
      let boundaryFailure: SurfaceUnavailable | undefined
      const refuse = (url: string): SurfaceUnavailable => {
        let origin = "an originless document"
        try {
          origin = new URL(url).origin
        } catch { /* Keep the safe description. */ }
        boundaryFailure ??= new SurfaceUnavailable({
          action: "authorizeOrigin", reason: `browser origin policy denied ${origin}`
        })
        return boundaryFailure
      }

      const navigationSessions = new Set<CDPSession>()
      const loadingFrames = new Set<string>()
      const loadChanged = new Set<() => void>()

      const page = yield* Effect.tryPromise({
        try: async () => {
          const context = await browser.newContext({ serviceWorkers: "block" })
          const watched = new Map<Frame, Promise<void>>()
          const watchFrame = (frame: Frame): Promise<void> => {
            const existing = watched.get(frame)
            if (existing !== undefined) return existing
            const watching = (async () => {
              const session = await context.newCDPSession(frame).catch(async (cause: unknown) => {
                const parent = frame.parentFrame()
                if (
                  parent !== null && cause instanceof Error &&
                  cause.message.includes("part of the parent frame's session")
                ) {
                  await watchFrame(parent)
                  return undefined
                }
                throw cause
              })
              if (session === undefined) return
              navigationSessions.add(session)
              session.on("Page.frameRequestedNavigation", ({ frameId, disposition }) => {
                if (disposition === "currentTab") loadingFrames.add(frameId)
              })
              session.on("Page.frameStartedLoading", ({ frameId }) => {
                loadingFrames.add(frameId)
              })
              session.on("Page.frameStoppedLoading", ({ frameId }) => {
                loadingFrames.delete(frameId)
                for (const changed of loadChanged) changed()
              })
              session.on("Page.frameDetached", ({ frameId, reason }) => {
                if (reason === "swap") return
                loadingFrames.delete(frameId)
                for (const changed of loadChanged) changed()
              })
              await session.send("Page.enable")
              session.on("Fetch.requestPaused", async (event) => {
                try {
                  if (boundaryFailure !== undefined || !authorized(event.request.url)) {
                    refuse(event.request.url)
                    await session.send("Fetch.failRequest", {
                      requestId: event.requestId,
                      errorReason: "BlockedByClient"
                    })
                  } else {
                    await session.send("Fetch.continueRequest", { requestId: event.requestId })
                  }
                } catch { /* A detached frame cannot send a request. */ }
              })
              await session.send("Fetch.enable", {
                patterns: [{ urlPattern: "*", requestStage: "Request" }]
              })
            })()
            watched.set(frame, watching)
            return watching
          }
          // Browser routing protects the first request of every new frame or
          // popup. Chromium interception also checks each redirected request;
          // Playwright routing alone skips subsequent hops.
          await context.route("**/*", async (route) => {
            const url = route.request().url()
            if (boundaryFailure !== undefined || !authorized(url)) {
              refuse(url)
              await route.abort("blockedbyclient")
              return
            }
            try {
              await watchFrame(route.request().frame())
              await route.continue()
            } catch {
              refuse(url)
              await route.abort("failed").catch(() => undefined)
            }
          })
          await context.routeWebSocket("**/*", (socket) => {
            const url = socket.url().replace(/^ws:/, "http:").replace(/^wss:/, "https:")
            if (boundaryFailure !== undefined || !authorized(url)) {
              refuse(url)
              socket.close()
            } else socket.connectToServer()
          })
          context.on("page", (opened) => {
            opened.on("framenavigated", (frame) => {
              // A child can acquire its own renderer on cross-site navigation.
              if (frame.parentFrame() !== null) watched.delete(frame)
            })
          })
          const created = await context.newPage()
          created.setDefaultTimeout(actionTimeout)
          await watchFrame(created.mainFrame())
          return created
        },
        catch: (cause) => new SurfaceUnavailable({ action: "newPage", reason: String(cause) })
      })

      /** Native timeouts cancel queued actions before a failure reaches handoff. */
      const attempt = <A>(action: string, run: (timeout: number) => Promise<A>) =>
        Effect.tryPromise({
          try: async () => {
            if (boundaryFailure !== undefined) throw boundaryFailure
            try {
              const result = await run(operationTimeout())
              if (boundaryFailure !== undefined) throw boundaryFailure
              if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw deadlineFailure()
              return result
            } catch (cause) {
              // A navigation timeout can stop only Playwright's wait while its
              // response is still arriving. Stop that load before ceding control.
              if (action === "navigate" || action === "click" || action === "fill") {
                await Promise.all([...navigationSessions].map((session) =>
                  session.send("Page.stopLoading").catch(() => undefined)))
              }
              throw cause
            }
          },
          catch: (cause) => boundaryFailure ?? (cause instanceof SurfaceUnavailable
            ? cause : new SurfaceUnavailable({ action, reason: String(cause) }))
        })

      const checkFrames = () => attempt("authorizeOrigin", async () => {
        const effectiveUrl = (frame: Frame): string => {
          const url = frame.url()
          const parent = frame.parentFrame()
          return (url === "about:blank" || url === "about:srcdoc") && parent !== null
            ? effectiveUrl(parent) : url
        }
        for (const frame of page.frames()) {
          const url = effectiveUrl(frame)
          // The empty initial browser is observable, but cannot hold targets.
          if (frame === page.mainFrame() && url === "about:blank") continue
          if (!authorized(url)) throw refuse(url)
        }
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
        yield* checkFrames()
        const yaml = yield* attempt("observe", (timeout) => page.ariaSnapshot({ mode: "ai", timeout }))
        yield* checkFrames()
        const title = yield* attempt("observe", async (timeout) => {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            return await Promise.race([
              page.title(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(deadlineFailure()), timeout)
              })
            ])
          } finally {
            if (timer !== undefined) clearTimeout(timer)
          }
        })
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
        run: (locator: Locator, timeout: number) => Promise<void>
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
        // Checking every live frame includes the actual target's document,
        // without reading markup or assuming frame names are unique.
        yield* checkFrames()
        yield* attempt(action, async (timeout) => {
          const expiresAt = Date.now() + timeout
          await run(nodeLocator(page, ref), timeout)
          // The action and lifecycle events use separate protocol sessions;
          // drain each session before checking whether it reported a load.
          await Promise.all([...navigationSessions].map((session) =>
            session.send("Page.getFrameTree").catch(() => undefined)))
          // Loading begins before a navigation request passes interception.
          // Track Chromium's frame lifecycle, including child documents, so an
          // already-loaded parent cannot make an in-flight form look settled.
          if (loadingFrames.size === 0) return
          let timer: ReturnType<typeof setTimeout> | undefined
          let changed: (() => void) | undefined
          try {
            await new Promise<void>((resolve, reject) => {
              changed = () => { if (loadingFrames.size === 0) resolve() }
              loadChanged.add(changed)
              timer = setTimeout(() => reject(new SurfaceUnavailable({
                action, reason: "frame navigation did not settle before the operation deadline"
              })), Math.max(1, Math.min(operationTimeout(), expiresAt - Date.now())))
              changed()
            })
          } finally {
            if (timer !== undefined) clearTimeout(timer)
            if (changed !== undefined) loadChanged.delete(changed)
          }
        })
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
          if (round < attempts - 1) {
            const delay = yield* attempt("waitFor", async (remaining) => Math.min(interval, remaining))
            yield* Effect.sleep(delay)
          }
        }
        return yield* new SurfaceTimeout({
          condition: describeCondition(condition),
          waitedMillis: timeout
        })
      })

      const adapter = SurfaceAdapter.of({
        setDeadline: (value) => Effect.sync(() => {
          deadlineAt = value === undefined || Number.isFinite(value) ? value : 0
        }),

        navigate: Effect.fn("SurfaceAdapter.navigate")(function* (url: string) {
          yield* attempt("authorizeOrigin", async () => {
            if (!authorized(url)) throw refuse(url)
          })
          yield* attempt("navigate", (timeout) => page.goto(url, { waitUntil: "load", timeout }).then(() => undefined))
          return yield* observe
        }),

        observe,

        resolveTarget,

        click: (target) => actOn(target, "click", (locator, timeout) => locator.click({ timeout })),

        fill: (target, value) => actOn(target, "fill", (locator, timeout) => locator.fill(value, { timeout })),

        extract: Effect.fn("SurfaceAdapter.extract")(function* (target: Target) {
          const located = yield* locate(target)
          yield* checkFrames()
          return readTextOf(located.node)
        }),

        waitFor,

        captureEvidence: Effect.gen(function* () {
          const state = yield* observe
          const screenshot = yield* attempt("captureEvidence", (timeout) =>
            page.screenshot({ fullPage: true, timeout })
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
