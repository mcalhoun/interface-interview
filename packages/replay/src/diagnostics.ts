import type { Scrubber } from "@cua/evidence"
import { Schema } from "effect"
import { ReplayResult } from "./ReplayResult.ts"

/** Return diagnostics obey the same privacy boundary as stored evidence. */
export const publicResult = (result: ReplayResult, scrub: Scrubber): ReplayResult => {
  const steps = result.steps.map((step) => ({
    ...step,
    intent: scrub(step.intent),
    ...(step.read === undefined ? {} : { read: scrub(step.read) })
  }))
  switch (result.result) {
    case "success":
      // Declared outputs are the API's requested data, distinct from diagnostic text.
      return { ...result, steps }
    case "business_outcome":
      return { ...result, steps, detail: scrub(result.detail) }
    case "intervention_required":
      return { ...result, steps, reason: scrub(result.reason), accessibility: scrub(result.accessibility) }
    case "failure": {
      const identifiers = new Set(["reason", "stepId", "code", "condition", "action", "narrowedBy", "owner", "output"])
      const failure = Object.fromEntries(Object.entries(result.failure).map(([key, value]) => [
        key,
        identifiers.has(key) ? value
          : typeof value === "string" ? scrub(value)
          : Array.isArray(value) ? value.map(scrub) : value
      ]))
      return Schema.decodeUnknownSync(ReplayResult)({ ...result, steps, failure })
    }
  }
}
