/**
 * A random web page cannot drive a paused run.
 *
 * The operator interface listens on a predictable loopback port and its
 * state-changing routes used to take anybody's word for anything. That is worse
 * than it sounds, and the reason is not the port: a **cross-origin form POST is
 * not blocked by the same-origin policy**, and the attacker does not need to
 * read the response. Any page open in the operator's browser could `POST /take`
 * while a run was paused, then `POST /return` with a name and a "should
 * automation handle this next time" answer nobody gave -- and that answer is
 * what writes a durable Capability amendment (ADR-0004) and a stored Tenant
 * Override (ADR-0006). Both are append-only. ADR-0004's whole argument is that
 * the classification comes from what a real person actually did.
 *
 * What is asserted below, in the order the request meets it:
 *
 *   - a POST with no token changes nothing, and the state machine agrees;
 *   - a POST with the wrong token likewise, so the check is not `!== ""`;
 *   - a POST carrying the *right* token from a cross-site context is refused, so
 *     a token leaked by `Referer` is not enough on its own;
 *   - `GET /` and `GET /state` need the token too, and the argument for that is
 *     that `/` renders the token into every form on it;
 *   - the ordinary path still works, end to end, through the real interface.
 *
 * Every case checks ownership *after* the refusal rather than only the status
 * code. A 401 that had already moved the state machine would be a worse bug than
 * no check at all, because it would look fixed.
 */

import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { attendedReplay } from "./support/handoff-harness.ts"
import { shippedArtifact } from "./support/replay-harness.ts"

const RESTRICTED = "77777"

/** What a browser sends when a page on another origin submits a form here. */
const CROSS_SITE = {
  origin: "https://not-your-bank.example",
  "sec-fetch-site": "cross-site"
} as const

interface Attempt {
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly fields: Readonly<Record<string, string>>
  readonly why: string
}

