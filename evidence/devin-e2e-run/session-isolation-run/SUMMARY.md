# Session Isolation Run — Summary (PR #996 Item 1 live acceptance)

**Date:** 2026-09-17 (16:49–18:35 UTC-3). **Host:** Devin CLI `3000.10.31`, model `swe-2-medium`
(parent session), bun `~/.bun/bin/bun`. **Source under test:** `bce80f29` + uncommitted Item 1 fix
(`core/tools/aidlc-testing-posture.ts`), rebuilt with `bun scripts/package.ts` (`--check` deterministic)
and copied into a fresh project `~/devin-e2e-session-isolation` (see `README.md`).
**Scope/prompt:** `/aidlc express "create a single-file script hello.py that prints the word ok"`.

**Sessions:** A = `purple-wool` (owning conversation), B = `awake-radon` (concurrent second
terminal), C = `lively-voyage` (after `/clear` in A's terminal). `jasper-psychology` and
`carpal-sphynx` were earlier starts of the same terminal before a Devin restart; they created no
workflow state.

All paths below are relative to the project unless noted. No file under
`aidlc/.aidlc-sessions/plan-approval/` was created, copied, renamed, or edited by hand.

## Verdicts

| # | Contract | Verdict | Evidence |
|---|----------|---------|----------|
| S1 | Same-session approval certifies; guard honors the receipt | **PASS (receipt)** / dispatch **BLOCKED by Item 2** | `HUMAN_TURN` (purple-wool 20:36:22Z) → `PLAN_APPROVAL_RECORDED` (Session purple-wool 20:36:41Z) → `receipt-6f7de906….json` `"session":"purple-wool"`, `"status":"approved"`; challenge/response consumed (`06-after-approval.txt`, `06-receipt.json`). This happened while `.current-session` = B. `run_subagent → aidlc-developer-agent` was then refused 4× with `Unit: (missing marker)` — see Item 2 below, not an approval-engine refusal (`06-dispatch-rejection.txt`). |
| S2 | Concurrent session B cannot answer A's challenge | **PASS** | `Approve Plan` typed in B recorded `HUMAN_TURN` Session `awake-radon` (20:24:29Z); `plan-approval/` still held only `challenge-purple-wool.json` (unchanged mtime 17:08:32), no `response-*`, no receipt (`04-after-b-typed.txt`). |
| S3 | `answer --session <B>` against A's pending pair is refused | **PASS** | With `[Answer]: Approve Plan` set (the state B's conductor would produce), `aidlc-log.ts answer … --session awake-radon --stage-level` → exit 1, `Refusing to record Plan Approval: Plan Approval requires the actual offered choice from this prompt and session`; `ERROR_LOGGED` audit row; `plan-approval/` unchanged; questions file restored byte-identical (sha `1862e040…`) (`05-answer-with-b.txt`, `05-after-b-answer.txt`). A first attempt with the tag blank was refused earlier by the precondition `questions file must contain exactly [Answer]: Approve Plan` and did not reach the session check; recorded as a deviation. |
| S4 | Challenge keyed by the runtime session, not the intent UUID | **PASS** | `challenge-purple-wool.json` with `"session":"purple-wool"`, `"intentId":"01a0b0ee-…"` (`02-challenge-a.json`). Devin session ids are slugs, not UUIDs. |
| S5 | Certified receipt survives a session change | **PASS (persistence)** / no-re-prompt **INCONCLUSIVE** | After `/clear` (C = lively-voyage) the receipt was untouched (sha `016baee3…` = `06-receipt-sha.txt`), not deleted, no second receipt. The conductor's first act in C was a developer dispatch → Item 2 block; its rejection text says "not currently approved … present Plan Approval", so the conductor blanked `[Answer]:` and re-ran `decision`, minting `challenge-lively-voyage.json` with **identical identity** to A's (only `session`/`challengeId` differ — `07-after-clear.txt`, `07-challenge-c.json`). Approving in C re-certified the **same receipt path** with `"session":"lively-voyage"` (`08-receipt-final.json`), and at 20:53:07Z the guard set `"status":"generation"` — i.e. it honored the receipt for a non-dispatch generation action. The re-prompt was induced by Item 2 + guard wording, not by Item 1 session logic. |

