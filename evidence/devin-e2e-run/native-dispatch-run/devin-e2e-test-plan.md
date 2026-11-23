# Native-dispatch live run plan (PR #996 Item 2 acceptance)

**Prepared:** 2026-09-17. **Host:** Devin CLI 3000.10.31 (b98cc431), bun 1.3.14.
**Installed tree:** `dist/devin` built from `3baf4d54` + uncommitted Item 2 fix (`normalizeRunSubagentInput`, `{task}`-only rewrite, zero-marker guard wording); install commit `fc6c870` in `~/devin-e2e-native-dispatch`.

## Launch

Every session must export per-turn (the previous run lost sessions A/B because export wasn't enabled):

```bash
cd ~/devin-e2e-native-dispatch
devin --export devin-session-<label>.json
```

Use a fresh label per session (e.g. `devin-session-a.json`; after `/clear`, Devin starts a NEW session — relaunch with `--export devin-session-c.json`). The first launch may ask to approve hooks — approve; that creates the SessionStart marker the doctor check needs.

Prompt:

```text
/aidlc express "create a single-file script hello.py that prints the word ok"
```

Answer requirements questions with the simplest options (Python 3, no deps), approve the requirements gate.

## Checkpoints and verdicts

Save artifacts into this evidence directory as you go (numbered `NN-name.txt`/`json`).

### V1 — Unapproved dispatch blocks with correct wording (expected, free)

The conductor habitually attempts developer dispatch before approval. Capture its rejection text (`01-dispatch-blocked.txt`).

- PASS: refusal names missing approval for `stage:code-generation` if the brief had a marker, or says the brief "carries no target marker" (and does NOT say "not currently approved") when it didn't. Audit `PLAN_APPROVAL_BLOCKED` rows record the reason.
- FAIL: the old "not currently approved" wording on a no-marker brief, or any block AFTER approval with a marker-bearing task.

### V2 — Approved dispatch is allowed

At "Approve this exact Code Generation plan?" click **Approve Plan**. Watch the next `run_subagent → aidlc-developer-agent`.

- PASS: dispatch proceeds; no new `PLAN_APPROVAL_BLOCKED` after `PLAN_APPROVAL_RECORDED`; `receipt-*.json` shows `"status": "generation"`. Save `02-after-approval.txt` (ls of `aidlc/.aidlc-sessions/plan-approval/`), `02-receipt.json`, `03-dispatch-result.txt`.
- FAIL: `(missing marker)` or any guard block on the approved dispatch.

### V3 — Rules land in `task` (the novel check)

After the dispatch, read the exported session JSON (`04-task-rewrite.txt` — extract the `run_subagent` `tool_input`).

- PASS: the executed `tool_input.task` contains the conductor's brief (starting `AIDLC-STAGE:` / `AIDLC-TESTING-CONTRACT:`) followed by exactly one `<!-- AIDLC_DISPATCH_RULES_BEGIN sha256:… stage:code-generation -->` block. `tool_input` has no `prompt`/`subagent_type`/`run_in_background` keys.
- FAIL / HOST GAP: `task` lacks the bundle even though no block occurred → Devin did not apply the `updatedInput` rewrite. Stop and record; do not work around it.

### V4 — Workflow completes

- PASS: `hello.py` exists, `python3 hello.py` prints `ok`; audit shows code-generation + build-and-test completion (`05-workflow-complete.txt`, `05-hello.py`, `aidlc-state.md`, `audit-shard.md`).
- If the operation tail self-skips (express scope), record that.

### V5 — Clean `/clear` (closes the DEVIN-09 S5 caveat)

After the developer dispatch has run (or the workflow completes), in the same terminal: `/clear`, then relaunch with `--export devin-session-c.json` and `/aidlc`.

- PASS: `plan-approval/` holds only the original `receipt-*.json` (byte-identical hash, `06-receipt-final-sha.txt`); no `challenge-<C>.json`; **no Plan Approval prompt appears** (`06-after-clear.txt`, `07-session-c-id.txt`, `07-challenge-c-absent.txt`).
- If a Plan Approval prompt appears, screenshot/record the guard's stated reason before doing anything.

### V6 — Non-AI-DLC profile control

If the conductor dispatches any built-in profile during the run, its exported `tool_input.task` is unchanged (no bundle). Note in `08-controls.txt`.

## Close-out

1. `/exit` all sessions; run `bun .devin/tools/aidlc-doctor.ts --json` → `08-doctor-after.txt`.
2. Copy `aidlc/.aidlc-sessions/` final listing + audit shard + state file into this directory.
3. `sha256sum` every artifact into `MANIFEST.sha256` (excluding the manifest itself).
4. Report verdicts V1–V6; then DEVIN-07/09/14, index, and the evidence README get updated.

## Rules

- Interactive sessions only; real UI choices; no seeded authority, no hand-run `answer`/`report` workarounds.
- If hooks do not fire (no `.devin/.aidlc-session-start.local.json` after the first prompt), STOP and record it.
- The runtime session is the Devin slug from the welcome context / `.current-session`, not the intent UUID.
