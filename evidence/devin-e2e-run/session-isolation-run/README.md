# session-isolation-run — environment and manifest

Attended live acceptance of the PR #996 review Item 1 fix (Plan Approval session isolation).
Read `SUMMARY.md` for verdicts; `devin-e2e-test-plan.md` is the plan that was executed.

## Environment

| Item | Value |
|------|-------|
| Date | 2026-09-17, 16:49–18:35 (UTC-3) |
| Source checkout | `/home/wiley/sources/aidlc-workflows` at `bce80f291789a35d5045ebb898ed83f9d14cc525` (`feat/devin-harness`) plus the **uncommitted** Item 1 fix in `core/tools/aidlc-testing-posture.ts` and its tests/docs |
| Build | `bun scripts/package.ts` then `bun scripts/package.ts --check` → deterministic across two independent builds for all 8 harnesses |
| Fix present in shipped tree | `grep -c readCurrentSessionId dist/devin/.devin/tools/aidlc-testing-posture.ts` → 0; refusal string `from this prompt and session` present |
| Project | `~/devin-e2e-session-isolation`, fresh `git init`, single commit `73fe8fe install aidlc devin tree (bce80f29 + Item 1 fix)`; copied `.devin/`, `aidlc/`, `AGENTS.md`, `.gitignore` from `dist/devin/` |
| Installed tree hashes | `.devin/tools/aidlc-testing-posture.ts` `f7d153db7669b808c176dfa3042a53a20153634b23207e16356d1ed756e7dddd`; `.devin/hooks/aidlc-devin-adapter.ts` `cd807872e639a448df0e10c864d37608e2ccf499403d6ca348209399b994ccc9` |
| Devin CLI | `3000.10.31 (b98cc431)`; support floor `3000.10.21` |
| Model | user-level `swe-2-medium` (parent); subagent model policy warning only, no dispatch succeeded |
| Runtime | bun at `~/.bun/bin/bun` (doctor warns it is interactive-only on PATH; hooks nevertheless fired) |
| Hooks | project `.devin/hooks.v1.json`, approved on first start; SessionStart marker written 19:49:59Z |
| MCP | all five disabled |
| Sessions | A `purple-wool`, B `awake-radon`, C `lively-voyage` (earlier restarts: `carpal-sphynx`, `jasper-psychology`) |
| Redaction | `/home/wiley` → `<home>` in doctor outputs and the session export; audit shard uses the engine's `<project-dir>` |

## Artifacts

| File | What it is |
|------|------------|
| `devin-e2e-test-plan.md` | The plan executed (Phase 0–5, S1–S5) |
| `SUMMARY.md` | Verdicts, counters, findings, deviations |
| `00-doctor-before.txt` | Doctor on the fresh project before any session (expected SessionStart-evidence fail) |
| `01-session-a-id.txt` | `purple-wool` |
| `02-pending-challenge.txt`, `02-challenge-a.json` | `plan-approval/` listing and A's challenge while the prompt was pending (S4) |
| `03-session-b-id.txt` | `awake-radon` |
| `04-after-b-typed.txt` | State after `Approve Plan` typed in B (S2) |
| `05-answer-with-b.txt`, `05-after-b-answer.txt` | Forced `answer --session awake-radon` refusal and unchanged state (S3) |
| `06-after-approval.txt`, `06-receipt.json`, `06-receipt-sha.txt` | State after the genuine click in A; receipt as first certified (S1) |
| `06-dispatch-rejection.txt` | Guard text relayed for the post-approval `run_subagent` blocks (Item 2) |
| `07-session-c-id.txt`, `07-after-clear.txt`, `07-challenge-c.json` | State after `/clear` and resume in C (S5) |
| `08-receipt-final.json`, `08-receipt-final-sha.txt` | Receipt after re-certification in C (`status: generation`) |
| `08-sessions-final.txt` | Final `aidlc/.aidlc-sessions/` listing and pid records |
| `08-doctor-after.txt` | Doctor after the run (exit 0, 57 passed) |
| `09-run-subagent-task-field.txt` | Native `run_subagent` field set extracted from the session export (Item 2 root cause) |
| `aidlc-state.md`, `audit-shard.md` | Workflow state and the full audit shard (`galaxybook-9af31f6db466.md`) |
| `devin-session-c.json` | ATIF export of session C (`lively-voyage`); sessions A and B were not exported |

## SHA-256 manifest

See `MANIFEST.sha256` (generated with `sha256sum` over every file in this directory except the
manifest itself). Verify with `sha256sum -c MANIFEST.sha256` from this directory.
