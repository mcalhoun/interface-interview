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
 *      no Capability knew a person would be involved.
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
import { operatorFieldLabel } from "@cua/session"
import { labelledValuesIn, parseAccessibilityTree } from "@cua/surface"
import { attendedReplay } from "./support/handoff-harness.ts"
import { replay, shippedArtifact } from "./support/replay-harness.ts"
import { describeAppearances, scanForSecrets } from "./support/secret-scan.ts"

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

it.live(
  "a credential an operator types is redacted from every text file the run writes",
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

            // Said before it is typed. The needles have to exist before the
            // application can echo either value back at us.
            yield* desk.post("/note", {
              detail: `entered ${SUPERVISOR_ID} / ${OVERRIDE_CODE} on the override panel`,
              enteredField: ["Supervisor ID", "Authorization Code"],
              enteredValue: [SUPERVISOR_ID, OVERRIDE_CODE]
            })

            yield* desk.surface.fill({ role: "textbox", name: "Supervisor ID" }, SUPERVISOR_ID)
            yield* desk.surface.fill(
              { role: "textbox", name: "Authorization Code" },
              OVERRIDE_CODE
            )

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

      // The Operator's own note quoted both values. That note is redacted too,
      // because registration happens before the event that reports it.
      // The last of them: the first is `took control`, which quotes nothing.
      const noted = outcome.events
        .filter((event) => event.kind === "intervention.human_action")
        .at(-1)
      expect(noted && "detail" in noted ? noted.detail : "").toContain(
        "[redacted:supervisorId]"
      )

      // What the record keeps is the field names, never the characters.
      const closed = outcome.snapshot.resolved[0]
      expect(closed?.actions.flatMap((action) => action.redacted)).toEqual([
        "supervisorId",
        "authorizationCode"
      ])

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
