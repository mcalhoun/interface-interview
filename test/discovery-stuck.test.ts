/**
 * Stuck detection, all six triggers.
 *
 * SPEC weighs this as heavily as success, and singles out cycle detection: "Hash-
 * based cycle detection is the one that earns its keep, because looping is the
 * actual failure mode of these loops." So the cycle tests are the detailed ones,
 * and they check not only that it fires but that it fires *before* the step bound
 * would have and reports which screens the run went round between — the
 * difference between "gave up after twenty steps" and a finding.
 *
 * Everything here is pure. The detector takes an elapsed time rather than reading
 * a clock, which is what lets the wall-clock trigger be tested in a millisecond
 * and without a `TestClock`.
 */

import { expect, it } from "vitest"
import {
  DEFAULT_BOUNDS,
  STUCK_TRIGGERS,
  describeTrigger,
  escalated,
  normaliseForHashing,
  stateSignature,
  stuckDetector
} from "@cua/agent"

const SEARCH = `- table:
  - row:
    - cell "Member Number Search"
    - textbox "Member Number" [ref=e12]
    - button "Search" [ref=e13]`

const DETAIL = `- table:
  - row:
    - cell "Member Detail"
    - link "Primary Savings" [ref=e40]`

const at = (step: number, elapsedMillis = 0) => ({ step, elapsedMillis })

it("names all six triggers SPEC lists", () => {
  expect([...STUCK_TRIGGERS].sort()).toEqual([
    "cycle",
    "deadline",
    "escalated",
    "max_steps",
    "no_effect",
    "resolution_failures"
  ])
})

// ---------------------------------------------------------------------------
// The signature
// ---------------------------------------------------------------------------

it("a state's signature ignores playwright's node handles", () => {
  // Refs change on every navigation, and the frame prefix shifts too (`e31`
  // becomes `f2e31`). Hashing them would make every state look new and the cycle
  // detector would never fire — which is the failure mode where the whole
  // mechanism is present and does nothing.
  const before = "- button \"Search\" [ref=e13]"
  const after = "- button \"Search\" [ref=f2e91]"
  expect(normaliseForHashing(before)).toBe(normaliseForHashing(after))
  expect(stateSignature("/x", before)).toBe(stateSignature("/x", after))
})

it("a state's signature keeps the values on screen", () => {
  // An empty search box and one with a member number typed in are genuinely
  // different states. Collapsing them would make the detector fire on a run that
  // is making progress, which is worse than not firing at all.
  const empty = "- textbox \"Member Number\""
  const filled = "- textbox \"Member Number\": 12345"
  expect(stateSignature("/", empty)).not.toBe(stateSignature("/", filled))
})

it("a state's signature is url and tree together, because neither alone is the state", () => {
  // Heritage Core renders visibly different panels at one path...
  expect(stateSignature("/", SEARCH)).not.toBe(stateSignature("/", DETAIL))
  // ...and the same empty search form at two different paths.
  expect(stateSignature("/", SEARCH)).not.toBe(stateSignature("/xref", SEARCH))
})

// ---------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------

it("fires on a state seen more times than the bound allows", () => {
  const detector = stuckDetector({ ...DEFAULT_BOUNDS, repeatsAllowed: 2 })

  // A loop: search -> detail -> search -> detail -> search.
  expect(detector.observe({ url: "/", accessibility: SEARCH, ...at(1) })).toBeUndefined()
  expect(detector.observe({ url: "/m", accessibility: DETAIL, ...at(2) })).toBeUndefined()
  expect(detector.observe({ url: "/", accessibility: SEARCH, ...at(3) })).toBeUndefined()
  expect(detector.observe({ url: "/m", accessibility: DETAIL, ...at(4) })).toBeUndefined()

  const trigger = detector.observe({ url: "/", accessibility: SEARCH, ...at(5) })
  expect(trigger?.trigger).toBe("cycle")
  if (trigger?.trigger !== "cycle") return
  expect(trigger.seen).toBe(3)
  // The finding, not just the fact: which screens it went round between.
  expect(trigger.between).toEqual(["/", "/m"])
  expect(trigger.detail).toContain("/ -> /m")
})

it("catches a cycle long before the step bound would have", () => {
  // This is the argument for having it at all. With a 20-step bound, a two-state
  // loop would burn 20 steps and 20 model calls before stopping, and the report
  // would say only that time ran out.
  const detector = stuckDetector(DEFAULT_BOUNDS)
  let firedAt: number | undefined
  for (let step = 1; step <= DEFAULT_BOUNDS.maxSteps; step += 1) {
    const trigger = detector.observe({
      url: step % 2 === 0 ? "/m" : "/",
      accessibility: step % 2 === 0 ? DETAIL : SEARCH,
      ...at(step)
    })
    if (trigger !== undefined) {
      firedAt = step
      expect(trigger.trigger).toBe("cycle")
      break
    }
  }
  expect(firedAt).toBe(5)
  expect(firedAt).toBeLessThan(DEFAULT_BOUNDS.maxSteps)
})

