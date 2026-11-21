# background-lifecycle-run — verdicts

Attended live acceptance of the PR #996 review Item 3 fix (Devin-native
background-subagent lifecycle: in-flight ledger annotation, `read_subagent`
completion forwarding, Stop pending-subagent carve-out). Plan executed:
`devin-e2e-test-plan.md`. Environment and artifact index: `README.md`.

## Verdicts

| # | Check | Verdict | Evidence |
|---|-------|---------|----------|
| L1 | Launch pending | **PASS** — launch ack (17:11:13Z, node 89) wrote no audit row; `continue-workflow.drops` at 17:11:21Z shows "a background subagent is still in flight for this session; allowing the stop (pending-subagent carve-out)", proving the annotated ledger entry existed while the child ran | `01-lifecycle-l1-l2-l4.txt`, `04-l3-repeated-read.txt`, `09-hooks-health.txt` |
| L2 | Terminal once | **PASS** — one `SUBAGENT_COMPLETED` at 17:11:35Z, `Agent Type: subagent_explore`, `Agent ID: 3e9497b8`, `Message` = the read status line; ledger file absent afterwards | `01-lifecycle-l1-l2-l4.txt`, `02-final-state.txt`, `06-audit-shard.md` |
| L3 | Repeated read | **PASS** — second `read_subagent` (node 532) re-served the full report with `success:true`; `SUBAGENT_COMPLETED` count stayed 2; no ledger change | `04-l3-repeated-read.txt` |
| L4 | Stop carve-out | **PASS** — a Stop fired while the background child was in-flight and was allowed via the carve-out; matches the Phase-0 C11 prediction | `09-hooks-health.txt` (`continue-workflow.drops`) |
| L5 | Foreground isolation | **PASS** — developer completion at 17:45:15Z: `Agent Type: aidlc-developer-agent`, `Agent ID: c1804c13`, `Message` = the Subagent Summary; the foreground dispatch created no ledger entry and disturbed nothing | `02-final-state.txt`, `05-developer-dispatch.txt`, `06-audit-shard.md` |
| L6 | No regression | **PASS** — `PLAN_APPROVAL_BLOCKED` 0, `PLAN_APPROVAL_RECORDED` 1, `WORKFLOW_COMPLETED` 1; `hello.py` prints `ok`, 4/4 unittest green; doctor after 58 passed / 5 warnings / 0 failed | `02-final-state.txt`, `03-doctor-after.txt`, `08-receipt.json` |
| L7 | Failure path | **NOT EXERCISED** — no child failed; denied-tool children read as `completed` per C12 anyway | — |

## Findings

1. **The conductor acted on the new SKILL.md sentence.** Node 100's thinking
   reads "I need to read its result to collect the completion status and
   release the pending-work marker, as instructed" — the new orchestrator
   guidance (read each background result via `read_subagent` before
   integrating; the read releases the pending-work marker) was followed
   exactly.
2. **Stop fired mid-flight exactly as C11 predicted.** The
   `pending-subagent carve-out` line (17:11:21Z) sits between the launch ack
   (17:11:13Z) and the terminal read (17:11:35Z) — the ledger entry did its
   job for the whole in-flight window.
3. **Export coverage.** `devin-session-a.json` (ATIF-v1.7, 29 steps) covers
   the session-start preamble (steps 1–5, 17:07–17:08Z) and the
   post-compaction tail (step 6 is the "continuing from previous thread"
   summary at 18:02:49Z; steps 7–29 run 18:02–18:07Z). The background launch,
   the reads, and the developer dispatch (17:11–17:45Z) are all in the
   compacted-away region — the export contains only textual mentions of them
   in the continuation summary, not the dispatch events themselves. As with
   `native-dispatch-run`, dispatch evidence comes from `sessions.db`.

## Deviations

- **Track B was used.** The express `hello.py` graph dispatches only a
  foreground developer agent, so the background lifecycle was exercised via a
  user-prompted `subagent_explore` ("dispatch a background subagent_explore
  that reads AGENTS.md … keep working while it runs, then read_subagent it
  when it finishes") — a legitimate conductor action per SKILL.md, which
  sanctions `is_background: true` supports read via `read_subagent`.
- L3's second read was user-prompted ("read_subagent agent 3e9497b8 once
  more", node 529) rather than conductor-initiated; the dedup path it
  exercises is identical.
