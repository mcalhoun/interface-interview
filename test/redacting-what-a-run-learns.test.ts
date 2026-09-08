/**
 * The three kinds of sensitive text a run meets that no Artifact declared.
 *
 * `test/sensitive-data.test.ts` covers the declared half: a parameter is
 * `Redacted`, the scrubber is built from it before the run starts, and the
 * member number appears nowhere in the evidence. That mechanism is complete for
 * what a caller passed in, and blind to everything else.
 *
 * Three things arrive during a run instead of before it, and all three used to
 * be written down in the clear:
 *
 *   1. **What a person types during an Intervention.** A supervisor id and an
 *      override code are credentials, and no Capability declared them, because
 *      no Capability knew a person would be involved. Nobody transcribes these:
 *      the paused Session watches the screen it handed over, so the test below
 *      types into the live window and tells the system nothing.
 *   2. **What the application renders back.** A member's *name* is nobody's
 *      parameter. It comes off a screen as ordinary text, and it is the single
 *      most identifying string in the log.
 *   3. **What is sent to a model.** The assisted rung scrubs the tree and the
 *      url it sends; the *list of controls* it builds from that same tree used
 *      to go out untouched, so an allowed consultation could transmit a value
 *      the log had already learned to redact.
 *
 * Each is tested by running the real thing and then reading the files back,
 * because "the scrubber was called" is not the claim. The claim is that the
 * characters are not on disk.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { secretRegistry } from "@cua/evidence"
import { personalCaptions, personalFields } from "@cua/policy"
import { beganWith, operatorFieldLabel, sawEntries } from "@cua/session"
import {
  entryValuesIn,
  labelledValuesIn,
  parseAccessibilityTree,
  queryValuesIn
} from "@cua/surface"
import { attendedReplay } from "../apps/demo/src/support/handoff-harness.ts"
import { replay, shippedArtifact } from "../apps/demo/src/support/replay-harness.ts"
import { describeAppearances, scanForSecrets } from "../apps/demo/src/support/secret-scan.ts"

const HAPPY_PATH = "12345"
const HAPPY_PATH_NAME = "MARGUERITE A ELLSWORTH"
const RESTRICTED = "77777"
const SUPERVISOR_ID = "SUP7"
const OVERRIDE_CODE = "4417"

// ---------------------------------------------------------------------------
// The registry itself
// ---------------------------------------------------------------------------

it("a registry redacts what it is told after it was built, not only before", () => {
  const secrets = secretRegistry([{ label: "memberId", text: HAPPY_PATH }])
  expect(secrets.scrub(`member ${HAPPY_PATH}`)).toBe("member [redacted:memberId]")

  // The Evidence Layer is built once at the start of a run and cannot be
  // swapped, so the scrubber it holds has to be the one that keeps learning.
  // A snapshot taken at construction would have missed everything below.
  secrets.remember([{ label: "authorizationCode", text: OVERRIDE_CODE }])
  expect(secrets.scrub(`code ${OVERRIDE_CODE}`)).toBe("code [redacted:authorizationCode]")
  expect(secrets.labels()).toEqual(["memberId", "authorizationCode"])

  // Idempotent, and an empty value is never a needle: it would match between
  // every pair of characters in the log.
  secrets.remember([{ label: "authorizationCode", text: OVERRIDE_CODE }])
  secrets.remember([{ label: "nothing", text: "" }])
  expect(secrets.labels()).toEqual(["memberId", "authorizationCode"])
})

it("an operator field caption becomes a placeholder name", () => {
  expect(operatorFieldLabel("Supervisor ID")).toBe("supervisorId")
  expect(operatorFieldLabel("Authorization Code")).toBe("authorizationCode")
  // Never blank: a placeholder with no name in it tells a reader nothing about
  // what did not leak.
  expect(operatorFieldLabel("   ")).toBe("operatorInput")
})

// ---------------------------------------------------------------------------
// 2. What the application rendered back
// ---------------------------------------------------------------------------

it("reads the value beside a declared caption, and leaves everything else alone", () => {
  const tree = parseAccessibilityTree(
    [
      "- table:",
      "  - rowgroup:",
      "    - row:",
      `      - cell "Member Name"`,
      `      - cell "${HAPPY_PATH_NAME}"`,
      "    - row:",
      `      - cell "Account"`,
      `      - cell "Primary Savings"`
    ].join("\n")
  )

  const found = labelledValuesIn(tree, personalCaptions)
  expect(found).toEqual([{ caption: "Member Name", text: HAPPY_PATH_NAME }])

  // The account label is deliberately not in the list. Scrubbing it would blank
  // the account list out of the tree, which is the one part of the evidence that
  // shows what a `selectFromList` was choosing between — see the argument on
  // `accountType` in packages/policy/src/Sensitivity.ts.
  expect(personalCaptions).not.toContain("Account")
  expect(found.map((value) => value.text)).not.toContain("Primary Savings")
})

it("every declared personal field carries the reason somebody signed it off", () => {
  expect(personalFields.length).toBeGreaterThan(0)
  for (const field of personalFields) {
    expect(field.caption.trim(), JSON.stringify(field)).not.toBe("")
    expect(field.label.trim(), JSON.stringify(field)).not.toBe("")
    // A denylist entry with no argument is one nobody can audit, which is the
    // same rule the parameter allowlist above it lives by.
    expect(field.because.length, `${field.caption} has no stated reason`).toBeGreaterThan(60)
  }
})

it.live("a member's name is not written into the evidence of an ordinary run", () =>
  Effect.gen(function* () {
    const outcome = yield* replay({
      artifact: shippedArtifact(),
      inputs: { memberId: HAPPY_PATH },
      runId: "personal-fields"
    })
    expect(outcome.result.result).toBe("success")

    // The strong direction first: the placeholder is *present*. A run that
    // observed nothing at all would pass "the name is absent" and fail this.
    const log = readFileSync(join(outcome.evidenceDirectory, "events.jsonl"), "utf8")
    expect(log).toContain("[redacted:memberName]")
    expect(log).toContain("[redacted:taxId]")

    // And then the plain one, over every text file the run produced, using the
    // same walker the declared-parameter test uses.
    const appearances = scanForSecrets(outcome.evidenceDirectory, [
      HAPPY_PATH_NAME,
      "xxx-xx-4417"
    ])
    expect(appearances, describeAppearances(appearances)).toEqual([])
  })
)

// ---------------------------------------------------------------------------
// 1. What a person typed
// ---------------------------------------------------------------------------

it("reads what is in a screen's entry controls, and only those", () => {
  const tree = parseAccessibilityTree(
    [
      "- table:",
      "  - rowgroup:",
      "    - row:",
      `      - cell "Supervisor ID"`,
      "      - cell:",
      `        - textbox "Supervisor ID": ${SUPERVISOR_ID}`,
      "    - row:",
      `      - cell "Authorization Code"`,
      "      - cell:",
      `        - textbox "Authorization Code"`,
      "    - row:",
      `      - cell "Available Balance"`,
      `      - cell "$4,182.55"`
    ].join("\n")
  )

  // The premise of the whole capture: a filled control carries its value in the
  // tree beside its name, exactly as a balance cell carries its figure.
  expect(entryValuesIn(tree)).toEqual([{ field: "Supervisor ID", value: SUPERVISOR_ID }])

  // An empty control has nothing in it, and an empty needle would match between
  // every pair of characters in the log. A cell is the application talking, not
  // a person typing, and redacting the balance would empty out the evidence.
})

it("reads what a submitted form put in an address, by parameter", () => {
  expect(
    queryValuesIn("http://core.invalid/member?memberNumber=12345&branch=")
  ).toEqual([{ field: "memberNumber", value: "12345" }])
  // Not a URL at all is an empty answer rather than a throw: this runs against
  // whatever the browser reports while somebody is driving it.
  expect(queryValuesIn("about:blank")).toEqual([])
})

it("registers what changed while a person held the session, and nothing that was already there", () => {
  // What automation put there before anybody arrived. Registering these would
  // say a person typed something they did not, and the run's own scrubber
  // already covers them.
  const start = beganWith([{ field: "Member Number", value: "77777" }])

  const typed = sawEntries(start, [
    { field: "Member Number", value: "77777" },
    { field: "Supervisor ID", value: SUPERVISOR_ID }
  ])
  expect(typed.register).toEqual([{ field: "Supervisor ID", value: SUPERVISOR_ID }])

  // Seen once, registered once: the same value on the next look is not new.
  const again = sawEntries(typed.state, [{ field: "Supervisor ID", value: SUPERVISOR_ID }])
  expect(again.register).toEqual([])

  // A value is registered the first time it is seen rather than once it stops
  // changing, so somebody who types a code and presses the button in the same
  // second is still covered. The cost is a half-typed needle, which is the trade
  // this system makes everywhere: illegible evidence is recoverable, a leaked
  // credential is not.
  const corrected = sawEntries(again.state, [{ field: "Supervisor ID", value: "SUP8" }])
  expect(corrected.register).toEqual([{ field: "Supervisor ID", value: "SUP8" }])

  // Three controls captioned the same way are three fields, because the value in
  // each of them is a different value.
  const duplicates = sawEntries(beganWith([]), [
    { field: "Amount", value: "150.00" },
    { field: "Amount", value: "12.50" }
  ])
  expect(duplicates.register).toHaveLength(2)
})

it.live(
  "a credential an operator types is redacted although nobody declared it",
  () =>
    Effect.gen(function* () {
      const outcome = yield* attendedReplay({
        artifact: shippedArtifact("member.account-balance", "1.1.0"),
        inputs: { memberId: RESTRICTED },
        runId: "operator-typed-values",
        operate: (desk) =>
          Effect.gen(function* () {
            yield* desk.awaitPause
            yield* desk.post("/take", { operator: "r.mensah" })

            // Nobody says anything first. This is the whole test: the operator
            // types into the live window the way a person does, and the only
            // record of what they typed is the screen itself.
            yield* desk.surface.fill({ role: "textbox", name: "Supervisor ID" }, SUPERVISOR_ID)
            yield* desk.surface.fill(
              { role: "textbox", name: "Authorization Code" },
              OVERRIDE_CODE
            )

            // And then they quote both values in their own note, which is the
            // ordering that matters: the note is written after the values are on
            // the screen, so the capture has to have happened before the event
            // reporting it, or the note itself is the leak.
            yield* desk.post("/note", {
              detail: `entered ${SUPERVISOR_ID} / ${OVERRIDE_CODE} on the override panel`
            })

            // Deliberately *not* pressing Authorize. The fields keep the values
            // they were given, so the observation the run takes when it resumes
            // carries both of them in the accessibility tree — which is what
            // makes this test about redaction rather than about a screen that
            // happened to be empty.
            yield* desk.post("/return", {
              operator: "r.mensah",
              classification: "unresolved",
              detail: "filled the override panel and left it for a second signature",
              nextTime: "not_asked"
            })
          })
      })

      const log = readFileSync(join(outcome.evidenceDirectory, "events.jsonl"), "utf8")

      // Falsifiable in the same way as above: the placeholders are present, so
      // the values demonstrably reached the log and were taken out of it.
      expect(log).toContain("[redacted:supervisorId]")
      expect(log).toContain("[redacted:authorizationCode]")

      // The capture is in the log under its own kind, naming the fields and
      // never the characters. It is not an `intervention.human_action`: an
      // observation is not something the operator reported doing, and anybody
      // re-deriving ADR-0004's table from this file counts those.
      const captured = outcome.events.filter((event) => event.kind === "intervention.observed")
      expect(
        captured.flatMap((event) => (event.kind === "intervention.observed" ? event.fields : []))
      ).toEqual(["supervisorId", "authorizationCode"])

      // The Operator's own note quoted both values. That note is redacted too,
      // because registration happened when they typed them, not when they said so.
      const noted = outcome.events
        .filter((event) => event.kind === "intervention.human_action")
        .at(-1)
      expect(noted && "detail" in noted ? noted.detail : "").toContain(
        "[redacted:supervisorId]"
      )

      // What the record keeps is the field names, never the characters.
      const closed = outcome.snapshot.resolved[0]
      expect(closed?.observed).toEqual(["supervisorId", "authorizationCode"])

      const appearances = scanForSecrets(outcome.evidenceDirectory, [
        SUPERVISOR_ID,
        OVERRIDE_CODE
      ])
      expect(appearances, describeAppearances(appearances)).toEqual([])
    }),
  60_000
)

it.live(
  "a credential the operator submits away is still redacted, and so is the echo",
  () =>
    Effect.gen(function* () {
      /**
       * The case the watching half exists for, and the shape of the leak that was
       * found in a real run.
       *
       * A supervisor releases the hold and presses Authorize. The controls clear,
       * the panel re-renders, and Heritage Core's released panel says "overridden
       * by supervisor SUP7" on the screen the run then observes, so by the time
       * anybody could be asked what they typed, the value is somewhere nothing
       * can attribute it from. The only chance to see it is while it is in the
       * control, which is what the paused Session's watch is for.
       */
      const outcome = yield* attendedReplay({
        artifact: shippedArtifact("member.account-balance", "1.1.0"),
        inputs: { memberId: RESTRICTED },
        runId: "operator-submitted-values",
        operate: (desk) =>
          Effect.gen(function* () {
            yield* desk.awaitPause
            yield* desk.post("/take", { operator: "r.mensah" })
            yield* desk.surface.fill({ role: "textbox", name: "Supervisor ID" }, SUPERVISOR_ID)
            yield* desk.surface.fill(
              { role: "textbox", name: "Authorization Code" },
              OVERRIDE_CODE
            )

            // A person takes a second between typing a code and pressing the
            // button. Waiting on the fact rather than on a duration is what makes
            // this deterministic, and it fails loudly rather than quietly proving
            // something else if the capture stops happening.
            yield* desk.awaitObserved("supervisorId")
            yield* desk.awaitObserved("authorizationCode")

            yield* desk.surface.click({ role: "button", name: "Authorize" })

            // Both values are gone from the controls now, and the screen the run
            // is about to observe quotes one of them straight back at it. The
            // adapter does not scrub -- redaction happens where evidence is
            // serialised -- so this is the leak as it arrives.
            const after = yield* desk.surface.observe
            expect(after.accessibility).toContain(`supervisor ${SUPERVISOR_ID}`)

            yield* desk.post("/return", {
              operator: "r.mensah",
              classification: "resolved",
              detail: "released the hold as an authorized supervisor",
              nextTime: "not_asked"
            })
          })
      })

      expect(outcome.result.result).toBe("success")

      // The strong direction: the placeholder is *present*, so the value
      // demonstrably reached the writer and was taken out. Only the supervisor id
      // is echoed by the released panel; the authorization code is registered
      // just as early and simply never appears again, which is why the scan below
      // is over both and this assertion is over one.
      const log = readFileSync(join(outcome.evidenceDirectory, "events.jsonl"), "utf8")
      expect(log).toContain("[redacted:supervisorId]")

      const closed = outcome.snapshot.resolved[0]
      expect(closed?.observed).toEqual(["supervisorId", "authorizationCode"])

      const appearances = scanForSecrets(outcome.evidenceDirectory, [
        SUPERVISOR_ID,
        OVERRIDE_CODE
      ])
      expect(appearances, describeAppearances(appearances)).toEqual([])
    }),
  60_000
)

