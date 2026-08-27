/**
 * Confidence that a Target names exactly one control.
 *
 * Driven against the diagnostic screens in `apps/legacy-core/src/fixtures.ts`,
 * in a real Chromium, because the hazards being tested are things Chromium does
 * — expose layout tables as real tables, inline two iframes into one tree, hand
 * back an aggregate name on a cell and its child runs at the same time — and a
 * hand-written tree would only prove that the fixture author believed in them.
 * The markup is test data served by the application; nothing here stubs it.
 *
 * `it.live` throughout, for the reason ticket 02 recorded: `@effect/vitest`'s
 * `it.effect` installs the TestClock and the adapter sleeps.
 *
 * The claim under test has three parts and they are not the same claim:
 *
 *   - Two or more matches stop the run and report every candidate, *told apart*.
 *     A report listing three identical lines satisfies "lists every candidate"
 *     and helps nobody, so what is asserted is that a reader can act on it.
 *   - Zero matches is a different outcome, distinguishable from ambiguity in the
 *     result rather than only in a message.
 *   - Scope and ordinal each disambiguate, and land on the same control.
 */

import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { serve } from "@cua/legacy-core"
import {
  type Target,
  SurfaceAdapter,
  TargetAmbiguous,
  TargetNotFound,
  playwrightSurface
} from "@cua/surface"

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

/** Fails the test unless the Target was ambiguous, and hands back the failure. */
const ambiguity = (surface: SurfaceAdapter["Service"], target: Target) =>
  surface.resolveTarget(target).pipe(
    Effect.flip,
    Effect.map((failure) => {
      if (!(failure instanceof TargetAmbiguous)) {
        throw new Error(`expected ambiguity, got ${failure._tag}: ${JSON.stringify(failure)}`)
      }
      return failure
    })
  )

// ---------------------------------------------------------------------------
// Duplicate labels: three controls with nothing in their names to tell them apart
// ---------------------------------------------------------------------------

const AMOUNT: Target = { role: "textbox", name: "Amount" }

it.live("three identical controls stop the run and every candidate is told apart", () =>
  withSurface("/fixtures/duplicate-labels", (surface) =>
    Effect.gen(function* () {
      const failure = yield* ambiguity(surface, AMOUNT)

      // Every candidate, never a guess at the first one.
      expect(failure.matches).toHaveLength(3)

      // Role, accessible name and ancestor trail are identical across all three:
      // this screen is precisely the one where "list the candidates" is not
      // enough on its own.
      expect(new Set(failure.matches.map((match) => match.description)).size).toBe(1)
      expect(new Set(failure.matches.map((match) => match.path)).size).toBe(1)

      // What separates them, and what a reader can do about it.
      expect(failure.matches.map((match) => match.ordinal)).toEqual([0, 1, 2])
      expect(failure.matches.map((match) => match.region)).toEqual([
        "Scheduled Transfer",
        "Recurring Transfer",
        "One-Time Transfer"
      ])
      expect(failure.remedy).toContain("within")
      expect(failure.remedy).toContain("Recurring Transfer")
    })
  )
)

it.live("every scope the ambiguity report suggests does in fact resolve", () =>
  withSurface("/fixtures/duplicate-labels", (surface) =>
    Effect.gen(function* () {
      const failure = yield* ambiguity(surface, AMOUNT)

      // The round trip that makes the remedy worth printing. `region` is read
      // off a resolved node and handed back as the thing to put in `within`; if
      // the two ever stopped being inverses, the report would be advice that
      // does not work, which is worse than no advice.
      for (const candidate of failure.matches) {
        const resolved = yield* surface.resolveTarget({
          ...AMOUNT,
          within: { name: candidate.region }
        })
        expect(resolved.match.region).toBe(candidate.region)
        expect(resolved.alternatives).toBe(0)
      }
    })
  )
)

it.live("scope and ordinal disambiguate, and land on the same control", () =>
  withSurface("/fixtures/duplicate-labels", (surface) =>
    Effect.gen(function* () {
      const scoped = yield* surface.resolveTarget({
        ...AMOUNT,
        within: { name: "Recurring Transfer" }
      })
      const counted = yield* surface.resolveTarget({ ...AMOUNT, nth: 1 })

      expect(scoped.match.region).toBe("Recurring Transfer")
      expect(counted.match.region).toBe("Recurring Transfer")
      expect(counted.match.ordinal).toBe(1)

      // Both arrive; they do not arrive equally. Naming the panel is a claim
      // about the screen, counting is a claim about how many panels there are,
      // and only one of those survives a fourth transfer being added.
      expect(scoped.strategies).toContain("within")
      expect(scoped.alternatives).toBe(0)
      expect(counted.strategies).toContain("ordinal")
      expect(counted.alternatives).toBe(2)
    })
  )
)

