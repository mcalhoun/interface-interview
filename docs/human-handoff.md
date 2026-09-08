# Demonstrate human handoff

The assignment's section 3.6, on page 5, asks for an Intervention with enough context to act, control of the same live Session, recorded manual work, and a return to automation. It permits a minimal operator interface. This demo uses the real local interface and a synthetic banking application.

## Try it yourself

From the repository root, run:

```sh
bun run demo:handoff
```

This starts Heritage Core, opens a headed Chromium window and replays `member.account-balance@1.1.0` for synthetic member `77777`. No model key is needed. This version predates the learned supervisor hold, so it encounters the blocked balance screen and asks for help. The command uses an available operator port and waits up to ten minutes.

1. Open the complete operator URL printed after `PAUSED`, including its token. The page shows the capability, Step, current location, stopping reason and accessibility observation. Its control owner is `PAUSED`.
2. Enter your name and choose **Take control of this session**. The owner becomes `HUMAN`. Automated Actions cannot run while you hold the Session.
3. Switch to the existing **Google Chrome for Testing** window. Keep the application in that window; opening the banking URL in another browser would create a different Session.
4. In the account panel, enter `SUP7` in **Supervisor ID** and `4417` in **Authorization Code**. These are synthetic fixture values. Click **Authorize**. The same account panel now displays Available Balance and Current Balance.
5. Return to the operator page. Describe the action, for example, `Entered the synthetic supervisor values and clicked Authorize.` Check **I changed the live session**. Select the answer saying the screen is ready to resume. For the next-time question, choose the answer saying automation should always stop and ask for a person.
6. Choose **Return control**. The ownership history records `AUTOMATION → PAUSED → HUMAN → RESUME_REQUESTED → AUTOMATION`. Replay checks the screen before reading the balances.

The terminal should report `SUCCESS`, with available balance `2730.11 USD` and current balance `2905.60 USD`, then print the Evidence directory. The browser and local operator listener close when the command exits. An already loaded operator page can still show the closed Intervention, but refreshing it after exit cannot contact the stopped listener.

The shortcut includes `--noAmend`, so practicing this transfer does not create a new Artifact version. The Operator's action and next-time answer still enter Evidence. Learning and persistence have separate regression tests.

## Show that an unverified return cannot finish the run

Start the same command again. Take control and return it as resolved without releasing the hold. Replay checks the unchanged screen and returns an Intervention result instead of success.

For the blocked path, start again, take control, choose **I could not do this**, and explain that no supervisor is available. Return control. The command stops with an Intervention result and exit code 1. That episode teaches no unattended rule.

## Run the automated proof

```sh
bun run verify:handoff
```

This uses a scripted Operator through the real operator interface and real Chromium. It verifies the request context, control ownership, refusal of a competing Replay, manual field changes and click, return, post-return Checkpoint, balance outputs and text redaction. A second case verifies the blocked return.

The [retained verification bundle](../evidence/verification/2026-09-08-architecture/README.md) contains both cases and a separate native UI run.

To retain the two runs in a fresh directory:

```sh
proof="evidence/verification/handoff-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$proof"
CUA_HANDOFF_EVIDENCE="$proof" bun run verify:handoff
```

Each case stores its run Evidence and a `receipt.json` identifying the scripted Operator, Session, ownership sequence and result. Existing directories are refused. A test failure means that bundle is not a successful verification.

The fixture explicitly enables unredacted screenshots over synthetic data. Text logs remove known private values. Screenshot pixels are not masked. The operator token remains local and is not part of the retained receipt.

## Requirement coverage

| Assignment requirement | Implementation and proof |
| --- | --- |
| Detect and route a blocked state with context | Replay raises `intervention.raise`; the operator page shows capability, Step, reason and Surface State. The acceptance test checks those fields. |
| Discovery can request help when Stuck | `test/discovery-handoff.test.ts` runs Discovery through an Intervention. `test/discovery-intervention-artifact.test.ts` checks that its manual dependency remains in the compiled Artifact. |
| Operate the same live Session | The headed demo exposes the original Chromium window. The acceptance test acts through Replay's own Surface Adapter and preserves the Session ID across Evidence. |
| Know who owns control | The Session state machine records ownership transitions. A competing Replay returns `control_lost` while the Operator owns it. |
| Record what the Operator did | The Session records observed field names and the Operator's confirmed action description. Known values are scrubbed from text Evidence. |
| Return control and verify before proceeding | The completed case checks a Checkpoint after `intervention.resolve` and verifies the balance outputs. Existing manual-completion tests reject an unverified resolved return. |
| Stop when the Operator cannot resolve it | The blocked case returns `intervention_required`. Session learning tests verify that blocked episodes teach nothing. |

The automated proof verifies the handoff mechanism. It does not claim that a person performed its actions, or that a live model produced its Artifact. The repository's retained live-model discovery bundle documents that separate requirement.
