/**
 * The Surface Adapter, driven against the real Heritage Core in a real browser.
 *
 * `it.live` throughout, not `it.effect`: `waitFor` sleeps between polls, and
 * under the TestClock those sleeps never come back on their own.
 *
 * These are not unit tests and are not meant to be. The thing worth pinning is
 * that a Target written in an operator's words survives Heritage Core's nested
 * layout tables, its captions that label nothing, and its unnamed iframe — and
 * that it does so without the adapter ever offering a way to reach the document.
 * A fake tree would prove none of that.
 */

import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { serve } from "@cua/legacy-core"
import {
  type Target,
  formatAccessibilityTree,
  parseAccessibilityTree,
  SurfaceAdapter,
  TargetAmbiguous,
  TargetNotFound,
  playwrightSurface,
  textPresent
} from "@cua/surface"

const SAVINGS = "0000012345-S01"

/** The search field an operator means, said the way an operator says it. */
const memberNumberField: Target = {
  role: "textbox",
  name: "Member Number",
  within: { name: "Member Number Search" }
}

const searchButton: Target = { role: "button", name: "Search" }

/**
 * One Heritage Core and one browser per test.
 *
 * `serve({ port: 0 })` takes a free port; the server hangs off the test's Scope
 * and the browser off the layer's, so neither leaks between tests. The body runs
 * inside `Effect.provide` so the browser is still open while it does.
 */
const withSurface = <A, E>(
  path: string,
  body: (surface: SurfaceAdapter["Service"]) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const core = yield* serve({ port: 0 })
    const layer = playwrightSurface({ startUrl: core.origin + path })
    return yield* Effect.gen(function* () {
      const surface = yield* SurfaceAdapter
      return yield* body(surface)
    }).pipe(Effect.provide(layer))
  }).pipe(Effect.scoped)

