/**
 * A Capability's declared outputs, and the parsing that turns what a screen shows
 * into something a caller can use without re-parsing.
 *
 * SPEC user story 25: "I want typed outputs, a balance as an amount plus currency
 * rather than a scraped string, so that I use the value without re-parsing it."
 * The scrape happens once, here, against a declared type — not in every caller.
 *
 * The type vocabulary is two entries wide on purpose. Every entry is a parser
 * that has to work against real screens and be defensible to a reviewer, so this
 * grows one demonstrated case at a time rather than speculatively.
 *
 * ## On the currency declaration
 *
 * `money` requires a declared `currency`. Heritage Core renders `$4,182.55` with
 * no currency code anywhere on the page, so inferring `USD` from the glyph is a
 * guess. Writing the code into the Artifact makes it a reviewable claim instead,
 * and makes a Tenant whose installation renders `€` fail loudly rather than
 * return a number labelled with the wrong currency. Silently-wrong money is the
 * worst failure this system could produce.
 */

import { Result, Schema } from "effect"

export const OutputType = Schema.Literals(["money", "text"])
export type OutputType = typeof OutputType.Type

export const OutputDeclaration = Schema.Struct({
  type: OutputType,
  /** What the caller is getting, in domain terms. */
  description: Schema.String,
  /** The Step whose reading this output is built from. */
  from: Schema.Struct({ step: Schema.String }),
  /** Required for `money`: the ISO 4217 code the Surface's rendering means. */
  currency: Schema.optional(Schema.String)
})
export type OutputDeclaration = typeof OutputDeclaration.Type

export const OutputDeclarations = Schema.Record(Schema.String, OutputDeclaration)
export type OutputDeclarations = typeof OutputDeclarations.Type

/**
 * A monetary amount.
 *
 * `amount` is a `number` and therefore binary floating point, which is not what a
 * ledger should use. It is right for a read-only balance handed to a calling
 * agent, and wrong the moment this system moves money. A real posting path would
 * carry minor units as an integer or a decimal string; that is named here rather
 * than left for someone to discover.
 */
export const Money = Schema.Struct({
  amount: Schema.Finite,
  currency: Schema.String
})
export type Money = typeof Money.Type

export const OutputValue = Schema.Union([
  Schema.Struct({ type: Schema.Literal("money"), value: Money }),
  Schema.Struct({ type: Schema.Literal("text"), value: Schema.String })
])
export type OutputValue = typeof OutputValue.Type

/** Everything a successful run gives back, keyed by declared output name. */
export const OutputValues = Schema.Record(Schema.String, OutputValue)
export type OutputValues = typeof OutputValues.Type

/**
 * What the screen said cannot be read as the declared type.
 *
 * A distinct failure from a Checkpoint failure, because the run reached the right
 * screen and read the right cell — the *contract* is what broke. It still reports
 * expected-versus-observed, since that is the only useful thing to say.
 */
export interface OutputParseProblem {
  readonly output: string
  readonly expected: string
  readonly observed: string
}

/** Currency glyphs Heritage Core and its cousins actually render. */
const SYMBOLS: ReadonlyMap<string, string> = new Map([
  ["$", "USD"],
  ["£", "GBP"],
  ["€", "EUR"]
])

/** A reading that is shaped like an amount: an optional glyph, then digits. */
const AMOUNT = /^(?<symbol>[^\d\s-]*)\s*(?<sign>-?)(?<digits>[\d,]+(?:\.\d{1,2})?)$/u

/**
 * The currency a reading's own rendering means, or `undefined` if it is not money.
 *
 * Ticket 11's compiler asks this of what an `extract` actually read, to decide
 * whether the output it declares is `money` and which code to write down. It is
 * the same table `parseOutput` judges a replayed reading against, exported rather
 * than copied: a compiler that inferred `USD` from one table while the engine
 * rejected it against another would produce Artifacts that fail on their first
 * run.
 *
 * The glyph is not evidence, only a starting point — the Artifact records the
 * code as a claim a reviewer can disagree with, and `parseOutput` then holds
 * every future run to it. That is why an unrecognised glyph returns `undefined`
 * (declare `text` and say so) rather than guessing at the institution's currency.
 */
export const currencyOf = (read: string): string | undefined => {
  const match = AMOUNT.exec(read.trim())
  const symbol = match?.groups?.["symbol"]
  return symbol === undefined || symbol === "" ? undefined : SYMBOLS.get(symbol)
}

export const parseOutput = (
  name: string,
  declaration: OutputDeclaration,
  read: string
): Result.Result<OutputValue, OutputParseProblem> => {
  const text = read.trim()
  switch (declaration.type) {
    case "text":
      return text.length === 0
        ? Result.fail({ output: name, expected: "some text", observed: "an empty reading" })
        : Result.succeed({ type: "text", value: text })
    case "money": {
      const declared = declaration.currency
      if (declared === undefined) {
        return Result.fail({
          output: name,
          expected: "the artifact to declare a currency for a money output",
          observed: "no currency declared"
        })
      }
      const match = AMOUNT.exec(text)
      if (match?.groups === undefined) {
        return Result.fail({
          output: name,
          expected: `a monetary amount in ${declared}`,
          observed: JSON.stringify(text)
        })
      }
      const digits = match.groups["digits"] ?? ""
      const sign = match.groups["sign"] ?? ""
      const symbol = match.groups["symbol"] ?? ""
      const impliedCurrency = symbol === "" ? declared : SYMBOLS.get(symbol)
      if (impliedCurrency !== declared) {
        // A tenant rendering another currency is a real difference, not a
        // cosmetic one, so it stops the run rather than being absorbed.
        return Result.fail({
          output: name,
          expected: `an amount in ${declared}`,
          observed: `${JSON.stringify(text)}, whose ${
            symbol === "" ? "missing symbol" : `symbol ${JSON.stringify(symbol)}`
          } does not mean ${declared}`
        })
      }
      const amount = Number(`${sign}${digits.replaceAll(",", "")}`)
      return Number.isFinite(amount)
        ? Result.succeed({ type: "money", value: { amount, currency: declared } })
        : Result.fail({
            output: name,
            expected: `a monetary amount in ${declared}`,
            observed: JSON.stringify(text)
          })
    }
  }
}

/** Renders an output the way the CLI prints it and a report quotes it. */
export const describeOutputValue = (value: OutputValue): string =>
  value.type === "money"
    ? `${value.value.amount.toFixed(2)} ${value.value.currency}`
    : value.value
