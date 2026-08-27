/**
 * Regulated data stays out of everything we persist.
 *
 * SPEC calls the first test here the highest value-per-line test in the suite,
 * and the reason is that it turns a safety claim into something that can be
 * wrong. Every other kind of assertion about redaction — that the scrubber was
 * called, that the type is `Redacted`, that a code path exists — is a statement
 * about the mechanism. This one is a statement about the *outcome*: a real run
 * happens against the real Heritage Core, and then every byte of text it wrote,
 * plus every Artifact on disk, is searched for the member number.
 *
 * A scan that only ever runs against a clean tree is indistinguishable from a
 * scan that matches nothing, so the second test plants the member number in the
 * evidence directory and requires the same function to find it. Without that,
 * the first test proves the walker compiles.
 *
 * The rest pin the mechanisms the outcome rests on, each as external behaviour:
 * what a `Redacted` renders as, what the classification rule decides, how many
 * places in the workspace can unwrap, and what the evidence directory tells a
 * reviewer about the screenshot it cannot protect.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { extname, join } from "node:path"
import { it } from "@effect/vitest"
import { Effect, Redacted, Result } from "effect"
import { expect } from "vitest"
import {
  ARTIFACTS_DIRECTORY,
  OVERRIDES_DIRECTORY,
  bakedInLiterals,
  prepareInputs
} from "@cua/artifact"
import { placeholderFor, scrubbing } from "@cua/evidence"
import { declassifierFor, declassifying, sensitivityPolicy } from "@cua/policy"
import { scrubberFor, sensitiveNames } from "@cua/replay"
import { replay, shippedArtifact } from "./support/replay-harness.ts"
import {
  type Appearance,
  UNSCANNED_EXTENSIONS,
  describeAppearances,
  filesUnder,
  scanForSecrets
} from "./support/secret-scan.ts"

/**
 * The member the demo runs on. Sensitive by declaration and by policy, and
 * rendered on every screen the run touches — so it is in the accessibility tree,
 * in the URL query string and in the field the run typed it into.
 */
const MEMBER_ID = "12345"

/** Every scenario member number SPEC lists. All of them are member identifiers. */
const EVERY_MEMBER_ID = ["12345", "99999", "88888", "77777", "55555"]

// ---------------------------------------------------------------------------
// The headline test
// ---------------------------------------------------------------------------

it.live("no sensitive value appears in any artifact or any text evidence file", () =>
  Effect.gen(function* () {
    const { result, evidenceDirectory } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: MEMBER_ID }
    })

    // A run that failed early might not have reached the screens where the value
    // is rendered, and would pass this test by not having done anything.
    expect(result.result).toBe("success")

    const inEvidence = scanForSecrets(evidenceDirectory, [MEMBER_ID])
    expect(describeAppearances(inEvidence)).toBe("")

    // Artifacts are scanned for every scenario identifier, not just this run's.
    // A Capability Artifact is supposed to contain no runtime value at all
    // (ADR-0008), so any of them appearing is the same bug.
    const inArtifacts = scanForSecrets(ARTIFACTS_DIRECTORY, EVERY_MEMBER_ID)
    expect(describeAppearances(inArtifacts)).toBe("")

    // Tenant overrides are the second kind of document that lands on disk and
    // outlives the run it came from, and they quote an Operator's own sentence
    // verbatim — which is exactly where somebody types a member number without
    // thinking. Same rule, same scan, same walker.
    const inOverrides = scanForSecrets(OVERRIDES_DIRECTORY, EVERY_MEMBER_ID)
    expect(describeAppearances(inOverrides)).toBe("")

    // And the scan was not vacuous: it read files, and they were the ones the run
    // produced.
    const scanned = filesUnder(evidenceDirectory)
    expect(scanned.length).toBeGreaterThan(0)
    expect(scanned.some((path) => path.endsWith("events.jsonl"))).toBe(true)
    expect(filesUnder(ARTIFACTS_DIRECTORY).length).toBeGreaterThan(0)
    expect(filesUnder(OVERRIDES_DIRECTORY).length).toBeGreaterThan(0)
  })
)

