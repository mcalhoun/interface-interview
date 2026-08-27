/**
 * Where Capability Artifacts live on disk, and how a version is resolved.
 *
 * One file per version under `artifacts/<capability>/<version>.yaml`, never
 * rewritten. SPEC's reasoning: immutability is what makes "reviewable before
 * production use" demonstrable, because a reviewer can diff `1.0.0` against
 * `1.1.0` and see one outcome entry added. A single mutable file with git history
 * hides that where the evaluator has to go looking.
 *
 * `latest` is resolved by sorting the version files rather than by an index file.
 * An index is a second source of truth for a question the directory listing
 * already answers, and it is one more thing for ticket 11's compiler to keep
 * consistent.
 *
 * ## Seam for later tickets
 *
 * Reading is a plain function over the filesystem today. SPEC's Out of scope
 * table names "Persistence beyond files" with "artifact and evidence writers sit
 * behind interfaces" as the seam — `loadArtifact` is that interface for reading,
 * and ticket 11 adds the writing half next to it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Result, Schema } from "effect"
import type { CapabilityArtifact } from "./CapabilityArtifact.ts"
import { ArtifactInvalid, formatArtifact, parseArtifact } from "./parse.ts"

/** The repository's artifact directory, relative to the workspace root. */
export const ARTIFACTS_DIRECTORY = "artifacts"

/** Newest first. Numeric per component, so `1.10.0` beats `1.9.0`. */
const byVersionDescending = (left: string, right: string): number => {
  const l = left.split(".").map(Number)
  const r = right.split(".").map(Number)
  for (let index = 0; index < Math.max(l.length, r.length); index += 1) {
    const difference = (r[index] ?? 0) - (l[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export const listVersions = (
  directory: string,
  capability: string
): ReadonlyArray<string> => {
  try {
    return readdirSync(join(directory, capability))
      .filter((name) => name.endsWith(".yaml"))
      .map((name) => name.slice(0, -".yaml".length))
      .sort(byVersionDescending)
  } catch {
    return []
  }
}

/**
 * Loads one Capability Artifact.
 *
 * `version` omitted means the highest version on disk. A run always records the
 * version it resolved to, so "latest" never makes a run irreproducible.
 */
export const loadArtifact = (
  directory: string,
  capability: string,
  version?: string
): Result.Result<CapabilityArtifact, ArtifactInvalid> => {
  const resolved = version ?? listVersions(directory, capability)[0]
  if (resolved === undefined) {
    return Result.fail(
      new ArtifactInvalid({
        source: join(directory, capability),
        problems: ["no versions of this capability are stored here"]
      })
    )
  }

  const path = join(directory, capability, `${resolved}.yaml`)
  let yaml: string
  try {
    yaml = readFileSync(path, "utf8")
  } catch {
    return Result.fail(new ArtifactInvalid({ source: path, problems: ["no such artifact file"] }))
  }

  const parsed = parseArtifact(path, yaml)
  if (Result.isFailure(parsed)) return parsed

  // A file whose name disagrees with its contents is the kind of drift that makes
  // an immutable store stop being one.
  return parsed.success.version === resolved && parsed.success.capability === capability
    ? parsed
    : Result.fail(
        new ArtifactInvalid({
          source: path,
          problems: [
            `file says ${parsed.success.capability}@${parsed.success.version}, path says ${capability}@${resolved}`
          ]
        })
      )
}

/**
 * A version already exists, so nothing was written.
 *
 * Immutability is the whole reason this is an error rather than a silent
 * overwrite. SPEC: "Immutable versioned files, one per version... Immutability
 * makes 'reviewable before production use' demonstrable." A compiler that could
 * replace `1.0.0` would mean the document a reviewer approved and the document
 * that ran are only the same file by convention, and a diff between two versions
 * would stop being evidence of anything.
 */
export class ArtifactNotWritable extends Schema.TaggedError<ArtifactNotWritable>()(
  "ArtifactNotWritable",
  { path: Schema.String, reason: Schema.String }
) {
  override get message(): string {
    return `${this.path}: ${this.reason}`
  }
}

/**
 * Writes one version of a Capability Artifact, and refuses to write it twice.
 *
 * The writing half of the seam `loadArtifact` opens. Two rules, both structural:
 *
 *   - **An existing version is never overwritten.** A new version is a new file.
 *   - **What is written has already been read back.** The document is formatted,
 *     re-parsed through `parseArtifact`, and only then does the file appear — so
 *     an Artifact that would fail to load cannot reach the store, and the compiler
 *     cannot leave a half-valid document behind for someone to debug later.
 *
 * Ticket 13's Amendment is a second call to this function with a higher version,
 * not an edit.
 */
export const writeArtifact = (
  directory: string,
  artifact: CapabilityArtifact
): Result.Result<string, ArtifactInvalid | ArtifactNotWritable> => {
  const path = join(directory, artifact.capability, `${artifact.version}.yaml`)
  if (existsSync(path)) {
    return Result.fail(
      new ArtifactNotWritable({
        path,
        reason:
          `version ${artifact.version} of ${artifact.capability} is already stored. ` +
          `Artifacts are immutable: write a new version rather than replacing this one`
      })
    )
  }

  const yaml = formatArtifact(artifact)
  const readBack = parseArtifact(path, yaml)
  if (Result.isFailure(readBack)) return Result.fail(readBack.failure)

  try {
    mkdirSync(join(directory, artifact.capability), { recursive: true })
    writeFileSync(path, yaml, { encoding: "utf8", flag: "wx" })
  } catch (cause) {
    return Result.fail(new ArtifactNotWritable({ path, reason: String(cause) }))
  }
  return Result.succeed(path)
}

/** Every Capability with at least one stored version. Ticket 17's catalog reads this. */
export const listCapabilities = (directory: string): ReadonlyArray<string> => {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => listVersions(directory, name).length > 0)
      .sort()
  } catch {
    return []
  }
}