it.live("a scoped Target acts on the panel it named and not on its neighbours", () =>
  withSurface("/fixtures/duplicate-labels", (surface) =>
    Effect.gen(function* () {
      const inPanel = (heading: string): Target => ({ ...AMOUNT, within: { name: heading } })

      yield* surface.fill(inPanel("Recurring Transfer"), "150.00")

      expect(yield* surface.extract(inPanel("Recurring Transfer"))).toBe("150.00")
      expect(yield* surface.extract(inPanel("Scheduled Transfer"))).not.toBe("150.00")
      expect(yield* surface.extract(inPanel("One-Time Transfer"))).not.toBe("150.00")

      // And the panel that took the value is the one an operator would say it
      // was, checked by something only that panel carries.
      const reference = yield* surface.extract({
        role: "cell",
        label: "Reference",
        within: { name: "Recurring Transfer" }
      })
      expect(reference).toBe("REC-2002")
    })
  )
)

// ---------------------------------------------------------------------------
// Nothing is not the same as several
// ---------------------------------------------------------------------------

it.live("nothing and several are different outcomes, not different messages", () =>
  withSurface("/fixtures/duplicate-labels", (surface) =>
    Effect.gen(function* () {
      const several = yield* surface.resolveTarget(AMOUNT).pipe(Effect.flip)
      const nothing = yield* surface
        .resolveTarget({ role: "textbox", name: "Routing Number" })
        .pipe(Effect.flip)

      // Branchable, not merely readable. A missing control is as likely to be
      // the application telling the truth about its own domain as it is to be
      // breakage; an ambiguous one never is.
      expect(several._tag).toBe("TargetAmbiguous")
      expect(nothing._tag).toBe("TargetNotFound")
      expect(several).toBeInstanceOf(TargetAmbiguous)
      expect(nothing).toBeInstanceOf(TargetNotFound)
    })
  )
)

it.live("a Target that matches nothing says which part of it ran out", () =>
  withSurface("/fixtures/duplicate-labels", (surface) =>
    Effect.gen(function* () {
      const missing = (target: Target) =>
        surface.resolveTarget(target).pipe(
          Effect.flip,
          Effect.map((failure) => failure as TargetNotFound)
        )

      // The screen is not the one expected: no control of that role at all.
      const wrongScreen = yield* missing({ role: "slider", name: "Amount" })
      expect(wrongScreen.narrowedBy).toBe("role")

      // The screen is right and the control was renamed.
      const renamed = yield* missing({ role: "textbox", name: "Routing Number" })
      expect(renamed.narrowedBy).toBe("nameContains")

      // The panel an operator named is not on this screen.
      const noPanel = yield* missing({ ...AMOUNT, within: { name: "Wire Transfer" } })
      expect(noPanel.narrowedBy).toBe("within")

      // Fewer controls than the artifact counted on. Not a missing control and
      // not ambiguity: the set is a different size than it was.
      const overrun = yield* missing({ ...AMOUNT, nth: 9 })
      expect(overrun.narrowedBy).toBe("ordinal")
      expect(overrun.rationale).toContain("asked for #9 of 3")

      expect(wrongScreen.considered).toBeGreaterThan(0)
    })
  )
)

// ---------------------------------------------------------------------------
// Nested layout tables
// ---------------------------------------------------------------------------

it.live("a figure six layout tables deep still resolves to exactly one node", () =>
  withSurface("/fixtures/nested-tables", (surface) =>
    Effect.gen(function* () {
      const resolution = yield* surface.resolveTarget({
        role: "cell",
        label: "Net Settlement"
      })

      expect(resolution.match.text).toBe("$18,204.36")
      expect(resolution.alternatives).toBe(0)

      // The noise is real: Chromium exposes every layout table, so the tree is
      // enormous and the figure sits many levels down inside it.
      expect(resolution.considered).toBeGreaterThan(100)
      expect(resolution.match.path.split(" > ").filter((step) => step === "table").length)
        .toBeGreaterThanOrEqual(6)
    })
  )
)

