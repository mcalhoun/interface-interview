import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const receipt = JSON.parse(readFileSync(new URL('./receipt.json', import.meta.url), 'utf8'))
const events = readFileSync(new URL('./run/events.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line))

const verifyReturn = (sessionId, events) => {
  assert.equal(typeof sessionId, 'string', 'expected a session ID')
  assert(sessionId.trim().length > 0, 'expected a non-empty session ID')
  const returned = events.findIndex(event => event.kind === 'intervention.resolve')
  assert(returned >= 0, 'expected intervention.resolve before replay resumes')
  assert(events.slice(returned + 1).some(event =>
    event.kind === 'checkpoint' && event.stepId === 'open-account' && event.verdict === 'held'
  ), 'expected the account checkpoint to hold after return')
  assert(events.every(event => event.sessionId === sessionId), 'every event must belong to the recorded Session')
}

verifyReturn(receipt.sessionId, events)
assert.throws(() => verifyReturn(receipt.sessionId, events.filter(event => event.kind !== 'intervention.resolve')),
  /expected intervention.resolve/)
assert.throws(() => verifyReturn(undefined, events), /expected a session ID/)
assert.throws(() => verifyReturn('', events), /expected a non-empty session ID/)
assert.throws(() => verifyReturn(receipt.sessionId, events.map(event => ({ ...event, sessionId: undefined }))),
  /every event must belong/)
assert.throws(() => verifyReturn(receipt.sessionId, events.map((event, index) =>
  index === 0 ? { ...event, sessionId: 'another-session' } : event
)), /every event must belong/)
const returned = events.findIndex(event => event.kind === 'intervention.resolve')
assert.throws(() => verifyReturn(receipt.sessionId, events.filter((event, index) =>
  index <= returned || event.kind !== 'checkpoint' || event.stepId !== 'open-account' || event.verdict !== 'held'
)), /expected the account checkpoint/)

console.log(JSON.stringify({
  verified: true, sessionId: receipt.sessionId, events: events.length,
  returnedEventIndex: returned, rejectedInvalidEvidenceCases: 6
}, null, 2))
