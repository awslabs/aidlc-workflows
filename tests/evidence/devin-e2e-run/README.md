# Devin CLI Harness — E2E Run Campaign

Live end-to-end run evidence for the Devin CLI harness, captured by executing
the per-run plan against the shipped `dist/devin` tree on a real `devin` CLI
session. Run 1 drove `devin -p` (print mode) and proved the deterministic
plumbing; run 2 drives `devin` interactively to exercise the
human-in-the-loop surfaces print mode cannot reach (`ask_user_question`
rendering, genuine plan approval, subagent dispatch).

## Campaign

Three runs are planned. Each lives in its own subdirectory with a per-run
`README.md` describing the environment and SHA-256 hashes of every artifact,
mirroring the convention established by `tests/evidence/p3-kiro-routing/`.

| Run | Date | Scope | Mode | Status |
|-----|------|-------|------|--------|
| `first-run/`  | 2026-08-31 | express (9 stages) | print (`devin -p`) | PASS (15/17 hooks verified; plan approval manual hack; subagent dispatch not tested) |
| `second-run/` | planned   | express (9 stages) | interactive (`devin`) | plan written — targets the 4 run-1 gaps (ask_user_question rendering, genuine plan approval, record-human-turn on ask_user_question, subagent dispatch) |
| `third-run/`  | planned   | —                  | —    | pending |

## Per-run layout

Each `<run>/` directory contains the raw captured artifacts (doctor output,
workflow output, audit trail, outcomes pack, hook coverage, runtime graph,
generated stage artifacts) plus a `SUMMARY.md` narrating the run phase by
phase and a `README.md` with environment + SHA-256 manifest.

## Why tracked

Same rationale as `tests/evidence/p3-kiro-routing/`: tamper-evident receipts
for live harness runs that cannot be reproduced in CI. Hashes let a reviewer
confirm the captured artifacts are exactly what the run produced.
