/**
 * The capability catalog: what a calling agent sees, and what it must never see.
 *
 * The catalog is the agent-facing view of everything the system has learned, so
 * these tests assert on what a caller can do with an entry rather than on how one
 * is built. Two properties carry the ticket:
 *
 *   - **An entry is sufficient to invoke the Capability.** Tested by driving
 *     `prepareInputs` — the same validation `bun run replay` uses — from nothing
 *     but a catalog entry, with no access to the Artifact.
 *   - **An entry cannot show a sensitive value.** Tested by putting a value into
 *     an Artifact that must not come out the other side, and looking for it in
 *     every form the catalog emits.
 *
 * Nothing here hard-codes which versions are on disk. Tickets 13 and 14 are
 * cutting new versions of `member.account-balance` while this is written, and a
 * catalog that had to be edited when one landed would be a catalog nobody could
 * trust to be current.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Effect, Result } from "effect"
import {
  type CapabilityArtifact,
  type CatalogEntry,
  ARTIFACTS_DIRECTORY,
  catalogEntry,
  describeCatalog,
  describeCatalogEntry,
  listVersions,
  loadArtifact,
  prepareInputs,
  readCatalog,
  readCatalogEntry,
  writeArtifact
} from "@cua/artifact"
import { ACCOUNT_BALANCE, shippedArtifact } from "./support/replay-harness.ts"

const DISCOVERED = "member.account-balance.discovered"

const inTemporaryStore = <A>(use: (directory: string) => A): A => {
  const directory = mkdtempSync(join(tmpdir(), "cua-catalog-"))
  try {
    return use(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * A legal argument for one parameter, chosen from the entry alone.
 *
 * This function is the test's whole point: it is what a calling agent has to be
 * able to do. It reads the catalog's declared type, pattern and enum domain and
 * nothing else — it never opens the Artifact — and if it cannot produce a value
 * a caller could not either.
 */
const argumentFor = (parameter: CatalogEntry["parameters"][number]): string => {
  switch (parameter.type) {
    case "integer":
      return "12345"
    case "enum":
      return parameter.values?.[0] ?? "unusable: the entry declared no legal values"
    case "string":
      // The pattern is the only thing that says what shape a value takes, which
      // is why it is published for a sensitive parameter too.
      return parameter.pattern === undefined ? "a-value" : "12345"
  }
}

const callFromCatalog = (
  entry: CatalogEntry,
  overrides: Readonly<Record<string, string>> = {}
): Readonly<Record<string, string>> => ({
  ...Object.fromEntries(
    entry.parameters
      .filter((parameter) => parameter.required)
      .map((parameter) => [parameter.name, argumentFor(parameter)])
  ),
  ...overrides
})

// ---------------------------------------------------------------------------
// What is listed
// ---------------------------------------------------------------------------

