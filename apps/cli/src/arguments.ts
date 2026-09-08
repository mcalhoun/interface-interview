/** The command boundary: declared switches never consume positional arguments. */
export interface Arguments {
  readonly positionals: ReadonlyArray<string>
  readonly options: Readonly<Record<string, string>>
  readonly switches: ReadonlySet<string>
}

export interface ArgumentContract {
  readonly switches: ReadonlyArray<string>
  readonly options: ReadonlyArray<string>
  readonly maxPositionals: number
  /** Replay passes unknown valued options through the artifact's input schema. */
  readonly allowInputOptions?: boolean
}

export class UsageError extends Error {}

export const parseArguments = (tokens: ReadonlyArray<string>, contract: ArgumentContract): Arguments => {
  const positionals: string[] = []
  const options: Record<string, string> = {}
  const switches = new Set<string>()
  let positionalOnly = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) break
    if (token === "--") { positionalOnly = true; continue }
    if (positionalOnly || !token.startsWith("--")) {
      positionals.push(token)
      continue
    }
    const separator = token.indexOf("=")
    const key = token.slice(2, separator === -1 ? undefined : separator)
    if (key === "__proto__" || key === "constructor" || key === "prototype") throw new UsageError("Invalid option name")
    if (contract.switches.includes(key)) {
      if (separator !== -1) throw new UsageError(`--${key} is a switch and takes no value`)
      switches.add(key)
      continue
    }
    if (!contract.options.includes(key) && contract.allowInputOptions !== true) throw new UsageError(`Unknown option --${key}`)
    const value = separator === -1 ? tokens[index + 1] : token.slice(separator + 1)
    if (value === undefined || value.startsWith("--") || value === "") throw new UsageError(`--${key} requires a value`)
    if (Object.hasOwn(options, key)) throw new UsageError(`--${key} was supplied more than once`)
    options[key] = value
    if (separator === -1) index += 1
  }
  if (positionals.length > contract.maxPositionals) throw new UsageError("Too many positional arguments")
  return { positionals, options, switches }
}

/** No model, browser or application starts until argument validation succeeds. */
export const commandArguments = (contract: ArgumentContract): Arguments => {
  try { return parseArguments(Bun.argv.slice(2), contract) }
  catch (cause) {
    console.error(cause instanceof UsageError ? cause.message : "Invalid command arguments")
    process.exit(2)
  }
}

export const numberOption = (args: Arguments, name: string, options: {
  readonly minimum?: number
  readonly maximum?: number
  readonly integer?: boolean
} = {}): number | undefined => {
  const raw = args.options[name]
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < (options.minimum ?? 0) ||
    value > (options.maximum ?? Number.MAX_SAFE_INTEGER) ||
    (options.integer === true && !Number.isInteger(value))) {
    console.error(`--${name} must be ${options.integer === true ? "an integer" : "a number"} between ${options.minimum ?? 0} and ${options.maximum ?? Number.MAX_SAFE_INTEGER}`)
    process.exit(2)
  }
  return value
}
