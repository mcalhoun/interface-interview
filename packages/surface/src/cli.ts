/**
 * `bun run surface` — look at Heritage Core the way this system does.
 *
 *   bun run surface observe /
 *   bun run surface observe "/account?memberNumber=12345&accountNumber=0000012345-S01"
 *   bun run surface resolve / --role textbox --name "Member Number" --within "Member Number Search"
 *
 * The diagnostic screens are where a Target has to work for its living. Each of
 * these fails, and says what would make it succeed:
 *
 *   bun run surface resolve /fixtures/duplicate-labels --role textbox --name Amount
 *   bun run surface resolve /fixtures/frames --role cell --label "Posted Balance"
 *   bun run surface resolve /fixtures/nested-tables --name "Clearing Bat"
 *
 * Two subcommands, because those are the two things worth being able to see by
 * hand: what a screen looks like as an accessibility tree, and which control a
 * Target picks out of it and why. The second one prints the reasoning, since a
 * Target that resolves for the wrong reason is the failure mode that matters.
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
  type Target,
  SurfaceAdapter,
  TargetAmbiguous,
  TargetNotFound,
  describeMatch,
  describeTarget,
  playwrightSurface
} from "./index.ts"

const USAGE = `usage:
  bun run surface observe <path|url>
  bun run surface resolve <path|url> [target options]

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

const observeCommand = Effect.fn("cli.observe")(function* () {
  const state = yield* printState()
  yield* Console.log("")
  yield* Console.log(state.accessibility)
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
                  `because:    ${failure.rationale} (${failure.considered} nodes considered)`
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

const program = Effect.gen(function* () {
  const argv = Bun.argv.slice(2)
  const command = argv[0]
  const location = argv[1]

  if ((command !== "observe" && command !== "resolve") || location === undefined) {
    yield* Console.log(USAGE)
    return
  }

  // A bare path means "against the mock app", so the demo is one command.
  const origin = /^https?:\/\//.test(location)
    ? undefined
    : (yield* serve({ port: 0 })).origin
  const url = origin === undefined ? location : origin + location

  const run = command === "observe" ? observeCommand() : resolveCommand(buildTarget(parseOptions(argv)))

  yield* run.pipe(Effect.provide(playwrightSurface({ startUrl: url })))
})

Effect.runPromise(Effect.scoped(program)).catch((cause) => {
  console.error(String(cause))
  process.exitCode = 1
})
