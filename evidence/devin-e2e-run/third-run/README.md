# Run 3 — Environment & Artifact Manifest

## Environment

| Item | Value |
|------|-------|
| Date | 2026-09-01 |
| OS | Linux 5.15.167.4-microsoft-standard-WSL2 x86_64 |
| Devin CLI | 3000.6.7 (260a97c8) |
| bun | 1.3.14 |
| Model | glm-5-2 (user-level `~/.config/devin/config.json`) |
| Scope | express (9 stages, 6 approval gates) |
| Mode | interactive (`devin`) |
| Project dir | `~/devin-e2e-test-3` |
| Intent | `260901-todo-api` |
| Source repo commit | `fdaeb5213ed7ce37eecc433c2ab7be1aa44d9cd6` |
| dist/devin last touched | `d7ad958e` (test(devin): pin ensemble harness-binding parity + bump 2.6.125) |
| Install commit | `3588da8` (install aidlc devin shell (post-fix)) |
| Run duration | ~42 minutes (15:03:52 – 15:45:17 UTC) |
| Outcome | BLOCKED at code-generation plan approval — 4 bugs found (A, B, C, D); 15/17 hooks verified |

## Pre-flight checks

All Phase 0 pre-flight checks passed:
- `bun scripts/package.ts --check` clean
- `normalizeToolResponse` at line 131 of `dist/devin/.devin/hooks/aidlc-devin-adapter.ts`
- `### Devin` binding at line 180 of `stage-protocol-ensemble.md`
- `profile` field mechanic present
- Model-resolution note (SWE-1.6) present
- Must-dispatch instruction present in `SKILL.md`
- Doctor: 45 passed, 0 failed, exit 0

## SHA-256 manifest

Computed with `find . -type f ! -name README.md | sort | xargs sha256sum`:

```
9f3aa31f44ea5ba00f7d3db11c883b2709e494220d6aa631b150bc298a7f5c27  ./00-doctor-output.txt
24d8277f3275b62c7965f90eba0281c2d3f47f84ff9725427ac51610ebc4d207  ./05-active-directive.json
7507b156e02bcb1b1c923db23916b951b09e943e88e43c3f300bf7c2c24468a5  ./05-aidlc-state.md
a526c6859961a9af3b4174b515a6a189d98c726dda1a81fbcc7e460d3a9601c0  ./05-audit-shard.md
65374cea22b3b24f5d72c6dfb00b22f49b3c1ad3586bbfcb017720a8df2a0cc8  ./05-audit-trail-distribution.txt
1442833ce1b68e98ecde2a98ee727c4e23696f2b5802b406f3055b2b1780b414  ./05-session-cost.json
3cfed824b9bb30c22b876cdebaacfa4fc6e16d2944ca72b79fefa04dd7e90255  ./06-hook-coverage.txt
03c252a27d94cb5ed83f6769a50c26a1aeafde66278a65d32f6aee31bd7fe321  ./RUN-NOTES.md
fd18f37e0840d59e5e3f8d6b8bc39ba882164c3c42d450a36381b366e9b66b19  ./SUMMARY.md
b4b993c90d896c099f221bdcd0c99071af1fe6ab9d8749c8ce26f7a34e8565ac  ./devin-e2e-test-plan.md
```

## Artifact index

| File | Description |
|------|-------------|
| `devin-e2e-test-plan.md` | The per-run test plan (authored before the run) |
| `RUN-NOTES.md` | Full chronological log of operator-observed events with corrected root cause analysis |
| `SUMMARY.md` | Phase-by-phase narrative with run-2 deltas and bug analysis |
| `00-doctor-output.txt` | Phase 0 doctor output (45 passed, 0 failed) |
| `05-audit-shard.md` | Full audit trail from the intent's audit shard |
| `05-audit-trail-distribution.txt` | Event count distribution (final) |
| `05-session-cost.json` | Runtime summary (`aidlc-runtime.ts summary --json`) |
| `05-active-directive.json` | Final active directive state (`load-steering`, revision 5) |
| `05-aidlc-state.md` | Final workflow state (Completed: 4, In Progress: code-generation) |
| `06-hook-coverage.txt` | Hook coverage checklist (15/17) |

## Not captured

- `/aidlc-replay` output — requires a fresh interactive `devin` session; not run (workflow incomplete)
- `/aidlc-outcomes-pack` output — requires a fresh interactive `devin` session; not run (workflow incomplete)
- `OUTCOMES.md` — not generated (workflow incomplete)
- Background monitor log — not set up for this run
