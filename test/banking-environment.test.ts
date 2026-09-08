import { expect, it } from "vitest"
import { optionsFromEnvironment } from "../apps/banking/src/environment.ts"
import { transientState } from "../apps/banking/src/conditions.ts"
import { DEFAULT_PORT } from "../apps/banking/src/server.ts"

it.each([undefined, "", " ", "abc", "NaN", "Infinity", "-1", "0.5", "65536"])(
  "uses the default port for invalid PORT=%s", (PORT) => {
    expect(optionsFromEnvironment({ PORT }).port).toBe(DEFAULT_PORT)
  }
)

it.each(["0", "4174", "65535"])("preserves valid PORT=%s", (PORT) => {
  expect(optionsFromEnvironment({ PORT }).port).toBe(Number(PORT))
})

it.each([undefined, "", " ", "abc", "NaN", "Infinity", "-1", "0.5", "9007199254740992"])(
  "leaves session expiry disabled for invalid EXPIRE_SESSION_AFTER=%s", (EXPIRE_SESSION_AFTER) => {
    const options = optionsFromEnvironment({ EXPIRE_SESSION_AFTER })
    expect(options).not.toHaveProperty("expireSessionAfter")
    const state = transientState(options)
    for (let i = 0; i < 3; i++) state.notePageRequest()
    expect(state.isSignedOut()).toBe(false)
  }
)

it.each([0, 2])("expires after %s allowed page requests", (count) => {
  const state = transientState(optionsFromEnvironment({ EXPIRE_SESSION_AFTER: String(count) }))
  for (let i = 0; i < count; i++) state.notePageRequest()
  expect(state.isSignedOut()).toBe(false)
  state.notePageRequest()
  expect(state.isSignedOut()).toBe(true)
})
