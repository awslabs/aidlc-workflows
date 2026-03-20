# aidlc-runner

A two-agent orchestrator that drives the full AI-DLC (AI-Driven Development Life Cycle) workflow. Given a vision document and an optional technical environment document, aidlc-runner coordinates an **Executor** agent and a **Human Simulator** agent to carry a software project from requirements through code generation, producing all documentation artifacts and working application code.

## How It Works

aidlc-runner creates a [Strands Agents](https://github.com/strands-agents) swarm with two agents that hand off to each other:

1. **Executor** — Drives the AIDLC workflow stage-by-stage. It loads the relevant rule file for each stage, produces artifacts (requirements, designs, code), and hands off to the simulator whenever human input is needed.
2. **Human Simulator** — Acts as a knowledgeable human stakeholder. It answers clarifying questions, approves documents, and reviews generated code based on the vision and technical environment documents, then hands back to the executor.

The agents repeat this handoff loop through all Inception and Construction phases until the full application is generated.

### Workflow Stages

**Inception Phase** — what to build and why:

| Stage | Condition |
|---|---|
| Workspace Detection | Always |
| Reverse Engineering | Brownfield only |
| Requirements Analysis | Always |
| User Stories | If complexity warrants |
| Workflow Planning | Always |
| Application Design | Conditional |
| Units Generation | Conditional |

**Construction Phase** — how to build it (runs per unit of work):

| Stage | Condition |
|---|---|
| Functional Design | Conditional |
| NFR Requirements | Conditional |
| NFR Design | Conditional |
| Infrastructure Design | Conditional |
| Code Generation | Always |
| Build and Test | Always |

## Prerequisites

- Python 3.13+
- [uv](https://github.com/astral-sh/uv)
- Git (for cloning AIDLC rules; not needed if using `--rules-path`)
- AWS CLI configured with a profile that has Amazon Bedrock access

## Installation

From the repository root:

```bash
cd aidlc-runner
uv sync
```

## Usage

```bash
uv run aidlc-runner --vision <path-to-vision-file> [--tech-env <path-to-tech-env-file>] [options]
```

The only required argument is `--vision`, which points to a markdown file describing what to build. Optionally, `--tech-env` provides a technical environment document that defines how to build it (languages, frameworks, security controls, testing standards). See the [input document guide](GUIDE_TO_WRITING_VISION_DOCS.md) for details on writing these documents.

### Examples

Minimal — uses all defaults:

```bash
uv run aidlc-runner --vision ./my-project-vision.md
```

With a technical environment document:

```bash
uv run aidlc-runner --vision ./my-project-vision.md \
  --tech-env ./my-project-tech-env.md
```

Custom AWS profile and region:

```bash
uv run aidlc-runner --vision ./my-project-vision.md \
  --aws-profile my-profile \
  --aws-region us-east-1
```

Use a local copy of the AIDLC rules instead of cloning from GitHub:

```bash
uv run aidlc-runner --vision ./my-project-vision.md \
  --rules-path /opt/aidlc-workflows
```

Custom output directory and config file:

```bash
uv run aidlc-runner --vision ./my-project-vision.md \
  --config ./my-config.yaml \
  --output-dir ./my-runs
```

Override model IDs:

```bash
uv run aidlc-runner --vision ./my-project-vision.md \
  --executor-model us.anthropic.claude-opus-4-20250514-v1:0 \
  --simulator-model us.anthropic.claude-opus-4-20250514-v1:0
```

### CLI Reference

| Flag | Required | Default | Description |
|---|---|---|---|
| `--vision PATH` | Yes | — | Path to the vision/constraints markdown file |
| `--tech-env PATH` | No | — | Path to the technical environment markdown file |
| `--config PATH` | No | Built-in default | Path to a YAML configuration file |
| `--aws-profile TEXT` | No | `default` | AWS profile name |
| `--aws-region TEXT` | No | `us-west-2` | AWS region for Bedrock |
| `--executor-model TEXT` | No | Claude Opus 4 | Model ID for the executor agent |
| `--simulator-model TEXT` | No | Claude Sonnet 4.5 | Model ID for the simulator agent |
| `--output-dir PATH` | No | `../runs` | Directory where run folders are created |
| `--rules-path PATH` | No | Cloned from Git | Path to a local AIDLC rules directory |
| `--no-exec` | No | Enabled | Disable in-workflow command execution |
| `--no-post-tests` | No | Enabled | Disable post-run test execution |

## Configuration

Settings are resolved in order of precedence: **CLI flags > YAML config > built-in defaults**.

### YAML Config File

Create a YAML file and pass it via `--config`. Any value not specified falls back to the built-in default.

```yaml
aws:
  profile: "my-profile"
  region: "us-east-1"

models:
  executor:
    provider: "bedrock"
    model_id: "us.anthropic.claude-opus-4-20250514-v1:0"
  simulator:
    provider: "bedrock"
    model_id: "us.anthropic.claude-opus-4-20250514-v1:0"

aidlc:
  rules_source: "git"                  # "git" or "local"
  rules_repo: "https://github.com/awslabs/aidlc-workflows.git"
  rules_local_path: null               # set when rules_source is "local"

swarm:
  max_handoffs: 200
  max_iterations: 200
  execution_timeout: 14400             # 4 hours, in seconds
  node_timeout: 3600                   # 1 hour, in seconds

runs:
  output_dir: "../runs"
```

### Built-in Defaults

The built-in defaults match the file above. The default config ships at `aidlc-runner/config/default.yaml`.

## Run Output

Each invocation creates a timestamped run folder under the output directory:

```
runs/
└── 20260212T143022-a1b2c3d4e5f6.../
    ├── run-meta.yaml              # Metadata: timestamps, config snapshot, status
    ├── run-metrics.yaml           # NFR metrics: tokens, timing, artifacts, errors
    ├── test-results.yaml          # Test pass/fail results (if post-run tests enabled)
    ├── vision.md                  # Copy of the input vision file
    ├── tech-env.md                # Copy of the input tech-env file (if provided)
    ├── aidlc-rules/               # AIDLC workflow rules (cloned or copied)
    │   ├── aws-aidlc-rules/
    │   └── aws-aidlc-rule-details/
    ├── aidlc-docs/                # Documentation artifacts from the workflow
    │   ├── inception/             # Requirements, user stories, designs, etc.
    │   ├── construction/          # Functional design, code plans, reviews
    │   ├── aidlc-state.md         # Current workflow state tracker
    │   └── audit.md               # Timestamped audit log of all stages
    └── workspace/                 # Generated application code
        ├── src/
        ├── tests/
        ├── pyproject.toml
        └── ...
```

`run-meta.yaml` records the full execution context — start/end times, status, total handoffs, node history, and the config snapshot used. `run-metrics.yaml` captures NFR metrics — token usage (total and per-agent), handoff timing and patterns, generated artifact counts and lines of code, and error/retry events.

## Development

### Running Tests

```bash
cd aidlc-runner
uv run pytest
```

### Linting

```bash
uv run ruff check . && uv run ruff format .
```

### Project Structure

```
aidlc-runner/
├── config/
│   └── default.yaml                # Default configuration
├── src/aidlc_runner/
│   ├── __init__.py                 # Package version (0.1.0)
│   ├── __main__.py                 # python -m aidlc_runner entry point
│   ├── cli.py                      # Argument parsing and main()
│   ├── config.py                   # Configuration dataclasses and loading
│   ├── runner.py                   # Run folder creation, rules setup, swarm orchestration
│   ├── metrics.py                  # Metrics collection, artifact scanning, YAML output
│   ├── progress.py                 # Callback handlers and swarm hooks for progress reporting
│   ├── post_run.py                 # Post-run test evaluation
│   ├── agents/
│   │   ├── executor.py             # Executor agent factory
│   │   └── simulator.py            # Simulator agent factory
│   └── tools/
│       ├── file_ops.py             # Sandboxed read/write/list file tools
│       ├── rule_loader.py          # AIDLC rule file loader with path resolution
│       └── run_command.py          # Sandboxed shell command execution tool
├── tests/
│   ├── test_config.py              # Configuration unit tests
│   ├── test_metrics.py             # Metrics collection and artifact scanning tests
│   ├── test_post_run.py            # Post-run evaluation tests
│   ├── test_run_command.py         # Command execution and sandboxing tests
│   └── test_two_inputs.py          # Two-input-document (vision + tech-env) tests
└── pyproject.toml
```

### Key Modules

- **cli.py** — Parses CLI arguments (including `--vision` and optional `--tech-env`), loads config, and calls `runner.run()`.
- **config.py** — Defines `RunnerConfig` and nested dataclasses (`AwsConfig`, `ModelConfig`, `SwarmConfig`, etc.). Merges defaults, YAML, and CLI overrides.
- **runner.py** — Creates the run folder, copies the vision and optional tech-env files, sets up rules, builds both agents, creates a `Swarm`, executes it, and writes metrics.
- **metrics.py** — `MetricsCollector` accumulates handoff timings and error events during execution, then assembles token usage, artifact counts, and handoff patterns post-run into `run-metrics.yaml`.
- **progress.py** — `AgentProgressHandler` prints tool invocations and detects error events per agent. `SwarmProgressHook` tracks node-level handoff timing via Strands hook events.
- **post_run.py** — Post-run test evaluation: detects the project type in `workspace/`, installs dependencies, runs tests, and writes `test-results.yaml`.
- **agents/executor.py** — Builds the executor `Agent` with file-ops tools, a rule-loader tool, and an optional `run_command` tool. The system prompt encodes the complete AIDLC stage sequence and handoff protocol.
- **agents/simulator.py** — Builds the simulator `Agent` with file-ops tools. The system prompt is dynamically generated to embed the vision document content and, when provided, the technical environment document.
- **tools/file_ops.py** — `make_file_tools(run_folder)` returns sandboxed `read_file`, `write_file`, and `list_files` functions scoped to the run folder with path-traversal prevention.
- **tools/rule_loader.py** — `make_rule_loader(rules_dir)` returns a `load_rule` function that resolves shorthand paths (e.g., `"inception/requirements-analysis"`) to full rule file paths.
- **tools/run_command.py** — `make_run_command(run_folder)` returns a sandboxed `run_command` function for executing shell commands within the run folder during Build and Test.
