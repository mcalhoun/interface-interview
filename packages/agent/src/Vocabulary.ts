/**
 * The Discovery action vocabulary, as an Effect `Toolkit`.
 *
 * SPEC user story 3 wants Discovery choosing from a constrained vocabulary
 * "rather than emit arbitrary code, so that every action it takes is reviewable
 * and policy-checkable". A `Toolkit` is what makes that structural: the runtime
 * validates every argument against a `Schema`, so a malformed or
 * out-of-vocabulary action is **not representable** rather than caught by
 * hand-written parsing of a JSON blob.
 *
 * ## The toolkit cannot act
 *
 * This is the part worth reading twice. Every handler below is `Effect.die`, and
 * the loop calls `generateText` with `disableToolCallResolution: true`. The model
 * proposes; the framework resolves nothing; the loop reads the proposal off the
 * response, puts it through Policy, and only then touches the Surface itself.
 *
 * So the Toolkit is a *vocabulary of proposals*, not an executor. A tool call
 * cannot reach a browser even if Policy were misconfigured, because there is no
 * code path from a handler to the `SurfaceAdapter` — the handlers do not run, and
 * if a later change ever re-enabled resolution they would crash loudly rather
 * than quietly acting unjudged. It is the same argument ADR-0005 makes about the
 * assisted-recovery model being structurally incapable of acting, applied to the
 * one loop where a model genuinely does drive.
 *
 * ## Seven verbs, in two groups
 *
 * Five of them touch the Surface and are exactly `@cua/policy`'s `ACTION_TYPES`:
 * `navigate`, `fill`, `click`, `extract`, `selectFromList`. Keeping the two lists
 * identical is checked by a test rather than by eye — Policy is the backstop, but
 * a vocabulary wider than the one Policy can classify would mean the model
 * routinely proposing things that can only ever be denied.
 *
 * Two of them do not touch the Surface at all: `succeed` and `escalate` end the
 * run. They are deliberately outside Policy's gate, because Policy authorises
 * *actions on a surface*, and there is nothing for an origin allowlist to check
 * about a model saying it is finished. `escalate` is also one of the six Stuck
 * triggers (SPEC, "Discovery agent"): the model's own admission that it is not
 * getting anywhere is worth as much as a cycle detector noticing.
 *
 * ## No selector, anywhere
 *
 * Every subject is a `Target` from `@cua/surface` — role, accessible name,
 * label, `textNear`, scope, ordinal. There is no `selector` field, no `css`, no
 * `xpath` and no coordinate, so a model that cannot see markup has nowhere to put
 * one even if it invented some (ADR-0001).
 */

import { TargetSchema } from "@cua/surface"
import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { ProvenancedValue } from "./Provenance.ts"

/**
 * What a Step is *for*, in the operator's words.
 *
 * Required on every acting verb because a Capability Artifact's `Step.intent` is
 * required, and asking the model for it at the moment it decides is the only
 * time the answer is actually known. Reconstructing intent afterwards from an
 * action and a screenshot is exactly the guesswork this design avoids.
 */
const Intent = Schema.String

/** Why this action, now. Lands in the `decide` Evidence event beside the action. */
const Rationale = Schema.String

// ---------------------------------------------------------------------------
// The five verbs that touch a Surface
// ---------------------------------------------------------------------------

const Navigate = Tool.make("navigate", {
  description:
    "Go to a location within the application. Give a path such as \"/\" or " +
    "\"/member?memberNumber=123\", never an absolute URL: the capability being " +
    "learned belongs to the product, not to one institution's installation.",
  parameters: Schema.Struct({
    intent: Intent,
    rationale: Rationale,
    path: Schema.String
  })
})

const Click = Tool.make("click", {
  description:
    "Press a control: a button, a link, a tab. Name it the way an operator would " +
    "point at it, by role and accessible name. " +
    "Do NOT use this to press one item out of a list the screen is offering — an " +
    "account among a member's accounts, a row among rows. Use selectFromList for " +
    "that: a click names this institution's label, and the capability then only " +
    "works at institutions that use the same wording.",
  parameters: Schema.Struct({
    intent: Intent,
    rationale: Rationale,
    target: TargetSchema
  })
})