describe("the catalog lists what is stored", () => {
  it("lists every stored capability with its inputs and outputs", () => {
    const catalog = readCatalog(ARTIFACTS_DIRECTORY)
    expect(catalog.problems).toEqual([])

    const names = catalog.entries.map((entry) => entry.capability)
    expect(names).toContain(ACCOUNT_BALANCE)
    expect(names).toContain(DISCOVERED)

    for (const entry of catalog.entries) {
      // A signature with no inputs and no outputs is not a signature. Every
      // Capability this system can produce declares at least one of each.
      expect(entry.parameters.length).toBeGreaterThan(0)
      expect(entry.returns.length).toBeGreaterThan(0)
      for (const parameter of entry.parameters) {
        expect(parameter.description.length).toBeGreaterThan(0)
        expect(["string", "integer", "enum"]).toContain(parameter.type)
      }
      for (const value of entry.returns) {
        // A `money` return without a currency is a number labelled with a guess.
        if (value.type === "money") expect(value.currency).toBeDefined()
      }
    }
  })

  it("reads the directory rather than a list of versions someone maintained", () => {
    // Tickets 13 and 14 are cutting versions of this capability right now. The
    // assertion is that the catalog agrees with the disk, whatever the disk says.
    const entry = readCatalogEntry(ARTIFACTS_DIRECTORY, ACCOUNT_BALANCE)
    if (Result.isFailure(entry)) throw new Error(entry.failure.message)
    expect(entry.success.versions).toEqual(listVersions(ARTIFACTS_DIRECTORY, ACCOUNT_BALANCE))
  })

  it("flags a compiled capability as awaiting review, and a hand-written one as not", () => {
    // The schema has no approval field yet, so `authored` is the only signal and
    // the catalog reads it conservatively. A compiled Artifact's own summary says
    // in writing that nothing has looked at it; an agent-facing list should not
    // present it as though something had.
    const discovered = readCatalogEntry(ARTIFACTS_DIRECTORY, DISCOVERED)
    if (Result.isFailure(discovered)) throw new Error(discovered.failure.message)
    expect(discovered.success.authored).toBe("discovered")
    expect(discovered.success.awaitingReview).toBe(true)
    expect(describeCatalogEntry(discovered.success)).toContain("awaiting review")

    const written = readCatalogEntry(ARTIFACTS_DIRECTORY, ACCOUNT_BALANCE)
    if (Result.isFailure(written)) throw new Error(written.failure.message)
    expect(written.success.awaitingReview).toBe(false)
    expect(describeCatalogEntry(written.success)).not.toContain("awaiting review")
  })

  it("reports an artifact that will not load rather than quietly dropping it", () => {
    inTemporaryStore((directory) => {
      const good = writeArtifact(directory, shippedArtifact())
      if (Result.isFailure(good)) throw new Error(good.failure.message)

      const broken = { ...shippedArtifact(), capability: "broken.capability" }
      writeArtifact(directory, broken)
      // Corrupt the version that was actually written. Hard-coding 1.0.0 here
      // silently stopped corrupting anything once the shipped artifact moved to
      // 1.1.0, leaving a loadable document beside the unloadable one.
      writeFileSync(join(directory, "broken.capability", `${broken.version}.yaml`), "capability: {\n")

      const catalog = readCatalog(directory)
      // The working one still lists. A catalog that fell over entirely because
      // one document broke would take every other capability down with it.
      expect(catalog.entries.map((entry) => entry.capability)).toEqual([ACCOUNT_BALANCE])
      expect(catalog.problems).toHaveLength(1)
      // And the failure is named, because a capability that silently stops
      // existing is the worst way for this to go wrong.
      expect(describeCatalog(catalog)).toContain("broken.capability")
    })
  })
})

// ---------------------------------------------------------------------------
// Enough to call it with
// ---------------------------------------------------------------------------

