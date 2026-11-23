# native-dispatch-run — verdicts

Attended live acceptance of the PR #996 review Item 2 fix (Devin-native `run_subagent`
dispatch translation, DEVIN-07). Plan executed: `devin-e2e-test-plan.md`. Environment and
artifact index: `README.md`. Deterministic coverage lives in `tests/unit/t332-devin-adapter.test.ts`
(Item 2 cases) and `tests/unit/t265-plan-approval-guard.test.ts`; this run only adds host behavior.

Completion bar set for this run: the whole `hello.py` workflow must finish, not just the dispatch.
It did (`WORKFLOW_COMPLETED` at 11:34Z, `aidlc-state.md` Status: Completed).

## Verdicts

| # | Check | Verdict | Evidence |
|---|-------|---------|----------|
| V1 | Unapproved developer dispatch is blocked with the new "carries no target marker" wording | **Not exercised live** — the conductor ran Steps 2–4 in order and made no dispatch before Plan Approval; `PLAN_APPROVAL_BLOCKED` = 0 for the whole run | `09-audit-counters.txt`; wording pinned by t265 (`blockReason([])`) and t332 `Item 2` unapproved case |
| V2 | Approved developer dispatch is allowed on the first attempt | **PASS** — one `run_subagent → aidlc-developer-agent` (01:43:08Z), zero guard blocks; receipt flipped to `status: generation` in the same session | `06-sessions-db-dispatch.txt` (node 266), `08-receipt-final.json`, `09-audit-counters.txt` |
| V3 | Active-stage rule bundle reaches the child through Devin's `updatedInput.task` merge, no alias leakage | **PASS** — child prompt (node 267) = conductor's native `task` (markers first) + exactly one `AIDLC_DISPATCH_RULES_BEGIN sha256:20bba9dd… stage:code-generation` block; parent-side recorded args carry only `profile`, `task`, `title` | `04-task-rewrite.txt`, `06-sessions-db-dispatch.txt` |
| V4 | Full workflow completes | **PASS** — 6 stages completed, 3 operation stages skipped, `SUBAGENT_COMPLETED` = 1, `hello.py` prints `ok`, `test_hello.py` 4/4 green, doctor 58 passed / 0 failed | `07-final-artifacts.txt`, `aidlc-state.md`, `11-doctor-after.txt` |
| V5 | Clean `/clear` after approval: valid receipt reused, no Plan Approval re-prompt | **Not exercised** — no `/clear` was issued after approval. Partial signal only: the session was **resumed** (`SESSION_RESUMED` 11:03Z) and **compacted** (`SESSION_COMPACTED` 11:07Z) mid code-generation under the *same* session id, and the conductor did not re-present Plan Approval (`PLAN_APPROVAL_RECORDED` stays 1, no second challenge). Cross-session reuse (DEVIN-09 caveat) remains open | `09-audit-counters.txt`, `08-sessions-final.txt` |
| V6 | Built-in profile dispatch is untouched | **Not exercised live** — only the developer profile was dispatched | t332 `Item 2` unrelated-profile cases |

Overall: **Item 2 accepted live** (V2, V3, V4). V1/V6 rest on deterministic pins; V5 needs a
dedicated re-run of the DEVIN-14 live protocol (approve, `/clear`, resume) before the DEVIN-09
"reuse without re-prompt" caveat can be closed.

## Counters (audit shard, 135 events)

`PLAN_APPROVAL_RECORDED` 1 (01:42:09Z, `Approve Plan`, session `nettle-vicuna`) ·
`PLAN_APPROVAL_BLOCKED` 0 · `SUBAGENT_COMPLETED` 1 · `HUMAN_TURN` 13 · `STAGE_STARTED` 9 ·
`STAGE_COMPLETED` 6 · `STAGE_SKIPPED` 3 · `SESSION_RESUMED` 1 · `SESSION_COMPACTED` 1 ·
`SESSION_ENDED` 1 (11:44:42Z, `prompt_input_exit`) · `WORKFLOW_COMPLETED` 1.

Comparison with `session-isolation-run/` (pre-fix adapter, same CLI build): 7 post-approval
`PLAN_APPROVAL_BLOCKED` rows there, `(missing marker)` every time, workflow never left
code-generation. Here: 0 blocks, workflow complete.

## Findings

1. **Devin applies `updatedInput.task` to `run_subagent`** — first live observation. The parent's
   recorded tool call keeps the *emitted* (pre-merge) arguments, so "the transcript shows an
   unchanged `task`" is not evidence that the rewrite was dropped; the child's received prompt is
   the authoritative surface. Node 367 is a re-render of node 266 (same message id, same call id,
   byte-identical args, stored at child-assembly time 01:45:49Z), not a second dispatch.
2. **Pre-existing core defect, outside Item 2: `runtime-graph.json` is never compiled on Devin.**
   `classifyRuntimeCompileCommand` (`core/hooks/aidlc-rebuild-stage-graph.ts`) builds its path
   regexes from `KNOWN_HARNESS_DIRS` (`core/tools/aidlc-lib.ts`), which is documented as a
   probe-order hint only and lists `.claude .kiro .codex .aidlc .cursor` — no `.devin`. The same
   command classifies `fire` under `.claude/tools/…` and `pass` under `.devin/tools/…`, so the
   `rebuild-stage-graph` PostToolUse hook never dispatches `compile`; `learnings surface` failed
   twice with `runtime-graph.json not found` and the conductor skipped that bookkeeping. Hooks did
   fire (hooks-health stamps present) — the classifier, not the host wiring, is the gap. By
   construction any harness dir absent from the list (`.opencode`, Copilot's dir) is affected the
   same way; only `.devin` was observed. Not fixed in this change. `10-runtime-graph-gap.txt`.
3. **Export coverage caveat.** `devin --export` (and the in-session export) produced only the
   post-compaction tail of `nettle-vicuna` (81 steps from 11:07Z; `run_subagent` count 0). The
   dispatch evidence was recovered read-only from `~/.local/share/devin/cli/sessions.db`
   (`message_nodes`). Future runs should snapshot the DB right after dispatch rather than rely on
   the export. `05-export-coverage.txt`, `06-sessions-db-dispatch.txt`.
4. **Overnight resume did not disturb authority.** Approval at 01:42Z, dispatch 01:43Z, session
   resumed 11:03Z and compacted 11:07Z, code-generation finished 11:2xZ, all under one session id
   with the receipt untouched (`status: generation`, `session: nettle-vicuna`).

## Deviations from the plan

- `--export` was not passed at launch (the given path pointed at a non-existent `native-dispatch/`
  dir); the export was written at session end instead, hence finding 3.
- V5 `/clear` step skipped by the operator; recorded as not exercised rather than inferred.
- Pre-existing `00-doctor-before.txt` / `00-environment.txt` keep the literal home path.
