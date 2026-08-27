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

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Result } from "effect"
import type { CapabilityArtifact } from "./CapabilityArtifact.ts"
import { ArtifactInvalid, parseArtifact } from "./parse.ts"

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
