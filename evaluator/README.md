# AIDLC v2 Evaluation Suite

Standalone evaluation harness for **AIDLC v2** — packaged with the 2.0 release
so anyone can reproduce the framework's benchmark numbers. It drives the real
`claude` CLI through v2's `/aidlc` workflow on three standard tasks and scores
the results against executable oracles.

## The three standard tasks

| Task | Kind | What v2 must do | Oracle |
|---|---|---|---|
| **Greenfield** (`test_cases/sci-calc-v2/`) | Graded | Build a scientific-calculator API from scratch | 88-case OpenAPI contract (live HTTP) + 0-1 semantic-similarity score vs the v2 golden doc set |
| **Brownfield bugfix** (`test_cases/brownfield/httpbin/`) | Deterministic | Fix `/base64` error handling in a real Flask codebase (`psf/httpbin`) | 3 explicit HTTP assertions: valid input → 200, malformed → 400 |
| **Brownfield feature** (`test_cases/brownfield/realworld/`) | Deterministic | Implement follow/unfollow in a real Django codebase (`realworld-django-ninja`, routes removed as the seed delta) | The RealWorld project's own Hurl contract suite |

The two families are measured differently **by design**: greenfield gets graded
metrics (cost, wall clock, doc fidelity vs golden); brownfield is a
**deterministic pass/fail reliability measure** — a run passes only if every
contract case passes, no partial credit. The combined report keeps them in
separate sections so the axes never blend.

**Repeatability:** the brownfield testbeds are frozen snapshots pinned to
upstream commits (`scenario.yaml: upstream_commit`, cross-checked against
`UPSTREAM_COMMIT` at preflight — a mismatch aborts the run):
httpbin `f7b02ae`, realworld-django-ninja `04ef47c`.

## Prerequisites

1. **Claude Code CLI** (`claude`) on PATH, authenticated (Bedrock or Anthropic
   API). **bun** on PATH (v2's tools run via bun).
2. **uv** (Python 3.13 workspace manager): `curl -LsSf https://astral.sh/uv/install.sh | sh`
3. **Docker** + the sandbox image (generated servers boot in isolation):
   ```bash
   bash docker/sandbox/build.sh
   ```
4. **hurl ≥ 8.0** on PATH (the RealWorld feature oracle).
5. **The v2 distribution**: point `claude_dist` in `config/versions.yaml` at
   your v2 release's `.claude` directory (marked `EDIT`).

Then: `uv sync`

## Run the full suite

```bash
# All three tasks (greenfield n=5 + bugfix n=5 + feature n=5), then the report.
# Detached — survives SSH loss; watch runs/v2-suite.log:
setsid nohup bash scripts/run_v2_suite.sh >/dev/null 2>&1 < /dev/null &

# Foreground, fewer runs:
RUNS=3 bash scripts/run_v2_suite.sh
```

Completion markers: `runs/V2_SUITE_DONE` (or `_ABORTED`). The final report
lands at `runs/V2-EVALUATION-<date>.md` with an executive summary, a verdict
table, greenfield statistics (mean ± SD, 95% CI), deterministic brownfield
pass rates, and collapsible per-run drill-downs with failure detail.

Expect roughly **$45 per greenfield run** and **$12–21 per brownfield run**
(Bedrock, Opus-tier), ~1.5–5 h per greenfield run and ~25–50 min per
brownfield run. n=5 across all three tasks ≈ **$400–500 total**.

## Run one task / one run

```bash
# One greenfield batch:
uv run python scripts/run_version_batch.py --versions v2 --runs 1 --no-report

# One brownfield task:
uv run python scripts/run_version_batch.py --versions v2 --runs 1 \
    --scenario brownfield/httpbin --no-report      # or brownfield/realworld

# Rebuild the combined report from existing batches:
uv run python scripts/run_combined_report.py \
    --greenfield runs/<gf-batch> \
    --brownfield-bug runs/<bug-batch> \
    --brownfield-feature runs/<feat-batch> \
    --out runs/V2-EVALUATION.md --generated "$(date -u +%F)"
```

`run_combined_report.py` accepts repeated `--brownfield-*` flags — a later
batch replaces that version's runs (useful for folding an individual re-run
into the report). Single-version reports render one column and skip the
cross-version significance tests; if you add more versions to
`config/versions.yaml`, the same report grows comparison columns, Mann-Whitney
U tests on the consumption axes, and Fisher's exact tests on pass rates.

## How scoring works

- **Contract (both families):** the generated/modified app boots in the Docker
  sandbox (framework auto-detected: FastAPI / Flask / Django, migrations and
  env handled), then the oracle runs against live HTTP. Brownfield pass/fail
  is read from `contract-test-results.yaml` — never from the workflow's own
  "done" claim.
- **Qualitative (greenfield only):** each produced AIDLC document is scored
  0-1 on intent/design/completeness against the v2 golden
  (`test_cases/sci-calc-v2/golden-aidlc-docs/`) by an LLM judge, with
  per-document rationales in each run's `report.md`.
- **Cost/tokens (built-in):** each run's tokens and cost are captured by a
  local in-process OTLP receiver — the harness points the `claude` CLI's OTEL
  exporter at `127.0.0.1` and sums `claude_code.token.usage` /
  `claude_code.cost.usage` itself. Fully self-contained: no collector,
  CloudWatch, or extra AWS permissions needed. `CAPTURE_TOKENS=1` switches to
  an external-collector path (OTEL → CloudWatch) for centralized telemetry
  setups; implausible readings from idled-out runs (query window swept
  concurrent sessions) are auto-excluded from cost statistics there.

## Layout

```
v2_evaluator/
├── run.py                  # CLI entry (version-batch, combined-report, …)
├── scripts/
│   ├── run_v2_suite.sh     # ← the one-command full suite
│   ├── run_version_batch.py
│   ├── run_combined_report.py
│   └── run_cli_evaluation.py / run_evaluation.py   # per-run pipeline
├── config/versions.yaml    # v2 dist path (EDIT), runs, timeouts
├── test_cases/
│   ├── sci-calc-v2/        # greenfield: vision, contract, golden docs
│   └── brownfield/         # httpbin + realworld seeds (commit-pinned)
├── packages/               # uv workspace (harness, contracttest, reporting…)
└── docker/sandbox/         # sandbox image for booting generated servers
```

## Provenance

Extracted from the AIDLC v1.5 evaluation framework (three-version comparative
harness) and trimmed to a v2-only packaging: v1/v1.5 goldens, transports, and
comparison thesis material removed; task definitions, oracles, PTY driving,
sandbox boot, and reporting are identical to the versions used to produce the
published three-way comparison numbers.