const Fill = Tool.make("fill", {
  description:
    "Type a value into a named control. The value is NOT a bare string: it must " +
    "record where it came from. Use goalDerived for anything the goal told you, " +
    "and name the parameter it should become (for example memberId). Use " +
    "uiDerived for something an earlier extract step read. Use constant only for " +
    "a value that is genuinely fixed for every future run and appears nowhere in " +
    "the goal.",
  parameters: Schema.Struct({
    intent: Intent,
    rationale: Rationale,
    target: TargetSchema,
    value: ProvenancedValue
  })
})

const Extract = Tool.make("extract", {
  description:
    "Read the text a named control shows, and bind that reading under a step id " +
    "so later steps and the final answer can refer to it.",
  parameters: Schema.Struct({
    intent: Intent,
    rationale: Rationale,
    target: TargetSchema,
    /** Names the reading. Becomes the Step id, and what `uiDerived` points at. */
    bindAs: Schema.String
  })
})

/**
 * Choose one of the items a screen currently offers, and press it.
 *
 * The parameters here are what ticket 11 turns into an `enum` input, and the one
 * place a Discovery run can quietly destroy multi-tenant reuse. See
 * `Selection.ts` for the rule and the reason.
 */
const SelectFromList = Tool.make("selectFromList", {
  description:
    "Choose one item from a list the screen is offering, by matching a word " +
    "against the items' labels, and press it. Use this instead of clicking a " +
    "specific account or row by name: it is what lets the learned capability " +
    "work at an institution whose labels read differently. " +
    "IMPORTANT: `match` must be the GOAL'S OWN WORD, not the label you matched " +
    "it against. If the goal says \"savings\" and the screen offers \"Primary " +
    "Savings\", match on \"savings\". Recording \"Primary Savings\" would break " +
    "at an institution that calls the same account \"Regular Savings\". " +
    "List every label you can see in `observedLabels`, because those become the " +
    "legal values of the parameter. " +
    "Scope the list with `list.within.name`, using the caption heading it on " +
    "screen: an unscoped list is every item on the page, so navigation links end " +
    "up declared as legal values. Give `list.within.name` only — do NOT set " +
    "`list.within.role`, which narrows the scope to nothing. " +
    "`discoveredFrom` is the whole inference in one sentence, for example: the " +
    "goal's word for the account type is a token subset of the label the screen " +
    "offered. It is what a reviewer reads to decide whether to agree with the " +
    "choice, so a fragment is no use.",
  parameters: Schema.Struct({
    intent: Intent,
    rationale: Rationale,
    list: Schema.Struct({
      /**
       * The region the list sits in, named by the caption heading it.
       *
       * Optional in the schema and required in practice: `checkSelection` refuses
       * a proposal without it. It stays optional here because a `Target`'s scope
       * is optional everywhere else in this vocabulary, and because a refusal the
       * model is told about in words it can act on is better than a decode error
       * it only sees as a malformed call.
       *
       * The `role` half is almost always wrong to supply and the description says
       * so. A region is found by climbing from the caption that heads it, so the
       * caption is a cell beside the list rather than a role the region carries;
       * naming a role for it narrows the scope to nothing. A live run spent its
       * whole step budget re-proposing `{ role: ..., name: "Share and Deposit
       * Accounts" }` and being told the list was empty.
       */
      within: Schema.optional(
        Schema.Struct({
          role: Schema.optional(Schema.String),
          name: Schema.optional(Schema.String)
        })
      ),
      /** The role each item carries; `link` for a list of account links. */
      itemRole: Schema.String
    }),
    /** The word to match. Provenanced like a `fill`, and checked the same way. */
    match: ProvenancedValue,
    /**
     * Every label on offer, as read off this screen. Becomes the `values` of the
     * declared enum input, which is how a reviewer sees what the choice was made
     * among rather than only what was chosen.
     */
    observedLabels: Schema.Array(Schema.String),
    /**
     * The inference, in one line, e.g. `goal term 'savings' ⊂ label 'Primary
     * Savings'`. Becomes the input's `discoveredFrom`: provenance a reviewer can
     * disagree with, rather than a contract asserted after the fact.
     */
    discoveredFrom: Schema.String,
    /**
     * Why this list and this matching rule, and what would have to change on
     * screen to break them. A selection has no single Target to hang a
     * robustness argument on, so it hangs here — and the Artifact schema requires
     * more than 80 characters of it, so a one-word answer fails at emission.
     */
    robustness: Schema.String
  })
})

