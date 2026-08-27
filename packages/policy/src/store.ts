/**
 * Where Policies live on disk, and how one becomes a service.
 *
 * `policies/<name>.yaml`, beside `artifacts/`, for the same reason: both are
 * documents a reviewer reads, and a reviewer should be able to find every
 * statement of what the system may do by listing one directory.
 *
 * ## Loading is a pure `Result`, and that is deliberate
 *
 * `loadPolicy` requires no services and opens nothing. The CLI resolves the
 * Policy before it provides the Playwright Layer, exactly as it validates inputs
 * before it provides the Playwright Layer, so a malformed or missing Policy
 * cannot have opened a browser — the guarantee is in the signature rather than in
 * the order of statements. `policyFrom` then builds the Layer from an
 * already-checked value, which is why it cannot fail.
 *
 * The failure mode this produces is the one the ticket asks for: no Policy means
 * no run. There is no "carry on unrestricted if the file is missing" branch
 * anywhere, and there is no permissive Layer left in this package for anyone to
 * reach for. Ticket 03 shipped one as a placeholder; it is gone, because a
 * layer that says yes to everything is precisely the second path a chokepoint
 * cannot have.
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, Result } from "effect"
import { decide } from "./decide.ts"
import { Policy } from "./Policy.ts"
import { type CompiledPolicy, PolicyInvalid, parsePolicy } from "./PolicyDocument.ts"

/** The repository's policy directory, relative to the workspace root. */
export const POLICIES_DIRECTORY = "policies"

/** The Policy in force when nothing says otherwise. */
export const DEFAULT_POLICY = "default"

/**
 * Where a `--policy` argument points.
 *
 * A bare name is a document in the policy directory; anything that looks like a
 * path is used as given, so a deployment can keep its Policy outside the repo.
 */
export const resolvePolicyPath = (directory: string, nameOrPath: string): string =>
  nameOrPath.includes("/") || nameOrPath.endsWith(".yaml")
    ? nameOrPath
    : join(directory, `${nameOrPath}.yaml`)

/** Loads and checks one Policy. Every problem in the file at once, or the Policy. */
export const loadPolicy = (
  directory: string,
  nameOrPath: string
): Result.Result<CompiledPolicy, PolicyInvalid> => {
  const path = resolvePolicyPath(directory, nameOrPath)
  let yaml: string
  try {
    yaml = readFileSync(path, "utf8")
  } catch {
    return Result.fail(
      new PolicyInvalid({
        source: path,
        problems: [
          "no such policy file. A run without a policy does not happen: there is no " +
            "unrestricted default to fall back to"
        ]
      })
    )
  }
  return parsePolicy(path, yaml)
}

/** Every Policy stored here, for a CLI's usage text and for ticket 17's catalog. */
export const listPolicies = (directory: string): ReadonlyArray<string> => {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".yaml"))
      .map((name) => name.slice(0, -".yaml".length))
      .sort()
  } catch {
    return []
  }
}

/**
 * The Policy service, from a Policy that has already been checked.
 *
 * `Layer<Policy>` with no error channel, because everything that could have gone
 * wrong went wrong at load. Each `authorise` is a pure `decide` wrapped in
 * `Effect.succeed`: the service is total, so a denial is a value the engine
 * records and reports rather than a defect that skips the record.
 */
export const policyFrom = (policy: CompiledPolicy): Layer.Layer<Policy> =>
  Layer.succeed(Policy)({
    name: policy.name,
    authorise: (request) => Effect.succeed(decide(policy, request))
  })
