import assert from 'node:assert/strict'
import { cpSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { Effect } from 'effect'
import { attendedReplay } from '../../apps/demo/src/support/handoff-harness.ts'
import { shippedArtifact } from '../../apps/demo/src/support/replay-harness.ts'

const root = resolve('.scratch/hil-video-v2')
const marks = []
const mark = text => { marks.push({ at: Date.now(), text }); console.log(text) }
const launch = chromium.launch.bind(chromium)
let applicationPage
let applicationVideo
let applicationStartedAt
// Record the real adapter's Chromium context. Only capture options are changed.
chromium.launch = async options => {
  const browser = await launch(options)
  const newContext = browser.newContext.bind(browser)
  browser.newContext = async options => {
    const context = await newContext({ ...options, viewport: { width: 1000, height: 900 },
      recordVideo: { dir: resolve(root, 'raw/application'), size: { width: 1000, height: 900 } } })
    context.on('page', page => { applicationPage = page; applicationVideo = page.video(); applicationStartedAt = Date.now() })
    return context
  }
  return browser
}
const operatorBrowser = await launch({ headless: true })
const operatorContext = await operatorBrowser.newContext({ viewport: { width: 1000, height: 900 },
  recordVideo: { dir: resolve(root, 'raw/operator'), size: { width: 1000, height: 900 } } })
let operatorPage, operatorVideo, operatorStartedAt
try {
  const outcome = await Effect.runPromise(attendedReplay({
    artifact: shippedArtifact(undefined, '1.1.0'), inputs: { memberId: '77777' },
    runId: 'hil-video', waitMillis: 180000,
    operate: desk => Effect.gen(function* () {
      yield* desk.awaitPause
      operatorPage = yield* Effect.promise(() => operatorContext.newPage())
      operatorVideo = operatorPage.video(); operatorStartedAt = Date.now()
      // Tokens are passed in headers so they never appear in recorded page content.
      yield* Effect.promise(() => operatorContext.setExtraHTTPHeaders({ 'x-operator-token': desk.token }))
      yield* Effect.promise(() => operatorPage.goto(desk.origin))
      yield* Effect.promise(() => operatorPage.getByRole('heading', { name: /^Operator/ }).scrollIntoViewIfNeeded())
      assert.equal((yield* desk.served).owner, 'paused')
      mark('Replay paused at the supervisor hold. The operator request includes the stopping context.')
      yield* Effect.sleep(4500)
      yield* Effect.promise(() => operatorPage.getByRole('textbox', { name: 'Your name' }).fill('demo.operator'))
      yield* Effect.sleep(2000)
      yield* Effect.promise(() => operatorPage.getByRole('button', { name: 'Take control of this session' }).click())
      yield* desk.awaitOwner('operator')
      mark('The Operator owns the original Session. Automation cannot act.')
      yield* Effect.sleep(3000)
      const excluded = yield* desk.replayAgain('hil-video-exclusion')
      assert.equal(excluded.result, 'failure'); assert.equal(excluded.failure.reason, 'control_lost')
      mark('A competing Replay was refused with control_lost.')
      yield* Effect.sleep(2500)
      yield* desk.surface.fill({ role: 'textbox', name: 'Supervisor ID' }, 'SUP7')
      yield* desk.awaitObserved('supervisorId')
      yield* Effect.sleep(2000)
      yield* desk.surface.fill({ role: 'textbox', name: 'Authorization Code' }, '4417')
      yield* desk.awaitObserved('authorizationCode')
      mark('The Operator enters synthetic supervisor values in the same application Session.')
      yield* Effect.sleep(3000)
      yield* Effect.promise(async () => {
        for (const frame of applicationPage.frames()) {
          const button = frame.getByRole('button', { name: 'Authorize', exact: true })
          if (await button.count() === 1) await button.scrollIntoViewIfNeeded()
        }
      })
      yield* Effect.sleep(2000)
      yield* desk.surface.click({ role: 'button', name: 'Authorize' })
      assert.match((yield* desk.surface.observe).accessibility, /Available Balance/)
      mark('Authorize releases the hold. Both balances are now visible.')
      yield* Effect.sleep(3500)
      yield* Effect.promise(() => operatorPage.reload())
      yield* Effect.promise(() => operatorPage.getByRole('textbox', { name: 'What you did, or what stopped you' }).fill('Entered synthetic supervisor values and clicked Authorize in the original browser Session.'))
      yield* Effect.promise(() => operatorPage.getByRole('checkbox').check())
      yield* Effect.promise(() => operatorPage.getByRole('radio', { name: /automation should always stop here/ }).check())
      mark('The request records observed field changes and the confirmed action. Future runs must ask a person.')
      yield* Effect.sleep(5000)
      yield* Effect.promise(() => operatorPage.getByRole('button', { name: 'Return control' }).click())
      yield* desk.awaitOwner('automation')
      mark('Control returns to automation. Replay verifies the account screen before extracting balances.')
      yield* Effect.sleep(6500)
      yield* Effect.promise(() => operatorPage.screenshot({ path: resolve(root, 'operator-completed.png') }))
    })
  }))
  assert.equal(outcome.result.result, 'success')
  assert.equal(outcome.result.outputs.availableBalance.value.amount, 2730.11)
  assert.equal(outcome.result.outputs.currentBalance.value.amount, 2905.60)
  assert.deepEqual(outcome.snapshot.history.map(x => x.owner), ['automation','paused','operator','resume_requested','automation'])
  const returned = outcome.events.findIndex(e => e.kind === 'intervention.resolve')
  assert(outcome.events.slice(returned + 1).some(e => e.kind === 'checkpoint' && e.stepId === 'open-account' && e.verdict === 'held'))
  assert.equal(new Set(outcome.events.map(e => e.sessionId)).size, 1)
  for (const secret of ['77777','SUP7','4417']) assert(!JSON.stringify(outcome.events).includes(secret))
  mark('Verified success: available 2730.11 USD; current 2905.60 USD. One Session throughout.')
  await operatorContext.close(); await operatorBrowser.close()
  cpSync(outcome.evidenceDirectory, resolve(root, 'run'), { recursive: true })
  writeFileSync(resolve(root, 'capture.json'), JSON.stringify({
    sourceCommit: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    provenance: 'Scripted Operator uses the real operator web form and the same Chromium Surface Adapter used by Replay. No person at a keyboard is claimed. Browser capture options are instrumented; no application, Policy, Session or Replay behavior is replaced.',
    privacy: 'Synthetic fixture values only. Video pixels are unredacted. No audio or desktop capture. Operator token supplied through request headers and omitted from receipts.',
    applicationVideo: await applicationVideo.path(), operatorVideo: await operatorVideo.path(),
    applicationStartedAt, operatorStartedAt, marks, owners: outcome.snapshot.history,
    sessionId: outcome.snapshot.sessionId, result: outcome.result, events: 'run/events.jsonl'
  },null,2)+'\n')
} finally {
  chromium.launch = launch
  await operatorBrowser.close()
}