// ---------------------------------------------------------------------------
// The two verbs that end the run
// ---------------------------------------------------------------------------

const Succeed = Tool.make("succeed", {
  description:
    "The goal has been accomplished. Call this only when the value the goal " +
    "asked for is actually on screen and has been read by an extract step.",
  parameters: Schema.Struct({
    rationale: Rationale,
    /** What was accomplished, in the caller's terms. Becomes the Capability summary. */
    summary: Schema.String,
    /**
     * The readings that answer the goal, each naming the extract step it came
     * from. Becomes the Capability's declared outputs.
     */
    outputs: Schema.Array(
      Schema.Struct({
        /** The caller's name for it: `availableBalance`, not `Available Balance`. */
        name: Schema.String,
        /** The `bindAs` of the extract step that read it. */
        fromStep: Schema.String,
        description: Schema.String
      })
    )
  })
})

const Escalate = Tool.make("escalate", {
  description:
    "Stop and hand over to a person. Use this when the application is telling " +
    "you something you cannot act on, when you have run out of ideas, or when " +
    "proceeding would need authority you do not have. Stopping here is a correct " +
    "outcome, not a failure.",
  parameters: Schema.Struct({
    rationale: Rationale,
    /** A short code a routing system can branch on, e.g. `MEMBER_NOT_FOUND`. */
    code: Schema.String,
    detail: Schema.String
  })
})

// ---------------------------------------------------------------------------
// The toolkit
// ---------------------------------------------------------------------------

export const discoveryTools = Toolkit.make(
  Navigate,
  Click,
  Fill,
  Extract,
  SelectFromList,
  Succeed,
  Escalate
)

/**
 * Handlers that refuse to run, and the reason they exist.
 *
 * The loop disables tool-call resolution, so none of these is ever invoked. They
 * are here so the claim "a tool call cannot reach a browser" does not rest on one
 * option staying set: if resolution were re-enabled by a later change, this dies
 * loudly at the first tool call rather than quietly performing an action that
 * Policy never saw and Evidence never recorded.
 *
 * `Effect.die` rather than a failure, because there is no sensible recovery. A
 * model executing its own proposals is not a condition to handle, it is a
 * chokepoint that has stopped existing.
 */
const refuseToAct = (verb: DiscoveryVerb) => () =>
  Effect.die(
    `the discovery toolkit is a vocabulary of proposals, not an executor: ` +
      `${verb} was resolved by the framework instead of going through the policy gate`
  )

/**
 * The toolkit the loop hands to the model: tools, plus handlers that cannot act.
 *
 * An `Effect<WithHandler<...>>` rather than a bare `Toolkit`, so it satisfies
 * `generateText`'s `toolkit` option with nothing left in its requirement channel.
 */
export const discoveryToolkit = Effect.provide(
  discoveryTools,
  discoveryTools.toLayer({
    navigate: refuseToAct("navigate"),
    click: refuseToAct("click"),
    fill: refuseToAct("fill"),
    extract: refuseToAct("extract"),
    selectFromList: refuseToAct("selectFromList"),
    succeed: refuseToAct("succeed"),
    escalate: refuseToAct("escalate")
  })
)

