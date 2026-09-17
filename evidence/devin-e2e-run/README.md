# Devin CLI Harness — E2E Run Campaign

Live end-to-end run evidence for the Devin CLI harness was captured by executing
the per-run plan against the shipped `dist/devin` tree on a real `devin` CLI
session. The four run subdirectories (`first-run/`, `second-run/`, `third-run/`,
`fourth-run/`) have been removed from the working tree; they remain recoverable
from Git history if needed. This `README.md` and `HARNESS-REQUIREMENTS.md` are
retained as the campaign index and requirements.

## Campaign (historical)

Three original runs completed, followed by a fourth capture used for fixture
provenance. Each originally lived in its own subdirectory with a per-run
`README.md` describing the environment and SHA-256 hashes of every artifact.
Those artifacts are now historical Git objects; see `git log --
evidence/devin-e2e-run/` for provenance.

| Run | Date | Scope | Mode | Status |
|-----|------|-------|------|--------|
| `first-run/` (removed) | 2026-08-31 | express (9 stages) | print (`devin -p`) | PASS (15/17 hooks verified; plan approval manual hack; subagent dispatch not tested) |
| `second-run/` (removed) | 2026-08-31 | express (9 stages) | interactive (`devin`) | BLOCKED at code-generation plan approval — adapter bug found (`hasExplicitHumanSelection` doesn't handle Devin's object-format `tool_response`, breaking all `ask_user_question` answer recording); `ask_user_question` rendering verified (run-1 gap closed); 14/17 hooks verified |
| `third-run/` (removed) | 2026-09-01 | express (9 stages) | interactive (`devin`) | BLOCKED at code-generation plan approval — run-2 fix (`normalizeToolResponse`) was necessary but NOT sufficient: `hasExplicitHumanSelection` still rejects all Devin response shapes, so the PostToolUse `record-human-turn` arm has NEVER fired (all 7 HUMAN_TURNs from UserPromptSubmit, 0 from PostToolUse); 4 bugs found (A: arm never fires, B: guard blocks hooks, C: downstream refusal, D: directive corruption on re-run); 15/17 hooks verified (`log-subagent` newly PASS); `PLAN_APPROVAL_RECORDED: 0`, `PLAN_APPROVAL_BLOCKED: 23` |
| `fourth-run/` (removed) | — | express (9 stages) | interactive (`devin`) | Retained session exports, including native question schema/response observations used during later fixes; not a blanket all-topology PASS or independent hook-stdin capture. |

## Current run

| Run | Scope | Mode | Status |
|-----|-------|------|--------|
| `session-isolation-run/` (2026-09-17, Devin CLI 3000.10.31, `bce80f29` + uncommitted Item 1 fix) | express (minimal `hello.py` prompt) | interactive, two concurrent sessions + `/clear` session change | Item 1 ACCEPTED: S1 receipt, S2, S3, S4 PASS; S5 receipt persistence PASS, no-re-prompt inconclusive. Workflow BLOCKED at developer dispatch by review Item 2 / DEVIN-07 (native `task` field not forwarded) — `PLAN_APPROVAL_RECORDED: 2`, `PLAN_APPROVAL_BLOCKED: 10` (3 correct pre-approval, 7 Item 2). See `SUMMARY.md`. |

## Why this record was tracked

Same rationale as `evidence/p3-kiro-routing/`: tamper-evident receipts for live
harness runs that cannot be reproduced in CI. Hashes in the original
subdirectories let a reviewer confirm the captured artifacts are exactly what the
run produced. The removed subdirectories are recoverable from Git history for
forensic inspection.