describe("an entry is enough to invoke the capability with", () => {
  it("names every required input in the command it prints", () => {
    for (const entry of readCatalog(ARTIFACTS_DIRECTORY).entries) {
      expect(entry.invocation.startsWith(`bun run replay ${entry.capability}`)).toBe(true)
      for (const parameter of entry.parameters) {
        // Required inputs appear bare, optional ones in brackets — a usage line
        // that a caller can read the same way they read every other usage line.
        expect(entry.invocation).toContain(
          parameter.required
            ? `--${parameter.name} <${parameter.type}>`
            : `[--${parameter.name} <${parameter.type}>]`
        )
      }
    }
  })

  it("carries enough type information to construct a call that validates", () => {
    for (const entry of readCatalog(ARTIFACTS_DIRECTORY).entries) {
      const artifact = loadArtifact(ARTIFACTS_DIRECTORY, entry.capability, entry.version)
      if (Result.isFailure(artifact)) throw new Error(artifact.failure.message)

      // `callFromCatalog` sees only the entry. `prepareInputs` is the validation
      // `bun run replay` runs before anything opens. If a call built from the
      // catalog alone is rejected, the entry was not enough to invoke with.
      const accepted = prepareInputs(
        entry.capability,
        artifact.success.inputs,
        callFromCatalog(entry)
      )
      if (Result.isFailure(accepted)) throw new Error(accepted.failure.message)
      expect(Result.isSuccess(accepted)).toBe(true)
    }
  })

  it("rejects a call that disagrees with the declared inputs, purely and before anything opens", () => {
    const entry = readCatalogEntry(ARTIFACTS_DIRECTORY, ACCOUNT_BALANCE)
    if (Result.isFailure(entry)) throw new Error(entry.failure.message)
    const inputs = shippedArtifact().inputs

    const bad = prepareInputs(
      ACCOUNT_BALANCE,
      inputs,
      callFromCatalog(entry.success, { memberId: "not-a-number", nonsense: "1" })
    )

    // Not an `Effect`: it requires no services, so it cannot have opened a
    // browser. The guarantee is in the type rather than in the order of
    // statements in a CLI, which is the property `test/replay-inputs.test.ts`
    // owns and the catalog must not undo — the catalog reads the declarations
    // this validates against, and does not add a second way to invoke anything.
    expect(Effect.isEffect(bad)).toBe(false)
    expect(Result.isFailure(bad)).toBe(true)
    if (!Result.isFailure(bad)) return
    expect(bad.failure.problems.join("; ")).toContain("nonsense")
    expect(bad.failure.problems.join("; ")).toContain("pattern")
    // And the rejection does not quote the value back, for the same reason the
    // catalog withholds a sensitive default.
    expect(bad.failure.message).not.toContain("not-a-number")
  })
})

// ---------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------