it("does not fire on a run that is making progress", () => {
  const detector = stuckDetector(DEFAULT_BOUNDS)
  for (let step = 1; step <= 10; step += 1) {
    const trigger = detector.observe({
      url: `/step-${step}`,
      accessibility: `- cell "screen ${step}"`,
      ...at(step)
    })
    expect(trigger, `fired at step ${step}`).toBeUndefined()
  }
})

// ---------------------------------------------------------------------------
// No effect
// ---------------------------------------------------------------------------

it("fires when consecutive actions change nothing", () => {
  const detector = stuckDetector({ ...DEFAULT_BOUNDS, ineffectiveAllowed: 3, repeatsAllowed: 99 })
  expect(detector.observe({ url: "/", accessibility: SEARCH, ...at(1) })).toBeUndefined()
  expect(detector.observe({ url: "/", accessibility: SEARCH, ...at(2) })).toBeUndefined()
  expect(detector.observe({ url: "/", accessibility: SEARCH, ...at(3) })).toBeUndefined()
  const trigger = detector.observe({ url: "/", accessibility: SEARCH, ...at(4) })
  expect(trigger?.trigger).toBe("no_effect")
  expect(trigger?.detail).toContain("doing nothing")
})

it("reports no-effect rather than a cycle, because it is the more specific finding", () => {
  // An action that changed nothing is always also a repeat. Reporting the cycle
  // would bury the actual complaint: the actions are being accepted and are
  // having no consequence.
  // Tuned so both conditions come due on the same observation: the third
  // identical screen is a second ineffective action and a third sighting.
  const detector = stuckDetector({ ...DEFAULT_BOUNDS, ineffectiveAllowed: 2, repeatsAllowed: 2 })
  detector.observe({ url: "/", accessibility: SEARCH, ...at(1) })
  detector.observe({ url: "/", accessibility: SEARCH, ...at(2) })
  const trigger = detector.observe({ url: "/", accessibility: SEARCH, ...at(3) })
  expect(trigger?.trigger).toBe("no_effect")
})