it.live("the same scan catches a planted member number, so a pass means something", () =>
  Effect.gen(function* () {
    const { evidenceDirectory } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: MEMBER_ID }
    })

    // A copy, so the plant cannot affect anything else, walked by the same
    // function the test above trusts.
    const planted = join(mkdtempSync(join(tmpdir(), "cua-plant-")), "evidence")
    cpSync(evidenceDirectory, planted, { recursive: true })

    // Three plants, one per way redaction actually gets lost in systems like this:
    // an event field nobody taught the scrubber about, a stray debug dump beside
    // the log, and a file in a subdirectory nothing thought to walk into.
    const log = join(planted, "events.jsonl")
    const leakedEvent = JSON.stringify({
      kind: "observe",
      url: `http://example/member?memberNumber=${MEMBER_ID}`,
      accessibility: `cell "${MEMBER_ID}"`
    })
    writeFileSync(log, `${readFileSync(log, "utf8")}${leakedEvent}\n`)
    writeFileSync(join(planted, "debug.txt"), `dumped member ${MEMBER_ID} for troubleshooting\n`)
    mkdirSync(join(planted, "frames"), { recursive: true })
    writeFileSync(join(planted, "frames", "panel.yaml"), `member: ${MEMBER_ID}\n`)

    const caught = scanForSecrets(planted, [MEMBER_ID])
    const where = caught.map((appearance: Appearance) => appearance.file)
    expect(where).toContain("events.jsonl")
    expect(where).toContain("debug.txt")
    expect(where).toContain(join("frames", "panel.yaml"))

    // The failure message names the file, the line and the value, because the
    // person reading it at that moment has a leak to go and find.
    const described = describeAppearances(caught)
    expect(described).toContain("debug.txt:1")
    expect(described).toContain(MEMBER_ID)

    // A control on the control: the untouched copy of the same tree is clean, so
    // what the scan found was the plant and not something the run had left there.
    expect(scanForSecrets(evidenceDirectory, [MEMBER_ID])).toEqual([])
  })
)

// ---------------------------------------------------------------------------
// The type refuses to print
// ---------------------------------------------------------------------------

it("a resolved input renders as a placeholder through every ordinary way out", () => {
  const prepared = prepareInputs("member.account-balance", shippedArtifact().inputs, {
    memberId: MEMBER_ID
  })
  if (!Result.isSuccess(prepared)) throw new Error("expected valid inputs")
  const memberId = prepared.success.get("memberId")!

  // The four ways a value leaks without anyone meaning to.
  expect(String(memberId.text)).toBe("<redacted:memberId>")
  expect(`${memberId.text}`).toBe("<redacted:memberId>")
  expect(JSON.stringify(memberId)).not.toContain(MEMBER_ID)
  expect(JSON.stringify({ inputs: [memberId] })).toContain("<redacted:memberId>")

  // The label is the parameter name, so a leak that does happen says which
  // parameter it was rather than just that something was hidden.
  expect(JSON.stringify(memberId)).toContain("memberId")

  // And getting the characters back takes the one greppable call.
  expect(Redacted.value(memberId.text)).toBe(MEMBER_ID)
})

/**
 * Source with comments removed.
 *
 * The test below counts *calls*, and several modules discuss `Redacted.value` in
 * their documentation — which is the point of documenting it. Scanning the prose
 * as though it were code would make the test fire on someone explaining the rule.
 */
const withoutComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "")

it("unwrapping is confined to three named call sites, and all are greppable", () => {
  const sources = filesUnder("packages").filter((path) => extname(path) === ".ts")
  const unwrapping = sources.filter((path) =>
    withoutComments(readFileSync(path, "utf8")).includes("Redacted.value(")
  )

  // Three, and exactly which three. A fourth is not forbidden — a future ticket
  // may genuinely need one — but it cannot arrive unnoticed. This test fails, and
  // whoever adds it has to say in the diff why it is safe.
  //
  // The third arrived with ticket 10 and this comment is that argument.
  // Discovery cannot build its scrubber up front the way Replay does: its only
  // input is a sentence, and which parameters exist is exactly what the run is
  // there to find out. So the scrubber grows as the model tags values, and
  // `packages/agent/src/redaction.ts` is where a discovered literal becomes a
  // needle for it — the same unavoidable reason Replay's `redaction.ts` unwraps,
  // for the same one purpose. It is also where the characters to type into a
  // field come from, which is Replay's `checkpoint.ts` reason. Both uses are
  // locals consumed immediately; nothing holds the plaintext, and what the
  // Trajectory carries is the `Redacted` wrapper.
  expect(unwrapping.sort()).toEqual([
    join("packages", "agent", "src", "redaction.ts"),
    join("packages", "replay", "src", "checkpoint.ts"),
    join("packages", "replay", "src", "redaction.ts")
  ])

  // And the prose really is prose: the module that documents the rule most
  // heavily does not itself unwrap.
  const inputs = readFileSync(join("packages", "artifact", "src", "Inputs.ts"), "utf8")
  expect(inputs).toContain("Redacted.value(")
  expect(withoutComments(inputs)).not.toContain("Redacted.value(")
})

