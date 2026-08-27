/**
 * `bun run compile` — turn a recorded discovery run into a stored Capability
 * Artifact.
 *
 *   bun run compile evidence/discovery/<run>/trajectory.json \
 *     --capability member.account-balance.discovered \
 *     --product "Heritage Core Member Services (MSS 4.02.11)"
 *
 * A second entry point rather than the only one. `bun run discover --emit <name>`
 * compiles in the same process the moment a run succeeds, which is the path SPEC
 * describes and the one where nothing is lost between the run and the document.
 * This one exists because a Trajectory is a value that can be written down: a run
 * that happened last week, on a machine with a working model key, can be compiled
 * here — and reviewed, and diffed — without running it again.
 *
 * ## What a stored Trajectory cannot carry, and what that costs
 *
 * A Trajectory is scrubbed on the way out (ticket 10), so the file on disk holds
 * `<redacted:memberId>` where the run held a member number. That is the property
 * that makes one safe to commit, and it means two of the compiler's three gates
 * have nothing to look for when compiling from a file: they check the document
 * for values, and the values are gone.
 *
 * The gate that matters most still runs at full strength. The Goal is the one
 * field a Trajectory keeps in the clear, precisely so ADR-0008's goal-echo check
 * cannot pass vacuously, and every `goalDerived` literal is by construction made
 * of the Goal's own words. So a member number baked into a constant is still
 * caught here; what is not caught is a value that never appeared in the Goal.
 * This CLI says so out loud when it notices, rather than reporting a clean bill
 * of health it did not earn.
 */

import { readFileSync } from "node:fs"
import {
  type CapabilityArtifact,
  ARTIFACTS_DIRECTORY,
  formatArtifact,
  isSensitive,
  listVersions,
  writeArtifact
} from "@cua/artifact"
import { Console, Effect, Redacted, Result, Schema } from "effect"
import { PRODUCT_UNIDENTIFIED, compileArtifact } from "./compile.ts"
import { ProvenancedValue } from "./Provenance.ts"
import type { Trajectory } from "./Trajectory.ts"

const DEFAULT_VERSION = "1.0.0"

const usage = (): string =>
  [
    "usage:",
    "  bun run compile <trajectory.json> --capability <name> [options]",
    "",
    "options:",
    "  --capability <name>  the dotted name a calling agent invokes (required)",
    `  --version <ver>      the version to cut (default: ${DEFAULT_VERSION})`,
    "  --product <text>     the vendor product, for a reviewer's context",
    "  --title <text>       one line for a catalog listing",
    `  --out <dir>          where artifacts are stored (default: ${ARTIFACTS_DIRECTORY})`,
    "  --dry-run            print the document and write nothing",
    "",
    "example:",
    "  bun run compile evidence/discovery/<run>/trajectory.json \\",
    "    --capability member.account-balance.discovered \\",
    "    --product \"Heritage Core Member Services (MSS 4.02.11)\""
  ].join("\n")

// ---------------------------------------------------------------------------
// Reading a Trajectory back off disk
// ---------------------------------------------------------------------------

/**
 * The stored form, decoded rather than cast.
 *
 * A JSON file is unknown data whatever produced it, and the compiler's guarantees
 * are only worth what its input is. Unknown fields are dropped by the decode, so
 * a Trajectory written by a later version of the loop compiles on the fields this
 * one understands rather than half-working.
 */
