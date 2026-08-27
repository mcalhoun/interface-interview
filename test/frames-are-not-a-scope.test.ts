/**
 * A frame is not a scope, and the observed tree no longer says otherwise.
 *
 * ## The defect
 *
 * The first live model-driven discovery run reached Account Detail and then died
 * there, three identical proposals in a row:
 *
 * ```
 * proposed: extract labelled "Available Balance" within iframe "acctdetail"
 * answered: refused: nothing on the screen answers to labelled "Available
 *           Balance" within iframe "acctdetail". scoped to 0 iframe node(s)
 * ```
 *
 * The model had done nothing unreasonable. The tree it was shown rendered the
 * frame boundary as `iframe [frame=acctdetail]`, every other line on the screen
 * was a thing a Target can name, and so it named that one. But `[frame=...]` was
 * a renderer annotation rather than an accessible name — the iframe node has
 * none — so `within` matched zero nodes, and the refusal it got back said only
 * that, which left it with the same screen, the same idea and no reason to have
 * a different one. The system advertised a handle its own vocabulary could not
 * express, and then declined to say so.
 *
 * ## What is asserted here
 *
 * Two halves, and both are needed: removing the bait does not help a reader who
 * arrives at the same idea some other way, and a good refusal does not excuse
 * offering the bait.
 *
 *   1. The render that will be answered in Targets — `state.accessibility`, and
 *      therefore the model's prompt — carries no frame annotation, while the
 *      frame-annotated render still exists for a person diagnosing a screen.
 *   2. A `within` that named nothing comes back with a remedy that says what to
 *      reach for instead, and — the part worth checking rather than assuming —
 *      the scope it suggests actually resolves.
 *
 * None of it needs a model. The screen, the browser and the resolution are real;
 * the mistake is reproduced by writing the Target the model wrote.
 *
 * ADR-0001 is untouched by all this: a Target still has nowhere to name a frame,
 * `within` still never matches one, and the fix is that the tree stops implying
 * they could. See `test/surface-no-escape-hatch.test.ts`.
 */

import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { serve } from "@cua/legacy-core"
import { observation } from "@cua/agent"
import type { AccessibilityNode, SurfaceState } from "@cua/surface"
import {
  SurfaceAdapter,
  TargetNotFound,
  formatAccessibilityTree,
  formatAccessibilityTreeWithFrames,
  playwrightSurface
} from "@cua/surface"

const ACCOUNT_DETAIL = "/account?memberNumber=12345&accountNumber=0000012345-S01"

/** The screen the live run died on, with the adapter pointed at it. */
const onAccountDetail = <A, E>(
  use: (surface: SurfaceAdapter["Service"], state: SurfaceState) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const core = yield* serve({ port: 0 })
    return yield* Effect.gen(function* () {
      const surface = yield* SurfaceAdapter
      const state = yield* surface.navigate(core.origin + ACCOUNT_DETAIL)
      return yield* use(surface, state)
    }).pipe(Effect.provide(playwrightSurface({ startUrl: core.origin + "/" })))
  }).pipe(Effect.scoped)

// ---------------------------------------------------------------------------
// 1. The tree stops advertising the handle
// ---------------------------------------------------------------------------

it.live("the observed tree names no frame, while the frame's contents are all in it", () =>
  onAccountDetail((_surface, state) =>
    Effect.sync(() => {
      // The frame is really there. This is not a screen that happens to have no
      // iframe on it; it is the one whose every figure is inside one.
      expect(state.frames.map((frame) => frame.name)).toEqual(["main", "acctdetail"])

      // And the render that will be answered in Targets says nothing about it,
      // by either spelling: not the annotation, not the name.
      expect(state.accessibility).not.toContain("[frame=")
      expect(state.accessibility).not.toContain("acctdetail")

      // What it does carry is everything inside the frame, which is why naming
      // the frame was never necessary in the first place.
      expect(state.accessibility).toContain("iframe")
      expect(state.accessibility).toContain('cell "Available Balance"')
      expect(state.accessibility).toContain("$4,182.55")

      // The other render is unchanged and still says where the boundary is. It
      // is what `bun run surface observe` prints and what
      // `parseAccessibilityTree` round-trips; a person diagnosing a screen by
      // hand is not the reader this defect was about.
      expect(formatAccessibilityTreeWithFrames(state.tree)).toContain("iframe [frame=acctdetail]")
    })
  ))

it("the two renders differ in exactly one thing, and it is the frame tag", () => {
  const tree: AccessibilityNode = {
    role: "document",
    properties: {},
    children: [
      {
        role: "iframe",
        frame: "acctdetail",
        properties: {},
        children: [{ role: "cell", name: "Available Balance", properties: {}, children: [] }]
      }
    ]
  }

  expect(formatAccessibilityTree(tree)).toBe(
    ['- iframe:', '  - cell "Available Balance"'].join("\n")
  )
  expect(formatAccessibilityTreeWithFrames(tree)).toBe(
    ['- iframe [frame=acctdetail]:', '  - cell "Available Balance"'].join("\n")
  )
})

