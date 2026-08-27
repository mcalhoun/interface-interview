/**
 * `bun run surface` — look at Heritage Core the way this system does.
 *
 *   bun run surface observe /
 *   bun run surface observe "/account?memberNumber=12345&accountNumber=0000012345-S01"
 *   bun run surface resolve / --role textbox --name "Member Number" --within "Member Number Search"
 *   bun run surface select "/member?memberNumber=22222" --within "Share and Deposit Accounts" \
 *     --item-role link --match Savings
 *
 * The diagnostic screens are where a Target has to work for its living. Each of
 * these fails, and says what would make it succeed:
 *
 *   bun run surface resolve /fixtures/duplicate-labels --role textbox --name Amount
 *   bun run surface resolve /fixtures/frames --role cell --label "Posted Balance"
 *   bun run surface resolve /fixtures/nested-tables --name "Clearing Bat"
 *
 * Three subcommands, because those are the things worth being able to see by
 * hand: what a screen looks like as an accessibility tree, which control a
 * Target picks out of it and why, and which item of a list a parameter selects
 * and out of what. Each prints its reasoning, since something that resolves for
 * the wrong reason is the failure mode that matters.
 *
 * A bare path starts Heritage Core in-process on a free port; an absolute URL is
 * used as given, so the same command works against anything.
 *
 * Argument parsing is hand-rolled rather than `effect/unstable/cli`, which needs
 * platform services (`FileSystem`, `Terminal`, `Stdio`, `ChildProcessSpawner`)
 * from a platform package this workspace does not depend on yet.
 */

import { serve } from "@cua/legacy-core"
import { Console, Effect } from "effect"
import {
  type ListDescription,
  type Target,
  SurfaceAdapter,
  TargetAmbiguous,
  TargetNotFound,
  describeMatch,
  describeTarget,
  formatAccessibilityTreeWithFrames,
  playwrightSurface,
  selectFromTree
} from "./index.ts"

const USAGE = `usage:
  bun run surface observe <path|url>
  bun run surface resolve <path|url> [target options]
  bun run surface select  <path|url> --item-role <role> --match <text> [--within <text>]

select options:
  --item-role <role>   the role each item of the list carries, e.g. link
  --match <text>       the value to match against the item labels, by token subset
  --within <text>      the panel or table the list sits in

target options:
  --role <role>        e.g. textbox, button, link, cell
  --name <text>        the accessible name
  --exact              require an exact name match
  --label <text>       the visible caption beside the control
  --near <text>        text the control sits near, measured over the tree
  --within <text>      the panel that text heads
  --within-role <role> narrow the scope to one role
  --nth <n>            zero-based choice among equally good matches`

interface Options {
  readonly flags: ReadonlyMap<string, string>
  readonly switches: ReadonlySet<string>
}

const parseOptions = (argv: ReadonlyArray<string>): Options => {
  const flags = new Map<string, string>()
  const switches = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (!argument.startsWith("--")) continue
    const key = argument.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith("--")) {
      switches.add(key)
    } else {
      flags.set(key, next)
      index += 1
    }
  }
  return { flags, switches }
}

const buildTarget = (options: Options): Target => {
  const scopeName = options.flags.get("within")
  const scopeRole = options.flags.get("within-role")
  const nth = options.flags.get("nth")
  return {
    ...(options.flags.has("role") ? { role: options.flags.get("role")! } : {}),
    ...(options.flags.has("name") ? { name: options.flags.get("name")! } : {}),
    ...(options.switches.has("exact") ? { exact: true } : {}),
    ...(options.flags.has("label") ? { label: options.flags.get("label")! } : {}),
    ...(options.flags.has("near") ? { textNear: options.flags.get("near")! } : {}),
    ...(scopeName === undefined && scopeRole === undefined
      ? {}
      : {
          within: {
            ...(scopeRole === undefined ? {} : { role: scopeRole }),
            ...(scopeName === undefined ? {} : { name: scopeName })
          }
        }),
    ...(nth === undefined ? {} : { nth: Number(nth) })
  }
}

const printState = Effect.fn("cli.printState")(function* () {
  const surface = yield* SurfaceAdapter
  const state = yield* surface.observe
  yield* Console.log(`url:    ${state.url}`)
  yield* Console.log(`title:  ${state.title}`)
  yield* Console.log(
    `frames: ${state.frames.map((frame) => `${frame.name === "" ? "(unnamed)" : frame.name}`).join(", ")}`
  )
  return state
})

/**
 * The one place the frame-annotated render is printed.
 *
 * A person reading a screen by hand wants to know where one document ends and
 * the next begins, and this is a diagnostic tool. `state.accessibility` is the
 * other render — the one shown to anything that will answer with a Target — and
 * it deliberately says nothing about frames, because a Target cannot name one.
 */
const observeCommand = Effect.fn("cli.observe")(function* () {
  const state = yield* printState()
  yield* Console.log("")
  yield* Console.log(formatAccessibilityTreeWithFrames(state.tree))
})