// ---------------------------------------------------------------------------
// Deny-first classification
// ---------------------------------------------------------------------------

const declarations = {
  silent: { type: "string" as const, description: "says nothing about sensitivity" },
  claimsSafe: { type: "string" as const, description: "asks to be public", sensitive: false },
  claimsSensitive: { type: "string" as const, description: "asks to be private", sensitive: true }
}

const classify = (
  parameter: keyof typeof declarations,
  declassify: (name: string) => boolean
): boolean => {
  const prepared = prepareInputs(
    "cap",
    declarations,
    { silent: "a", claimsSafe: "b", claimsSensitive: "c" },
    declassify
  )
  if (!Result.isSuccess(prepared)) throw new Error("expected valid inputs")
  return prepared.success.get(parameter)!.sensitive
}

it("a parameter is sensitive unless the artifact and policy both say otherwise", () => {
  const allows = allowlistingEverything()
  const forbids = declassifierFor(sensitivityPolicy, "cap")

  // Saying nothing means sensitive. This is the case that matters, because it is
  // what every parameter a discovery run invents will look like.
  expect(classify("silent", forbids)).toBe(true)
  expect(classify("silent", allows)).toBe(true)

  // The artifact asking on its own is not enough. An artifact is a discovered
  // document; from ticket 11 a model writes it, and a document that can
  // declassify itself is not a control.
  expect(classify("claimsSafe", forbids)).toBe(true)

  // Both signatures present: declassified.
  expect(classify("claimsSafe", allows)).toBe(false)

  // And policy cannot override an artifact that asked to stay private. Every
  // route that is not "both said yes" lands on sensitive.
  expect(classify("claimsSensitive", allows)).toBe(true)
})

/** A policy that allowlists every parameter of the fixture capability. */
function allowlistingEverything(): (name: string) => boolean {
  return declassifierFor(
    declassifying([
      { capability: "cap", parameter: "silent", because: "test fixture" },
      { capability: "cap", parameter: "claimsSafe", because: "test fixture" },
      { capability: "cap", parameter: "claimsSensitive", because: "test fixture" }
    ]),
    "cap"
  )
}

it("the shipped policy declassifies only what a reviewer signed off, and nothing about a member", () => {
  // Deny-first still holds. The one exception is a product label the institution
  // prints on the account list itself; every parameter carrying member data is
  // absent from this list, which is the property worth asserting rather than the
  // list being empty.
  expect(sensitivityPolicy.summary).toContain("deny-first")
  expect(sensitivityPolicy.declassified.map((entry) => entry.parameter)).toEqual(["accountType"])
  expect(sensitivityPolicy.declassified.every((entry) => entry.because.length > 40)).toBe(true)

  // memberId is not declassified for the capability that actually uses it.
  const shipped = declassifierFor(sensitivityPolicy, "member.account-balance")
  expect(shipped("memberId")).toBe(false)
  expect(shipped("accountType")).toBe(true)

  // An allowlist entry is scoped to one capability. A parameter that is harmless
  // in one is not thereby harmless in another.
  const elsewhere = declassifierFor(
    declassifying([{ capability: "other.capability", parameter: "memberId", because: "not this" }]),
    "member.account-balance"
  )
  expect(elsewhere("memberId")).toBe(false)
})

// ---------------------------------------------------------------------------
// The scrubber
// ---------------------------------------------------------------------------