const StoredTrajectory = Schema.Struct({
  goal: Schema.String,
  runId: Schema.String,
  sessionId: Schema.String,
  entry: Schema.String,
  evidenceDirectory: Schema.String,
  conclusion: Schema.Struct({
    conclusion: Schema.String,
    summary: Schema.optional(Schema.String)
  }),
  steps: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      intent: Schema.String,
      rationale: Schema.String,
      verb: Schema.String,
      action: Schema.Record(Schema.String, Schema.Unknown),
      value: Schema.optional(ProvenancedValue),
      outcome: Schema.Struct({
        url: Schema.String,
        resolvedBy: Schema.Array(Schema.String),
        rationale: Schema.String,
        alternatives: Schema.Number,
        read: Schema.optional(Schema.String)
      }),
      authorisedBy: Schema.Struct({ policy: Schema.String, risk: Schema.String })
    })
  ),
  parameters: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      usedBy: Schema.Array(Schema.String),
      sensitive: Schema.Boolean,
      literal: Schema.String
    })
  ),
  selections: Schema.Array(
    Schema.Struct({
      stepId: Schema.String,
      parameter: Schema.String,
      values: Schema.Array(Schema.String),
      default: Schema.String,
      matched: Schema.optional(Schema.String),
      discoveredFrom: Schema.String,
      robustness: Schema.String
    })
  ),
  outputs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      fromStep: Schema.String,
      description: Schema.String,
      value: Schema.optional(Schema.String)
    })
  ),
  signatures: Schema.Array(Schema.String),
  steps_attempted: Schema.Number,
  durationMillis: Schema.Number
})

const decodeStored = Schema.decodeUnknownResult(StoredTrajectory)

/** What a value looks like once the wrapper has already stopped it once. */
const isPlaceholder = (literal: string): boolean => /^<redacted:.+>$/.test(literal)

/** A Trajectory, and whether the values behind its parameters survived the trip. */
interface LoadedTrajectory {
  readonly trajectory: Trajectory
  /** True when the file carries placeholders rather than what the run typed. */
  readonly scrubbed: boolean
}

const loadTrajectory = (path: string): Result.Result<LoadedTrajectory, string> => {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return Result.fail(`no trajectory at ${path}`)
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (cause) {
    return Result.fail(`${path} is not valid JSON: ${cause}`)
  }
  const decoded = decodeStored(document)
  if (Result.isFailure(decoded)) {
    return Result.fail(`${path} is not a trajectory: ${decoded.failure}`)
  }
  const stored = decoded.success
  if (stored.conclusion.conclusion !== "reached") {
    return Result.fail(
      `that run ended ${stored.conclusion.conclusion} rather than reaching its goal, so there ` +
        `is no capability to compile from it`
    )
  }
  return Result.succeed({
    trajectory: {
      ...stored,
      conclusion: { conclusion: "reached", summary: stored.conclusion.summary ?? "" },
      parameters: stored.parameters.map((parameter) => ({
        ...parameter,
        // Re-wrapped on the way in, so the compiler sees the same type whether a
        // Trajectory came from a live run or from a file. What is inside it here
        // is the placeholder the scrubber left, which the note at the end of a
        // run says plainly rather than letting a reader assume otherwise.
        literal: Redacted.make(parameter.literal, { label: parameter.name })
      })),
      // Written out field by field rather than spread: a Trajectory says
      // `matched: string | undefined` — the field is always there and may be
      // empty — where a decoded optional says the field may be missing. They are
      // different statements and the compiler is right to insist.
      selections: stored.selections.map((selection) => ({
        ...selection,
        matched: selection.matched
      })),
      outputs: stored.outputs.map((output) => ({ ...output, value: output.value }))
    },
    scrubbed: stored.parameters.some((parameter) => isPlaceholder(parameter.literal))
  })
}

// ---------------------------------------------------------------------------

interface Argv {
  readonly path: string | undefined
  readonly options: Readonly<Record<string, string>>
  readonly switches: ReadonlySet<string>
}

const parse = (argv: ReadonlyArray<string>): Argv => {
  const options: Record<string, string> = {}
  const switches = new Set<string>()
  let path: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (!argument.startsWith("--")) {
      path ??= argument
      continue
    }
    const key = argument.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith("--")) switches.add(key)
    else {
      options[key] = next
      index += 1
    }
  }
  return { path, options, switches }
}

/**
 * What was derived, for someone deciding whether to approve it.
 *
 * Leads with the parameters and the selection rule rather than with the steps,
 * for the same reason the discovery report does: the steps are how it got there,
 * and the contract is what it learned.
 */