const resolveCommand = Effect.fn("cli.resolve")(function* (target: Target) {
  const surface = yield* SurfaceAdapter
  yield* printState()
  yield* Console.log("")
  yield* Console.log(`target: ${describeTarget(target)}`)

  // A Target that fails to resolve is the interesting case, so report it in the
  // adapter's own words rather than letting a stack trace stand in for it.
  const resolution = yield* surface.resolveTarget(target).pipe(
    Effect.catch((failure) =>
      Effect.gen(function* () {
        yield* Console.log(
          failure instanceof TargetAmbiguous
            ? [
                "",
                `AMBIGUOUS: ${failure.matches.length} controls answer to this Target.`,
                ...failure.matches.map(
                  (match) => `  ${describeMatch(match)}  reads ${JSON.stringify(match.text)}`
                ),
                "",
                `to fix:  ${failure.remedy}`,
                `because: ${failure.rationale}`
              ].join("\n")
            : failure instanceof TargetNotFound
              ? [
                  "",
                  `NOT FOUND: nothing answers to this Target.`,
                  `emptied by: ${failure.narrowedBy ?? "the screen offered nothing to narrow"}`,
                  `because:    ${failure.rationale} (${failure.considered} nodes considered)`,
                  `to fix:     ${failure.remedy}`
                ].join("\n")
              : `\nSURFACE UNAVAILABLE: ${failure.reason}`
        )
        process.exitCode = 1
        return undefined
      })
    )
  )
  if (resolution === undefined) return

  yield* Console.log("")
  yield* Console.log(`found:      ${resolution.match.description}`)
  yield* Console.log(`region:     ${resolution.match.region}`)
  yield* Console.log(`frame:      ${resolution.match.frame}`)
  yield* Console.log(`path:       ${resolution.match.path}`)
  yield* Console.log(`reads:      ${resolution.match.text}`)
  yield* Console.log(`strategies: ${resolution.strategies.join(" -> ")}`)
  yield* Console.log(`because:    ${resolution.rationale}`)
  yield* Console.log(`considered: ${resolution.considered} accessibility nodes`)
  // The headline: whether this Target named one control or merely counted to one.
  yield* Console.log(
    resolution.alternatives === 0
      ? "unique:     yes, exactly one control answered"
      : `unique:     no, ${resolution.alternatives} other control(s) also answered and nth chose`
  )
})

/**
 * Show the account list the way Replay sees it, and which item a parameter picks
 * out of it.
 *
 *   bun run surface select "/member?memberNumber=12345" \
 *     --within "Share and Deposit Accounts" --item-role link --match Savings
 *
 * Worth having by hand because the interesting question about token-subset
 * matching is not whether it worked once — it is what a *different* tenant's
 * labels do to it, and this prints the whole list beside the verdict.
 */
const selectCommand = Effect.fn("cli.select")(function* (options: Options) {
  const itemRole = options.flags.get("item-role")
  const wanted = options.flags.get("match")
  if (itemRole === undefined || wanted === undefined) {
    yield* Console.log(USAGE)
    return
  }
  const within = options.flags.get("within")
  const list: ListDescription = {
    itemRole,
    ...(within === undefined ? {} : { within: { name: within } })
  }

  const state = yield* printState()
  const selection = selectFromTree(state.tree, { list, wanted })

  yield* Console.log("")
  yield* Console.log(`list:  ${itemRole} items${within === undefined ? "" : ` in "${within}"`}`)
  yield* Console.log(`match: ${JSON.stringify(wanted)} by token subset`)
  yield* Console.log("")
  switch (selection._tag) {
    case "Selected":
      yield* Console.log(`SELECTED: ${JSON.stringify(selection.item.label)}`)
      break
    case "NoMatch":
      yield* Console.log("NO MATCHING ITEM")
      process.exitCode = 1
      break
    case "AmbiguousMatch":
      yield* Console.log(
        `AMBIGUOUS MATCH: ${selection.matches.map((match) => JSON.stringify(match.label)).join(", ")}`
      )
      process.exitCode = 1
      break
  }
  yield* Console.log(`because:  ${selection.rationale}`)
  yield* Console.log("")
  yield* Console.log("on offer:")
  for (const item of selection.items) {
    yield* Console.log(`  - ${JSON.stringify(item.label)}  [${item.frame}]  ${item.path}`)
  }
})

const program = Effect.gen(function* () {
  const argv = Bun.argv.slice(2)
  const command = argv[0]
  const location = argv[1]

  if (
    (command !== "observe" && command !== "resolve" && command !== "select") ||
    location === undefined
  ) {
    yield* Console.log(USAGE)
    return
  }

  // A bare path means "against the mock app", so the demo is one command.
  const origin = /^https?:\/\//.test(location)
    ? undefined
    : (yield* serve({ port: 0 })).origin
  const url = origin === undefined ? location : origin + location

  const options = parseOptions(argv)
  const run = command === "observe"
    ? observeCommand()
    : command === "select"
      ? selectCommand(options)
      : resolveCommand(buildTarget(options))

  yield* run.pipe(Effect.provide(playwrightSurface({ startUrl: url })))
})

Effect.runPromise(Effect.scoped(program)).catch((cause) => {
  console.error(String(cause))
  process.exitCode = 1
})
