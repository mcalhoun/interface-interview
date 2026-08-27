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
      "/member?memberNumber=99999",
      "/xref?legacyMemberNumber=ABC123"
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

it.effect("a member who does not exist gets a real screen and an HTTP 200, not an error", () =>
  Effect.gen(function* () {
    const { core } = yield* openCore
    const response = yield* Effect.promise(() =>
      fetch(`${core.origin}/member?memberNumber=99999`)
    )
    const page = yield* Effect.promise(() => response.text())

    // The single most important byte on the wire. Heritage Core understood the
    // search and answered it; the answer is that there is no such member. Nothing
    // at the transport layer says otherwise, so anything hoping to classify this
    // by status code, `response.ok` or a thrown exception is told "success" and
    // handed a page with no balances on it.
    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)

    expect(page).toContain("Member Not Found")
    expect(page).toContain("No member record found for member number 99999.")

    // Not the generic system-message page. A request that could not be carried
    // out and a request that was carried out and came back empty are different
    // things, and this fixture only teaches the distinction if it draws it.
    expect(page).not.toContain("System Message")
  })
)

it.effect("an empty search is an operator error, and does not borrow the not-found screen", () =>
  Effect.gen(function* () {
    const { core } = yield* openCore
    const response = yield* Effect.promise(() => fetch(`${core.origin}/member?memberNumber=`))
    const page = yield* Effect.promise(() => response.text())

    expect(response.status).toBe(400)
    expect(page).toContain("System Message")
    expect(page).not.toContain("Member Not Found")
  })
)