const report = (
  trajectory: Trajectory,
  artifact: CapabilityArtifact
): Effect.Effect<void> =>
  Effect.gen(function*() {
    yield* Console.log("")
    yield* Console.log(`compiled ${artifact.capability}@${artifact.version} (${
      artifact.steps.length
    } steps)`)

    yield* Console.log("")
    yield* Console.log("inputs derived from recorded provenance:")
    for (const [name, input] of Object.entries(artifact.inputs)) {
      const shape = input.type === "enum"
        ? `enum ${input.values?.map((value) => JSON.stringify(value)).join(", ") ?? ""}`
        : input.type
      yield* Console.log(
        `  ${name}: ${shape}  (sensitive: ${isSensitive(input)}${
          input.default === undefined ? "" : `; default ${JSON.stringify(input.default)}`
        })`
      )
    }

    for (const selection of trajectory.selections) {
      yield* Console.log("")
      yield* Console.log(`selection rule (${selection.parameter}):`)
      yield* Console.log(
        `  default:        ${JSON.stringify(selection.default)}   (the goal's word — recorded)`
      )
      yield* Console.log(
        `  matched label:  ${JSON.stringify(selection.matched ?? "")}   (this tenant's word — NOT recorded)`
      )
    }

    yield* Console.log("")
    yield* Console.log("outputs:")
    for (const [name, output] of Object.entries(artifact.outputs)) {
      yield* Console.log(
        `  ${name}: ${output.type}${
          output.currency === undefined ? "" : ` ${output.currency}`
        }  <- step ${output.from.step}`
      )
    }
  })

const program = Effect.gen(function*() {
  const argv = parse(Bun.argv.slice(2))
  if (argv.path === undefined) {
    yield* Console.log(usage())
    return
  }

  const capability = argv.options["capability"]
  if (capability === undefined) {
    yield* Console.error("--capability is required: a capability's name is a decision, not a derivation")
    yield* Console.log("")
    yield* Console.log(usage())
    process.exitCode = 2
    return
  }

  const loaded = loadTrajectory(argv.path)
  if (Result.isFailure(loaded)) {
    yield* Console.error(loaded.failure)
    process.exitCode = 2
    return
  }
  const { scrubbed, trajectory } = loaded.success

  const version = argv.options["version"] ?? DEFAULT_VERSION
  const directory = argv.options["out"] ?? ARTIFACTS_DIRECTORY

  const compiled = compileArtifact(trajectory, {
    capability,
    version,
    ...(argv.options["product"] === undefined ? {} : { product: argv.options["product"] }),
    ...(argv.options["title"] === undefined ? {} : { title: argv.options["title"] })
  })
  if (Result.isFailure(compiled)) {
    yield* Console.error(`compilation refused for ${capability}:`)
    for (const reason of compiled.failure.reasons) yield* Console.error(`  - ${reason}`)
    process.exitCode = 1
    return
  }

  if (argv.switches.has("dry-run")) {
    yield* Console.log(formatArtifact(compiled.success))
    return
  }

  const written = writeArtifact(directory, compiled.success)
  if (Result.isFailure(written)) {
    yield* Console.error(written.failure.message)
    process.exitCode = 1
    return
  }

  yield* report(trajectory, compiled.success)
  yield* Console.log("")
  yield* Console.log(`written: ${written.success}`)
  yield* Console.log(
    `versions of ${capability}: ${listVersions(directory, capability).join(", ")}`
  )

  if (scrubbed) {
    yield* Console.log("")
    yield* Console.log(
      "note: this trajectory came from a file, so the values behind its parameters were " +
        "already scrubbed out of it. The goal-echo check ran at full strength — the goal is " +
        "kept in the clear for exactly that reason — but the two checks that look for the " +
        "run's own values had placeholders to look for. Compile in-process with " +
        "`bun run discover --emit` to have all three."
    )
  }
  if (argv.options["product"] === undefined) {
    yield* Console.log("")
    yield* Console.log(
      `note: no --product was given, so the artifact records "${PRODUCT_UNIDENTIFIED}". ` +
        "Discovery observes an accessibility tree, not a product identifier; naming the " +
        "product is a person's job and the document says so rather than guessing."
    )
  }
})

Effect.runPromise(program).catch((cause) => {
  console.error(String(cause))
  process.exitCode = 1
})
