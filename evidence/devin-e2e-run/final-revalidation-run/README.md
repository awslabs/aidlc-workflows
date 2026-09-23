# final-revalidation-run — environment and manifest

Consolidated revalidation of PR #996 head `2b6ea4b6` after the
review-5248693673 fixes: `bun run check`, focused Plan Approval and Devin
suites, the full unit tier, the integration + e2e tier, baseline
reconciliation of every failure against the pristine PR base, and the three
gated live Devin e2e files on the installed binary. Read `SUMMARY.md` for
verdicts V0–V8 and findings.

## Environment

| Item | Value |
|------|-------|
| Date | 2026-09-22 22:39Z (preflight) → 2026-09-23 00:03Z (GitHub state) |
| Source checkout | `<home>/sources/aidlc-workflows` at `2b6ea4b6` (`feat/devin-harness`, 4 commits on PR base `3c54ec1a`), clean tree |
| Baseline worktree | `/tmp/aidlc-main-check` at `3c54ec1a` (pristine PR base, `dist/` regenerated with `bun scripts/package.ts` before use) |
| `upstream/main` | `d3c3b067` at preflight; `eaf8e991` at GitHub-state capture (see SUMMARY finding 1) |
| Devin CLI | `3000.11.1 (cc4e349ca55e)`; support floor `3000.10.21` |
| Runtime | bun `1.3.14`; Linux WSL2 `5.15.167.4-microsoft-standard-WSL2` x86_64 |
| Live gate | `AIDLC_DEVIN_EXEC_LIVE=1` only for captures 07–09; closed for 05 |
| Redaction | `<home>` → `<home>` in every file |

## Commands (run from the source checkout, in this order)

```bash
bun run check                                                         # 01
bun tests/run-tests.ts --unit --integration --filter 't265|t328-plan-approval|t334-change-control|t340'   # 02
bun tests/run-tests.ts --unit --integration --filter 't331-devin|t332-devin|t334-devin|t345-doctor-devin|t226|t241|t68'  # 03
bun tests/run-tests.ts --unit                                         # 04
bun tests/run-tests.ts --integration --e2e --parallel 4               # 05
# 06: bun test <failing file> in /tmp/aidlc-main-check @3c54ec1a
AIDLC_DEVIN_EXEC_LIVE=1 bun tests/run-tests.ts --e2e --filter '^t-exec-devin-status\.serial\.test\.ts$' --debug          # 07
AIDLC_DEVIN_EXEC_LIVE=1 bun tests/run-tests.ts --e2e --filter '^t-exec-devin-mcp-headers\.serial\.test\.ts$' --debug     # 08
AIDLC_DEVIN_EXEC_LIVE=1 bun tests/run-tests.ts --e2e --filter '^t-exec-devin-config-imports\.serial\.test\.ts$' --debug  # 09
```

## Artifacts

| File | What it is |
|------|------------|
| `SUMMARY.md` | Verdicts V0–V8, findings, deviations |
| `00-environment.txt` | HEAD, tree status, main SHA, tool versions, PR state at start |
| `01-check.txt` | `bun run check` — determinism ×8 harnesses, `tsc` ×3, Biome |
| `02-focused-plan-approval.txt` | t265 / t328 / t334-change-control / t340 ×3 — 201 assertions, 0 failed |
| `03-focused-devin.txt` | t331 / t332 / t334-devin / t345-doctor-devin / t226 / t241 / t68 — 212 assertions, 0 failed |
| `04-unit-tier.txt` | Full unit tier — 345 files, 3 failed (pre-existing) |
| `05-integration-e2e-tier.txt` | Integration + e2e tier, live gates closed — 214 files, 1 failed (pre-existing); Devin live files `SKIP` |
| `06-baseline-reconciliation.txt` | Each failing file re-run on `3c54ec1a`; side-by-side table |
| `07-live-devin-status.txt` | Gated live `t-exec-devin-status` — 1/1 PASS, real `devin -p` |
| `08-live-devin-mcp-headers.txt` | Gated live `t-exec-devin-mcp-headers` — 1/1 PASS |
| `09-live-devin-config-imports.txt` | Gated live `t-exec-devin-config-imports` — 2/2 PASS |
| `10-github-state.txt` | PR head/base/mergeable, latest review, reply comment, workflow runs |
| `live-traces/<test>/` | `--debug` harness logs for each live run (`summary.txt`, `failures.txt`, `<test>.serial.log`) |
| `MANIFEST.sha256` | SHA-256 of every other file in this directory |