it.live(
  "an unauthenticated or cross-site POST cannot take or return control",
  () =>
    Effect.gen(function* () {
      const outcome = yield* attendedReplay({
        artifact: shippedArtifact("member.account-balance", "1.1.0"),
        inputs: { memberId: RESTRICTED },
        runId: "operator-authentication",
        operate: (desk) =>
          Effect.gen(function* () {
            const paused = yield* desk.awaitPause
            expect(paused.owner).toBe("paused")

            /** A caller with no token, exactly as `curl` or a stray page has. */
            const outsider = (attempt: Attempt) =>
              Effect.promise(async () => {
                const response = await fetch(desk.origin + attempt.path, {
                  method: "POST",
                  redirect: "manual",
                  headers: attempt.headers,
                  body: new URLSearchParams(attempt.fields)
                })
                return { status: response.status, body: await response.text() }
              })

            const forged = {
              operator: "not-a-real-person",
              classification: "resolved",
              detail: "forged",
              nextTime: "automation_handles_it"
            } as const

            const attempts: ReadonlyArray<Attempt> = [
              {
                path: "/take",
                headers: {},
                fields: { operator: "not-a-real-person" },
                why: "no token at all"
              },
              {
                path: "/return",
                headers: {},
                fields: forged,
                why: "no token at all"
              },
              {
                path: "/take",
                headers: { "x-operator-token": `${desk.token}x` },
                fields: { operator: "not-a-real-person" },
                why: "a wrong token, so the check is not merely non-empty"
              },
              {
                path: "/take",
                headers: { ...CROSS_SITE, "x-operator-token": desk.token },
                fields: { operator: "not-a-real-person" },
                why: "the right token from a cross-site page, as a Referer leak would give"
              },
              {
                path: "/return",
                headers: { ...CROSS_SITE, "x-operator-token": desk.token },
                fields: forged,
                why: "the right token from a cross-site page"
              },
              {
                // The token in the URL, which is where a `Referer` leak puts it,
                // but still cross-site. The fetch metadata is the half a page
                // cannot forge.
                path: `/return?t=${desk.token}`,
                headers: { ...CROSS_SITE },
                fields: forged,
                why: "the right token on the query string, cross-site"
              }
            ]

            for (const attempt of attempts) {
              const response = yield* outsider(attempt)
              expect(
                response.status,
                `${attempt.path} accepted a request with ${attempt.why}`
              ).toBe(401)
              // The refusal must not leak the credential it is refusing for.
              expect(response.body).not.toContain(desk.token)

              // The real check. A 401 that had already moved the state machine
              // would look fixed and be worse than no check at all.
              const after = yield* desk.control.snapshot
              expect(after.owner, `${attempt.path} moved the session anyway`).toBe("paused")
              expect(after.resolved).toEqual([])
              expect(after.pending?.operator).toBeUndefined()
            }

            // Read-only routes are behind the token too. `GET /` renders the
            // token into every form on the page, so an open `/` would hand the
            // credential to anything that can guess the port; `/state` carries
            // the paused screen's accessibility tree.
            for (const path of ["/", "/state"]) {
              const open = yield* Effect.promise(async () => {
                const response = await fetch(desk.origin + path, { redirect: "manual" })
                return { status: response.status, body: await response.text() }
              })
              expect(open.status, `${path} answered without a token`).toBe(401)
              expect(open.body).not.toContain(desk.token)
            }

            // And the person the run printed a link for is not inconvenienced by
            // any of it: the link carries the token.
            const invited = yield* Effect.promise(() =>
              fetch(`${desk.origin}/?t=${desk.token}`).then((response) => response.status)
            )
            expect(invited).toBe(200)

            // The ordinary path still works, through the same interface, with the
            // same token a real operator's browser would be carrying -- and with
            // the headers that browser actually sends when it submits one of this
            // interface's own forms. A check that refused those would be a broken
            // page rather than a secure one.
            const fromTheForm = yield* Effect.promise(async () => {
              const response = await fetch(`${desk.origin}/take`, {
                method: "POST",
                redirect: "manual",
                headers: { origin: desk.origin, "sec-fetch-site": "same-origin" },
                body: new URLSearchParams({ token: desk.token, operator: "r.mensah" })
              })
              return response.status
            })
            expect(fromTheForm).toBe(303)
            expect((yield* desk.served).owner).toBe("operator")

            // Taking it twice is refused by the state machine, not by the token
            // check: 409, which is the interface behaving as it always did.
            expect((yield* desk.post("/take", { operator: "r.mensah" })).status).toBe(409)
            yield* desk.post("/return", {
              operator: "r.mensah",
              classification: "unresolved",
              detail: "looked, and left it for somebody with the authority",
              nextTime: "not_asked"
            })
          })
      })

      // One episode, closed once, by the only caller that was ever allowed to.
      expect(outcome.snapshot.resolved).toHaveLength(1)
      expect(outcome.snapshot.resolved[0]?.operator).toBe("r.mensah")
      expect(outcome.snapshot.resolved[0]?.nextTime).toBe("not_asked")
      expect(outcome.result.result).toBe("intervention_required")

      // Nothing forged reached Evidence either, which is the record an Amendment
      // would later be derived from.
      const resolutions = outcome.events.filter(
        (event) => event.kind === "intervention.resolve"
      )
      expect(resolutions).toHaveLength(1)
      expect(JSON.stringify(outcome.events)).not.toContain("not-a-real-person")
      expect(JSON.stringify(outcome.events)).not.toContain("automation_handles_it")
    }),
  60_000
)

it.live("the token is a per-run secret, and it is nowhere in the run's evidence", () =>
  Effect.gen(function* () {
    const tokens: Array<string> = []

    // Two interfaces, two runs, two tokens. A token derived from the port or
    // from a constant would make the first run's link work on the second, which
    // is the whole point of "per run".
    for (const runId of ["token-one", "token-two"]) {
      const outcome = yield* attendedReplay({
        artifact: shippedArtifact("member.account-balance", "1.1.0"),
        inputs: { memberId: RESTRICTED },
        runId,
        operate: (desk) =>
          Effect.gen(function* () {
            yield* desk.awaitPause
            tokens.push(desk.token)
            yield* desk.post("/take", { operator: "r.mensah" })
            yield* desk.post("/return", {
              operator: "r.mensah",
              classification: "unresolved",
              detail: "no authority here",
              nextTime: "not_asked"
            })
          })
      })

      // A credential in an evidence file outlives the process it protects.
      expect(JSON.stringify(outcome.events)).not.toContain(tokens.at(-1))
    }

    expect(tokens).toHaveLength(2)
    expect(tokens[0]).not.toBe(tokens[1])
    // base64url of 32 bytes. Long enough that guessing is not a strategy.
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(43)
  }),
  90_000
)