// ---------------------------------------------------------------------------
// 3. What is sent to a model
// ---------------------------------------------------------------------------

it.live(
  "the controls offered to a consultation are scrubbed before they leave the machine",
  () =>
    Effect.gen(function* () {
      /**
       * A Target the screen does not have, of a role the screen is full of.
       *
       * `controlsOfferedIn` enumerates every control of the role the Target
       * asked for, so a missing `cell` offers the model *the whole record*:
       * account numbers, the tax id, and the member's name. That is the shape of
       * the leak rather than a contrivance -- a Target naming a value cell is
       * ordinary in this application, and `read-available-balance` is one.
       */
      const stored = shippedArtifact()
      const [search, enter, run, ...rest] = stored.steps
      const artifact = {
        ...stored,
        steps: [
          search!,
          enter!,
          run!,
          {
            ...rest[0]!,
            id: "reach-for-something-absent",
            action: {
              type: "click" as const,
              target: {
                role: "cell",
                name: "A Caption This Screen Does Not Have",
                exact: true,
                strategy: "accessible-name",
                robustness:
                  "Deliberately unresolvable, so that the assisted rung is asked about a " +
                  "control that is not there and has to enumerate the ones that are."
              }
            }
          },
          ...rest.slice(1)
        ]
      }

      /** Not a model. Something that writes down what it was asked. */
      const asked: Array<ReadonlyArray<string>> = []
      const eavesdropper = {
        consult: (consultation: { readonly controls?: ReadonlyArray<{ readonly name: string }> }) =>
          Effect.sync(() => {
            asked.push((consultation.controls ?? []).map((control) => control.name))
            return { _tag: "Unclassified" as const, rationale: "not a real consultation" }
          })
      }

      const outcome = yield* replay({
        artifact,
        inputs: { memberId: HAPPY_PATH },
        runId: "assist-prompt-scrubbing",
        assist: eavesdropper as never
      })
      expect(outcome.result.result).toBe("failure")

      const offered = asked.flat()
      expect(offered.length, "the consultation was never asked about any control").toBeGreaterThan(
        0
      )

      // The member number and the member's name are both on Member Detail as
      // cells, so both are in the list. Neither leaves in the clear.
      expect(offered.join("\n")).toContain("[redacted:")
      for (const secret of [HAPPY_PATH, HAPPY_PATH_NAME]) {
        expect(
          offered.filter((name) => name.includes(secret)),
          `a control name carrying ${secret} was offered to the model`
        ).toEqual([])
      }
    }),
  60_000
)

// ---------------------------------------------------------------------------
// The scan is only worth anything if it can fail
// ---------------------------------------------------------------------------

it("the walker finds an operator credential when one really is there", () => {
  const root = mkdtempSync(join(tmpdir(), "cua-planted-"))
  writeFileSync(
    join(root, "events.jsonl"),
    `{"kind":"intervention.human_action","detail":"entered ${OVERRIDE_CODE}"}\n`
  )
  writeFileSync(join(root, "note.txt"), `supervisor ${SUPERVISOR_ID} signed it off\n`)

  const appearances = scanForSecrets(root, [SUPERVISOR_ID, OVERRIDE_CODE])
  expect(appearances.map((appearance) => appearance.secret).sort()).toEqual([
    OVERRIDE_CODE,
    SUPERVISOR_ID
  ])
})
