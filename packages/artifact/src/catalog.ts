/**
 * The capability catalog: the agent-facing view of everything the system has
 * learned.
 *
 * A calling agent decides *what* to do. This system is *how* it does it — and
 * this module is where those two meet. It turns the Capability Artifacts on disk
 * into a list of callable signatures: what exists, what each one needs, what it
 * returns, and the exact line that invokes it. SPEC's Capability catalog, and the
 * framing the brief opens with made concrete rather than asserted.
 *
 * ## A catalog entry cannot leak a sensitive value, because it does not hold one
 *
 * The requirement is that an entry shows a parameter *is* sensitive without ever
 * showing a sensitive value. The way that is made true here is structural, in the
 * same spirit as `prepareInputs` being a `Result`: a sensitive parameter's
 * `default` is never copied into the `CatalogParameter` at all. There is no
 * rendering path that could print it, no `--json` field carrying it, and no
 * future formatter that can get it wrong, because by the time anything formats an
 * entry the value is simply not there. `defaultWithheld` records that a value was
 * dropped, so the omission is visible rather than silent.
 *
 * ### Where the line falls, and why
 *
 * A parameter's **domain** is published; a parameter's **value** is not.
 *
 *   - `type`, `required`, `pattern` and an enum's `values` describe which
 *     arguments are legal. They are shown, including for a sensitive parameter —
 *     a caller cannot construct a valid argument without them, and this is the
 *     same line `prepareInputs` already draws: its rejection messages quote the
 *     pattern and the legal enum labels while deliberately never quoting the
 *     offending value.
 *   - `default` is an actual argument, used verbatim when the caller omits the
 *     input. So it is withheld whenever the parameter is sensitive. The
 *     hand-written Artifact makes the same argument about itself, in writing:
 *     "a credential with a default value in one is a credential in a git
 *     repository."
 *
 * Sensitivity is read through `isSensitive`, so ADR-0008's deny-by-default holds
 * here too: an input that says nothing is sensitive, and its default is withheld.
 *
 * ## Which version is "current"
 *
 * The highest version stored, which is what `loadArtifact` already resolves to
 * when a caller names no version. The catalog states it rather than implying it:
 * every entry names the version it resolved to and lists the others beside it, so
 * a caller who wants yesterday's behaviour can pin `--version` and one who does
 * not gets the newest reviewed document. Nothing here holds a list of versions —
 * it reads the directory, so a version another ticket writes appears without this
 * file changing.
 *
 * ## What the catalog cannot tell you yet
 *
 * Whether a Capability has been *reviewed*. The Artifact schema has no approval
 * field — ticket 14's `requiresHuman:` and a review record are where one would
 * go. Until then `authored` is the only signal, and this reads it conservatively:
 * a `discovered` document is shown as awaiting review, because a compiled
 * Artifact's own summary says in writing that nothing has looked at it. Better to
 * over-flag two entries than to let a machine-written capability appear in an
 * agent-facing list looking approved.
 */

import { Result } from "effect"
import type { CapabilityArtifact, SurfaceDeclaration } from "./CapabilityArtifact.ts"
import type { InputDeclaration, InputType } from "./Inputs.ts"
import { isRequired, isSensitive } from "./Inputs.ts"
import type { OutputDeclaration, OutputType } from "./Outputs.ts"
import type { ArtifactInvalid } from "./parse.ts"
import { listCapabilities, listVersions, loadArtifact } from "./store.ts"

/** The command that invokes a catalogued Capability. */
export const REPLAY_COMMAND = "bun run replay"

/**
 * One declared input, as a caller needs to see it.
 *
 * `default` is `undefined` for a sensitive parameter whatever the Artifact
 * declares; `defaultWithheld` is how a reader tells "no default" apart from "a
 * default this catalog refuses to print". See the module header.
 */
export interface CatalogParameter {
  readonly name: string
  readonly type: InputType
  readonly description: string
  readonly required: boolean
  readonly sensitive: boolean
  /** For `string`: the regular expression source a value must match. */
  readonly pattern: string | undefined
  /** For `enum`: the legal labels. A value matching one by token subset is legal too. */
  readonly values: ReadonlyArray<string> | undefined
  /** Used when the caller omits this input. Absent whenever `sensitive`. */
  readonly default: string | undefined
  readonly defaultWithheld: boolean
}

