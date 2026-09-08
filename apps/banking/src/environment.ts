import { DEFAULT_PORT, type LegacyCoreOptions } from "./server.ts"

export const optionsFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): Pick<LegacyCoreOptions, "port" | "expireSessionAfter"> => {
  const number = (name: string, maximum: number): number | undefined => {
    const configured = environment[name]
    if (configured === undefined || configured.trim() === "") return undefined
    const parsed = Number(configured)
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : undefined
  }
  const port = number("PORT", 65_535) ?? DEFAULT_PORT
  const expireSessionAfter = number("EXPIRE_SESSION_AFTER", Number.MAX_SAFE_INTEGER)
  return { port, ...(expireSessionAfter === undefined ? {} : { expireSessionAfter }) }
}
