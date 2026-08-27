/**
 * The Policy engine: one place that decides whether an Action may happen.
 *
 * Four claims, in increasing order of how much they cost to establish.
 *
 *   1. **The configuration is the policy.** The shipped `policies/*.yaml` files
 *      load, say what they appear to say, and a file that permits something
 *      irreversible without a reason does not load at all. Pure, no browser.
 *   2. **Origins mean origins.** Matching happens on parsed scheme, host and
 *      port, so the usual tricks for smuggling a hostname past an allowlist do
 *      not work. Pure.
 *   3. **A denial stops a run.** A disallowed origin and a disallowed action type
 *      each stop a real replay against a real Heritage Core in a real browser,
 *      and each leaves the reason in the Evidence.
 *   4. **The chokepoint cannot be bypassed.** Under a Policy that denies
 *      everything, the Surface Adapter is called zero times for anything that
 *      acts — counted on the real adapter, not a stub — and every `action` event
 *      in a successful run is preceded by an allowing `policy.check` for the same
 *      Step. Ticket 03's `replay-has-no-model.test.ts` establishes the same
 *      property statically by counting call sites; this establishes it
 *      behaviourally, which is the half that survives a refactor.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"
import { describe, expect } from "vitest"
import {
  type CompiledPolicy,
  type PolicyDocument,
  ACTION_TYPES,
  JUSTIFICATION_MINIMUM,
  POLICIES_DIRECTORY,
  RISK,
  RISKY_ACTION_TYPES,
  compilePolicy,
  decide,
  loadPolicy,
  REPEATABLE_JUSTIFICATION_MINIMUM,
  describeUnsafeRepeat,
  originOf,
  parseOriginPattern,
  riskOf,
  unsafeRepeats
} from "@cua/policy"
import {
  type CapabilityArtifact,
  type RecoverableCondition,
  recoverableConditions
} from "@cua/artifact"
import { type SurfaceAdapterService, SurfaceAdapter, playwrightSurface } from "@cua/surface"
import { replay, shippedArtifact, shippedPolicy } from "./support/replay-harness.ts"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const document = (overrides: Partial<PolicyDocument> = {}): PolicyDocument => ({
  policy: "test",
  description: "a policy written for a test",
  origins: ["http://127.0.0.1:*"],
  actions: [{ type: "navigate" }, { type: "extract" }],
  ...overrides
})

const justification = "x".repeat(JUSTIFICATION_MINIMUM)

const compiled = (overrides: Partial<PolicyDocument> = {}): CompiledPolicy => {
  const result = compilePolicy("test", document(overrides))
  if (Result.isFailure(result)) throw new Error(result.failure.message)
  return result.success
}

const problems = (overrides: Partial<PolicyDocument> = {}): ReadonlyArray<string> => {
  const result = compilePolicy("test", document(overrides))
  if (Result.isSuccess(result)) throw new Error("expected this policy to be refused")
  return result.failure.problems
}

/** An Action asking to happen. Every field a Policy is entitled to judge on. */
const asking = (
  type: string,
  extra: { readonly subject?: string; readonly page?: string; readonly mode?: "replay" | "discovery" } = {}
) => ({
  type,
  subject: extra.subject ?? "the button named Search",
  stepId: "a-step",
  mode: extra.mode ?? ("replay" as const),
  ...(extra.page === undefined ? {} : { page: extra.page })
})

// ---------------------------------------------------------------------------
// 1. Policy is configuration a reviewer can read
// ---------------------------------------------------------------------------