it("replaces every occurrence, longest value first, and percent-encoded forms too", () => {
  const scrub = scrubbing([
    { label: "short", text: "123" },
    { label: "long", text: "123456" },
    { label: "spaced", text: "Ada Lovelace" }
  ])

  // Longest first: replacing "123" first would leave "456" of the longer value
  // sitting in the clear, which is the near-miss this ordering removes.
  expect(scrub("account 123456 belongs to 123")).toBe(
    `account ${placeholderFor("long")} belongs to ${placeholderFor("short")}`
  )

  // Heritage Core puts values in query strings, where a space is not a space.
  expect(scrub("/search?name=Ada%20Lovelace")).toBe(`/search?name=${placeholderFor("spaced")}`)
  expect(scrub("hello Ada Lovelace")).toBe(`hello ${placeholderFor("spaced")}`)

  // And there are two query-string spellings, not one. Every Heritage Core
  // screen this system drives is a GET form, and a browser submits one as
  // `application/x-www-form-urlencoded` — which writes a space as `+` where
  // `encodeURIComponent` writes `%20`. A scrubber that knew only the second
  // would let the value the URL bar is actually showing straight through.
  expect(scrub("/search?name=Ada+Lovelace")).toBe(`/search?name=${placeholderFor("spaced")}`)

  // The characters that are spelled the same either way are still covered once.
  const ampersand = scrubbing([{ label: "odd", text: "a&b c" }])
  expect(ampersand("?q=a%26b%20c")).toBe(`?q=${placeholderFor("odd")}`)
  expect(ampersand("?q=a%26b+c")).toBe(`?q=${placeholderFor("odd")}`)
  expect(ampersand("a&b c")).toBe(placeholderFor("odd"))
})

it("scrubs sensitive inputs and leaves declassified ones alone", () => {
  const prepared = prepareInputs(
    "cap",
    declarations,
    { silent: "AAA", claimsSafe: "BBB", claimsSensitive: "CCC" },
    allowlistingEverything()
  )
  if (!Result.isSuccess(prepared)) throw new Error("expected valid inputs")

  expect([...sensitiveNames(prepared.success)].sort()).toEqual(["claimsSensitive", "silent"])

  const scrub = scrubberFor(prepared.success)
  expect(scrub("AAA BBB CCC")).toBe(
    `${placeholderFor("silent")} BBB ${placeholderFor("claimsSensitive")}`
  )
})

// ---------------------------------------------------------------------------
// Artifacts carry no runtime values
// ---------------------------------------------------------------------------

it("no stored artifact bakes a runtime value into a fixed literal", () => {
  // The structural half of ADR-0008, over the same documents the file scan above
  // reads as text. Ticket 11's compiler calls this before writing.
  for (const capability of readdirSync(ARTIFACTS_DIRECTORY)) {
    expect(bakedInLiterals(shippedArtifact(capability), EVERY_MEMBER_ID)).toEqual([])
  }
})

it("catches a member number baked into a constant or an asserted string", () => {
  const artifact = shippedArtifact()
  const poisoned = {
    ...artifact,
    steps: artifact.steps.map((step, index) =>
      index === 0
        ? {
            ...step,
            checkpoint: {
              ...step.checkpoint,
              expect: [{ assert: "textPresent" as const, text: `Member ${MEMBER_ID}` }]
            }
          }
        : step
    )
  }

  const found = bakedInLiterals(poisoned, [MEMBER_ID])
  expect(found.length).toBe(1)
  expect(found[0]).toContain("checkpoint assertion 0")
  expect(found[0]).toContain(MEMBER_ID)
})

/**
 * The positions the scan used to walk past.
 *
 * ADR-0008's structural half is only as good as its coverage, and coverage that
 * is a list somebody extended when they remembered is not coverage. Three of
 * these are the ones that matter most, because they are written by an *Amendment*
 * — after a run met a state, from what that run saw on screen, which is precisely
 * the moment a member number gets copied into a `textPresent`.
 */
