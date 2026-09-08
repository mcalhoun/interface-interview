/**
 * What the model is shown, and — more importantly — what it is not.
 *
 * ADR-0001 says the accessibility tree is the only observation channel. This
 * module is where that stops being an architectural preference and becomes a
 * fact about the bytes on the wire: `observation()` returns a string built from
 * the accessibility YAML, the URL and the frame list, and there is nowhere in it
 * to put an image. Screenshots are still captured every step (see `loop.ts`) and
 * written to Evidence for a person to look at — they simply never enter a prompt.
 *
 * This is not caution for its own sake. The entire submission rests on the claim
 * that a legacy application with no test IDs, no clean DOM and content buried in
 * nested layout tables can be driven from its accessibility structure alone. A
 * loop that could see pixels would make that claim unfalsifiable: nobody could
 * tell afterwards whether the tree was sufficient or whether vision quietly
 * carried the run. So the loop is built so it cannot be true, and a test asserts
 * that no prompt this module builds contains an image part.
 *
 * ## The transcript, and why it stays small
 *
 * A discovery run can take twenty steps, and an accessibility tree of a Heritage
 * Core screen is several kilobytes. Sending every past tree would grow the
 * transcript quadratically and, worse, bury the current screen among stale ones
 * the model might act on. So the transcript carries **the full current
 * observation, and a one-line summary of every earlier step**. What happened is
 * preserved; what the screen looked like six steps ago is not, because it is no
 * longer true.
 */

import type { SurfaceState } from "@cua/surface"
import type { Prompt } from "effect/unstable/ai"

/**
 * The standing instructions.
 *
 * Written as a briefing for an operator rather than a list of rules, because the
 * model's job is a domain task and the constraints are the shape of the tools it
 * has. The parts that would silently produce a bad Capability — provenance
 * tagging, and the goal's-word-not-the-screen's-label rule — are stated here and
 * *also* checked in code, because a prompt is guidance and a check is a
 * guarantee. See `Provenance.ts` and `Selection.ts`.
 */
export const SYSTEM_INSTRUCTIONS = `You are operating a back-office banking application to accomplish a goal for the first time. What you do here is recorded and turned into a reusable capability, so how you describe your actions matters as much as which ones you take.

You perceive the application only through its accessibility tree. You will never be shown a screenshot, and there is no way to write a CSS selector, an XPath or a coordinate: you name a control the way an operator would point at it, by its role and the name or caption a person reads.

Each turn, call exactly one action. Decide from what is on the screen now, not from what you expect to be there.

Naming controls:
- Prefer role plus accessible name. Add "within" to scope to a panel when a name appears more than once; on a legacy screen the same words often appear at several nesting levels.
- Use "label" for a value cell whose caption sits beside it in the row. This is how figures are read out of a table that has no headers.
- The contents of every frame on the screen are already inlined into the tree you are shown. There is no frame to step into, and a frame is not something a target can name or scope to: name the control itself, or scope to the heading of the section it sits in.
- If a target does not resolve, you are told what was on the screen and what to reach for instead. Read it and name the control differently rather than repeating yourself.

Values you type carry their origin, and getting this wrong silently ruins the capability:
- goalDerived: the value came from the goal. Name the parameter it should become, in a caller's vocabulary, e.g. "memberId" rather than "Member Number". Every word of the value must appear in the goal.
- uiDerived: the value was read off an earlier screen by an extract step. Name that step.
- constant: the value is fixed for every future run. It must NOT appear in the goal. If in doubt it is not a constant.

Choosing from a list: use selectFromList, not a click on a specific row. Match on the goal's own word, never the label you matched it against. If the goal says "savings" and the screen offers "Primary Savings", match on "savings" — another institution calls the same account "Regular Savings", and "Primary Savings" would not match it.

When the goal's answer is on screen, extract it and then call succeed. If the application is telling you something you cannot act on, or you have run out of ideas, call escalate. Stopping is a legitimate outcome; guessing is not.`

/** One earlier step, as it appears in the transcript. */
export interface StepSummary {
  readonly ordinal: number
  readonly line: string
}

export interface ObservationOptions {
  readonly goal: string
  readonly state: SurfaceState
  readonly step: number
  readonly maxSteps: number
  /** One line per completed step. Never a past accessibility tree. */
  readonly history: ReadonlyArray<StepSummary>
  /**
   * What went wrong with the last proposal, when something did: a denial, a
   * mis-tagged value, a target that named nothing. Fed back so the model can
   * correct rather than repeat.
   */
  readonly correction?: string | undefined
}

/**
 * The user turn: goal, where we are, what has happened, and what is on screen.
 *
 * The current screen goes last. It is the largest and most relevant part, and
 * putting it at the end keeps it adjacent to the model's own turn.
 */
export const observation = (options: ObservationOptions): string => {
  const { state } = options
  // Named, because which documents a screen is made of is a real fact about it
  // and the evidence should say so. Qualified, because the tree below shows
  // their contents and not their boundaries: without the qualification a reader
  // sees a list of names and reasonably tries to scope to one, which is exactly
  // the mistake the tree itself no longer invites.
  const named = state.frames.map((frame) =>
    frame.isMain ? "main document" : frame.name === "" ? "an unnamed frame" : frame.name
  )
  const frames = named.length <= 1
    ? named.join(", ")
    : `${named.join(", ")} — every frame's contents are inlined in the tree below, ` +
      "and a frame is not something a target can name"

  const parts: Array<string> = [
    `GOAL: ${options.goal}`,
    "",
    `Step ${options.step} of at most ${options.maxSteps}.`
  ]

  if (options.history.length === 0) {
    parts.push("Nothing has happened yet.")
  } else {
    parts.push("", "What has happened so far:")
    for (const step of options.history) {
      parts.push(`  ${step.ordinal}. ${step.line}`)
    }
  }

  if (options.correction !== undefined) {
    parts.push("", `YOUR LAST ACTION DID NOT HAPPEN: ${options.correction}`)
  }

  parts.push(
    "",
    `CURRENT SCREEN`,
    `  url:    ${state.url}`,
    `  title:  ${state.title}`,
    `  frames: ${frames}`,
    "",
    "accessibility tree:",
    state.accessibility
  )

  return parts.join("\n")
}

/**
 * The prompt for one decision.
 *
 * A system turn and a single user turn, rebuilt each step from the current screen
 * and the summarised history, rather than an accumulating chat. Two reasons: the
 * transcript stays bounded however long the run goes, and each decision is made
 * against a prompt that can be reproduced exactly from the trajectory — which is
 * what makes a bad decision investigable after the fact.
 *
 * The return type is `Prompt.RawInput`, and every content field is text. There is
 * no branch here that could attach an image.
 */
export const decisionPrompt = (options: ObservationOptions): Prompt.RawInput => [
  { role: "system", content: SYSTEM_INSTRUCTIONS },
  { role: "user", content: observation(options) }
]
