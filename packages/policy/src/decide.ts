/**
 * Applying a Policy to one Action. The whole decision, in one pure function.
 *
 * Pure and total: a `CompiledPolicy` and an `ActionRequest` in, a `PolicyVerdict`
 * out, no services, no clock, no filesystem, no browser. That is what makes the
 * chokepoint testable exhaustively without opening anything, and it is why the
 * expensive checks — does every origin pattern parse, is every risky Action
 * justified — happen at load rather than here. By the time this function runs
 * there is nothing left that could go wrong other than the answer being "no".
 *
 * ## The order of the checks is the order of the reasons
 *
 * A denial is prose that a person reads in a stopped run's output, so the checks
 * run in the order that produces the most useful sentence. Whether the Action
 * type is permitted comes first, because an Action this system will not perform
 * is denied wherever it points and saying so is more useful than "wrong origin".
 * Origin comes second, current page before destination, because "the run is
 * somewhere it should not be" is a different and more alarming fact than "it
 * tried to go somewhere it should not".
 *
 * ## Both ends of a navigation
 *
 * Every Action is checked against the origin it happens *on*; a `navigate` is
 * additionally checked against where it goes. An allowlist that only checked
 * destinations would be satisfied by a run that clicked a link off-origin and
 * then filled a member's data into whatever came back.
 */

import type { CompiledPolicy } from "./PolicyDocument.ts"
import { type ActionRequest, type PolicyVerdict, riskOf } from "./Policy.ts"
import { allowedBy, originOf } from "./origins.ts"

export const decide = (policy: CompiledPolicy, request: ActionRequest): PolicyVerdict => {
  const risk = riskOf(request.type)
  const origin = request.page === undefined ? undefined : originOf(request.page)
  const at = origin === undefined ? {} : { origin }

  const verdict = (verdict: "allow" | "deny", reason: string): PolicyVerdict => ({
    verdict,
    reason,
    policy: policy.name,
    risk,
    ...at
  })

  // (1) Is this an Action anybody has classified?
  //
  // Only reachable from Discovery, where a model proposes the verb. An Action
  // type nobody wrote down is exactly the one that must not run, and the reason
  // says what the vocabulary is so the log shows what was asked for.
  if (risk === "unknown") {
    return verdict(
      "deny",
      `"${request.type}" is not an Action this system has. Policy ${policy.name} judges only ` +
        `the Artifact action vocabulary, and an unclassified action is refused rather than guessed at`
    )
  }

  // (2) Does this Policy permit it, in this mode?
  const permitted = policy.permitted.get(request.mode)?.get(request.type)
  if (permitted === undefined) {
    const listed = [...(policy.permitted.get(request.mode)?.keys() ?? [])]
    return verdict(
      "deny",
      `policy ${policy.name} does not permit ${request.type} in ${request.mode} mode` +
        (risk === "risky"
          ? `. ${request.type} is a risky action: it can commit a change that cannot be undone, ` +
            `so it happens only where the policy names it with a reason`
          : "") +
        `. Permitted here: ${listed.length === 0 ? "nothing" : listed.join(", ")}`
    )
  }

  // (3) Where is the run right now?
  if (request.page !== undefined && origin === undefined) {
    // A blank page has no origin. Navigating away from one is the only sensible
    // thing to do with it; acting on it is not, and the honest answer is that
    // there is nothing here to act on.
    if (request.type !== "navigate") {
      return verdict(
        "deny",
        `no page is open (${request.page}), so there is nothing for ${request.type} to act on. ` +
          `Policy ${policy.name} allows an action only on an origin it can name`
      )
    }
  } else if (origin !== undefined && allowedBy(policy.origins, origin) === undefined) {
    return verdict(
      "deny",
      `this run is on ${origin}, which policy ${policy.name} does not allow. ` +
        `Allowed origins: ${policy.origins.map((pattern) => pattern.source).join(", ")}`
    )
  }

  // (4) And where would a navigation go?
  if (request.type === "navigate") {
    const destination = originOf(request.subject)
    if (destination === undefined) {
      return verdict(
        "deny",
        `${request.subject} is not an absolute http or https URL, so policy ${policy.name} ` +
          `cannot tell which origin it would reach`
      )
    }
    const match = allowedBy(policy.origins, request.subject)
    if (match === undefined) {
      return verdict(
        "deny",
        `${destination} is not an allowed origin under policy ${policy.name}. ` +
          `Allowed origins: ${policy.origins.map((pattern) => pattern.source).join(", ")}`
      )
    }
    return verdict(
      "allow",
      `policy ${policy.name} permits navigate (safe) to ${destination}, matching ${match.source}`
    )
  }

  // The reviewer's own justification travels into the Evidence event, so the
  // argument for permitting an irreversible action sits next to the record of it
  // happening rather than in a file nobody opens afterwards.
  const because = permitted.because?.trim()
  return verdict(
    "allow",
    `policy ${policy.name} permits ${request.type} (${risk})` +
      (origin === undefined ? "" : ` on ${origin}`) +
      (because === undefined || because.length === 0 ? "" : ` — ${because}`)
  )
}
