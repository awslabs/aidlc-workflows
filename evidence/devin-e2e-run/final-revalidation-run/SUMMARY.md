# final-revalidation-run — verdicts

Consolidated revalidation of the PR #996 head `2b6ea4b6` (`feat/devin-harness`,
4 commits on PR base `3c54ec1a`) after the review-5248693673 fixes
(`830c29c4` `.devin` classifier, `18c68c1f` release-metadata revert,
`2b6ea4b6` background `run_subagent` drop path). Deterministic tiers plus
the three explicitly gated live Devin e2e files on the installed
`devin 3000.11.1`. Environment and artifact index: `README.md`.

## Verdicts

| # | Check | Verdict | Evidence |
|---|-------|---------|----------|
| V0 | Preflight | **PASS** — clean tree at `2b6ea4b6` (only the untracked scratch tracker and this evidence dir), `devin 3000.11.1` ≥ floor `3000.10.21`, bun `1.3.14`, `upstream/main` = `d3c3b067` at start | `00-environment.txt` |
| V1 | `bun run check` | **PASS** — `package --check` deterministic across two independent builds for all 8 harnesses; `tsc --noEmit` clean on `tsconfig.json` / `tsconfig.tests.json` / `tsconfig.adapters.json`; Biome 882 files, 24 infos, 0 errors/warnings; exit 0 | `01-check.txt` |
| V2 | Plan Approval family | **PASS** — 6 files (t265, t328, t334-change-control, t340 ×3), 201 assertions, 0 failed, 1 skipped case | `02-focused-plan-approval.txt` |
| V3 | Devin + neighbour suites | **PASS** — 7 files (t331, t332, t334-devin, t345-doctor-devin, t226, t241, t68), 212 assertions, 0 failed, 0 skipped | `03-focused-devin.txt` |
| V4 | Full unit tier | **PASS (pre-existing only)** — 345 files, 8779 assertions, 8733 executed, 46 skipped; 3 failed files / 5 failed assertions: `t240-opencode-packaging` (1), `t332-preview-release-pipeline` (3), `t83-doctor-orphan-worktree` (1) — all reconciled in V6 | `04-unit-tier.txt` |
| V5 | Integration + e2e tier (live gates closed) | **PASS (pre-existing only)** — 214 files, 2264 assertions, 2209 executed, 55 skipped cases / 84 skipped files; 1 failed file: `t78-bolt-worktree-lifecycle` (1 assertion). The three `t-exec-devin-*` files reported `SKIP` with the documented gate reason — a skip is not a pass; they were run in V7 | `05-integration-e2e-tier.txt` |
| V6 | Baseline reconciliation | **PASS** — every failing file from V4/V5 re-run with `bun test` on the pristine PR base `3c54ec1a` fails on the identical case(s) with identical counts (t240 9/1, t332-preview 21/3, t83 29/1, t78 65/1). Zero failures attributable to `2b6ea4b6` | `06-baseline-reconciliation.txt` |
| V7 | Gated live Devin suite | **PASS** — all three files executed (not skipped) with `AIDLC_DEVIN_EXEC_LIVE=1` on `devin 3000.11.1`: `t-exec-devin-status` 1/1 (real `devin -p` inference, 36.5 s: no-workflow `/aidlc --status` renders "no active" and scaffolds nothing); `t-exec-devin-mcp-headers` 1/1 (7.6 s: `${env:VAR}` header arrives resolved, unset → empty string); `t-exec-devin-config-imports` 2/2 (shipped `config.json` imports nothing and `/aidlc` stays unprefixed; vendor-default positive control imports Copilot skills + OpenCode/Zed MCP) | `07-live-devin-status.txt`, `08-live-devin-mcp-headers.txt`, `09-live-devin-config-imports.txt`, `live-traces/` |
| V8 | GitHub state | **FAIL (external, new since V0)** — head `2b6ea4b6`, 4 commits, PR open/not merged, reply comment `5784752683` present, `Pull Request Validation` success (other workflows `action_required` = fork approval gate). But `upstream/main` advanced twice during this run (`d3c3b067` → `61b2a0ac` #982 → `eaf8e991` #1361) and GitHub now reports `mergeable: false`, `mergeable_state: dirty`. See finding 1 | `10-github-state.txt` |

## Findings

1. **The branch became non-mergeable during the run, not because of it.** At
   V0 (22:39Z) GitHub reported `mergeable: true` against main `d3c3b067`;
   at V8 (00:03Z) main was `eaf8e991` and the PR was `dirty`. `git
   merge-tree` against the new main shows five files changed on both sides
   (`core/tools/aidlc-lib.ts`, `tests/unit/t226-detector-corpus.test.ts`,
   `tests/integration/t121-stop-hook-enforce.test.ts`,
   `tests/.coverage-registry.json`, `tests/.coverage-ratchet.json`) with
   textual conflict markers only in the two generated coverage JSON files.
   `#982` touched the same runtime-command classifier region of
   `aidlc-lib.ts` / t226 that `830c29c4` extended with `.devin`, so the
   resolution is a merge (or rebase) plus `bun tests/gen-coverage-registry.ts`
   regeneration — not a semantic conflict. This is outside Item 6's scope and
   is reported for the owner's decision.
2. **No regression on the assembled head.** All four failing files reproduce
   with the identical failing case on the pristine base; they are host /
   environment failures (opencode `debug agent` absent, preview-release
   evidence fixtures, same-slug same-stamp worktree, symlink abort hints).
3. **Gate behaviour is honest.** With the gate closed (V5) the three live
   files skip with the reason in the test name; with the gate open (V7) they
   run and pass. No live test was counted from a skip.

## Deviations from the plan

- Step 5 was executed twice: the first run was killed at `t90` when the
  driving session terminated; the partial capture was deleted and the tier
  re-run from scratch (the retained `05-integration-e2e-tier.txt` is the
  complete second run).
- Baseline reproductions for the three unit files were run while the second
  step-5 run was in flight (they execute in the separate `/tmp` baseline
  worktree and do not touch this checkout); t78 was reproduced after step 5
  finished.
- Live traces: the `--debug` run produced only `summary.txt`, `failures.txt`
  and the per-test `.log` (no `{sdk,tui,kiro-acp}-drive-*.ndjson` — those
  drivers are not used by the Devin exec tests); all three were copied.