it.live("a candidate that merely encloses another candidate is discarded", () =>
  withSurface("/fixtures/nested-tables", (surface) =>
    Effect.gen(function* () {
      // Chromium names the cell with the aggregate of its inline runs *and*
      // exposes the runs as children, so a partial name is true of both the cell
      // and the run inside it. Both matches are correct and only the inner one
      // is useful.
      const resolution = yield* surface.resolveTarget({ name: "Clearing Bat" })

      expect(resolution.rationale).toContain("enclosing duplicate(s) discarded")
      expect(resolution.match.text).toBe("Clearing Batch")
      expect(resolution.alternatives).toBe(0)
    })
  )
)

it.live("a caption reaches a figure that a further table nesting sits between", () =>
  withSurface("/fixtures/nested-tables", (surface) =>
    Effect.gen(function* () {
      // Nothing in the markup relates the two; only their position in the row
      // they share does, and that association is computed over the tree.
      const suspense = yield* surface.extract({ role: "cell", label: "Suspense Total" })
      expect(suspense).toBe("$41.28")
    })
  )
)

// ---------------------------------------------------------------------------
// Two frames
// ---------------------------------------------------------------------------

const POSTED: Target = { role: "cell", label: "Posted Balance" }

it.live("one Target reaching into two documents reports which document each is in", () =>
  withSurface("/fixtures/frames", (surface) =>
    Effect.gen(function* () {
      const state = yield* surface.observe
      expect(state.frames.map((frame) => frame.name)).toEqual(["main", "ledgerone", "ledgertwo"])

      const failure = yield* ambiguity(surface, POSTED)

      expect(failure.matches).toHaveLength(2)
      expect(failure.matches.map((match) => match.frame)).toEqual(["ledgerone", "ledgertwo"])
      expect(failure.matches.map((match) => match.text)).toEqual(["$1,204.00", "$9,870.55"])

      // The remedy never suggests naming the frame, because a Target has nowhere
      // to put one. It suggests the heading, which happens to sit inside a frame.
      expect(failure.remedy).toContain("Ledger A")
      expect(failure.remedy).not.toContain("ledgerone")
      expect(failure.remedy).not.toMatch(/frame/i)
    })
  )
)

it.live("naming the region reaches into the right frame without naming a frame", () =>
  withSurface("/fixtures/frames", (surface) =>
    Effect.gen(function* () {
      const second: Target = { ...POSTED, within: { name: "Ledger B" } }
      expect(JSON.stringify(second)).not.toMatch(/frame|ledgertwo/)

      const resolution = yield* surface.resolveTarget(second)
      expect(resolution.match.text).toBe("$9,870.55")
      expect(resolution.match.frame).toBe("ledgertwo")
      expect(resolution.alternatives).toBe(0)

      // Ordinal reaches the same control, counting across the frame boundary as
      // if it were not there.
      const counted = yield* surface.resolveTarget({ ...POSTED, nth: 1 })
      expect(counted.match.text).toBe("$9,870.55")
      expect(counted.match.frame).toBe("ledgertwo")
    })
  )
)

it.live("a control inside the second frame can be operated, not only read", () =>
  withSurface("/fixtures/frames", (surface) =>
    Effect.gen(function* () {
      const adjustment: Target = {
        role: "textbox",
        name: "Adjustment",
        within: { name: "Ledger B" }
      }

      yield* surface.fill(adjustment, "12.50")
      expect(yield* surface.extract(adjustment)).toBe("12.50")
      expect(
        yield* surface.extract({ ...adjustment, within: { name: "Ledger A" } })
      ).not.toBe("12.50")
    })
  )
)

// ---------------------------------------------------------------------------
// The near-duplicate on the real screen
// ---------------------------------------------------------------------------

it.live("the near-duplicate on Member Search resolves unambiguously by exact name", () =>
  withSurface("/", (surface) =>
    Effect.gen(function* () {
      // `Member Number (Legacy)` sits in the Cross-Reference panel with its own
      // submit, and choosing it lands on a page that is quietly not Member
      // Detail. The exact name separates them with no disambiguation at all.
      const resolution = yield* surface.resolveTarget({ role: "textbox", name: "Member Number" })

      expect(resolution.match.description).toBe('textbox "Member Number"')
      expect(resolution.match.region).toBe("Member Number Search")
      expect(resolution.strategies).toContain("name")
      expect(resolution.alternatives).toBe(0)

      // Partial names are where it gets ambiguous, and the report says which
      // panel each candidate belongs to rather than leaving a reader to guess.
      const failure = yield* ambiguity(surface, { role: "textbox", name: "Member Num" })
      expect(failure.matches.map((match) => match.region)).toEqual([
        "Member Number Search",
        "Cross-Reference Lookup"
      ])
    })
  )
)