it("walks the selection, the outcome branches and the recovery rules too", () => {
  const artifact = shippedArtifact()
  const target = {
    role: "cell",
    name: `Member ${MEMBER_ID}`,
    strategy: "name",
    robustness: "a target named after one member's screen is a runtime value in a fixed field"
  }

  const poisoned = {
    ...artifact,
    steps: [
      {
        id: "select-it",
        intent: "Choose the account.",
        action: {
          type: "selectFromList" as const,
          list: { within: { name: "Share and Deposit Accounts" }, itemRole: "link" },
          // The field the scanner did not look at: `against` is a full ValueRef,
          // so `{ from: constant }` is expressible here exactly as it is in a fill.
          match: { against: { from: "constant" as const, text: `Account ${MEMBER_ID}` }, strategy: "tokenSubset" as const },
          onNoMatch: { escalate: "NO_MATCHING_ITEM" },
          onMultiple: { escalate: "AMBIGUOUS_MATCH" },
          robustness: "written to put a constant in a selection, which is where one can hide"
        },
        checkpoint: {
          description: "Something happened.",
          expect: [{ assert: "targetPresent" as const, target }],
          orOutcome: [
            {
              code: "MEMBER_NOT_FOUND",
              when: [
                { assert: "textPresent" as const, text: `No member record found for ${MEMBER_ID}` }
              ]
            }
          ]
        }
      }
    ],
    recoverable: [
      {
        condition: "SESSION_EXPIRED",
        description: "The session timed out.",
        detect: [{ assert: "textPresent" as const, text: `Signed out of ${MEMBER_ID}` }],
        remedy: [
          {
            intent: "Sign back on.",
            action: {
              type: "navigate" as const,
              path: { from: "constant" as const, text: `/signon?member=${MEMBER_ID}` }
            }
          }
        ],
        resume: "at-step" as const,
        repeatable: "reading a balance twice reads the same balance",
        attempts: 2,
        backoffMillis: 100
      }
    ]
  }

  const found = bakedInLiterals(poisoned, [MEMBER_ID])
  const where = found.join(" | ")

  expect(where).toContain("step select-it's match's constant")
  expect(where).toContain("step select-it's checkpoint assertion 0's name")
  expect(where).toContain("step select-it's MEMBER_NOT_FOUND branch condition 0")
  expect(where).toContain("recoverable condition SESSION_EXPIRED's detect condition 0")
  expect(where).toContain("recoverable condition SESSION_EXPIRED's remedy 0's path's constant")
  expect(found.length).toBe(5)
})

// ---------------------------------------------------------------------------
// The screenshot exception, stated where a reviewer will find it
// ---------------------------------------------------------------------------

it.live("the evidence directory says screenshots are unredacted and over synthetic data", () =>
  Effect.gen(function* () {
    const { evidenceDirectory } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: MEMBER_ID }
    })

    const note = readFileSync(join(evidenceDirectory, "README.txt"), "utf8")

    // ADR-0010's disclosure, in the directory rather than only in the ADR: the
    // person who most needs it is looking at a screenshot, not at the repository.
    expect(note).toContain("Screenshots are NOT redacted")
    expect(note).toContain("SYNTHETIC")
    expect(note).toContain("docs/adr/0010-evidence-screenshots-are-not-redacted.md")
    expect(note).toContain("optical recognition")

    // It names which parameters were scrubbed, without naming their values.
    expect(note).toContain("memberId")
    expect(note).not.toContain(MEMBER_ID)

    // And there is in fact an unredacted screenshot sitting beside it, which the
    // scan skips by extension rather than by not looking.
    const files = readdirSync(evidenceDirectory)
    expect(files).toContain("final.png")
    expect(UNSCANNED_EXTENSIONS).toContain(".png")
  })
)

it.live("the accessibility snapshot in evidence carries the placeholder, not the number", () =>
  Effect.gen(function* () {
    const { events } = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: MEMBER_ID }
    })

    // The live leak this ticket closed: `observe` events carry the accessibility
    // YAML of the screen, and after the member number is typed in, that YAML
    // contains it. Nothing about the event's shape says so, which is why the
    // scrubber is field-blind.
    const observations = events.filter((event) => event.kind === "observe")
    expect(observations.length).toBeGreaterThan(0)

    const redacted = observations.filter((event) =>
      event.kind === "observe" && event.accessibility.includes(placeholderFor("memberId"))
    )
    expect(redacted.length).toBeGreaterThan(0)

    // Including the URL, which carries it as a query parameter.
    expect(
      observations.some(
        (event) => event.kind === "observe" && event.url.includes(placeholderFor("memberId"))
      )
    ).toBe(true)
  })
)