it.live("observe reports accessibility structure, location and frames, and no markup", () =>
  withSurface("/", (surface) =>
    Effect.gen(function* () {
      const state = yield* surface.observe

      expect(state.title).toBe("Heritage Core - Member Search")
      expect(state.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      expect(state.frames.map((frame) => frame.name)).toEqual(["main"])

      // Semantic structure survives markup with no ids, classes or ARIA.
      expect(state.accessibility).toContain('textbox "Member Number"')
      expect(state.accessibility).toContain('button "Search"')

      // Nothing that could be pasted back in as a selector: no markup, and no
      // Playwright node handles either.
      expect(state.accessibility).not.toMatch(/<[a-z!/]/i)
      expect(state.accessibility).not.toMatch(/\[ref=/)
      expect(JSON.stringify(state.tree)).not.toMatch(/\bref\b/)
    })
  )
)

it.live("a Target survives layout tables that repeat the same text at every level", () =>
  withSurface("/", (surface) =>
    Effect.gen(function* () {
      const resolution = yield* surface.resolveTarget(memberNumberField)

      expect(resolution.match.description).toBe('textbox "Member Number"')
      expect(resolution.match.frame).toBe("main")
      // The tree is deep and noisy; the point is that the Target still lands.
      expect(resolution.considered).toBeGreaterThan(40)
      expect(resolution.strategies).toContain("within")
      expect(resolution.rationale).toContain("Member Number Search")
    })
  )
)

it.live("the near-duplicate field is reported as ambiguous rather than guessed at", () =>
  withSurface("/", (surface) =>
    Effect.gen(function* () {
      const failure = yield* surface
        .resolveTarget({ role: "textbox", name: "Member Num" })
        .pipe(Effect.flip)

      expect(failure).toBeInstanceOf(TargetAmbiguous)
      const ambiguous = failure as TargetAmbiguous
      expect(ambiguous.matches.map((match) => match.description)).toEqual([
        'textbox "Member Number"',
        'textbox "Member Number (Legacy)"'
      ])

      // Scoping to the panel an operator would name resolves it.
      const scoped = yield* surface.resolveTarget(memberNumberField)
      expect(scoped.match.description).toBe('textbox "Member Number"')
    })
  )
)

it.live("an exact accessible name beats the near-duplicate without disambiguation", () =>
  withSurface("/", (surface) =>
    Effect.gen(function* () {
      const resolution = yield* surface.resolveTarget({ role: "textbox", name: "Member Number" })
      expect(resolution.match.description).toBe('textbox "Member Number"')
      expect(resolution.strategies).toContain("name")
    })
  )
)

it.live("a Target that matches nothing fails with what it looked at", () =>
  withSurface("/", (surface) =>
    Effect.gen(function* () {
      const failure = yield* surface
        .resolveTarget({ role: "textbox", name: "Sort Code" })
        .pipe(Effect.flip)

      expect(failure).toBeInstanceOf(TargetNotFound)
      expect((failure as TargetNotFound).considered).toBeGreaterThan(0)
    })
  )
)

it.live("fill and click walk Member Search through to Member Detail", () =>
  withSurface("/", (surface) =>
    Effect.gen(function* () {
      yield* surface.fill(memberNumberField, "12345")

      const typed = yield* surface.extract(memberNumberField)
      expect(typed).toBe("12345")

      const afterSearch = yield* surface.click(searchButton)
      expect(afterSearch.url).toContain("/member?memberNumber=12345")
      expect(afterSearch.title).toBe("Heritage Core - Member 12345")
      expect(afterSearch.accessibility).toContain("MARGARET T HOLLOWAY")

      // Landing on the Cross-Reference decoy would look like this instead.
      expect(afterSearch.url).not.toContain("/xref")
    })
  )
)

it.live("waitFor settles on a condition read off the accessibility tree", () =>
  withSurface("/", (surface) =>
    Effect.gen(function* () {
      yield* surface.fill(memberNumberField, "12345")
      yield* surface.click(searchButton)

      const state = yield* surface.waitFor(textPresent("Share and Deposit Accounts"), {
        timeoutMillis: 5_000
      })
      expect(state.accessibility).toContain("Share and Deposit Accounts")
    })
  )
)

it.live("waitFor gives up with the condition it was waiting on", () =>
  withSurface("/", (surface) =>
    Effect.gen(function* () {
      const failure = yield* surface
        .waitFor(textPresent("Wire Transfer Approval"), {
          timeoutMillis: 400,
          intervalMillis: 100
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("SurfaceTimeout")
    })
  )
)

it.live("a control inside the iframe resolves without the caller knowing it exists", () =>
  withSurface(`/account?memberNumber=12345&accountNumber=${SAVINGS}`, (surface) =>
    Effect.gen(function* () {
      // Nothing in this Target mentions a frame. The caller names the caption
      // beside the figure, exactly as it appears on screen.
      const balance = yield* surface.extract({ role: "cell", label: "Available Balance" })
      expect(balance).toBe("$4,182.55")

      const resolution = yield* surface.resolveTarget({ role: "cell", label: "Current Balance" })
      // The adapter knows which frame it crossed into and says so; the Target did not.
      expect(resolution.match.frame).toBe("acctdetail")
      expect(resolution.match.text).toBe("$4,382.55")

      const state = yield* surface.observe
      expect(state.frames.map((frame) => frame.name)).toEqual(["main", "acctdetail"])
    })
  )
)

it.live("the whole happy path: search, open an account, read a balance", () =>
  withSurface("/", (surface) =>
    Effect.gen(function* () {
      yield* surface.fill(memberNumberField, "12345")
      yield* surface.click(searchButton)
      yield* surface.click({ role: "link", name: "Primary Savings" })

      const state = yield* surface.observe
      expect(state.url).toContain("/account?memberNumber=12345")
      expect(state.frames).toHaveLength(2)

      const available = yield* surface.extract({ role: "cell", label: "Available Balance" })
      const status = yield* surface.extract({
        role: "cell",
        label: "Status",
        within: { name: "Primary Savings" }
      })

      expect(available).toBe("$4,182.55")
      expect(status).toBe("Active")
    })
  )
)

it.live("textNear measures proximity in edges of the accessibility tree", () =>
  withSurface(`/account?memberNumber=12345&accountNumber=${SAVINGS}`, (surface) =>
    Effect.gen(function* () {
      const resolution = yield* surface.resolveTarget({
        role: "cell",
        textNear: "Current Balance"
      })

      expect(resolution.match.text).toBe("$4,382.55")
      expect(resolution.strategies).toContain("textNear")
      expect(resolution.rationale).toMatch(/\d+ tree edge\(s\) from "Current Balance"/)
    })
  )
)

it.live("captureEvidence returns a picture and the state that goes with it", () =>
  withSurface("/", (surface) =>
    Effect.gen(function* () {
      const evidence = yield* surface.captureEvidence

      // PNG magic number. The screenshot is for a person reviewing the run.
      expect([...evidence.screenshot.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
      expect(evidence.state.title).toBe("Heritage Core - Member Search")
      expect(Date.parse(evidence.capturedAt)).not.toBeNaN()
    })
  )
)

it.live("navigate reaches a page and reports what is there", () =>
  withSurface("/", (surface) =>
    Effect.gen(function* () {
      const state = yield* surface.observe
      const origin = new URL(state.url).origin
      const detail = yield* surface.navigate(`${origin}/member?memberNumber=12345`)

      expect(detail.title).toBe("Heritage Core - Member 12345")
      expect(detail.accessibility).toContain('link "Checking"')
    })
  )
)

it.live("the rendered accessibility tree round-trips, so a snapshot hash is stable", () =>
  withSurface("/", (surface) =>
    Effect.gen(function* () {
      const state = yield* surface.observe

      // Discovery's stuck detection hashes normalised snapshots. That only works
      // if rendering the tree is a fixed point, so pin it here rather than
      // discover it later as a loop that never terminates.
      const reparsed = formatAccessibilityTree(parseAccessibilityTree(state.accessibility))
      expect(reparsed).toBe(state.accessibility)
    })
  )
)
