# Test Case: all-stages

## Purpose

Force the adaptive AI-DLC workflow to execute **every conditional stage** rather
than skipping any.  The sci-calc test case is deliberately simple (single unit,
no user stories, no NFR design, no infrastructure design).  This test case is
designed so the AI model cannot reasonably skip anything.

## Stages Triggered

| Stage | Trigger Mechanism |
|---|---|
| Workspace Detection | Always executes |
| Reverse Engineering | **Not triggered** -- requires brownfield (see note below) |
| Requirements Analysis | Always executes |
| User Stories | 3 distinct user personas with different workflows |
| Workflow Planning | Always executes |
| Application Design | New components, services, and business rules |
| Units Generation | 2 modules requiring decomposition |
| Functional Design (per unit) | Complex business rules (lending limits, fees, holds) |
| NFR Requirements (per unit) | Explicit performance SLAs, security, scalability |
| NFR Design (per unit) | Resilience, caching, rate limiting patterns required |
| Infrastructure Design (per unit) | AWS services specified (Lambda, DynamoDB, Cognito, SQS) |
| Code Generation (per unit) | Always executes |
| Build and Test | Always executes |

## Files

| File | Description |
|---|---|
| `vision.md` | Project vision -- BookShelf community library API |
| `tech-env.md` | Technical environment -- Python/FastAPI, AWS serverless |
| `openapi.yaml` | API contract with `x-test-cases` for contract testing |
| `golden-aidlc-docs/` | Golden reference docs (created after first successful run) |
| `golden.yaml` | Baseline metrics from golden run (created after promotion) |

---

## Running with run_evaluation.py

`run_evaluation.py` orchestrates the full six-stage evaluation pipeline.  Since
the defaults all point to `test_cases/sci-calc/`, you must override the input
paths for this test case.

### First run (no golden baseline yet)

On the very first run there is no `golden-aidlc-docs/` to compare against.
Run execution only, skip the qualitative comparison, and inspect the output
manually:

```bash
# Pick a model config from config/ (e.g., opus.yaml, sonnet-4-5.yaml)
python run_evaluation.py \
  --config  config/opus.yaml \
  --vision  test_cases/all-stages/vision.md \
  --tech-env test_cases/all-stages/tech-env.md \
  --openapi test_cases/all-stages/openapi.yaml \
  --golden  test_cases/all-stages/golden-aidlc-docs
```

The `--golden` path won't exist yet, so the qualitative stage will fail.  That
is expected.  The run itself will still produce:

```
runs/<timestamp>/
  aidlc-docs/          # Generated AIDLC documentation
  workspace/           # Generated application code
  test-results.yaml    # Post-run unit test results
  run-meta.yaml        # Execution metadata
```

### Promoting a run to golden

After inspecting a successful run and confirming the outputs look correct:

```bash
# Copy the aidlc-docs from the run into the test case as the golden reference
cp -r runs/<timestamp>/aidlc-docs test_cases/all-stages/golden-aidlc-docs
```

To create a `golden.yaml` baseline for regression comparison, capture the key
metrics from the run (see `test_cases/sci-calc/golden.yaml` for the format).

### Subsequent runs (with golden baseline)

Once `golden-aidlc-docs/` exists, the full pipeline works end-to-end:

```bash
python run_evaluation.py \
  --config   config/opus.yaml \
  --vision   test_cases/all-stages/vision.md \
  --tech-env test_cases/all-stages/tech-env.md \
  --openapi  test_cases/all-stages/openapi.yaml \
  --golden   test_cases/all-stages/golden-aidlc-docs
```

The `--baseline` flag is auto-discovered from `golden.yaml` in the same
directory as `--golden`, so if `test_cases/all-stages/golden.yaml` exists it
will be used automatically for regression comparison.

### Evaluate an existing run (skip execution)

To re-score a previous run without re-executing the AIDLC workflow:

```bash
python run_evaluation.py \
  --evaluate-only runs/<timestamp>/aidlc-docs \
  --golden  test_cases/all-stages/golden-aidlc-docs \
  --openapi test_cases/all-stages/openapi.yaml
```