describe("an entry shows that a parameter is sensitive without showing a value", () => {
  const SECRET_DEFAULT = "correct-horse-battery-staple"

  const withSensitiveDefault = (): CapabilityArtifact => {
    const artifact = shippedArtifact()
    return {
      ...artifact,
      inputs: {
        ...artifact.inputs,
        operatorPassword: {
          type: "string",
          description: "A credential, with a default it should not have.",
          sensitive: true,
          required: false,
          default: SECRET_DEFAULT
        }
      }
    }
  }

  it("drops a sensitive default at the boundary, so nothing downstream can print it", () => {
    const entry = catalogEntry(withSensitiveDefault())
    const parameter = entry.parameters.find((each) => each.name === "operatorPassword")
    expect(parameter?.sensitive).toBe(true)
    // Not redacted on the way out — absent. There is no rendering path, JSON
    // field or future formatter that could get this wrong, because the value is
    // not in the entry.
    expect(parameter?.default).toBeUndefined()
    expect(parameter?.defaultWithheld).toBe(true)

    expect(JSON.stringify(entry)).not.toContain(SECRET_DEFAULT)
    expect(describeCatalogEntry(entry, true)).not.toContain(SECRET_DEFAULT)
  })

  it("says so out loud, in both the flag and the rendering", () => {
    const rendered = describeCatalogEntry(catalogEntry(withSensitiveDefault()))
    expect(rendered).toContain("--operatorPassword")
    expect(rendered).toContain("sensitive")
    // The distinction a caller needs: this input has a default, and the catalog
    // is refusing to print it. Silence would read as "no default".
    expect(rendered).toContain("default withheld (sensitive)")
  })

  it("publishes the domain of a sensitive parameter, because a caller cannot call without it", () => {
    // The line: a parameter's *domain* — its type, whether it is required, the
    // pattern it must match, the labels an enum offers — says which arguments
    // are legal and is published. Its *default* is an actual argument and is not.
    // `prepareInputs` draws the same line: its rejections quote the pattern and
    // the legal labels while never quoting the offending value.
    const entry = readCatalogEntry(ARTIFACTS_DIRECTORY, ACCOUNT_BALANCE)
    if (Result.isFailure(entry)) throw new Error(entry.failure.message)
    const memberId = entry.success.parameters.find((each) => each.name === "memberId")
    expect(memberId?.sensitive).toBe(true)
    expect(memberId?.required).toBe(true)
    expect(memberId?.pattern).toBeDefined()

    // Which is what makes the previous test's "enough to invoke with" possible
    // for a sensitive input at all.
    expect(describeCatalogEntry(entry.success)).toContain("sensitive")
  })

  it("withholds a sensitive default in the shipped compiled capability too", () => {
    // Not a synthetic case. Ticket 11's compiler classifies every input sensitive
    // by default (ADR-0008), so the discovered capability really does ship a
    // sensitive parameter carrying a default, and the catalog really does
    // withhold it. The cost of the conservative default is visible here rather
    // than argued about.
    const entry = readCatalogEntry(ARTIFACTS_DIRECTORY, DISCOVERED)
    if (Result.isFailure(entry)) throw new Error(entry.failure.message)
    const withheld = entry.success.parameters.filter((each) => each.defaultWithheld)
    expect(withheld.length).toBeGreaterThan(0)
    for (const parameter of withheld) {
      expect(parameter.sensitive).toBe(true)
      expect(parameter.default).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

describe("multiple versions resolve to a current one", () => {
  it("resolves to the highest stored version, numerically", () => {
    inTemporaryStore((directory) => {
      const base = { ...shippedArtifact(), capability: "many.versions" }
      // Out of order on purpose, and including the pair that a lexicographic
      // sort gets wrong: 1.10.0 is newer than 1.9.0.
      for (const version of ["1.0.0", "1.10.0", "1.9.0", "1.2.0"]) {
        const written = writeArtifact(directory, { ...base, version })
        if (Result.isFailure(written)) throw new Error(written.failure.message)
      }

      const entry = readCatalogEntry(directory, "many.versions")
      if (Result.isFailure(entry)) throw new Error(entry.failure.message)
      expect(entry.success.version).toBe("1.10.0")
      expect(entry.success.versions).toEqual(["1.10.0", "1.9.0", "1.2.0", "1.0.0"])

      // The same version `bun run replay` runs when the caller names none. Two
      // answers to "which one is current" would be one answer too many.
      const loaded = loadArtifact(directory, "many.versions")
      if (Result.isFailure(loaded)) throw new Error(loaded.failure.message)
      expect(loaded.success.version).toBe(entry.success.version)
    })
  })

  it("marks which version is current and still lists the others", () => {
    inTemporaryStore((directory) => {
      const base = { ...shippedArtifact(), capability: "many.versions" }
      for (const version of ["1.0.0", "1.1.0"]) {
        writeArtifact(directory, { ...base, version })
      }
      const entry = readCatalogEntry(directory, "many.versions")
      if (Result.isFailure(entry)) throw new Error(entry.failure.message)
      const rendered = describeCatalogEntry(entry.success)
      // An older version is still callable with `--version`, so hiding it would
      // lose the only thing an immutable store buys a caller.
      expect(rendered).toContain("1.1.0 (current)")
      expect(rendered).toContain("1.0.0")
    })
  })

  it("describes the version a caller pinned, not the current one", () => {
    inTemporaryStore((directory) => {
      const base = { ...shippedArtifact(), capability: "many.versions" }
      writeArtifact(directory, { ...base, version: "1.0.0", title: "the old one" })
      writeArtifact(directory, { ...base, version: "1.1.0", title: "the new one" })

      const pinned = readCatalogEntry(directory, "many.versions", "1.0.0")
      if (Result.isFailure(pinned)) throw new Error(pinned.failure.message)
      expect(pinned.success.version).toBe("1.0.0")
      expect(pinned.success.title).toBe("the old one")
      // It still lists its siblings, so a caller reading an old signature can
      // see that a newer one exists.
      expect(pinned.success.versions).toContain("1.1.0")
    })
  })
})
