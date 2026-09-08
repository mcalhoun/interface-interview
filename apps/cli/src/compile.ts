import { commandArguments } from "./arguments.ts"
/** Loads a staged, deidentified compilation. Private checks ran in discovery. */

import { readFileSync } from "node:fs"
import {
  CapabilityArtifactSchema,
  ARTIFACTS_DIRECTORY,
  formatArtifact,
  parseArtifact,
  writeArtifact
} from "@cua/artifact"
import { Console, Effect, Result, Schema } from "effect"

const DEFAULT_VERSION = "1.0.0"

const usage = (): string =>
  [
    "usage:",
    "  bun run compile <compilation.json> --capability <name> [options]",
    "",
    "options:",
    "  --capability <name>  override the staged dotted capability name",
    `  --version <ver>      the version to cut (default: ${DEFAULT_VERSION})`,
    "  --product <text>     the vendor product, for a reviewer's context",
    "  --title <text>       one-line capability summary",
    `  --out <dir>          where artifacts are stored (default: ${ARTIFACTS_DIRECTORY})`,
    "  --dry-run            print the document and write nothing",
    "",
    "example:",
    "  bun run compile evidence/discovery/<run>/compilation.json \\",
    "    --capability member.account-balance.discovered \\",
    "    --product \"Heritage Core Member Services (MSS 4.02.11)\""
  ].join("\n")


const program = Effect.gen(function*() {
  const argv = commandArguments({ switches: ['dry-run', 'help'], options: ['capability', 'version', 'product', 'title', 'out'], maxPositionals: 1 })
  if (argv.switches.has("help") || argv.positionals[0] === undefined) { yield* Console.log(usage()); return }
  let document: unknown
  try { document = JSON.parse(readFileSync(argv.positionals[0], "utf8")) }
  catch { yield* Console.error("Could not read a compilation JSON file"); process.exitCode = 2; return }
  const envelope = Schema.decodeUnknownResult(Schema.Struct({
    format: Schema.Literal("discovery-compilation-v1"),
    verification: Schema.Literal("checked-in-memory-before-erasing-private-context"),
    artifact: Schema.Unknown
  }))(document)
  if (Result.isFailure(envelope)) {
    yield* Console.error("This file is a diagnostic trajectory or an unsupported legacy format. " +
      "Raw goals are no longer stored. Discover again with --emit to prepare a compilation " +
      "while the private goal and parameter values are in memory.")
    process.exitCode = 2
    return
  }
  const decoded = Schema.decodeUnknownResult(CapabilityArtifactSchema)(envelope.success.artifact)
  if (Result.isFailure(decoded)) {
    yield* Console.error("The staged artifact does not satisfy the artifact schema")
    process.exitCode = 2
    return
  }
  const source = decoded.success
  const candidate = {
    ...source,
    capability: argv.options["capability"] ?? source.capability,
    version: argv.options["version"] ?? source.version,
    title: argv.options["title"] ?? source.title,
    surface: { ...source.surface, product: argv.options["product"] ?? source.surface.product }
  }
  const parsed = parseArtifact(candidate.capability, formatArtifact(candidate))
  if (Result.isFailure(parsed)) {
    yield* Console.error("The staged artifact is invalid after applying the requested options")
    process.exitCode = 2
    return
  }
  yield* Console.error("Loaded a staged artifact whose receipt records private-data checks during discovery; " +
    "they cannot be repeated from this file. This command validates the artifact schema.")
  if (argv.switches.has("dry-run")) { yield* Console.log(formatArtifact(parsed.success)); return }
  const written = writeArtifact(argv.options["out"] ?? ARTIFACTS_DIRECTORY, parsed.success)
  if (Result.isFailure(written)) {
    yield* Console.error(written.failure.message); process.exitCode = 1; return
  }
  yield* Console.log(`written: ${written.success}`)
})

Effect.runPromise(program).catch(() => {
  console.error("Compilation could not complete")
  process.exitCode = 1
})
