import { secretRegistry } from "@cua/evidence"
import { commandArguments, numberOption } from "./arguments.ts"
import { DEFAULT_POLICY, POLICIES_DIRECTORY, loadPolicy, originAuthorizer, personalCaptions, personalLabelFor } from "@cua/policy"
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
import { Console, Effect, Result } from "effect"
import {
  labelledValuesIn,
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
} from "@cua/surface"

const diagnostics = secretRegistry()
const print = (text: string) => Console.log(diagnostics.scrub(text))

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
  const location = new URL(state.url)
  diagnostics.remember([
    ...[...location.searchParams.entries()].map(([label, text]) => ({ label, text })),
    { label: "urlUser", text: location.username }, { label: "urlPassword", text: location.password },
    ...labelledValuesIn(state.tree, personalCaptions).flatMap((found) => {
      const label = personalLabelFor(found.caption)
      return label === undefined ? [] : [{ label, text: found.text }]
    })
  ])
  yield* print(`url:    ${state.url}`)
  yield* print(`title:  ${state.title}`)
  yield* print(
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
  yield* print("")
  yield* print(formatAccessibilityTreeWithFrames(state.tree))
})

const resolveCommand = Effect.fn("cli.resolve")(function* (target: Target) {
  const surface = yield* SurfaceAdapter
  yield* printState()
  yield* print("")
  yield* print(`target: ${describeTarget(target)}`)

  // A Target that fails to resolve is the interesting case, so report it in the
  // adapter's own words rather than letting a stack trace stand in for it.
  const resolution = yield* surface.resolveTarget(target).pipe(
    Effect.catch((failure) =>
      Effect.gen(function* () {
        yield* print(
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

  yield* print("")
  yield* print(`found:      ${resolution.match.description}`)
  yield* print(`region:     ${resolution.match.region}`)
  yield* print(`frame:      ${resolution.match.frame}`)
  yield* print(`path:       ${resolution.match.path}`)
  yield* print(`reads:      ${resolution.match.text}`)
  yield* print(`strategies: ${resolution.strategies.join(" -> ")}`)
  yield* print(`because:    ${resolution.rationale}`)
  yield* print(`considered: ${resolution.considered} accessibility nodes`)
  // The headline: whether this Target named one control or merely counted to one.
  yield* print(
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
    yield* print(USAGE)
    return
  }
  const within = options.flags.get("within")
  const list: ListDescription = {
    itemRole,
    ...(within === undefined ? {} : { within: { name: within } })
  }

  const state = yield* printState()
  const selection = selectFromTree(state.tree, { list, wanted })

  yield* print("")
  yield* print(`list:  ${itemRole} items${within === undefined ? "" : ` in "${within}"`}`)
  yield* print(`match: ${JSON.stringify(wanted)} by token subset`)
  yield* print("")
  switch (selection._tag) {
    case "Selected":
      yield* print(`SELECTED: ${JSON.stringify(selection.item.label)}`)
      break
    case "NoMatch":
      yield* print("NO MATCHING ITEM")
      process.exitCode = 1
      break
    case "AmbiguousMatch":
      yield* print(
        `AMBIGUOUS MATCH: ${selection.matches.map((match) => JSON.stringify(match.label)).join(", ")}`
      )
      process.exitCode = 1
      break
  }
  yield* print(`because:  ${selection.rationale}`)
  yield* print("")
  yield* print("on offer:")
  for (const item of selection.items) {
    yield* print(`  - ${JSON.stringify(item.label)}  [${item.frame}]  ${item.path}`)
  }
})

const program = Effect.gen(function* () {
  const argv = commandArguments({ switches: ["exact", "help"], options: ["item-role", "match", "within", "role", "name", "label", "near", "within-role", "nth"], maxPositionals: 2 })
  const command = argv.positionals[0]
  const location = argv.positionals[1]
  if (argv.switches.has("help")) { yield* print(USAGE); return }

  if (
    (command !== "observe" && command !== "resolve" && command !== "select") ||
    location === undefined
  ) {
    yield* print(USAGE)
    if (Bun.argv.length > 2) process.exitCode = 2
    return
  }
  numberOption(argv, "nth", { integer: true })
  if (command === "select" && (argv.options["item-role"] === undefined || argv.options["match"] === undefined)) {
    yield* Console.error("select requires --item-role and --match"); process.exitCode = 2; return
  }
  const policy = loadPolicy(POLICIES_DIRECTORY, DEFAULT_POLICY)
  if (Result.isFailure(policy)) { yield* Console.error("Cannot load surface policy"); process.exitCode = 2; return }

  // A bare path means "against the mock app", so the demo is one command.
  const origin = /^https?:\/\//.test(location)
    ? undefined
    : (yield* serve({ port: 0 })).origin
  const url = origin === undefined ? location : origin + location

  const options: Options = { flags: new Map(Object.entries(argv.options)), switches: argv.switches }
  const run = command === "observe"
    ? observeCommand()
    : command === "select"
      ? selectCommand(options)
      : resolveCommand(buildTarget(options))

  yield* run.pipe(Effect.provide(playwrightSurface({ startUrl: url, authorizeOrigin: originAuthorizer(policy.success) })))
})

Effect.runPromise(Effect.scoped(program)).catch(() => {
  console.error("Surface diagnostic could not complete under the configured policy")
  process.exitCode = 1
})