/** One declared output. */
export interface CatalogReturn {
  readonly name: string
  readonly type: OutputType
  readonly description: string
  /** The ISO 4217 code a `money` output is denominated in. */
  readonly currency: string | undefined
}

/** One Business Outcome a caller has to handle instead of the outputs. */
export interface CatalogOutcome {
  readonly code: string
  readonly title: string
}

/**
 * One state this Capability has learned it will always stop on.
 *
 * Deliberately not folded into `outcomes`. A Business Outcome is something a
 * caller *receives*; this is something a caller has to know it may never receive
 * anything for, because a run that meets it ends needing a person. An agent
 * deciding whether to invoke this capability unattended needs both halves of
 * that, and a list that showed only the first would be a contract with the
 * expensive half missing.
 */
export interface CatalogEscalation {
  readonly code: string
  readonly title: string
  /** Which Step reaches it, so a reader can find it in the document. */
  readonly step: string
}

/** One callable Capability, at the version the catalog resolved to. */
export interface CatalogEntry {
  readonly capability: string
  /** The version this entry describes: the highest stored. */
  readonly version: string
  /** Every stored version, newest first. */
  readonly versions: ReadonlyArray<string>
  readonly title: string
  readonly summary: string
  readonly authored: CapabilityArtifact["authored"]
  /** No approval field exists yet, so a `discovered` document is flagged. */
  readonly awaitingReview: boolean
  readonly surface: SurfaceDeclaration
  readonly parameters: ReadonlyArray<CatalogParameter>
  readonly returns: ReadonlyArray<CatalogReturn>
  readonly outcomes: ReadonlyArray<CatalogOutcome>
  /** States a run always stops on, learned from an Intervention. Usually empty. */
  readonly escalations: ReadonlyArray<CatalogEscalation>
  /** The exact command line that runs this Capability. */
  readonly invocation: string
}

/**
 * Everything callable, plus everything that would have been callable if it
 * parsed.
 *
 * A document that will not load is reported rather than skipped. An agent-facing
 * list that quietly shrinks when an Artifact breaks is worse than one that says
 * which one broke, because the failure mode is a capability that silently stops
 * existing.
 */
export interface Catalog {
  readonly entries: ReadonlyArray<CatalogEntry>
  readonly problems: ReadonlyArray<ArtifactInvalid>
}

const parameterFor = (name: string, declaration: InputDeclaration): CatalogParameter => {
  const sensitive = isSensitive(declaration)
  // The value is dropped here, once, at the boundary. Nothing downstream has it
  // to print. Compared against `undefined` rather than tested for truthiness: an
  // empty-string default is still a default, and still one that was withheld.
  const withheld = sensitive && declaration.default !== undefined
  return {
    name,
    type: declaration.type,
    description: declaration.description,
    required: isRequired(declaration),
    sensitive,
    pattern: declaration.pattern,
    values: declaration.values,
    default: sensitive ? undefined : declaration.default,
    defaultWithheld: withheld
  }
}

const returnFor = (name: string, declaration: OutputDeclaration): CatalogReturn => ({
  name,
  type: declaration.type,
  description: declaration.description,
  currency: declaration.currency
})

/**
 * The command that invokes this Capability, with a placeholder per input.
 *
 * Required inputs first and optional ones in brackets, which is what a usage line
 * means everywhere else. The placeholder is the declared type rather than the
 * legal values: an `enum` accepts any token subset of a label, so printing
 * `<Primary Savings|Checking>` here would understate the contract. The parameter
 * block carries the domain.
 */
export const invocationOf = (
  capability: string,
  parameters: ReadonlyArray<CatalogParameter>
): string => {
  const required = parameters.filter((parameter) => parameter.required)
  const optional = parameters.filter((parameter) => !parameter.required)
  return [
    REPLAY_COMMAND,
    capability,
    ...required.map((parameter) => `--${parameter.name} <${parameter.type}>`),
    ...optional.map((parameter) => `[--${parameter.name} <${parameter.type}>]`)
  ].join(" ")
}

