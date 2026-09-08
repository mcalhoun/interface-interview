/**
 * What the system can see a person do to the screen it handed them.
 *
 * ## Why this exists
 *
 * ADR-0008 makes every declared parameter sensitive and builds the run's
 * scrubber from them before anything starts. A person who takes control types
 * things no parameter ever named: a supervisor id, an override code, whatever
 * the screen in front of them is refusing without. Those are the same class of
 * value and arguably a worse one, because a credential is not merely
 * identifying. Until they are registered, anything the application echoes back,
 * renders into a field or puts in a URL is written into the log in the clear.
 *
 * The first version of this asked the Operator to retype what they had typed,
 * on a form, before they could hand control back. That is the machine's job. A
 * real person met it once, did not do it, and a supervisor id went into the log
 * three times.
 *
 * ## What replaced it
 *
 * The system owns the browser. A filled control carries its value in the
 * accessibility tree beside its accessible name -- `textbox "Supervisor ID":
 * SUP7` reads as plainly as a balance cell reads its figure -- and a submitted
 * GET form carries it in the address. Both are observation, in the one channel
 * ADR-0001 permits. So the Session watches the screen while a person holds it
 * and registers what changed, and the free-text note goes back to being what a
 * note is: what observation cannot infer.
 *
 * ## The rule, and its one deliberate cost
 *
 * A value is registered the first time it is seen, not once it looks finished.
 * Waiting for a value to stop changing would produce tidier needles and would
 * lose the case this exists for, which is somebody typing a code and pressing
 * the button in the same second. The cost is that a half-typed value can become
 * a needle of its own and make the log harder to read. That is the trade this
 * system has already made everywhere else: illegible evidence is recoverable, a
 * leaked credential is not.
 *
 * Values already on the screen when the pause began are never registered. They
 * are what automation put there, they are covered by the run's own scrubber,
 * and registering them under a second name would say a person typed something
 * they did not.
 */

import { Effect } from "effect"
import type { EnteredValue } from "./Intervention.ts"

/**
 * How a paused Session sees the screen it is handing over.
 *
 * A value rather than a service, and passed to `pause` by the engine, because
 * the engine is the one expression in the system that holds both the live
 * Surface and the Session. Nothing else can pause, so nothing else has to
 * remember to supply this: the type will not let a run park a person in front
 * of a screen it cannot see.
 */
export interface ScreenWatch {
  /**
   * Every value a field on the live screen is holding, right now.
   *
   * Never fails. An observation that could not be taken is an empty answer for
   * that moment, not a reason to end an episode a person is in the middle of.
   */
  readonly entries: Effect.Effect<ReadonlyArray<EnteredValue>>
}

/**
 * A watch that sees nothing.
 *
 * The explicit spelling of "this Session has no screen behind it", for the
 * state-machine tests that have no browser, and the string `grep -rn
 * watchesNothing` finds every instance of. It is not a way to switch the
 * capture off in a real run: the only caller of `pause` is the engine, and the
 * engine has a Surface.
 */
export const watchesNothing: ScreenWatch = { entries: Effect.succeed([]) }

/**
 * What the watcher has seen so far, per field.
 *
 * `known` is every value that field has held that this watch has already
 * accounted for: what was there at the start, and everything registered since.
 * A field can hold several values over one episode -- somebody clears a code
 * and types another -- and each of them is a needle.
 */
export interface WatchState {
  readonly known: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * The key one field is tracked under.
 *
 * The field name plus how many fields of that name came before it in document
 * order, because a screen can carry three controls captioned `Amount` and the
 * value in each of them is a different value.
 */
const keysFor = (entries: ReadonlyArray<EnteredValue>): ReadonlyArray<
  { readonly key: string; readonly entry: EnteredValue }
> => {
  const counts = new Map<string, number>()
  return entries.map((entry) => {
    const ordinal = counts.get(entry.field) ?? 0
    counts.set(entry.field, ordinal + 1)
    return { key: `${entry.field} #${ordinal}`, entry }
  })
}

/**
 * The screen as it was before anybody touched it. Nothing here is registered.
 */
export const beganWith = (entries: ReadonlyArray<EnteredValue>): WatchState => {
  const known = new Map<string, Set<string>>()
  for (const { key, entry } of keysFor(entries)) {
    const values = known.get(key) ?? new Set<string>()
    values.add(entry.value)
    known.set(key, values)
  }
  return { known }
}

/**
 * One look at the screen: what is new, and what to remember for the next look.
 *
 * Pure, so the rule can be tested without a browser and read without one.
 */
export const sawEntries = (
  state: WatchState,
  entries: ReadonlyArray<EnteredValue>
): { readonly state: WatchState; readonly register: ReadonlyArray<EnteredValue> } => {
  const known = new Map<string, Set<string>>(
    [...state.known].map(([key, values]) => [key, new Set(values)])
  )
  const register: Array<EnteredValue> = []
  for (const { key, entry } of keysFor(entries)) {
    const values = known.get(key) ?? new Set<string>()
    if (!values.has(entry.value)) {
      values.add(entry.value)
      register.push(entry)
    }
    known.set(key, values)
  }
  return { state: { known }, register }
}
