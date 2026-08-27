/**
 * Heritage Core is the fixture every later ticket is tested against, so what is
 * pinned here is the happy path an operator walks and the hostility that makes
 * the fixture worth having. Both are externally observable: the bytes the server
 * puts on the wire.
 */

import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { serve } from "@cua/legacy-core"

const SAVINGS = "0000012345-S01"
const CHECKING = "0000012345-D10"

const openCore = Effect.gen(function* () {
  const core = yield* serve({ port: 0 })
  const get = (path: string) =>
    Effect.promise(() => fetch(core.origin + path).then((response) => response.text()))
  return { core, get } as const
})

it.effect("Member Search offers a near-duplicate of the Member Number field", () =>
  Effect.gen(function* () {
    const { get } = yield* openCore
    const page = yield* get("/")

    expect(page).toContain('title="Member Number"')
    expect(page).toContain('title="Member Number (Legacy)"')
    expect(page).toContain("Member Number Search")
    expect(page).toContain("Cross-Reference Lookup")

    // Both fields answer to a bare "Member Number" name match, which is exactly
    // the ambiguity `within` and `nth` disambiguation has to resolve.
    const confusable = page.match(/title="Member Number[^"]*"/g) ?? []
    expect(confusable).toHaveLength(2)
  })
)

it.effect("Member Search submits as a GET, so navigation is a full page load", () =>
  Effect.gen(function* () {
    const { get } = yield* openCore
    const page = yield* get("/")
    expect(page).toContain('<form method="get" action="/member">')
    expect(page).toContain('<input type="submit" value="Search">')
  })
)

it.effect("Member Detail lists Primary Savings and Checking for member 12345", () =>
  Effect.gen(function* () {
    const { get } = yield* openCore
    const page = yield* get("/member?memberNumber=12345")

    expect(page).toContain("MARGARET T HOLLOWAY")
    expect(page).toContain(`<a href="/account?memberNumber=12345&amp;accountNumber=${SAVINGS}">Primary Savings</a>`)
    expect(page).toContain(`<a href="/account?memberNumber=12345&amp;accountNumber=${CHECKING}">Checking</a>`)

    // Balances are only reachable through Account Detail, so the click-through
    // cannot be skipped.
    expect(page).not.toContain("Available Balance")
  })
)

it.effect("Account Detail puts every figure inside an iframe", () =>
  Effect.gen(function* () {
    const { get } = yield* openCore
    const outer = yield* get(`/account?memberNumber=12345&accountNumber=${SAVINGS}`)

    expect(outer).toContain(
      `<iframe src="/account/panel?memberNumber=12345&amp;accountNumber=${SAVINGS}"`
    )
    expect(outer).not.toContain("Available Balance")

    const panel = yield* get(`/account/panel?memberNumber=12345&accountNumber=${SAVINGS}`)
    expect(panel).toContain("Available Balance")
    expect(panel).toContain("$4,182.55")
    expect(panel).toContain("Current Balance")
    expect(panel).toContain("$4,382.55")
    expect(panel).toContain("Status")
    expect(panel).toContain("Active")
  })
)

it.effect("every page is server-rendered hostile markup", () =>
  Effect.gen(function* () {
    const { get } = yield* openCore
    const paths = [
      "/",
      "/member?memberNumber=12345",
      `/account?memberNumber=12345&accountNumber=${SAVINGS}`,
      `/account/panel?memberNumber=12345&accountNumber=${SAVINGS}`,
      "/xref?legacyMemberNumber=ABC123",
      // The diagnostic screens are served by the same application and obey the
      // same rules. A fixture that quietly allowed itself an `id` would be
      // testing a system this repository does not have.
      "/fixtures",
      "/fixtures/duplicate-labels",
      "/fixtures/nested-tables",
      "/fixtures/frames",
      "/fixtures/frames/panel?ledger=A"
    ]

    for (const path of paths) {
      const page = yield* get(path)
      expect(page, `${path} renders client side`).not.toMatch(/<script/i)
      expect(page, `${path} carries a test id`).not.toMatch(/\s(id|class|data-[a-z-]+)\s*=/i)
      expect(page, `${path} carries ARIA`).not.toMatch(/\s(role|aria-[a-z-]+)\s*=/i)
      expect(page, `${path} carries semantic markup`).not.toMatch(
        /<(label|th|main|nav|header|footer|section|article|aside)[\s>]/i
      )
      expect(page, `${path} is not table based`).toMatch(/<table/i)
    }
  })
)

it.effect("the diagnostic screens carry the hazards they exist for", () =>
  Effect.gen(function* () {
    const { get } = yield* openCore

    // Duplicate labels: three controls with the same role, the same accessible
    // name and the same caption. Nothing in the name can separate them.
    const transfers = yield* get("/fixtures/duplicate-labels")
    expect(transfers.match(/title="Amount"/g)).toHaveLength(3)
    expect(transfers.match(/value="Post"/g)).toHaveLength(3)
    for (const heading of ["Scheduled Transfer", "Recurring Transfer", "One-Time Transfer"]) {
      expect(transfers).toContain(heading)
    }
    // One per-panel fact, so a test can prove which panel it acted on.
    expect(transfers).toContain("REC-2002")

    // Nested tables: the figure sits several layout tables below its panel.
    const settlement = yield* get("/fixtures/nested-tables")
    expect(settlement).toContain("$18,204.36")
    expect((settlement.match(/<table/g) ?? []).length).toBeGreaterThan(20)

    // Frame-crossing: two documents, each with its own copy of the captions.
    const ledgers = yield* get("/fixtures/frames")
    expect(ledgers).toContain('name="ledgerone"')
    expect(ledgers).toContain('name="ledgertwo"')
    for (const key of ["A", "B"]) {
      const panel = yield* get(`/fixtures/frames/panel?ledger=${key}`)
      expect(panel).toContain("Posted Balance")
      expect(panel).toContain('title="Adjustment"')
    }
  })
)

it.effect("nothing an operator can reach links to a diagnostic screen", () =>
  Effect.gen(function* () {
    const { get } = yield* openCore

    // The fixtures are reachable by URL and nowhere else. If Member Search grew
    // a link to them, observing it would no longer be observing the application
    // ticket 01 built, and every screen assertion downstream would be measuring
    // the fixture instead.
    for (const path of ["/", "/member?memberNumber=12345", "/xref"]) {
      expect(yield* get(path), `${path} links to a diagnostic screen`).not.toContain("/fixtures")
    }
  })
)