/** Every verb the model may propose. */
export const DISCOVERY_VERBS = [
  "navigate",
  "click",
  "fill",
  "extract",
  "selectFromList",
  "succeed",
  "escalate"
] as const

export type DiscoveryVerb = (typeof DISCOVERY_VERBS)[number]

/**
 * The verbs that touch a Surface, and therefore go through the Policy gate.
 *
 * A test asserts this is exactly `@cua/policy`'s `ACTION_TYPES`. Policy is the
 * backstop rather than the first line (ticket 07's note to this ticket), and the
 * two lists drifting apart would mean either a verb the model can propose that
 * Policy can only ever deny, or — much worse — a Surface action Policy has never
 * been asked about.
 */
export const SURFACE_VERBS = [
  "navigate",
  "click",
  "fill",
  "extract",
  "selectFromList"
] as const

export type SurfaceVerb = (typeof SURFACE_VERBS)[number]

const SURFACE_VERB_SET: ReadonlySet<string> = new Set(SURFACE_VERBS)

export const isSurfaceVerb = (verb: string): verb is SurfaceVerb =>
  SURFACE_VERB_SET.has(verb)

// ---------------------------------------------------------------------------
// Decoding a proposal
// ---------------------------------------------------------------------------

/**
 * One decided action, already validated against its Schema.
 *
 * A discriminated union rather than a bag of optional fields, so the loop's
 * `switch` is exhaustive and a verb added to the vocabulary without a branch
 * fails to compile.
 */
export type Proposal =
  | ({ readonly verb: "navigate" } & typeof Navigate.parametersSchema.Type)
  | ({ readonly verb: "click" } & typeof Click.parametersSchema.Type)
  | ({ readonly verb: "fill" } & typeof Fill.parametersSchema.Type)
  | ({ readonly verb: "extract" } & typeof Extract.parametersSchema.Type)
  | ({ readonly verb: "selectFromList" } & typeof SelectFromList.parametersSchema.Type)
  | ({ readonly verb: "succeed" } & typeof Succeed.parametersSchema.Type)
  | ({ readonly verb: "escalate" } & typeof Escalate.parametersSchema.Type)

const decoders = {
  navigate: Schema.decodeUnknownResult(Navigate.parametersSchema),
  click: Schema.decodeUnknownResult(Click.parametersSchema),
  fill: Schema.decodeUnknownResult(Fill.parametersSchema),
  extract: Schema.decodeUnknownResult(Extract.parametersSchema),
  selectFromList: Schema.decodeUnknownResult(SelectFromList.parametersSchema),
  succeed: Schema.decodeUnknownResult(Succeed.parametersSchema),
  escalate: Schema.decodeUnknownResult(Escalate.parametersSchema)
} as const

/** Why a raw tool call could not become a `Proposal`. Phrased at the model. */
export interface UndecodableProposal {
  readonly complaint: string
}

/**
 * Turns a raw tool call into a typed `Proposal`, or says why it cannot.
 *
 * This is where "not representable" is cashed in. The loop never sees a verb
 * outside the vocabulary and never sees arguments that did not decode, so its
 * `switch` has no default branch to write a guess in.
 */
export const proposalFrom = (
  name: string,
  params: unknown
): Proposal | UndecodableProposal => {
  if (!Object.hasOwn(decoders, name)) {
    return {
      complaint:
        `there is no action called ${JSON.stringify(name)}. ` +
        `The actions available are: ${DISCOVERY_VERBS.join(", ")}.`
    }
  }
  const verb = name as DiscoveryVerb
  const decoded = decoders[verb](params)
  if (decoded._tag === "Failure") {
    return {
      complaint: `the arguments to ${verb} did not validate: ${decoded.failure}`
    }
  }
  return { verb, ...decoded.success } as Proposal
}

export const isUndecodable = (
  candidate: Proposal | UndecodableProposal
): candidate is UndecodableProposal => "complaint" in candidate