/**
 * One Artifact, as a catalog entry.
 *
 * Pure, and takes the stored versions rather than reading the directory itself,
 * so the shape of an entry can be tested against a document that was never
 * written to disk.
 */
export const catalogEntry = (
  artifact: CapabilityArtifact,
  versions: ReadonlyArray<string> = [artifact.version]
): CatalogEntry => {
  const parameters = Object.entries(artifact.inputs).map(([name, declaration]) =>
    parameterFor(name, declaration)
  )
  return {
    capability: artifact.capability,
    version: artifact.version,
    versions,
    title: artifact.title,
    summary: artifact.summary,
    authored: artifact.authored,
    awaitingReview: artifact.authored === "discovered",
    surface: artifact.surface,
    parameters,
    returns: Object.entries(artifact.outputs).map(([name, declaration]) =>
      returnFor(name, declaration)
    ),
    outcomes: Object.entries(artifact.outcomes ?? {}).map(([code, declaration]) => ({
      code,
      title: declaration.title
    })),
    escalations: Object.entries(artifact.requiresHuman ?? {}).map(([code, declaration]) => ({
      code,
      title: declaration.title,
      step: declaration.step
    })),
    invocation: invocationOf(artifact.capability, parameters)
  }
}

/** One Capability from the store, at `version` or at the current one. */
export const readCatalogEntry = (
  directory: string,
  capability: string,
  version?: string
): Result.Result<CatalogEntry, ArtifactInvalid> => {
  const artifact = loadArtifact(directory, capability, version)
  return Result.isFailure(artifact)
    ? Result.fail(artifact.failure)
    : Result.succeed(catalogEntry(artifact.success, listVersions(directory, capability)))
}

