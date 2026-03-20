# AI-DLC Workflows Evaluation & Reporting Framework

Automated testing and reporting framework for validating changes to the [AI-DLC workflows](https://github.com/awslabs/aidlc-workflows) repository.

## Overview

This framework is organized around six major work streams ("big rocks"):

1. **Golden Test Case** — Curated baseline test cases (AIDLC docs + code output) used as reference inputs for all evaluations
2. **Execution Framework** — Core orchestration that runs test cases through the evaluation pipeline
3. **Semantic Evaluation** — AI-based evaluation of output correctness, completeness, and appropriateness (reported @k to account for non-determinism)
4. **Code Evaluation** — Static analysis of generated code (linting, security scanning, duplication detection)
5. **NFR Evaluation** — Non-functional requirements testing (token consumption, execution time, cross-model consistency)
6. **GitHub CI/CD Integration & Management** — Automated pipelines that trigger evaluations on PRs and attach reports

## Quick Start

```bash
# Install dependencies
uv sync

# Run all unit tests
uv run python run.py test
# Note: On Windows, 7 tests in test_run_command.py are expected to fail
# because they use Unix shell commands (echo, exit, sleep, etc.) not available on Windows.

# Build sandbox docker image
./docker/sandbox/build.sh

# Full pipeline: execute AIDLC workflow + evaluate + report (requires Bedrock) with defaults
uv run python run.py full

# Full pipeline: execute AIDLC workflow + evaluate + report (requires Bedrock)
uv run python run.py full \
    --vision test_cases/sci-calc/vision.md \
    --tech-env test_cases/sci-calc/tech-env.md \
    --golden test_cases/sci-calc/golden-aidlc-docs \
    --openapi test_cases/sci-calc/openapi.yaml

# Evaluate an existing run (skip execution, just score via Bedrock)
uv run python run.py full \
    --evaluate-only runs/<run-folder>/aidlc-docs \
    --golden test_cases/sci-calc/golden-aidlc-docs \
    --openapi test_cases/sci-calc/openapi.yaml
```

## Evaluation Pipeline

The evaluation pipeline (`run.py full` or `scripts/run_evaluation.py`) orchestrates six stages:

| Stage | Package | Description |
| ------- | --------- | ------------- |
| 1. Execution | `packages/execution` | Runs the AIDLC two-agent workflow to produce docs + code |
| 2. Post-Run | (inside execution) | Installs deps and runs the generated project's tests |
| 3. Quantitative | `packages/quantitative` | Lints, security-scans, and duplication-checks generated code |
| 4. Contract | `packages/contracttest` | Spins up the generated app and validates API endpoints |
| 5. Qualitative | `packages/qualitative` | Compares generated docs against golden baseline via Bedrock LLM |
| 6. Report | `packages/reporting` | Generates consolidated Markdown + HTML reports |

Output for each run is written to a timestamped folder under `runs/`:

```txt
runs/<timestamp>/
  ├── aidlc-docs/                    # AIDLC workflow documents
  ├── workspace/                     # Generated application code
  ├── run-meta.yaml                  # Run identity + config
  ├── run-metrics.yaml               # Tokens, timing, artifacts, errors
  ├── test-results.yaml              # Post-run test output
  ├── quality-report.yaml            # Lint + security + duplication findings
  ├── contract-test-results.yaml     # API endpoint validation
  ├── qualitative-comparison.yaml    # Semantic scoring
  ├── evaluation-config.yaml         # Full resolved config snapshot
  ├── report.md                      # Consolidated Markdown report
  └── report.html                    # Consolidated HTML report
```

## Configuration

### Config file (`config/default.yaml`)

The main configuration file controls AWS settings, models, swarm parameters, timeouts, and tool paths. Edit this file to change defaults, or pass a custom config with `--config`:

```yaml
aws:
  profile: "default"
  region: "us-east-1"

models:
  executor:
    provider: "bedrock"
    model_id: "global.anthropic.claude-opus-4-6-v1"
  simulator:
    provider: "bedrock"
    model_id: "global.anthropic.claude-opus-4-6-v1"
  scorer:
    provider: "bedrock"
    model_id: "global.anthropic.claude-opus-4-6-v1"

aidlc:
  rules_source: "git"   # "git" or "local"
  rules_repo: "https://github.com/awslabs/aidlc-workflows.git"
  rules_ref: "main"
  rules_local_path: null

swarm:
  max_handoffs: 200
  max_iterations: 200
  execution_timeout: 14400
  node_timeout: 3600

runs:
  output_dir: "./runs"

execution:
  enabled: true
  command_timeout: 120
  post_run_tests: true
  post_run_timeout: 300

execution:
  sandbox:
    enabled: true
    image: aidlc-sandbox:latest
    memory: 2g
    cpus: 2

tools:
  pmd_path: null   # Path to PMD executable; if null, looks for 'pmd' on PATH
```

Precedence: `CLI flags > YAML config > built-in defaults`

### Model-specific configs

Per-model config files in `config/` override the executor model while inheriting everything else from `default.yaml`:

| File | Model |
| ------ | ------- |
| `config/opus-4-6.yaml` | Claude Opus 4.6 |
| `config/opus-4-5.yaml` | Claude Opus 4.5 |
| `config/sonnet-4-6.yaml` | Claude Sonnet 4.6 |
| `config/sonnet-4-5.yaml` | Claude Sonnet 4.5 |
| `config/nova-premier.yaml` | Amazon Nova Premier |
| `config/nova-pro.yaml` | Amazon Nova Pro |
| `config/nova-lite.yaml` | Amazon Nova Lite |
| `config/mistral-large-3.yaml` | Mistral Large 3 (675B) |
| `config/devstral-2.yaml` | Mistral Devstral 2 (123B, code-specialized) |

### Docker Sandbox

The evaluation framework runs AI-generated code inside an isolated Docker container to prevent untrusted code from affecting the host system. The sandbox image includes Python 3.13 + uv, Node.js 22 + npm, and common build tools, running as a non-root user.

#### Prerequisites

Docker must be installed and running on the host machine.

#### Building the sandbox image

```bash
# Build the image (one-time setup, or after Dockerfile changes)
./docker/sandbox/build.sh

# Or build manually
docker build -t aidlc-sandbox:latest docker/sandbox/
```

This produces the `aidlc-sandbox:latest` image referenced by the default configuration.

#### Configuration

Sandbox settings are in `config/default.yaml` under `execution.sandbox`:

```yaml
execution:
  sandbox:
    enabled: true                # Set to false to run generated code directly on the host
    image: aidlc-sandbox:latest  # Docker image name (must be built first)
    memory: 2g                   # Container memory limit
    cpus: 2                      # Container CPU limit
```

When sandbox is enabled, post-run tests (stage 2) and contract test servers (stage 4) execute inside the container. The generated `workspace/` directory is mounted into the container at `/workspace`. If Docker is not available or `enabled` is set to `false`, commands run directly on the host.

### Tool configuration

**PMD (code duplication detection):** PMD CPD is used for copy-paste detection in stage 3. Configure the path in `config/default.yaml`:

```yaml
tools:
  pmd_path: /path/to/pmd    # Absolute path to PMD executable
  # pmd_path: null           # null = search PATH automatically
```

If PMD is not found, duplication analysis is skipped with a note — it does not fail the evaluation.

### Pipeline CLI flags

```bash
uv run python run.py full \
    --vision test_cases/sci-calc/vision.md \
    --tech-env test_cases/sci-calc/tech-env.md \
    --golden test_cases/sci-calc/golden-aidlc-docs \
    --openapi test_cases/sci-calc/openapi.yaml \
    --config config/default.yaml \
    --profile my-aws-profile \
    --region us-west-2 \
    --executor-model global.anthropic.claude-opus-4-6-v1 \
    --scorer-model us.anthropic.claude-sonnet-4-5-20250929-v1:0 \
    --report-format both
```

Supported flags:

- `--config` — path to YAML config file (default: `config/default.yaml`)
- `--test` — run unit tests only
- `--vision`, `--tech-env` — execution inputs
- `--evaluate-only` — score an existing `aidlc-docs` folder without re-running execution
- `--golden` — reference baseline docs directory
- `--openapi` — contract test spec
- `--report-format` — `markdown`, `html`, or `both`
- `--baseline` — override path to `golden.yaml` (otherwise auto-discovered next to `--golden`)
- `--output-dir` — override run output folder
- `--results` — write qualitative results YAML to custom path
- `--profile`, `--region` — AWS credentials/region for Bedrock
- `--executor-model` — execution model override
- `--scorer-model` — qualitative scoring model override
- `--rules-ref` — git ref (branch/tag/commit) for AIDLC rules

## Batch Evaluation

Run the evaluation pipeline across multiple Bedrock models sequentially, then generate a cross-model comparison report.

### List available models

```bash
uv run python run.py batch --list
```

### Run batch evaluation

```bash
# Run all configured models
uv run python run.py batch --models all

# Run specific models (names match config file stems in config/)
uv run python run.py batch --models nova-pro,sonnet-4-5

# Override AWS settings
uv run python run.py batch --models all \
    --profile my-aws-profile \
    --region us-east-1
```

Each model run is stored under `runs/<model-name>/` with full evaluation artifacts. A `batch-summary.yaml` is written to the runs directory with timing and pass/fail status for each model.

### Generate cross-model comparison

After batch evaluation completes, generate a comparison matrix:

```bash
# Compare all model runs found under runs/
uv run python run.py compare

# Compare specific models against golden baseline
uv run python run.py compare \
    --models nova-pro,sonnet-4-5 \
    --baseline test_cases/sci-calc/golden.yaml
```

This produces `runs/comparison/comparison-report.md` and `runs/comparison/comparison-data.yaml` with side-by-side metrics across all models (unit tests, contract tests, code quality, qualitative scores, token usage, and timing).

## CLI Evaluation

Run the AIDLC evaluation through CLI-based AI assistants (Claude Code, Kiro CLI) using the CLI harness (`packages/cli-harness`).

### List available adapters

```bash
uv run python run.py cli --list
```

Supported adapters: `claude-code`, `kiro-cli`.

### Run CLI evaluation

```bash
# Run evaluation through Claude Code
uv run python run.py cli --cli claude-code \
    --vision test_cases/sci-calc/vision.md \
    --golden test_cases/sci-calc/golden-aidlc-docs

# Run through Kiro CLI with a specific model
uv run python run.py cli --cli kiro-cli \
    --vision test_cases/sci-calc/vision.md \
    --golden test_cases/sci-calc/golden-aidlc-docs \
    --model claude-sonnet-4

# Check prerequisites for an adapter
uv run python run.py cli --cli claude-code --check-only
```

Output is written to `runs/<cli-name>-<timestamp>-<uuid>/`. The CLI harness runs the adapter, then invokes `scripts/run_evaluation.py --evaluate-only` for scoring (stages 2–6).

## IDE Evaluation

Run the AIDLC evaluation through third-party IDE AI assistants using the IDE harness (`packages/ide-harness`).

### List available adapters

```bash
uv run python run.py ide --list
```

Supported adapters: Cursor, Cline, Copilot, Kiro, Windsurf, Antigravity.

### Run IDE evaluation

```bash
# Run evaluation through Cursor
uv run python run.py ide --ide cursor \
    --vision test_cases/sci-calc/vision.md \
    --golden test_cases/sci-calc/golden-aidlc-docs

# Check prerequisites for an IDE adapter
uv run python run.py ide --ide kiro --check-only
```

Output is written to `runs/ide-<adapter-name>/`.

## Extension Hook Testing

Test the AIDLC workflow with different rules extension configurations. The extension hook feature allows progressive loading of extensions (security, performance, observability) based on opt-in questions.

```bash
# List available extension configurations
uv run python run.py ext-test --list-configs

# Run standard test (all extensions vs no extensions)
uv run python run.py ext-test --scenario sci-calc

# Use specific rules branch with extension support
uv run python run.py ext-test --scenario sci-calc \
    --rules-ref feat/extension_hook_question_split
```

This runs the evaluation twice:
1. With all extension opt-ins answered "YES" (maximum guidance)
2. With all extension opt-ins answered "NO" (baseline only)

Results are saved to `runs/<scenario>/extension-test/` with a comparison report showing the impact of different extension configurations.

See [Extension Hook Testing Guide](./docs/extension-hook-testing.md) for detailed documentation.

## Trend Reporting

Generate cross-release trend reports that track evaluation metrics over time. Fetches evaluation bundles from GitHub releases and Actions artifacts, then renders HTML, Markdown, and YAML reports.

```bash
# Generate trend report (requires gh CLI authenticated)
uv run python run.py trend --baseline test_cases/sci-calc/golden.yaml

# HTML only with verbose output
uv run python run.py trend --baseline test_cases/sci-calc/golden.yaml --format html -v

# Include local evaluation bundles
uv run python run.py trend --baseline test_cases/sci-calc/golden.yaml \
    --local-bundle runs/my-run/report.zip

# Gate mode (exit non-zero on regressions)
uv run python run.py trend --baseline test_cases/sci-calc/golden.yaml --gate
```

The HTML executive summary displays six metric cards:

- **Qualitative Score** — semantic quality vs golden baseline (higher is better)
- **Contract Tests** — API pass rate as passed/total (higher is better)
- **Unit Tests** — pass rate shown as percentage (higher is better)
- **Lint Findings** — static analysis issues (lower is better)
- **Execution Time** — generation duration (lower is better)
- **Total Tokens** — LLM token consumption (lower is better)

Output is written to a timestamped folder under the output directory (default: `runs/`).

A sample HTML report is available at [`packages/trend-reports/examples/trend-report.html`](./packages/trend-reports/examples/trend-report.html).

## Running the Execution Component Directly

For full execution-level controls you can run `aidlc-runner` directly:

```bash
uv run aidlc-runner \
    --vision test_cases/sci-calc/vision.md \
    --tech-env test_cases/sci-calc/tech-env.md \
    --config config/default.yaml \
    --aws-profile my-aws-profile \
    --aws-region us-west-2 \
    --executor-model global.anthropic.claude-opus-4-6-v1 \
    --simulator-model us.anthropic.claude-sonnet-4-5-20250929-v1:0 \
    --output-dir ./runs
```

Execution-specific toggles:

- `--rules-path <local-rules-dir>` — forces local rules source
- `--no-exec` — disable in-workflow command execution
- `--no-post-tests` — disable post-run tests

## Repository Structure

```txt
.
├── run.py                     # Master entry point — dispatches to evaluation modes
├── scripts/                   # Specialized run scripts
│   ├── run_evaluation.py      # Single-model evaluation pipeline
│   ├── run_batch_evaluation.py    # Multi-model batch evaluation
│   ├── run_comparison_report.py   # Cross-model comparison report generator
│   ├── run_cli_evaluation.py      # CLI adapter evaluation runner
│   ├── run_ide_evaluation.py      # IDE adapter evaluation runner
│   ├── run_extension_test.py      # Extension hook testing (opt-in configurations)
│   ├── run_trend_report.py        # Cross-release trend report generation
│   └── README.md              # Scripts documentation
├── config/
│   ├── default.yaml           # Default configuration (models, AWS, timeouts, tools)
│   ├── nova-premier.yaml      # Amazon Nova Premier executor override
│   ├── nova-pro.yaml          # Amazon Nova Pro executor override
│   ├── sonnet-4-5.yaml        # Claude Sonnet 4.5 executor override
│   └── sonnet-4-6.yaml        # Claude Sonnet 4.6 executor override
├── packages/
│   ├── execution/             # AIDLC workflow runner (two-agent Strands orchestrator)
│   ├── qualitative/           # Semantic evaluation — intent & design similarity via Bedrock
│   ├── quantitative/          # Code evaluation — linting, security, duplication (PMD CPD)
│   ├── contracttest/          # API contract testing against OpenAPI specs
│   ├── nonfunctional/         # NFR evaluation — tokens, timing, consistency
│   ├── reporting/             # Consolidated report generation (Markdown + HTML)
│   ├── trend-reports/         # Cross-release trend reporting (HTML, Markdown, YAML)
│   ├── cli-harness/           # CLI adapter framework (Claude Code, Kiro CLI)
│   ├── ide-harness/           # IDE adapter framework (Cursor, Cline, Kiro, etc.)
│   └── shared/                # Common utilities
├── test_cases/                # Golden test cases (vision + tech-env + golden aidlc-docs)
├── runs/                      # Run output folders (one per evaluation run)
├── docker/
│   └── sandbox/               # Dockerfile + build script for isolated execution
├── docs/                      # Additional documentation
│   ├── extension-hook-testing.md  # Extension hook testing guide
│   ├── ide-harness-design.md      # IDE adapter architecture
│   └── file-structure.md          # Project file organization reference
├── pyproject.toml             # Workspace configuration
└── uv.lock                    # Dependency lock file
```

## Documentation

- [FAQ](./FAQ.md) — Common questions and answers
- [Contributing](./CONTRIBUTING.md) — Guidelines for submitting changes
- [Architecture](./ARCHITECTURE.md) — System design and implementation details
- [Extension Hook Testing](./docs/extension-hook-testing.md) — Testing AIDLC with different extension configurations
- [IDE Harness Design](./docs/ide-harness-design.md) — Architecture of the IDE adapter framework
- [File Structure](./docs/file-structure.md) — Project file organization reference

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on submitting changes.

## License

[License information to be added]
