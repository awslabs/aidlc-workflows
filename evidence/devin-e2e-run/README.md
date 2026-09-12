# Devin CLI Harness — E2E Run Campaign

Live end-to-end run evidence for the Devin CLI harness, captured by executing
the per-run plan against the shipped `dist/devin` tree on a real `devin` CLI
session. Run 1 drove `devin -p` (print mode) and proved the deterministic
plumbing; run 2 drove `devin` interactively and found the adapter bug; run 3
verified the run-2 fix was necessary but not sufficient and found 4 new bugs.

## Campaign

Three runs completed. Each lives in its own subdirectory with a per-run
`README.md` describing the environment and SHA-256 hashes of every artifact,
mirroring the convention established by `evidence/p3-kiro-routing/`.

| Run | Date | Scope | Mode | Status |
|-----|------|-------|------|--------|
| `first-run/`  | 2026-08-31 | express (9 stages) | print (`devin -p`) | PASS (15/17 hooks verified; plan approval manual hack; subagent dispatch not tested) |
| `second-run/` | 2026-08-31 | express (9 stages) | interactive (`devin`) | BLOCKED at code-generation plan approval — adapter bug found (`hasExplicitHumanSelection` doesn't handle Devin's object-format `tool_response`, breaking all `ask_user_question` answer recording); `ask_user_question` rendering verified (run-1 gap closed); 14/17 hooks verified |
| `third-run/`  | 2026-09-01 | express (9 stages) | interactive (`devin`) | BLOCKED at code-generation plan approval — run-2 fix (`normalizeToolResponse`) was necessary but NOT sufficient: `hasExplicitHumanSelection` still rejects all Devin response shapes, so the PostToolUse `record-human-turn` arm has NEVER fired (all 7 HUMAN_TURNs from UserPromptSubmit, 0 from PostToolUse); 4 bugs found (A: arm never fires, B: guard blocks hooks, C: downstream refusal, D: directive corruption on re-run); 15/17 hooks verified (`log-subagent` newly PASS); `PLAN_APPROVAL_RECORDED: 0`, `PLAN_APPROVAL_BLOCKED: 23` |

## Per-run layout

Each `<run>/` directory contains the raw captured artifacts (doctor output,
workflow output, audit trail, outcomes pack, hook coverage, runtime graph,
generated stage artifacts) plus a `SUMMARY.md` narrating the run phase by
phase and a `README.md` with environment + SHA-256 manifest.

## Why tracked

Same rationale as `evidence/p3-kiro-routing/`: tamper-evident receipts
for live harness runs that cannot be reproduced in CI. Hashes let a reviewer
confirm the captured artifacts are exactly what the run produced.