### Key CLI flags reference

| Flag | Purpose | Default |
|---|---|---|
| `--config` | Model config YAML (AWS creds, executor model, swarm settings) | `config/default.yaml` |
| `--vision` | Vision document | `test_cases/sci-calc/vision.md` |
| `--tech-env` | Technical environment document | `test_cases/sci-calc/tech-env.md` |
| `--openapi` | API contract spec with `x-test-cases` | `test_cases/sci-calc/openapi.yaml` |
| `--golden` | Golden reference aidlc-docs for qualitative scoring | `test_cases/sci-calc/golden-aidlc-docs` |
| `--baseline` | `golden.yaml` for regression comparison | Auto-discovered from `--golden` parent |
| `--executor-model` | Override the executor model ID from config | From config YAML |
| `--scorer-model` | Bedrock model for qualitative scoring | From config YAML |
| `--rules-ref` | Git ref for AIDLC rules (branch/tag/commit) | From config YAML |
| `--output-dir` | Override run output directory | `runs/<timestamp>` |
| `--report-format` | `markdown`, `html`, or `both` | `both` |

---

## Running with run_batch_evaluation.py

The batch runner evaluates multiple models against the same test case.  It
calls `run_evaluation.py` once per model, collecting results into per-model
subdirectories under `runs/`.

```bash
# All models defined in config/*.yaml
python run_batch_evaluation.py \
  --vision   test_cases/all-stages/vision.md \
  --tech-env test_cases/all-stages/tech-env.md \
  --openapi  test_cases/all-stages/openapi.yaml \
  --golden   test_cases/all-stages/golden-aidlc-docs \
  --models all

# Specific models only
python run_batch_evaluation.py \
  --vision   test_cases/all-stages/vision.md \
  --tech-env test_cases/all-stages/tech-env.md \
  --openapi  test_cases/all-stages/openapi.yaml \
  --golden   test_cases/all-stages/golden-aidlc-docs \
  --models opus sonnet-4-5

# List available model configs
python run_batch_evaluation.py --list
```

---

## Evaluation Pipeline Stages

For reference, here is what each stage does for this test case:

| # | Stage | What It Does |
|---|---|---|
| 1 | **Execution** | Runs the two-agent AIDLC workflow (executor + simulator) to produce `aidlc-docs/` and `workspace/` code |
| 2 | **Post-Run Tests** | Installs deps in `workspace/` and runs `uv run pytest` (built into execution stage) |
| 3 | **Quantitative** | Lints generated code with ruff, runs security scans (bandit) |
| 4 | **Contract Tests** | Starts the FastAPI app from `workspace/`, sends requests from `openapi.yaml` `x-test-cases`, validates responses |
| 5 | **Qualitative** | Compares generated `aidlc-docs/` against `golden-aidlc-docs/` using Bedrock for semantic similarity scoring |
| 6 | **Report** | Generates consolidated Markdown + HTML report with all metrics |

---

## Note on Reverse Engineering

The Reverse Engineering stage only fires for brownfield projects (existing code
detected).  The current runner hardcodes `"this is a greenfield project"` in the
initial prompt (`packages/execution/src/aidlc_runner/runner.py` line 224).  To
test Reverse Engineering:

1. Place existing code in an `existing-code/` directory within this test case
2. Modify `runner.py` to copy `existing-code/*` into `workspace/` before execution
3. Remove the greenfield assumption from the initial prompt

This is the only AIDLC stage this test case does not cover.

---

## Design Rationale

The domain (library book lending) is simple enough that anyone can understand
the business rules, but includes enough structural complexity to force all
conditional stages:

- **Multiple user personas** (Librarian, Member, Admin) with distinct workflows
  force User Stories
- **Two logical modules** (Catalog, Lending) force Application Design and Units
  Generation
- **Business rules** (checkout limits, late fees, hold queues, renewals) force
  Functional Design
- **Explicit performance targets, security requirements, and scalability
  constraints** force NFR Requirements and NFR Design
- **AWS cloud deployment requirements** force Infrastructure Design
