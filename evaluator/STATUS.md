# Evaluator Status — Release Readiness

> As of 2026-08-13. Evidence-based inventory of every entry point: what has
> been proven by real executions, what carries caveats, and what is untested
> or broken. Intended for integrating this evaluator into the AIDLC v2 repo.

## TL;DR

**Release-grade:** the CLI evaluation surface — `scripts/run_v2_suite.sh`,
`scripts/run_cli_evaluation.py` (claude-cli, codex-cli, kiro-cli), the
version-batch/report scripts, and the scoring pipeline. Backed by ~12 real
Bedrock-billed runs across all three standard tasks (see `results/`).

**Not release-grade:** the IDE harness (modernized but zero end-to-end runs),
the legacy Strands execution path (`run.py full` / `batch`), and `run.py
trend` (dispatches to a script that no longer exists).

## Proven — real end-to-end executions

| Surface | Evidence |
|---|---|
| `scripts/run_v2_suite.sh` | 2 complete suite executions (2026-08-07): greenfield + bugfix + feature + combined report, detached across SSH loss. Markers `V2_SUITE_DONE`, log `runs/v2-suite.log`. |
| `run_cli_evaluation.py --cli claude-cli` | ~9 real runs. Greenfield 88/88 contract ×3 (fidelity 0.762/0.769/0.793, 88/112/91 min, $51–58); bugfix 3/3; feature 3/3. PTY modal handling (incl. the 2.1.2xx model-upgrade modal), gate driving, brownfield seeding all exercised. |
| `run_cli_evaluation.py --cli codex-cli` | Full sweep (2026-08-12, `openai.gpt-5.6-sol` high effort via Bedrock): greenfield 88/88 (50 min, fidelity 0.572), bugfix 3/3, feature 3/3. |
| `run_cli_evaluation.py --cli kiro-cli` | bugfix 3/3 (14 min), feature 3/3 (33 min), greenfield ran clean end-to-end scoring 85/88 (a product result — Infinity/NaN serialization — not a harness fault). kiro-cli 2.17.0, IAM Identity Center auth. |
| Scoring pipeline (stages 2–6) | Exercised by every run above: post-run pytest, ruff/bandit/semgrep, Docker-sandbox contract runs (FastAPI/Flask/Django + Hurl), LLM qualitative judge, per-run Markdown/HTML reports. |
| `run_version_batch.py` | Drove both baseline suites (claude-cli). Task-labeled batch dirs (`<ts>-<task>-version-batch`) verified. |
| `run_combined_report.py` | Generated both real suite reports; also fixture-tested. |
| Local OTLP token capture (`_otel_local.py`) | 8 unit tests + live end-to-end verification; real cost data captured in 4 claude runs (e.g. greenfield $51.76 / 60M cache-read tokens). No collector/CloudWatch/AWS permissions needed. |
| `run.py test` | Full unit suite green (cli-harness 72/72, ide-harness 4/4, all packages passing as of last full run). |
| `run.py cli/ide/batch --list`, `--check-only` | Verified; adapter prerequisite probes work. |

Published results: `results/V2-EVALUATION-20260807.md` (claude baseline) and
`results/CLI-COMPARISON-20260812.md` (three-way CLI comparison).

## Works, with documented caveats

- **`run_version_batch.py` is claude-cli-only** (`--cli claude-cli` is
  hardcoded). Cross-CLI runs go through `run_cli_evaluation.py` directly.
- **Token/cost capture is claude-only.** The local OTLP receiver reads Claude
  Code telemetry; codex/kiro runs report turn counts, not tokens/cost.
- **Dist auto-detect assumes the evaluator sits inside the AIDLC repo**
  (`REPO_ROOT.parent/dist/...`). On a standalone checkout pass
  `--claude-dist` / `--kiro-dist` / `--codex-dist` explicitly, or set
  `claude_dist` in `config/versions.yaml` (marked `EDIT`). Integrating the
  evaluator into the AIDLC v2 repo makes auto-detect work naturally.
- `run_version_report.py` and `run_comparison_report.py` (`compare`):
  fixture-tested (synthetic run folders), not yet exercised on real
  multi-version data in this packaging.
- Environment gotchas are recorded in code comments and README: kiro-cli ≥2.x
  rejects leading-`/` prompts (adapter phrases invocation as natural
  language); kiro-cli needs IAM Identity Center login; codex holds many
  stages in one long turn (20+ min silent turns are normal).

## Broken / untested — do not include in release claims

| Item | State | Cheapest fix |
|---|---|---|
| `run.py trend` | **Broken** — dispatches to `scripts/run_trend_report.py`, which was removed in the v2-only trim. The underlying package works (`python -m trend_reports`). | Delete the mode from `run.py`, or add a thin wrapper script. |
| `run.py full` / `run.py batch` (Strands swarm path, `packages/execution`) | **Untested** in this packaging — legacy from the parent framework; only arg validation exercised. The README does not advertise it. | Mark experimental or remove from the packaged entry points. |
| IDE harness (`run.py ide`, `packages/ide-harness`) | **Untested end-to-end.** `kiro` adapter was modernized (delegates to the proven CLI kiro adapter; loads + prereq checks pass) but has had zero real runs; `run_ide_evaluation.py` itself unproven. | Run one kiro IDE smoke (bugfix task, ~$15/25 min) before claiming it. |
| IDE adapters: cursor, cline, copilot, windsurf, antigravity | **Stale contracts** (pre-2.x invocation + old completion detection — same class of bug the old kiro adapter had). Archival requested, not yet done. | Move to an archive dir and trim the registry (~30 min). |
| IDE adapters for claude / codex (VS Code extensions) | **Do not exist yet.** Both products ship official VS Code extensions (Claude Code; OpenAI's Codex extension), so the surface exists — drivability unverified. | Future work; design decision needed (headless CLI transport vs UI automation). |
| `build_golden_reference.py`, `regenerate_single_report.py` | Utility scripts, untested in this packaging. | Exercise or mark as-is. |
| `ARCHITECTURE.md`, `scripts/README.md` | **Stale**: reference removed modes (ext-test/ext-report), nonexistent stability scripts, and the parent framework's three-path architecture. | Doc pass (~30 min). |

## Known product findings from the runs (not harness issues)

- kiro-cli greenfield: 85/88 — three `/constants` endpoints return 500 on the
  Infinity/NaN JSON-serialization edge case. (An earlier attempt failed to
  boot entirely — `-> dict | JSONResponse` route annotation; data removed.)
- claude is 3-for-3 at 88/88 with the highest doc fidelity; its ~90-min wall
  clock (vs ~50 for codex/kiro) is structural — intake Q&A + test-hardening
  loop — and correlates with the quality edge.

## Recommended pre-release actions (≈1 hour)

1. Remove the `trend` mode from `run.py` (or restore its wrapper script).
2. Archive the five dead IDE adapters; registry keeps `kiro` only until
   claude/codex IDE adapters exist.
3. Align `ARCHITECTURE.md` / `scripts/README.md` with the shipped surface.
4. Optional (+$15, 25 min): one kiro IDE smoke run to move the IDE harness
   from "untested" to "smoke-tested".