it("the prompt a model is handed says frames are inlined, and shows none to name", () => {
  const state: SurfaceState = {
    url: "http://127.0.0.1/account",
    title: "Heritage Core - Account",
    frames: [
      { name: "main", url: "http://127.0.0.1/account", isMain: true },
      { name: "acctdetail", url: "http://127.0.0.1/account/panel", isMain: false }
    ],
    tree: { role: "document", properties: {}, children: [] },
    accessibility: "- iframe:\n  - cell \"Available Balance\"",
    observedAt: new Date(0).toISOString()
  }

  const text = observation({
    goal: "Look up the savings account balance of member 12345",
    state,
    step: 1,
    maxSteps: 20,
    history: []
  })

  // The frame list is still reported — which documents a screen is made of is a
  // fact about it, and the evidence should say so — but it is reported with the
  // one sentence that stops it reading as a menu of scopes.
  expect(text).toContain("acctdetail")
  expect(text).toContain("inlined")
  expect(text).toContain("not something a target can name")
  expect(text).not.toContain("[frame=")
})

// ---------------------------------------------------------------------------
// 2. The refusal says what to do instead
// ---------------------------------------------------------------------------

/**
 * Both spellings of the same wrong idea.
 *
 * `{ role: "iframe", name: "acctdetail" }` is what the live run wrote, reading
 * the annotation as role plus name. `{ name: "acctdetail" }` is what a reader
 * who saw the frame list rather than the tree would write. Neither can work and
 * both deserve the same answer, so both are checked — a remedy that only fires
 * on the exact shape of one past mistake is a patch, not a fix.
 */
for (const [how, within] of [
  ["by role and name", { role: "iframe", name: "acctdetail" }],
  ["by name alone", { name: "acctdetail" }]
] as const) {
  it.live(`a within naming a frame ${how} is refused with somewhere else to go`, () =>
    onAccountDetail((surface) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          surface.resolveTarget({ label: "Available Balance", within })
        )

        expect(failure).toBeInstanceOf(TargetNotFound)
        const missing = failure as TargetNotFound
        expect(missing.narrowedBy).toBe("within")

        // Not "nothing matched". The three facts a reader needs to stop
        // repeating themselves: that a frame is not a nameable region, that
        // nothing is lost by that because the contents are already in the tree,
        // and what to do next.
        expect(missing.remedy).toContain("a frame is not a region a Target can name")
        expect(missing.remedy).toContain("already part of the tree")
        expect(missing.remedy).toContain("drop within")
      })
    ))
}

it.live("the region a refusal suggests really does resolve", () =>
  onAccountDetail((surface) =>
    Effect.gen(function* () {
      const failure = (yield* Effect.flip(
        surface.resolveTarget({
          label: "Available Balance",
          within: { role: "iframe", name: "acctdetail" }
        })
      )) as TargetNotFound

      // Ticket 05's rule, applied to the zero-match side: a remedy that would
      // not work is worse than none. So take the advice literally — scope by the
      // heading of the section the control sits in — and require the result to
      // resolve to exactly one control reading the balance.
      const scoped = yield* surface.resolveTarget({
        role: "cell",
        label: "Available Balance",
        within: { name: "Primary Savings" }
      })

      expect(failure.remedy).toContain('"Primary Savings"')
      expect(scoped.match.text).toBe("$4,182.55")
      expect(scoped.alternatives).toBe(0)

      // And the advice's other branch works too: dropping the scope entirely
      // reaches the same figure, which is the whole reason naming the frame was
      // never needed.
      expect(yield* surface.extract({ role: "cell", label: "Available Balance" })).toBe("$4,182.55")
    })
  ))

it.live("a within that names no region at all is told which regions exist", () =>
  onAccountDetail((surface) =>
    Effect.gen(function* () {
      const failure = (yield* Effect.flip(
        surface.resolveTarget({
          role: "cell",
          label: "Available Balance",
          within: { name: "Deposit Summary" }
        })
      )) as TargetNotFound

      // The ordinary zero-match case, which is not about frames at all: the
      // scope named something that is simply not on this screen. It gets the
      // same shape of answer — here is what is actually on offer — because the
      // reader's problem is the same one.
      expect(failure.narrowedBy).toBe("within")
      expect(failure.remedy).not.toContain("a frame is not a region")
      expect(failure.remedy).toContain("no region on this screen is headed that way")
      expect(failure.remedy).toContain('"Account Detail"')
      expect(failure.remedy).toContain('"Primary Savings"')
    })
  ))