it("a state that changes in between clears the no-effect count", () => {
  const detector = stuckDetector({ ...DEFAULT_BOUNDS, ineffectiveAllowed: 2, repeatsAllowed: 99 })
  detector.observe({ url: "/", accessibility: SEARCH, ...at(1) })
  detector.observe({ url: "/m", accessibility: DETAIL, ...at(2) })
  expect(detector.observe({ url: "/", accessibility: SEARCH, ...at(3) })).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

it("a read that leaves the screen alone is not a lap", () => {
  // Found by a live model-driven run. `member.account-balance` reads two figures
  // off one Account Detail screen, and reading changes nothing, so the second
  // read was the same state a third time and the run ended as a cycle. Under
  // that rule the flagship capability of this repository is undiscoverable.
  const BALANCES = '- cell "Available Balance"\n- cell "$4,182.55"'
  const detector = stuckDetector({ ...DEFAULT_BOUNDS, repeatsAllowed: 2, ineffectiveAllowed: 3 })

  expect(detector.observe({ url: "/a", accessibility: BALANCES, ...at(1) })).toBeUndefined()
  for (let read = 2; read <= 6; read += 1) {
    expect(
      detector.observe({ url: "/a", accessibility: BALANCES, readOnly: true, ...at(read) })
    ).toBeUndefined()
  }
})

it("a read is transparent, so the acting steps around it still count", () => {
  // The exemption is for the read, not for the run. Two clicks that changed
  // nothing with a read between them are still two ineffective actions.
  const detector = stuckDetector({ ...DEFAULT_BOUNDS, ineffectiveAllowed: 2, repeatsAllowed: 99 })
  detector.observe({ url: "/", accessibility: SEARCH, ...at(1) })
  detector.observe({ url: "/", accessibility: SEARCH, readOnly: true, ...at(2) })
  expect(detector.observe({ url: "/", accessibility: SEARCH, ...at(3) })).toBeUndefined()
  const trigger = detector.observe({ url: "/", accessibility: SEARCH, ...at(4) })
  expect(trigger?.trigger).toBe("no_effect")
  // Two, not three: the read between them was not counted as one of them.
  if (trigger?.trigger !== "no_effect") return
  expect(trigger.consecutive).toBe(2)
})

it("a run that only reads is stopped by the step bound, not by the cycle rule", () => {
  // What still bounds it. Twenty reads is bounded and costs nothing, and the
  // honest complaint about a run that does nothing but read is that it ran out
  // of steps rather than that it went round.
  const detector = stuckDetector({ ...DEFAULT_BOUNDS, maxSteps: 3, repeatsAllowed: 2 })
  detector.observe({ url: "/a", accessibility: "- a", readOnly: true, ...at(1) })
  detector.observe({ url: "/a", accessibility: "- a", readOnly: true, ...at(2) })
  const trigger = detector.observe({ url: "/a", accessibility: "- a", readOnly: true, ...at(3) })
  expect(trigger?.trigger).toBe("max_steps")
})

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

it("fires on the step bound", () => {
  const detector = stuckDetector({ ...DEFAULT_BOUNDS, maxSteps: 3 })
  detector.observe({ url: "/a", accessibility: "- a", ...at(1) })
  detector.observe({ url: "/b", accessibility: "- b", ...at(2) })
  const trigger = detector.observe({ url: "/c", accessibility: "- c", ...at(3) })
  expect(trigger?.trigger).toBe("max_steps")
})

it("fires on the wall clock", () => {
  const detector = stuckDetector({ ...DEFAULT_BOUNDS, maxMillis: 120_000 })
  expect(detector.observe({ url: "/a", accessibility: "- a", ...at(1, 119_000) })).toBeUndefined()
  const trigger = detector.observe({ url: "/b", accessibility: "- b", ...at(2, 120_001) })
  expect(trigger?.trigger).toBe("deadline")
  expect(trigger?.detail).toContain("120 seconds")
})

it("reports a cycle in preference to a bound, because it says why time ran out", () => {
  // Alternating screens, so nothing is ineffective — the run really is going
  // round. The step bound and the repeat bound both come due on observation 3.
  const detector = stuckDetector({ ...DEFAULT_BOUNDS, repeatsAllowed: 1, maxSteps: 3 })
  detector.observe({ url: "/", accessibility: SEARCH, ...at(1) })
  detector.observe({ url: "/m", accessibility: DETAIL, ...at(2) })
  const trigger = detector.observe({ url: "/", accessibility: SEARCH, ...at(3) })
  // Both conditions hold. A run that is both cycling and out of steps is
  // cycling: the step count says only that time ran out, the cycle says why it
  // was always going to.
  expect(trigger?.trigger).toBe("cycle")
})

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

it("fires when targets stop naming anything on the screen", () => {
  const detector = stuckDetector({ ...DEFAULT_BOUNDS, resolutionFailuresAllowed: 3 })
  expect(detector.resolutionFailed()).toBeUndefined()
  expect(detector.resolutionFailed()).toBeUndefined()
  const trigger = detector.resolutionFailed()
  expect(trigger?.trigger).toBe("resolution_failures")
  expect(trigger?.detail).toContain("stopped matching")
})

it("a target that resolves clears the count", () => {
  const detector = stuckDetector({ ...DEFAULT_BOUNDS, resolutionFailuresAllowed: 2 })
  detector.resolutionFailed()
  detector.resolutionSucceeded()
  expect(detector.resolutionFailed()).toBeUndefined()
})

// ---------------------------------------------------------------------------
// The model's own admission
// ---------------------------------------------------------------------------

it("the model's escalation is a trigger with the same shape as the rest", () => {
  const trigger = escalated("MEMBER_NOT_FOUND", "the search returned no such member")
  expect(trigger.trigger).toBe("escalated")
  if (trigger.trigger !== "escalated") return
  expect(trigger.code).toBe("MEMBER_NOT_FOUND")
  // Reported the same way as a detector's finding, so a caller reading the
  // conclusion does not have to special-case the one the model raised itself.
  expect(describeTrigger(trigger)).toBe("escalated: the search returned no such member")
})

it("every state seen is kept in order, so a cycle is visible in the record", () => {
  const detector = stuckDetector(DEFAULT_BOUNDS)
  detector.observe({ url: "/", accessibility: SEARCH, ...at(1) })
  detector.observe({ url: "/m", accessibility: DETAIL, ...at(2) })
  detector.observe({ url: "/", accessibility: SEARCH, ...at(3) })
  const signatures = detector.signatures()
  expect(signatures).toHaveLength(3)
  expect(signatures[0]).toBe(signatures[2])
  expect(signatures[0]).not.toBe(signatures[1])
})
