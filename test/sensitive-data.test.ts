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
import { ARTIFACTS_DIRECTORY, bakedInLiterals, prepareInputs } from "@cua/artifact"
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

    // And the scan was not vacuous: it read files, and they were the ones the run
    // produced.
    const scanned = filesUnder(evidenceDirectory)
    expect(scanned.length).toBeGreaterThan(0)
    expect(scanned.some((path) => path.endsWith("events.jsonl"))).toBe(true)
    expect(filesUnder(ARTIFACTS_DIRECTORY).length).toBeGreaterThan(0)
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

it("unwrapping is confined to two named call sites, and both are greppable", () => {
  const sources = filesUnder("packages").filter((path) => extname(path) === ".ts")
  const unwrapping = sources.filter((path) =>
    withoutComments(readFileSync(path, "utf8")).includes("Redacted.value(")
  )

  // Two, and exactly which two. A third is not forbidden — a future ticket may
  // genuinely need one — but it cannot arrive unnoticed. This test fails, and
  // whoever added it has to say in the diff why it is safe.
  expect(unwrapping.sort()).toEqual([
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

it("the shipped policy declassifies nothing, so the demo runs fully redacted", () => {
  expect(sensitivityPolicy.declassified).toEqual([])
  expect(sensitivityPolicy.summary).toContain("deny-first")

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