/** Every stored Capability, each at its current version. */
export const readCatalog = (directory: string): Catalog => {
  const entries: Array<CatalogEntry> = []
  const problems: Array<ArtifactInvalid> = []
  for (const capability of listCapabilities(directory)) {
    const entry = readCatalogEntry(directory, capability)
    if (Result.isFailure(entry)) problems.push(entry.failure)
    else entries.push(entry.success)
  }
  return { entries, problems }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const WIDTH = 88

/**
 * A prose field's paragraphs.
 *
 * Split on any run of newlines rather than on a blank line, because the two YAML
 * block styles an Artifact uses disagree about what a paragraph break decodes to:
 * a folded block (`>`) turns a blank line into one `\n`, a literal block (`|`)
 * keeps both. `yaml.ts` picks between them per field, so a rule that only
 * understood one of them would render half the documents as a single wall of
 * text — which is what the first version of this did.
 */
const paragraphs = (text: string): ReadonlyArray<string> =>
  text
    .split(/\n+/)
    .map((paragraph) => paragraph.replaceAll(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0)

/** The first paragraph of a prose field, as one line. */
const firstParagraph = (text: string): string => paragraphs(text)[0] ?? ""

/** Greedy wrap, so a paragraph of an Artifact's prose stays readable in a terminal. */
const wrap = (text: string, indent: string): ReadonlyArray<string> => {
  const lines: Array<string> = []
  let line = ""
  for (const word of text.split(" ").filter((word) => word.length > 0)) {
    if (line.length > 0 && `${line} ${word}`.length + indent.length > WIDTH) {
      lines.push(indent + line)
      line = word
    } else {
      line = line.length > 0 ? `${line} ${word}` : word
    }
  }
  if (line.length > 0) lines.push(indent + line)
  return lines
}

const prose = (text: string, indent: string, full: boolean): ReadonlyArray<string> => {
  if (!full) {
    const one = firstParagraph(text)
    if (one.length === 0) return []
    const wrapped = wrap(one, indent)
    const first = wrapped[0] ?? ""
    // The ellipsis is load-bearing: a sentence cut mid-clause with no mark reads
    // as the whole of what the Artifact said, and this is the view a caller
    // decides from. `bun run catalog <name>` prints the rest.
    return [wrapped.length > 1 ? `${first}…` : first]
  }
  return paragraphs(text).flatMap((paragraph, index) =>
    index === 0 ? wrap(paragraph, indent) : ["", ...wrap(paragraph, indent)]
  )
}

const pad = (text: string, width: number): string => text.padEnd(width, " ")

/**
 * The facts about a parameter that are not its description: what it accepts and
 * whether it has to be supplied.
 *
 * `default withheld (sensitive)` is a deliberate thing to print. It tells a
 * caller that omitting the input does something defined without telling them
 * what, and it makes a sensitive parameter carrying a default visible — which is
 * a smell worth noticing in a document people review.
 */
const parameterFacts = (parameter: CatalogParameter): string => {
  const facts = [parameter.required ? "required" : "optional"]
  if (parameter.sensitive) facts.push("sensitive")
  if (parameter.pattern !== undefined) facts.push(`matching /${parameter.pattern}/`)
  if (parameter.values !== undefined && parameter.values.length > 0) {
    facts.push(`one of: ${parameter.values.join(", ")}`)
  }
  if (parameter.default !== undefined) facts.push(`default ${parameter.default}`)
  else if (parameter.defaultWithheld) facts.push("default withheld (sensitive)")
  return facts.join("  ")
}

/**
 * One entry, as a caller reads it.
 *
 * `full` shows every paragraph of the Artifact's own prose; the list view shows
 * the first line of each. Everything a caller needs in order to invoke the
 * Capability is in the brief form — the signature, the domain of each argument,
 * what comes back, and the command line. The prose is context, not contract.
 */
export const describeCatalogEntry = (entry: CatalogEntry, full = false): string => {
  const lines: Array<string> = []
  const flag = entry.awaitingReview ? "   [awaiting review]" : ""
  lines.push(`${entry.capability}@${entry.version}${flag}`)
  lines.push(`  ${entry.title}`)
  lines.push(
    `  ${entry.surface.kind} · ${entry.surface.product} · entry ${entry.surface.entry} · ${entry.authored}`
  )
  lines.push(
    `  versions: ${entry.versions
      .map((version) => (version === entry.version ? `${version} (current)` : version))
      .join(", ")}`
  )
  lines.push("", ...prose(entry.summary, "  ", full))

  const nameWidth = Math.max(0, ...entry.parameters.map((parameter) => parameter.name.length + 2))
  lines.push("", "  takes:")
  if (entry.parameters.length === 0) lines.push("    (no inputs)")
  for (const parameter of entry.parameters) {
    lines.push(
      `    ${pad(`--${parameter.name}`, nameWidth)}  ${pad(parameter.type, 7)}  ${
        parameterFacts(parameter)
      }`
    )
    lines.push(...prose(parameter.description, " ".repeat(nameWidth + 6), full))
  }

  const returnWidth = Math.max(0, ...entry.returns.map((value) => value.name.length))
  lines.push("", "  returns:")
  for (const value of entry.returns) {
    const type = value.currency === undefined ? value.type : `${value.type} ${value.currency}`
    lines.push(`    ${pad(value.name, returnWidth)}  ${type}`)
    lines.push(...prose(value.description, " ".repeat(returnWidth + 6), full))
  }

  if (entry.outcomes.length > 0) {
    const codeWidth = Math.max(...entry.outcomes.map((outcome) => outcome.code.length))
    lines.push("", "  or, instead of returning:")
    for (const outcome of entry.outcomes) {
      lines.push(`    ${pad(outcome.code, codeWidth)}  ${firstParagraph(outcome.title)}`)
    }
  }

  if (entry.escalations.length > 0) {
    const codeWidth = Math.max(...entry.escalations.map((escalation) => escalation.code.length))
    lines.push("", "  or, stopping for a person (learned, and never automated):")
    for (const escalation of entry.escalations) {
      lines.push(
        `    ${pad(escalation.code, codeWidth)}  ${firstParagraph(escalation.title)}`
      )
    }
  }

  lines.push("", "  invoke:", `    ${entry.invocation}`)
  return lines.join("\n")
}

/** The whole catalog, entries separated by a blank line. */
export const describeCatalog = (catalog: Catalog): string => {
  const sections = catalog.entries.map((entry) => describeCatalogEntry(entry))
  if (catalog.problems.length > 0) {
    sections.push(
      ["will not load:", ...catalog.problems.map((problem) => `  ${problem.message}`)].join("\n")
    )
  }
  return sections.length === 0
    ? "no capabilities are stored yet."
    : `${sections.join("\n\n")}\n`
}
