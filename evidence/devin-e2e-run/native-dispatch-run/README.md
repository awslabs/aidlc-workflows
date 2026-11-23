# native-dispatch-run — environment and manifest

Attended live acceptance of the PR #996 review Item 2 fix (Devin-native `run_subagent`
`profile`/`task` translation, DEVIN-07). Read `SUMMARY.md` for verdicts; `devin-e2e-test-plan.md`
is the plan that was executed.

## Environment

| Item | Value |
|------|-------|
| Date | 2026-09-17 22:14 → 2026-09-18 08:44 (UTC-3); approval and dispatch 22:42–22:45, overnight pause, resumed 08:03, workflow complete 08:34 |
| Source checkout | `/home/wiley/sources/aidlc-workflows` at `3baf4d54` (`feat/devin-harness`) plus the **uncommitted** Item 2 fix (`harness/devin/hooks/aidlc-devin-adapter.ts`, `core/hooks/aidlc-plan-approval-guard.ts`, t332/t265 tests) |
| Build | `bun scripts/package.ts` then `bun scripts/package.ts --check` (deterministic) |
| Fix present in shipped tree | `normalizeRunSubagentInput` and the `{task}`-only `updatedInput` rewrite in `.devin/hooks/aidlc-devin-adapter.ts` (`4438c10d…`); guard `4056f429…`; Item 1 markers intact (0 `readCurrentSessionId`) — see `00-environment.txt` |
| Project | `~/devin-e2e-native-dispatch`, fresh `git init`, single commit `fc6c870 install aidlc devin tree (3baf4d54 + Item 2 fix)` |
| Devin CLI | `3000.10.31 (b98cc431)`; support floor `3000.10.21` |
| Model | parent `SWE-2 Max` (export header); subagent model policy warning only |
| Runtime | bun `1.3.14` at `~/.bun/bin/bun` (doctor warns interactive-only PATH; hooks fired throughout — hooks-health stamps in `10-runtime-graph-gap.txt`) |
| Hooks | project `.devin/hooks.v1.json`; SessionStart marker present at launch; doctor after run 58 passed / 5 warnings / 0 failed |
| Session | single session `nettle-vicuna` (resumed and compacted once, no `/clear`) |
| Redaction | `/home/wiley` → `<home>` in every file written after the run; the two `00-*` pre-run captures keep the literal path |

## Artifacts

| File | What it is |
|------|------------|
| `devin-e2e-test-plan.md` | The plan executed (V1–V6) |
| `SUMMARY.md` | Verdicts, counters, findings, deviations |
| `00-doctor-before.txt`, `00-environment.txt` | Doctor on the fresh project and the build/install provenance before any session |
| `04-task-rewrite.txt` | First read of the dispatch from `sessions.db`: parent emitted args (no bundle) vs child-received prompt (one bundle) — V3 |
| `05-export-coverage.txt` | What `devin-session-a.json` does and does not contain (post-compaction tail only) |
| `06-sessions-db-dispatch.txt` | Read-only `sessions.db` dump: parent `run_subagent` nodes 266/367 (full args), child prompt node 267 (full text), bundle counts, SQL used — V2/V3 |
| `07-final-artifacts.txt` | `hello.py`, `test_hello.py`, `python3 hello.py` → `ok`, unittest 4/4, project git state — V4 |
| `08-receipt-final.json`, `08-receipt-final-sha.txt` | Certified receipt (`status: generation`, `session: nettle-vicuna`) |
| `08-sessions-final.txt` | `aidlc/.aidlc-sessions/` listing, binding, pid records |
| `09-audit-counters.txt` | Event counts and the Plan Approval / session / stage rows from the audit shard |
| `10-runtime-graph-gap.txt` | Classifier evidence for the pre-existing `runtime-graph.json` gap on `.devin` (finding 2) |
| `11-doctor-after.txt` | Doctor after the run |
| `aidlc-state.md`, `audit-shard.md` | Copies of the intent's state file and audit shard |
| `devin-session-a.json` | Session export (ATIF), post-compaction tail, redacted |
| `MANIFEST.sha256` | SHA-256 of every other file in this directory |
