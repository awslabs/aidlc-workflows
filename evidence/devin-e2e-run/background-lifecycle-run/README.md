# background-lifecycle-run — environment and manifest

Attended live acceptance of the PR #996 review Item 3 fix (Devin-native
background-subagent lifecycle: in-flight ledger annotation, `read_subagent`
completion forwarding, Stop pending-subagent carve-out). Read `SUMMARY.md`
for verdicts; `devin-e2e-test-plan.md` is the plan that was executed.

## Environment

| Item | Value |
|------|-------|
| Date | 2026-09-19 (UTC-3); background launch 17:11Z, explore read 17:11:35Z, developer completion 17:45Z, workflow complete + session end 18:07–18:08Z |
| Source checkout | `<home>/sources/aidlc-workflows` at `10b71cb5` (`feat/devin-harness`) plus the **uncommitted** Item 3 change (adapter lifecycle arms + `hooks.v1.json` matcher) |
| Project | `<home>/devin-e2e-background-lifecycle`, fresh `git init`, baseline commit `a86b7df` |
| Devin CLI | `3000.10.31 (b98cc431)` |
| Model | `SWE-2 Max` (export header); subagent model policy warning only |
| Runtime | bun `1.3.14` at `~/.bun/bin/bun` |
| Installed adapter | `annotateSubagentInflight`, `forwardSubagentStop`, `matchSubagentLaunchAck` present; `hooks.v1.json` log-subagent matcher `^(run_subagent|read_subagent)$`; sha256 in `10-environment.txt` |
| Session | single session `cosmic-minnow`, intent `260919-hello-script` (express scope); compacted once (~18:02Z), no `/clear` |
| Redaction | `/home/wiley` → `<home>` in every file written after the run; `00-doctor-before.txt` keeps the literal path |

## Artifacts

| File | What it is |
|------|------------|
| `devin-e2e-test-plan.md` | The plan executed (L1–L7) |
| `SUMMARY.md` | Verdicts, findings, deviations |
| `00-doctor-before.txt` | Doctor on the fresh project (55 pass / 4 warn / 1 expected fail — no SessionStart marker yet) |
| `01-lifecycle-l1-l2-l4.txt` | In-run captures: dispatch args, launch ack, carve-out drops line, first read result, audit row, ledger absence |
| `02-final-state.txt` | Final audit counters, both SUBAGENT_COMPLETED rows verbatim, drops, ledger absence, hello.py/test output |
| `03-doctor-after.txt` | Doctor after the run (58 pass / 5 warn / 0 fail) |
| `04-l3-repeated-read.txt` | Read-only `sessions.db` dump: nodes 89/100–102 (launch ack, first read call+result), nodes 529–532 (second read call+result), dedup count — L3 |
| `05-developer-dispatch.txt` | `sessions.db` dump: node 238 parent dispatch (pre-merge args, no `is_background`), node 310 re-render analysis, node 311 tool result, child prompt nodes 239/241/243/245 with one `AIDLC_DISPATCH_RULES_BEGIN` each — L5 |
| `06-audit-shard.md` | Copy of the intent's audit shard |
| `07-aidlc-state.md` | Copy of `aidlc-state.md` (Status: Completed) |
| `08-receipt.json` | Plan-approval receipt (`session: cosmic-minnow`, `status: generation`) |
| `09-hooks-health.txt` | `hooks-health/` listing + contents; `continue-workflow.drops` carries the pending-subagent carve-out line — L1/L4 |
| `10-environment.txt` | Versions, installed-adapter grep hits, `hooks.v1.json` matcher, sha256s, source HEAD |
| `devin-session-a.json` | Session export (ATIF-v1.7); session-start preamble + post-compaction tail only — see SUMMARY.md finding 3 |
| `MANIFEST.sha256` | SHA-256 of every other file in this directory |
