/**
 * `bun run catalog` — list the Capabilities a calling agent can invoke.
 *
 *   bun run catalog                              # every capability, with its signature
 *   bun run catalog member.account-balance       # one, with the artifact's full prose
 *   bun run catalog member.account-balance --version 1.0.0
 *   bun run catalog --json                       # the same signatures, machine-readable
 *
 * Each entry ends with the exact command that runs it, so discovering a
 * Capability and calling it are two steps and no reading of a document in
 * between. That is the whole point of a catalog: `bun run replay` is the call,
 * this is the signature.
 *
 * ## What this deliberately does not do
 *
 * It does not invoke anything. A catalog that also ran things would need a
 * browser, a policy, an evidence writer and a session — `bun run replay` already
 * has all four, and validates a caller's arguments through the same
 * `prepareInputs` this file reads the declarations from. Two entry points over
 * one set of declarations, rather than a second execution path that could drift
 * from the first.
 *
 * Argument parsing is hand-rolled for the same reason `bun run replay`'s is:
 * `effect/unstable/cli` requires platform services this workspace does not depend
 * on.
 */

import { Console, Effect, Result } from "effect"
import { ARTIFACTS_DIRECTORY } from "./store.ts"
import {
  REPLAY_COMMAND,
  describeCatalog,
  describeCatalogEntry,
  readCatalog,
  readCatalogEntry
} from "./catalog.ts"

const usage = (): string =>
  [
    "usage:",
    "  bun run catalog [capability] [options]",
    "",
    "options:",
    "  --version <ver>   describe a specific stored version rather than the current one",
    `  --dir <path>      where artifacts are stored (default: ${ARTIFACTS_DIRECTORY})`,
    "  --json            print the signatures as JSON, for a calling agent",
    "  --help            this",
    "",
    `Every entry ends with the ${REPLAY_COMMAND} line that invokes it. Arguments are`,
    "checked against the declared inputs before a browser opens, so a bad call",
    "costs nothing.",
    "",
    "The current version of a capability is the highest one stored. Omit",
    "--version to get it; pass --version to pin a run to an older document."
  ].join("\n")

interface Argv {
  readonly capability: string | undefined
  readonly options: Readonly<Record<string, string>>
  readonly switches: ReadonlySet<string>
}

const parse = (argv: ReadonlyArray<string>): Argv => {
  const options: Record<string, string> = {}
  const switches = new Set<string>()
  let capability: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (!argument.startsWith("--")) {
      capability ??= argument
      continue
    }
    const key = argument.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith("--")) {
      switches.add(key)
    } else {
      options[key] = next
      index += 1
    }
  }
  return { capability, options, switches }
}

const program = Effect.gen(function* () {
  const argv = parse(Bun.argv.slice(2))
  if (argv.switches.has("help")) {
    yield* Console.log(usage())
    return
  }

  const directory = argv.options["dir"] ?? ARTIFACTS_DIRECTORY
  const asJson = argv.switches.has("json")

  if (argv.capability !== undefined) {
    const entry = readCatalogEntry(directory, argv.capability, argv.options["version"])
    if (Result.isFailure(entry)) {
      yield* Console.error(`no such capability: ${entry.failure.message}`)
      process.exitCode = 2
      return
    }
    // A named capability gets the Artifact's own prose in full. The list view
    // shows the first line of each field; a caller who has chosen one wants the
    // paragraph that says what it does about a member who is not on file.
    yield* Console.log(
      asJson
        ? JSON.stringify(entry.success, undefined, 2)
        : `${describeCatalogEntry(entry.success, true)}\n`
    )
    return
  }

  const catalog = readCatalog(directory)
  yield* Console.log(
    asJson
      ? JSON.stringify(
          {
            capabilities: catalog.entries,
            // Flattened to their messages: an error class is not a stable wire
            // shape, and what a caller can do with one of these is read it.
            problems: catalog.problems.map((problem) => problem.message)
          },
          undefined,
          2
        )
      : describeCatalog(catalog)
  )
  // An Artifact that will not parse is a capability that has silently stopped
  // existing, which is worth a non-zero exit even though the rest of the catalog
  // printed fine.
  if (catalog.problems.length > 0) process.exitCode = 1
})

Effect.runPromise(program).catch((cause) => {
  console.error(String(cause))
  process.exitCode = 1
})