describe("the policy is the file, not the code", () => {
  it("both shipped policies load and say what they appear to say", () => {
    const operating = shippedPolicy()
    expect(operating.name).toBe("heritage-core-default")
    expect([...operating.permitted.get("replay")!.keys()].sort()).toEqual(
      ["click", "extract", "fill", "navigate", "selectFromList"]
    )

    const readOnly = shippedPolicy("read-only")
    expect(readOnly.name).toBe("heritage-core-read-only")
    expect([...readOnly.permitted.get("replay")!.keys()].sort()).toEqual(["extract", "navigate"])

    // The conservative half, stated as a property of the file rather than of a
    // default: read-only permits neither risky action, and it needed no
    // `because:` to say so, because a policy permits only what it lists.
    for (const risky of RISKY_ACTION_TYPES) {
      expect(readOnly.permitted.get("replay")!.has(risky)).toBe(false)
    }
  })

  it("every shipped policy is a document a reviewer can actually read", () => {
    for (const name of ["default", "read-only"]) {
      const text = readFileSync(`${POLICIES_DIRECTORY}/${name}.yaml`, "utf8")
      // A header explaining what the document is for, and prose in it. A policy
      // whose only content is a list of tokens is not reviewable.
      expect(text.startsWith("# Policy"), `${name} has no explanatory header`).toBe(true)
      expect(text).toMatch(/description: >/)
    }
  })

  it("permitting a risky action without a written reason refuses to load", () => {
    const said = problems({ actions: [{ type: "navigate" }, { type: "click" }] })
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/click is a risky Action/)
    expect(said[0]).toMatch(/cannot be undone/)
    expect(said[0]).toMatch(/because:/)
  })

  it("a token reason is not a reason", () => {
    const said = problems({
      actions: [{ type: "navigate" }, { type: "click", because: "needed" }]
    })
    expect(said[0]).toMatch(new RegExp(`at least ${JUSTIFICATION_MINIMUM} characters`))
  })

  it("a risky action with a real reason loads, and the reason travels to the verdict", () => {
    const policy = compiled({
      actions: [{ type: "navigate" }, { type: "click", because: justification }]
    })
    const verdict = decide(policy, asking("click", { page: "http://127.0.0.1:4173/member" }))
    expect(verdict.verdict).toBe("allow")
    expect(verdict.risk).toBe("risky")
    // The reviewer's argument for accepting the risk lands in the evidence event,
    // not only in a file nobody opens again.
    expect(verdict.reason).toContain(justification)
  })

  it("a policy cannot permit an action the vocabulary does not have", () => {
    const said = problems({ actions: [{ type: "executeScript" }] })
    expect(said[0]).toMatch(/executeScript is not an Action type this system has/)
    for (const type of ACTION_TYPES) expect(said[0]).toContain(type)
  })

  it("every problem in a file is reported at once", () => {
    const said = problems({
      origins: ["not-a-url", "http://127.0.0.1:*"],
      actions: [{ type: "click" }, { type: "teleport" }]
    })
    expect(said).toHaveLength(3)
  })

  it("a mode may narrow the allowlist and may not widen it", () => {
    const narrowed = compiled({
      actions: [
        { type: "navigate" },
        { type: "extract" },
        { type: "fill", because: justification }
      ],
      modes: { discovery: { actions: ["navigate", "extract"] } }
    })
    expect([...narrowed.permitted.get("replay")!.keys()]).toContain("fill")
    expect([...narrowed.permitted.get("discovery")!.keys()]).not.toContain("fill")

    const widened = problems({
      actions: [{ type: "navigate" }],
      modes: { discovery: { actions: ["navigate", "click"] } }
    })
    expect(widened[0]).toMatch(/A mode may only narrow the allowlist, never widen it/)
  })

  it("a missing policy file is a stopped run, not an unrestricted one", () => {
    const loaded = loadPolicy(POLICIES_DIRECTORY, "no-such-policy")
    expect(Result.isFailure(loaded)).toBe(true)
    if (Result.isFailure(loaded)) {
      expect(loaded.failure.message).toMatch(/no unrestricted default to fall back to/)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Risk classification, and its exhaustiveness
// ---------------------------------------------------------------------------

describe("risk classification", () => {
  it("splits the vocabulary into what reads and what writes", () => {
    expect(RISK).toEqual({
      navigate: "safe",
      extract: "safe",
      fill: "risky",
      click: "risky",
      selectFromList: "risky"
    })
    expect([...RISKY_ACTION_TYPES].sort()).toEqual(["click", "fill", "selectFromList"])
  })

  it("classifies every action type the artifact vocabulary contains", () => {
    // `RISK` is `satisfies Record<ActionType, Risk>`, so an unclassified action
    // type is a compile error rather than an assertion here. What this catches is
    // the other direction: the vocabulary growing in a way the type-level check
    // cannot see, e.g. a literal added to the union in a shape TypeScript widens.
    const vocabulary = readFileSync("packages/artifact/src/Action.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
    const declared = [...vocabulary.matchAll(/type:\s*Schema\.Literal\("(\w+)"\)/g)].map(
      (match) => match[1]!
    )
    expect(declared.sort()).toEqual([...ACTION_TYPES].sort())
  })

  it("an action nobody classified is unknown, and unknown is always denied", () => {
    expect(riskOf("transferFunds")).toBe("unknown")

    // Not reachable from a Capability Artifact — the union would not decode — but
    // exactly what a Discovery model proposing an invented verb produces.
    const verdict = decide(
      compiled(),
      asking("executeScript", { page: "http://127.0.0.1:4173/", mode: "discovery" })
    )
    expect(verdict.verdict).toBe("deny")
    expect(verdict.risk).toBe("unknown")
    expect(verdict.reason).toMatch(/is not an Action this system has/)
  })
})

// ---------------------------------------------------------------------------
// 3. What an allowed origin means
// ---------------------------------------------------------------------------

describe("origin matching", () => {
  const allows = (pattern: string, url: string): boolean => {
    const parsed = parseOriginPattern(pattern)
    if ("problem" in parsed) throw new Error(parsed.problem)
    const policy = compiled({ origins: [pattern] })
    return decide(policy, asking("navigate", { subject: url })).verdict === "allow"
  }

  it("pins the port unless the pattern says otherwise", () => {
    expect(allows("http://127.0.0.1:4173", "http://127.0.0.1:4173/member")).toBe(true)
    expect(allows("http://127.0.0.1:4173", "http://127.0.0.1:9999/member")).toBe(false)
    expect(allows("http://127.0.0.1:*", "http://127.0.0.1:9999/member")).toBe(true)
  })

  it("pins the scheme", () => {
    expect(allows("https://mss.heritagecu.example", "http://mss.heritagecu.example/")).toBe(false)
    expect(allows("https://mss.heritagecu.example", "https://mss.heritagecu.example/")).toBe(true)
  })

  it("a subdomain wildcard covers hosts under the domain and not the domain itself", () => {
    expect(allows("https://*.heritagecu.example", "https://mss.heritagecu.example/")).toBe(true)
    expect(allows("https://*.heritagecu.example", "https://heritagecu.example/")).toBe(false)
    // The one that matters: a lookalike domain that merely ends with the text.
    expect(allows("https://*.heritagecu.example", "https://evil-heritagecu.example/")).toBe(false)
  })

  it("is not fooled by a URL that merely contains an allowed origin", () => {
    expect(allows("http://127.0.0.1:*", "http://elsewhere.test/?next=http://127.0.0.1:4173")).toBe(
      false
    )
    expect(allows("http://127.0.0.1:*", "http://elsewhere.test/#http://127.0.0.1:4173")).toBe(false)
    // Userinfo: the host here is elsewhere.test, whatever it reads like.
    expect(allows("http://127.0.0.1:*", "http://127.0.0.1@elsewhere.test/")).toBe(false)
  })

  it("refuses a pattern it does not understand rather than ignoring it", () => {
    for (const bad of ["*", "127.0.0.1", "ftp://host", "http://host/path", "http://host:port"]) {
      const parsed = parseOriginPattern(bad)
      expect("problem" in parsed, `${bad} was accepted`).toBe(true)
    }
  })

  it("a page with no origin is a page nothing can act on", () => {
    expect(originOf("about:blank")).toBeUndefined()

    const policy = compiled({
      actions: [{ type: "navigate" }, { type: "extract" }, { type: "fill", because: justification }]
    })
    // Navigating away from the blank page a browser starts on is the only
    // sensible thing to do with it.
    expect(
      decide(policy, asking("navigate", { subject: "http://127.0.0.1:4173/", page: "about:blank" }))
        .verdict
    ).toBe("allow")

    const acting = decide(policy, asking("fill", { page: "about:blank" }))
    expect(acting.verdict).toBe("deny")
    expect(acting.reason).toMatch(/no page is open/)
  })

  it("an action that names no page at all is denied for the same reason", () => {
    // `page` is optional in `ActionRequest` — it is genuinely absent before
    // anything is open. Optional must not mean the origin guard is opt-in: a
    // caller that simply left the field out would otherwise be a cheaper way
    // past the allowlist than one that supplied an off-allowlist URL, and the
    // weakest call site would silently set the standard for all of them.
    const policy = compiled({
      actions: [
        { type: "navigate" },
        { type: "extract" },
        { type: "fill", because: justification },
        { type: "click", because: justification }
      ]
    })

    for (const type of ["fill", "click", "extract"]) {
      const verdict = decide(policy, asking(type))
      expect(verdict.verdict, `${type} with no page`).toBe("deny")
      expect(verdict.reason).toMatch(/names no page/)
      expect(verdict.origin).toBeUndefined()
    }

    // Navigation keeps its exception: it is the one thing worth doing from
    // nowhere, and where it would go is judged on its own.
    expect(decide(policy, asking("navigate", { subject: "http://127.0.0.1:4173/" })).verdict).toBe(
      "allow"
    )
    expect(decide(policy, asking("navigate", { subject: "http://elsewhere.test/" })).verdict).toBe(
      "deny"
    )
  })
})

// ---------------------------------------------------------------------------
// 4. Both ends of the run are checked
// ---------------------------------------------------------------------------

describe("every action is judged against the origin it happens on", () => {
  const policy = () =>
    compiled({
      origins: ["http://127.0.0.1:*"],
      actions: [
        { type: "navigate" },
        { type: "extract" },
        { type: "click", because: justification }
      ]
    })

  it("allows a permitted action on an allowed origin", () => {
    const verdict = decide(policy(), asking("click", { page: "http://127.0.0.1:4173/member" }))
    expect(verdict.verdict).toBe("allow")
    expect(verdict.origin).toBe("http://127.0.0.1:4173")
    expect(verdict.policy).toBe("test")
  })

  it("denies even a safe action once the run has drifted off the allowlist", () => {
    // The case an allowlist that only checked navigations would miss entirely: a
    // click followed a link somewhere unexpected, and everything after it would
    // otherwise run unchecked on whatever came back.
    const verdict = decide(policy(), asking("extract", { page: "http://elsewhere.test/member" }))
    expect(verdict.verdict).toBe("deny")
    expect(verdict.reason).toMatch(/this run is on http:\/\/elsewhere\.test/)
    expect(verdict.reason).toMatch(/http:\/\/127\.0\.0\.1:\*/)
  })

  it("denies a navigation off the allowlist from a page that is on it", () => {
    const verdict = decide(
      policy(),
      asking("navigate", { subject: "http://elsewhere.test/", page: "http://127.0.0.1:4173/" })
    )
    expect(verdict.verdict).toBe("deny")
    expect(verdict.reason).toMatch(/is not an allowed origin/)
  })

  it("denies a navigation subject that is not an absolute http url", () => {
    const verdict = decide(policy(), asking("navigate", { subject: "/member?memberNumber=12345" }))
    expect(verdict.verdict).toBe("deny")
    expect(verdict.reason).toMatch(/not an absolute http or https URL/)
  })
})

// ---------------------------------------------------------------------------
// 5. A denial stops a real run
// ---------------------------------------------------------------------------

/** A Policy that permits nothing at all. The most conservative file expressible. */
const DENY_EVERYTHING = compiled({ policy: "deny-everything", actions: [] })

describe("a policy violation stops the run", () => {
  it.live("navigating outside the allowed origins stops it at the first step", () =>
    Effect.gen(function* () {
      // TEST-NET-2. Nothing is listening, and nothing tries: the denial happens
      // before the adapter is asked to open anything.
      const outcome = yield* replay({
        artifact: shippedArtifact(),
        inputs: { memberId: "12345" },
        baseUrl: "http://198.51.100.7:8080"
      })

      expect(outcome.result.result).toBe("failure")
      if (outcome.result.result !== "failure") return
      expect(outcome.result.failure.reason).toBe("policy_violation")
      expect(outcome.result.failure.stepId).toBe("open-member-search")
      expect(outcome.result.failure.observed).toMatch(/is not an allowed origin/)

      // The run stopped before it did anything, which is the whole point.
      const kinds = outcome.events.map((event) => event.kind)
      expect(kinds.filter((kind) => kind === "action")).toEqual([])

      const check = outcome.events.find((event) => event.kind === "policy.check")
      expect(check && "verdict" in check ? check.verdict : undefined).toBe("deny")
      expect(check && "policy" in check ? check.policy : undefined).toBe("heritage-core-default")
    })
  )

  it.live("a navigate path supplied as a parameter cannot leave the allowlist", () =>
    Effect.gen(function* () {
      // An Artifact's `navigate` takes a *path*, resolved against the tenant's
      // base URL with `new URL(path, baseUrl)` — and an absolute URL wins over a
      // base, so a `{ from: parameter }` path is somewhere a caller could put a
      // whole foreign origin. Nothing in the engine special-cases that, and
      // nothing needs to: Policy judges a navigate against the origin it would
      // actually reach, which is what `new URL` just computed. This is that
      // argument as a run rather than as a claim.
      const stored = shippedArtifact()
      const [first, ...rest] = stored.steps
      const artifact: CapabilityArtifact = {
        ...stored,
        inputs: {
          ...stored.inputs,
          destination: {
            type: "string",
            description: "where the first step opens, supplied by the caller",
            required: true
          }
        },
        steps: [
          {
            ...first!,
            action: { type: "navigate", path: { from: "parameter", name: "destination" } }
          },
          ...rest
        ]
      }

      const outcome = yield* replay({
        artifact,
        // TEST-NET-2, absolute. The base URL the run was given is the allowed
        // in-process fixture; this path ignores it entirely.
        inputs: { memberId: "12345", destination: "http://198.51.100.7:8080/member" }
      })

      expect(outcome.result.result).toBe("failure")
      if (outcome.result.result !== "failure") return
      expect(outcome.result.failure.reason).toBe("policy_violation")
      expect(outcome.result.failure.stepId).toBe("open-member-search")
      expect(outcome.result.failure.observed).toMatch(
        /198\.51\.100\.7:8080 is not an allowed origin/
      )

      // Nothing was opened, so nothing is on that origin to be acted on next.
      expect(outcome.events.filter((event) => event.kind === "action")).toEqual([])

      // And Policy was asked about the resolved destination, not about the path
      // as written — which is the reason no separate check is needed.
      //
      // The subject reads as the placeholder because the evidence scrubber
      // replaces the parameter's value wherever it appears, and it replaces the
      // whole literal. That it matched at all is the proof: the subject Policy
      // judged was character-for-character the URL the caller supplied. The
      // verdict's own prose keeps the origin, which the scrubber has no needle
      // for.
      const check = outcome.events.find((event) => event.kind === "policy.check")
      expect(check && "subject" in check ? check.subject : undefined).toBe(
        "[redacted:destination]"
      )
      expect(check && "reason" in check ? check.reason : undefined).toMatch(
        /198\.51\.100\.7:8080 is not an allowed origin/
      )
    })
  )

  it.live("an action type outside the allowlist stops it at the step that needs it", () =>
    Effect.gen(function* () {
      // The shipped read-only policy. It cannot type and it cannot press, so the
      // capability gets as far as the search screen and no further.
      const outcome = yield* replay({
        artifact: shippedArtifact(),
        inputs: { memberId: "12345" },
        policy: shippedPolicy("read-only")
      })

      expect(outcome.result.result).toBe("failure")
      if (outcome.result.result !== "failure") return
      expect(outcome.result.failure.reason).toBe("policy_violation")
      expect(outcome.result.failure.stepId).toBe("enter-member-number")
      expect(outcome.result.failure.observed).toMatch(
        /does not permit fill in replay mode/
      )
      expect(outcome.result.failure.observed).toMatch(/risky action/)

      // The safe step before it was allowed and did happen, so this is a denial
      // of one action type rather than of everything.
      const actions = outcome.events.flatMap((event) =>
        event.kind === "action" ? [event.action] : []
      )
      expect(actions).toEqual(["navigate"])

      const verdicts = outcome.events.flatMap((event) =>
        event.kind === "policy.check" ? [`${event.action}:${event.verdict}`] : []
      )
      expect(verdicts).toEqual(["navigate:allow", "fill:deny"])
    })
  )
})

// ---------------------------------------------------------------------------
// 6. The chokepoint cannot be bypassed
// ---------------------------------------------------------------------------

/**
 * The real Playwright adapter with a tally around the four acting methods.
 *
 * Not a stub: every call is forwarded to the adapter ticket 02 built, driving a
 * real Chromium against the real Heritage Core. It counts, and that is all it
 * does. SPEC rules out browser stubbing; it does not rule out watching.
 */
const countingSurface = (
  tally: Record<string, number>
): ReturnType<typeof playwrightSurface> =>
  Layer.effect(SurfaceAdapter)(
    Effect.gen(function* () {
      const inner = yield* SurfaceAdapter
      const counted = <A extends ReadonlyArray<unknown>, R>(
        name: string,
        method: (...args: A) => R
      ) =>
      (...args: A): R => {
        tally[name] = (tally[name] ?? 0) + 1
        return method(...args)
      }
      return {
        ...inner,
        navigate: counted("navigate", inner.navigate),
        click: counted("click", inner.click),
        fill: counted("fill", inner.fill),
        extract: counted("extract", inner.extract)
      } satisfies SurfaceAdapterService
    })
  ).pipe(Layer.provide(playwrightSurface({})))

describe("the chokepoint", () => {
  it.live("lets nothing reach the adapter when the policy denies everything", () =>
    Effect.gen(function* () {
      const tally: Record<string, number> = {}
      const outcome = yield* replay({
        artifact: shippedArtifact(),
        inputs: { memberId: "12345" },
        policy: DENY_EVERYTHING,
        surface: countingSurface(tally)
      })

      expect(outcome.result.result).toBe("failure")

      // The claim, counted on the real adapter: six steps asked, none acted.
      expect(tally).toEqual({})

      // And the run still left a record of being stopped, because a denial that
      // skipped the evidence would be an unauditable control.
      const checks = outcome.events.filter((event) => event.kind === "policy.check")
      expect(checks).toHaveLength(1)
      expect(checks[0] && "verdict" in checks[0] ? checks[0].verdict : undefined).toBe("deny")
    })
  )

  it.live("puts an allowing policy check in front of every action that happens", () =>
    Effect.gen(function* () {
      const outcome = yield* replay({
        artifact: shippedArtifact(),
        inputs: { memberId: "12345" }
      })

      expect(outcome.result.result).toBe("success")

      // One check per Step's Action, plus one for the single Checkpoint in this
      // capability that reads a control back. Six and one.
      const checks = outcome.events.flatMap((event) =>
        event.kind === "policy.check" ? [event] : []
      )
      expect(checks).toHaveLength(shippedArtifact().steps.length + 1)
      expect(checks.every((check) => check.verdict === "allow")).toBe(true)
      expect(checks.every((check) => check.policy === "heritage-core-default")).toBe(true)
      expect(checks.every((check) => check.risk === RISK[check.action as keyof typeof RISK])).toBe(
        true
      )
      // The first action opens the run, so its own page is the blank one a
      // browser starts on and it is judged on its destination alone. Every check
      // after it names the origin the run was actually sitting on.
      expect(checks[0]!.origin).toBeUndefined()
      for (const check of checks.slice(1)) {
        expect(check.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      }

      // Every action that happened had an allowing check for the same step and
      // the same action type recorded before it. Reading those two sequences off
      // one file is what makes "nothing acted unchecked" auditable by someone who
      // does not want to take the engine's word for it.
      const seq = outcome.events.flatMap((event) =>
        event.kind === "policy.check" || event.kind === "action" ? [event] : []
      )
      for (const [index, event] of seq.entries()) {
        if (event.kind !== "action") continue
        const before = seq[index - 1]
        expect(before?.kind).toBe("policy.check")
        if (before === undefined || before.kind !== "policy.check") continue
        expect(before.verdict).toBe("allow")
        expect(before.action).toBe(event.action)
        expect(before.stepId).toBe(event.stepId)
      }
    })
  )

  it.live("gates the reads a checkpoint makes, not only the steps", () =>
    Effect.gen(function* () {
      // A Checkpoint's `targetReads` assertion reads a live control, which is an
      // `extract` however it is spelled. This policy permits everything the
      // capability's Steps need and refuses `extract`, so the only thing that can
      // stop the run at the fill step is its Checkpoint's read being refused.
      const tally: Record<string, number> = {}
      const outcome = yield* replay({
        artifact: shippedArtifact(),
        inputs: { memberId: "12345" },
        policy: compiled({
          policy: "no-reading",
          actions: [
            { type: "navigate" },
            { type: "fill", because: justification },
            { type: "click", because: justification }
          ]
        }),
        surface: countingSurface(tally)
      })

      expect(outcome.result.result).toBe("failure")
      if (outcome.result.result !== "failure") return
      expect(outcome.result.failure.reason).toBe("policy_violation")
      expect(outcome.result.failure.stepId).toBe("enter-member-number")

      // The fill itself was permitted and happened; the checkpoint's read of it
      // was not, and the adapter's `extract` was never called.
      expect(tally["fill"]).toBe(1)
      expect(tally["extract"]).toBeUndefined()

      const verdicts = outcome.events.flatMap((event) =>
        event.kind === "policy.check" ? [`${event.action}:${event.verdict}`] : []
      )
      expect(verdicts).toEqual(["navigate:allow", "fill:allow", "extract:deny"])
    })
  )

  it.live("gates the reads an outcome branch makes, not only the ones in expect", () =>
    Effect.gen(function* () {
      // The same bypass, one level in. `orOutcome[].when` takes ordinary
      // Assertions, so a `targetReads` can sit in a branch — and `evaluate` puts
      // a branch's conditions to the screen through exactly the `context.read`
      // that `expect` uses. Authorising only `expect` left that read reaching
      // `surface.extract` with no `policy.check` in front of it and no deny
      // path, which is the one thing a chokepoint cannot have. Measured before
      // the fix: `{ navigate: 1, extract: 1 }` on the adapter, and a single
      // `navigate:allow` verdict in the whole log.
      //
      // `expect` here is written so it cannot hold, because that is what makes
      // the branch actually get evaluated.
      const stored = shippedArtifact()
      const [first, ...rest] = stored.steps
      const tally: Record<string, number> = {}
      const outcome = yield* replay({
        artifact: {
          ...stored,
          steps: [
            {
              ...first!,
              checkpoint: {
                description: "a checkpoint whose intended state never arrives",
                withinMillis: 0,
                expect: [{ assert: "textPresent", text: "No Such Text On Any Screen" }],
                orOutcome: [
                  {
                    code: "MEMBER_NOT_FOUND",
                    when: [
                      {
                        assert: "targetReads",
                        target: {
                          role: "textbox",
                          name: "Member Number",
                          within: { name: "Member Number Search" },
                          strategy: "scoped-accessible-name",
                          robustness:
                            "The search panel's own number field, named the way a screen " +
                            "reader would announce it. Written here only to put a live read " +
                            "inside an outcome branch, which is the position this test exists " +
                            "to prove is gated."
                        },
                        equals: { from: "constant", text: "" }
                      }
                    ]
                  }
                ]
              }
            },
            ...rest
          ]
        },
        inputs: { memberId: "12345" },
        policy: compiled({
          policy: "no-reading",
          actions: [
            { type: "navigate" },
            { type: "fill", because: justification },
            { type: "click", because: justification }
          ]
        }),
        surface: countingSurface(tally)
      })

      expect(outcome.result.result).toBe("failure")
      if (outcome.result.result !== "failure") return
      expect(outcome.result.failure.reason).toBe("policy_violation")
      expect(outcome.result.failure.stepId).toBe("open-member-search")

      // Nothing read the screen. Without the gate this is 1.
      expect(tally["extract"]).toBeUndefined()

      const verdicts = outcome.events.flatMap((event) =>
        event.kind === "policy.check" ? [`${event.action}:${event.verdict}`] : []
      )
      expect(verdicts).toEqual(["navigate:allow", "extract:deny"])
    })
  )
})

// ---------------------------------------------------------------------------
// (5) A recovery may not repeat a risky Action without saying why
// ---------------------------------------------------------------------------

/**
 * The gap ticket 06 flagged and could not close from where it stood.
 *
 * A Recoverable Condition that resumes `at-step` navigates back to where a Step
 * began and performs that Step's Action **again**. Right for a read; wrong for a
 * transfer. Nothing stopped an Artifact declaring one over an irreversible
 * Action, and the risk classification that could tell the difference lives here
 * rather than in the schema.
 *
 * So the refusal lives here too, as ticket 06's own note said it should. It is
 * ticket 07's `because:` precedent one layer up: a risky thing cannot be
 * permitted silently, and the argument for permitting it travels in the document
 * a person approves. The engine asks before a run performs anything, so a rule
 * that could repeat an irreversible Action never reaches a browser.
 */
describe("repeating an action during a recovery", () => {
  const rule = (overrides: Partial<RecoverableCondition> = {}): RecoverableCondition =>
    ({
      condition: "SOMETHING",
      description: "A transient state.",
      detect: [{ assert: "textPresent", text: "Busy" }],
      remedy: [],
      resume: "at-step",
      attempts: 2,
      backoffMillis: 100,
      ...overrides
    }) as RecoverableCondition

  const capability = (
    steps: ReadonlyArray<"navigate" | "extract" | "click">,
    rules: ReadonlyArray<RecoverableCondition>
  ): CapabilityArtifact =>
    ({
      ...shippedArtifact(),
      steps: steps.map((type, index) => ({
        id: `step-${index}`,
        intent: `Do a ${type}.`,
        action:
          type === "navigate"
            ? { type, path: { from: "constant", text: "/" } }
            : {
                type,
                target: { role: "cell", name: "Thing", strategy: "name", robustness: "because" }
              },
        checkpoint: { description: "It happened.", expect: [{ assert: "textPresent", text: "x" }] }
      })),
      recoverable: rules
    }) as unknown as CapabilityArtifact

  it("refuses an at-step rule whose remedy would repeat a risky action", () => {
    const unsafe = unsafeRepeats(
      capability(
        ["navigate"],
        [
          rule({
            remedy: [
              {
                intent: "Press it.",
                action: {
                  type: "click",
                  target: {
                    role: "button",
                    name: "Go",
                    strategy: "name",
                    robustness: "because"
                  }
                }
              }
            ] as RecoverableCondition["remedy"]
          })
        ]
      )
    )

    expect(unsafe).toHaveLength(1)
    expect(unsafe[0]?.actions).toEqual(["click"])
    expect(describeUnsafeRepeat(unsafe[0]!)).toContain("SOMETHING")
  })

  it("refuses an at-step rule in a capability whose own steps are risky", () => {
    // The rule's remedy is empty and still it is refused: `at-step` re-attempts
    // whichever Step it fired at, and nothing in the Artifact says which Steps a
    // `detect` matches. Guessing narrower would pass the document whose riskiest
    // Step is exactly the one the condition shows up at.
    const unsafe = unsafeRepeats(capability(["navigate", "click"], [rule()]))
    expect(unsafe.map((problem) => problem.actions)).toEqual([["click"]])
  })

  it("allows an at-step rule over a capability that only reads", () => {
    expect(unsafeRepeats(capability(["navigate", "extract"], [rule()]))).toEqual([])
  })

  it("allows a `resume: here` rule with an empty remedy, which repeats nothing", () => {
    // `here` re-evaluates the Checkpoint where it stands and performs no Step
    // Action, so the capability's own risky `click` is not in play. With nothing
    // in the remedy either, there is nothing that can happen twice.
    expect(unsafeRepeats(capability(["navigate", "click"], [rule({ resume: "here" })]))).toEqual([])
  })

  it("refuses a `resume: here` rule whose remedy performs a risky action more than once", () => {
    // The exemption this replaces. `resume` decides where the run carries on
    // *after* the remedy; it says nothing about the remedy itself, which the
    // engine performs at the top of every attempt (`recover` in
    // packages/replay/src/recovery.ts). So `attempts: 3` presses this button up
    // to three times, and pressing something three times is exactly what the
    // `repeatable:` justification exists to make somebody argue for.
    const unsafe = unsafeRepeats(
      capability(
        ["navigate", "extract"],
        [
          rule({
            resume: "here",
            attempts: 3,
            remedy: [
              {
                intent: "Press it.",
                action: {
                  type: "click",
                  target: {
                    role: "button",
                    name: "Continue",
                    strategy: "name",
                    robustness: "because"
                  }
                }
              }
            ] as RecoverableCondition["remedy"]
          })
        ]
      )
    )

    expect(unsafe).toHaveLength(1)
    expect(unsafe[0]?.actions).toEqual(["click"])
    // The reason names the field that causes it, so a reviewer knows which half
    // of the rule to argue for or change. Not `resume`, which is innocent here.
    expect(unsafe[0]?.remedy).toContain("attempts: 3")
    expect(unsafe[0]?.remedy).not.toContain("resume: at-step performs")
  })

  it("allows the same `resume: here` remedy at a single attempt, because once is not twice", () => {
    // The boundary, stated. A remedy Action performed exactly once has not been
    // repeated, and demanding an argument for it would teach the wrong lesson
    // about when one is needed.
    expect(
      unsafeRepeats(
        capability(
          ["navigate", "extract"],
          [
            rule({
              resume: "here",
              attempts: 1,
              remedy: [
                {
                  intent: "Press it.",
                  action: {
                    type: "click",
                    target: {
                      role: "button",
                      name: "Continue",
                      strategy: "name",
                      robustness: "because"
                    }
                  }
                }
              ] as RecoverableCondition["remedy"]
            })
          ]
        )
      )
    ).toEqual([])
  })

  it("does not accept a one-line assurance as a justification", () => {
    const short = unsafeRepeats(
      capability(["navigate", "click"], [rule({ repeatable: "It is fine." })])
    )
    expect(short).toHaveLength(1)
    expect(short[0]?.remedy).toContain(`${REPEATABLE_JUSTIFICATION_MINIMUM}`)
  })

  it("accepts an argument somebody actually made", () => {
    const argued = rule({
      repeatable:
        "Every action this capability performs is a read: a navigation, a search field, or " +
        "a reading. None of them posts a transaction, so performing one twice returns the " +
        "same screen it returned the first time."
    })
    expect(unsafeRepeats(capability(["navigate", "click"], [argued]))).toEqual([])
  })

  it("both of the shipped artifact's retrying rules are argued for", () => {
    // The session-expiry rule resumes `at-step` and this capability's steps
    // include a `fill`, a `click` and a `selectFromList`, all classified risky.
    // The transient-overlay rule resumes `here` and still retries: `attempts: 3`
    // presses its Continue link up to three times, and a `click` is risky. Both
    // are legal because the artifact says in writing why repeating a read-only
    // request is safe — not because the check happens to miss either of them.
    expect(unsafeRepeats(shippedArtifact())).toEqual([])

    const retrying = recoverableConditions(shippedArtifact()).filter(
      (declared) => declared.resume === "at-step" || declared.attempts > 1
    )
    expect(retrying.length).toBeGreaterThanOrEqual(2)
    for (const declared of retrying) {
      expect(declared.repeatable ?? "").not.toBe("")
    }
  })

  // `it.live`, not `it`. An Effect is not a thenable, so a plain `it` returning
  // one never runs the generator at all and the test passes having asserted
  // nothing. It was the only case in this file not using `it.live`, and it drives
  // a real browser through the harness like the others.
  it.live("stops a run before it performs anything, rather than when the rule fires", () =>
    Effect.gen(function* () {
      const tally: Record<string, number> = {}
      const outcome = yield* replay({
        artifact: capability(["navigate", "click"], [rule()]),
        inputs: { memberId: "12345" },
        surface: countingSurface(tally)
      })

      expect(outcome.result.result).toBe("failure")
      if (outcome.result.result !== "failure") return
      expect(outcome.result.failure.reason).toBe("artifact_unexecutable")
      expect(outcome.result.failure.observed).toContain("SOMETHING")

      // Nothing acted, and there is not even a `run.start`: the refusal happens
      // before the run announces itself, so a rule that could repeat an
      // irreversible action never reaches a browser.
      expect(tally).toEqual({})
      expect(outcome.events.filter((event) => event.kind === "action")).toEqual([])
    })
  )
})