**Run verdict:** Item 1 contract **accepted live**: challenge, response, and certification bind to
the exact hook-observed runtime session; a concurrent session's answer and a forced wrong-session
`answer` are refused; `.current-session` pointing at another session did not leak authority; the
certified receipt is session-independent and persisted across `/clear`. The workflow could **not**
complete on this host because of Item 2 (below); `hello.py` was never generated.

## Audit counters (final, `audit-shard.md`)

| Event | Count | Notes |
|-------|-------|-------|
| `PLAN_APPROVAL_RECORDED` | 2 | A (purple-wool 20:36:41Z) and C (lively-voyage 20:52:22Z), same receipt key |
| `PLAN_APPROVAL_BLOCKED` | 10 | 3 pre-approval in A at 20:07Z (conductor jumped to Step 4 before writing the plan: 1 Task, 2 Bash — correct refusals); 4 post-approval Task in A (20:37:17, 20:37:42, 20:38:20, 20:39:49Z); 1 Task in C before re-approval (20:44:42Z); 2 Task in C after re-approval (20:52:43, 20:53:42Z) — all seven `(missing marker)` = Item 2 |
| `ERROR_LOGGED` | 2 | Both from the S3 manual `answer` attempts (precondition, then session refusal) |
| `HUMAN_TURN` | 9 | 6 purple-wool, 1 awake-radon, 2 lively-voyage |
| `DECISION_RECORDED` | 5 | 3 requirements-analysis checkpoints, 2 Plan Approval (A and C) |
| `SESSION_STARTED` / `SESSION_ENDED` | 2 / 3 | starts: awake-radon, lively-voyage (A's start predates the intent record); ends: B `prompt_input_exit` 20:36:11Z, A `clear` 20:43:21Z, C `prompt_input_exit` 21:35:17Z |

## Findings beyond Item 1

1. **Item 2 (DEVIN-07) confirmed live and blocking.** Every `run_subagent → aidlc-developer-agent`
   was refused. The session export shows the conductor **did** put `AIDLC-STAGE: code-generation`
   and `AIDLC-TESTING-CONTRACT: …` at the top of the native `task` field
   (`09-run-subagent-task-field.txt`), but `harness/devin/hooks/aidlc-devin-adapter.ts` forwards
   `tool_input.prompt` (absent on Devin) to the core guard, which therefore sees an empty brief.
   Until fixed, no AI-DLC workflow can pass code-generation on Devin via dispatch.
2. **Guard wording misleads on a marker-less brief.** The rejection claims the plan is "not
   currently approved" although a valid receipt existed; the conductor obeyed and re-presented
   Plan Approval (confounding S5). The marker-missing branch should name the missing marker.
3. **Host caveat:** the 16:52 restart's `SessionStart` payload carried no `session_id`
   (`pids/21993` → `sessionId: null`) and no welcome context was shown; later hooks in that
   session carried `purple-wool` and everything bound correctly. Devin docs state every payload
   includes `session_id`; re-check on upgrades.
4. Pre-approval, the conductor attempted Step 4 (dispatch + shell) before writing the plan; the
   guard's three refusals redirected it correctly to Steps 2–3.

## Deviations from the plan

- S3 needed the `[Answer]: Approve Plan` tag to reach the session check; the tag was set, the
  command run, and the file restored byte-identical (verified by `cmp` and sha256). Nothing under
  `plan-approval/` was touched.
- Session exports: only session C was captured (`devin --export` writes the current session and
  `/clear` started a new one). Sessions A and B are evidenced by the audit shard, runtime files,
  and the `0x-*.txt` listings; no export exists for them.
- Runtime session id for A was corrected from `jasper-psychology` to `purple-wool` after the
  Devin restart; plan text referring to `<A>` means `purple-wool`.

## Not exercised

Operation tail, `build-and-test`, `Request Changes` path, subagent lifecycle hooks
(`deliver-stage-rules`, `log-subagent` — unreachable while Item 2 blocks dispatch), MCP.
