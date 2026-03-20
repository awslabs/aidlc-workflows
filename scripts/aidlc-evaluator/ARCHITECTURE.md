# AIDLC Evaluation Framework — Design Document

## 1. Purpose

This document describes the architecture, design decisions, data flows, and internal mechanics of the **AI-DLC Workflows Evaluation & Reporting Framework**. It is intended for developers who need to understand how the system works, extend it, or debug it.

The framework validates changes to the [AI-DLC workflows](https://github.com/awslabs/aidlc-workflows) repository by running an AI-driven software development lifecycle end-to-end, then scoring the outputs across multiple quality dimensions: functional correctness, code quality, API contract conformance, and semantic similarity to a golden baseline.

---

## 2. High-Level Architecture

```
                              ┌──────────────────────┐
                              │   Entry Points (CLI) │
                              └──────────┬───────────┘
                 ┌───────────────────────┼──────────────────────┐
                 │                       │                      │
        run_evaluation.py      run_batch_evaluation.py   run_ide_evaluation.py
         (single model)          (multi-model loop)       (IDE adapter)
                 │                       │                      │
                 └───────────┬───────────┘                      │
                             │                                  │
              ┌──────────────▼──────────────┐   ┌───────────────▼──────────┐
              │       6-Stage Pipeline      │   │     IDE Harness          │
              │  ┌──────────────────────┐   │   │  ┌───────────────────┐   │
              │  │ 1. Execution         │   │   │  │ Adapter (Cursor,  │   │
              │  │    (Strands Swarm)   │   │   │  │ Cline, Kiro, ...) │   │
              │  ├──────────────────────┤   │   │  └────────┬──────────┘   │
              │  │ 2. Post-Run Tests    │   │   │           │              │
              │  ├──────────────────────┤   │   │  ┌────────▼──────────┐   │
              │  │ 3. Quantitative      │   │   │  │ Output Normalizer │   │
              │  ├──────────────────────┤   │   │  └────────┬──────────┘   │
              │  │ 4. Contract Tests    │   │   │           │              │
              │  ├──────────────────────┤   │   └───────────┼──────────────┘
              │  │ 5. Qualitative       │   │               │
              │  ├──────────────────────┤   │    ┌──────────▼──────────┐
              │  │ 6. Report Generation │   │    │ --evaluate-only     │
              │  └──────────────────────┘   │    │ (stages 2-6)        │
              └─────────────────────────────┘    └─────────────────────┘
                             │
              ┌──────────────▼───────────────┐
              │  runs/<timestamp>/           │
              │   ├── aidlc-docs/            │
              │   ├── workspace/             │
              │   ├── run-meta.yaml          │
              │   ├── run-metrics.yaml       │
              │   ├── test-results.yaml      │
              │   ├── quality-report.yaml    │
              │   ├── contract-test-results… │
              │   ├── qualitative-comparison…│
              │   ├── report.md / .html      │
              │   └── evaluation-config.yaml │
              └─────────────────────────────┘
```

---

## 3. Package Structure

The project uses a **uv workspace** (defined in the root `pyproject.toml`) with eight internal packages. Each package is independently structured with its own `pyproject.toml`, `src/` layout, and `tests/` directory.

| Package | PyPI Name | Purpose |
|---------|-----------|---------|
| `packages/execution` | `aidlc-runner` | Two-agent swarm that runs the AIDLC workflow |
| `packages/qualitative` | `aidlc-qualitative` | Semantic scoring of documents vs golden baseline |
| `packages/quantitative` | `aidlc-quantitative` | Static analysis: linting, security, duplication |
| `packages/contracttest` | `aidlc-contracttest` | API contract testing against OpenAPI specs |
| `packages/nonfunctional` | `aidlc-nonfunctional` | NFR evaluation (tokens, timing, consistency) |
| `packages/reporting` | `aidlc-reporting` | Consolidated report generation (Markdown + HTML) |
| `packages/ide-harness` | (not published) | IDE adapter framework for third-party AI assistants |
| `packages/shared` | `aidlc-shared` | Common utilities shared across packages |

**Dependency graph** (simplified):

```
run_evaluation.py ──► execution (aidlc-runner)
                  ──► quantitative
                  ──► contracttest
                  ──► qualitative
                  ──► reporting ──► reporting.collector
                                ──► reporting.baseline
                                ──► reporting.render_md
                                ──► reporting.render_html
```

All packages communicate through **YAML files on disk**. There are no in-process library-level dependencies between the evaluation packages — the orchestrator (`run_evaluation.py`) invokes each package as a subprocess via `python -m <package>`, passing file paths as arguments. This design keeps packages independently testable and allows each to be run in isolation.

---

## 4. Configuration System

### 4.1 Layered Config Resolution

Configuration follows a three-tier precedence model:

```
CLI flags  >  YAML config file  >  Built-in Python defaults
```

1. **Built-in defaults** are defined as dataclass field defaults in `packages/execution/src/aidlc_runner/config.py` (`RunnerConfig` and its nested dataclasses).
2. **YAML config** is loaded from `config/default.yaml` (or a custom path via `--config`). The `_merge_dict_into_dataclass()` function recursively overlays YAML values onto the dataclass tree.
3. **CLI flags** (e.g., `--executor-model`, `--profile`) are applied last, overriding both YAML and defaults.

### 4.2 Config Dataclass Hierarchy

```python
RunnerConfig
  ├── aws: AwsConfig          # profile, region
  ├── models: ModelsConfig
  │     ├── executor: ModelConfig   # provider, model_id
  │     └── simulator: ModelConfig
  ├── aidlc: AidlcConfig      # rules_source, rules_repo, rules_ref
  ├── swarm: SwarmConfig       # max_handoffs, max_iterations, timeouts
  ├── runs: RunsConfig         # output_dir
  └── execution: ExecutionConfig  # enabled, command_timeout, post_run_tests
```

### 4.3 Per-Model Config Files

Files in `config/` (e.g., `config/sonnet-4-5.yaml`, `config/nova-pro.yaml`) override only the `models.executor.model_id` field. The batch runner (`run_batch_evaluation.py`) discovers these automatically by scanning `config/*.yaml` and excluding `default.yaml`.

---

## 5. Stage-by-Stage Pipeline Design

### 5.1 Stage 1: Execution (`packages/execution`)

This is the core of the framework. It uses the **Strands SDK** multi-agent orchestration to run the full AIDLC workflow.

#### Two-Agent Swarm Architecture

```
                    ┌──────────────────────┐
                    │   Strands Swarm      │
                    │                      │
  initial prompt ──►│  ┌────────────────┐  │
                    │  │   Executor     │  │
                    │  │   Agent        │◄─┤── handoff ──┐
                    │  │                ├──┤── handoff ──│
                    │  └────────────────┘  │             │
                    │                      │  ┌──────────▼─┐
                    │                      │  │ Simulator  │
                    │                      │  │ Agent      │
                    │                      │  └────────────┘
                    └──────────────────────┘
```

**Executor Agent** — Drives the AIDLC workflow through all phases (Inception → Construction). It:
- Loads AIDLC rule files on demand via the `load_rule` tool (lazy loading keeps context window usage low)
- Reads/writes files in the run folder via sandboxed `read_file`, `write_file`, `list_files` tools
- Executes shell commands (dependency install, test runs) via the `run_command` tool
- Hands off to the Simulator when human input is needed (questions, approvals, reviews)

**Simulator Agent** — Acts as a simulated human stakeholder. It:
- Has the vision document (and optional tech-env document) embedded in its system prompt
- Answers clarifying questions, approves documents, reviews code
- Always hands back to the Executor to continue the workflow

**Key design decisions:**
- **Sandboxed file operations**: All file tools use `_resolve_safe()` to prevent path traversal outside the run folder
- **Sandboxed command execution**: `run_command` uses a restricted environment (only PATH, HOME, LANG) to isolate execution
- **Lazy rule loading**: Rules are loaded one-at-a-time as each stage begins, rather than pre-loading all rules into the system prompt
- **Progress streaming**: `AgentProgressHandler` logs tool invocations to stderr without printing full LLM output; `SwarmProgressHook` logs handoff timing
- **Metrics collection**: `MetricsCollector` records token usage, handoff timing, context size samples, and error events during execution

#### AIDLC Workflow Stages

The Executor drives this sequence (some stages are conditional based on project scope):

| # | Stage | Phase | Conditional? |
|---|-------|-------|-------------|
| 1 | Workspace Detection | Inception | Always |
| 2 | Reverse Engineering | Inception | Brownfield only |
| 3 | Requirements Analysis | Inception | Always |
| 4 | User Stories | Inception | If complex |
| 5 | Workflow Planning | Inception | Always |
| 6 | Application Design | Inception | If needed |
| 7 | Units Generation | Inception | If needed |
| 8 | Functional Design | Construction | If needed |
| 9 | NFR Requirements | Construction | If needed |
| 10 | NFR Design | Construction | If needed |
| 11 | Infrastructure Design | Construction | If needed |
| 12 | Code Generation | Construction | Always |
| 13 | Build and Test | Construction | Always |

Each stage loads its corresponding rule file (e.g., `inception/requirements-analysis.md`) before execution. The Executor writes all documentation artifacts to `aidlc-docs/` and all generated code to `workspace/`.

#### Rules Setup

The runner either:
- **Git clones** the AIDLC rules repository (default: `awslabs/aidlc-workflows`, ref configurable) into the run folder, then extracts the `aidlc-rules/` content
- **Copies** from a local path when `rules_source: "local"` is configured

#### Run Folder Layout

```
runs/<YYYYMMDDTHHMMSS>-<rules_slug>/
  ├── vision.md                      # Copied input
  ├── tech-env.md                    # Copied input (if provided)
  ├── aidlc-rules/                   # AIDLC workflow rules
  │   ├── aws-aidlc-rules/           # Core workflow definition
  │   └── aws-aidlc-rule-details/    # Per-stage rule files
  ├── aidlc-docs/                    # Generated AIDLC documents
  │   ├── inception/                 # Requirements, user stories, design docs
  │   ├── construction/              # Functional design, code-gen docs
  │   ├── aidlc-state.md             # Workflow state tracker
  │   └── audit.md                   # Timestamped audit log
  ├── workspace/                     # Generated application code
  └── run-meta.yaml                  # Run identity and config snapshot
```

#### Post-Run Test Evaluation

After the swarm completes, `post_run.py` performs automatic testing:
1. **Project detection**: BFS scan of `workspace/` for marker files (`pyproject.toml`, `package.json`, `Cargo.toml`, `go.mod`) up to 3 levels deep
2. **Dependency install**: Runs the appropriate install command (e.g., `uv pip install -e ".[dev]"`)
3. **Test execution**: Runs the appropriate test command (e.g., `uv run pytest`)
4. **Output parsing**: Language-specific parsers extract pass/fail counts from test output (pytest, Jest/Vitest, cargo test, go test)
5. **Results**: Written to `test-results.yaml`

### 5.2 Stage 2: Post-Run Tests (Summary)

This stage reads `test-results.yaml` written by Stage 1 and prints a human-readable summary. It is embedded in the execution stage — the orchestrator reads the file for its summary display.

### 5.3 Stage 3: Quantitative Analysis (`packages/quantitative`)

Runs static analysis tools against the generated code in `workspace/`. The analysis is language-aware.

#### Tool Selection by Project Type

| Project Type | Linter | Security Scanner | Duplication |
|-------------|--------|-----------------|-------------|
| Python | ruff | bandit + semgrep | PMD CPD |
| Node.js | eslint | npm audit + semgrep | PMD CPD |

#### Analysis Flow

```
scan_workspace(path)
  ├── detect project type (pyproject.toml → Python, package.json → Node)
  ├── run_ruff() or run_eslint()         → LintFinding[]
  ├── run_bandit() or run_npm_audit()    → SecurityFinding[]
  ├── run_semgrep()                       → SecurityFinding[]
  ├── run_cpd()                           → DuplicationFinding[]
  └── compute_summary()                   → QualityReport
```

Each tool runner:
1. Checks if the tool is available (`shutil.which` or `uv run --version`)
2. Executes with JSON output format
3. Parses structured output into standardized finding models
4. Returns a `ToolResult` with findings and metadata

**Graceful degradation**: If any tool is not installed, the analysis for that tool is skipped with a note — it never fails the evaluation.

Output: `quality-report.yaml`

### 5.4 Stage 4: Contract Tests (`packages/contracttest`)

Validates the generated application's API endpoints against an OpenAPI 3.x specification.

#### Architecture

```
openapi.yaml ──► spec.py (parser) ──► ContractSpec
                                          ├── AppConfig (module, port, framework)
                                          └── TestCase[] (from x-test-cases extensions)

workspace/ ──► server.py (ServerProcess) ──► uvicorn subprocess
                                                  │
                                                  ▼
ContractSpec ──► runner.py ──► HTTP requests ──► CaseResult[]
                                                  │
                                                  ▼
                                          ContractTestResults
```

**Key mechanics:**
- **Spec parsing**: The OpenAPI spec uses custom `x-app` (server configuration) and `x-test-cases` (per-operation test inputs/expected outputs) extensions
- **Server management**: `ServerProcess` creates an isolated venv for the workspace project, starts uvicorn, polls `/health` until ready, and cleanly shuts down after tests
- **Test execution**: Each test case sends an HTTP request and validates: status code matches, response body contains expected keys/values (recursive deep match with floating-point tolerance)
- **Abort conditions**: Testing stops early if the server process dies or after 3 consecutive connection errors

Output: `contract-test-results.yaml`

### 5.5 Stage 5: Qualitative Evaluation (`packages/qualitative`)

Compares the generated AIDLC documents against a golden baseline using semantic similarity scoring.

#### Document Matching

```
golden aidlc-docs/         candidate aidlc-docs/
  inception/                 inception/
    requirements.md    ◄──►   requirements.md         (paired)
    user-stories.md    ◄──►   user-stories.md         (paired)
  construction/              construction/
    code-generation.md ◄──►   code-generation.md      (paired)
                              extra-doc.md             (unmatched candidate)
```

Documents are paired by relative path. Internal workflow files (`aidlc-state.md`, `audit.md`) are excluded.

#### Scoring Dimensions

Each document pair is scored on three dimensions (0.0 to 1.0):

| Dimension | Weight | What It Measures |
|-----------|--------|-----------------|
| Intent Similarity | 0.4 | Same goals, requirements, and purpose |
| Design Similarity | 0.4 | Same architecture, components, patterns |
| Completeness | 0.2 | Candidate covers all reference topics |

**Overall per-document** = 0.4 × intent + 0.4 × design + 0.2 × completeness

Scores are aggregated per-phase (inception, construction) then into an overall score.

#### Two Scorer Implementations

**HeuristicScorer** (offline, deterministic):
- Intent: Term-frequency cosine similarity with stopword removal
- Design: Weighted blend of technical identifier Jaccard similarity (0.6) and heading structure Jaccard similarity (0.4)
- Completeness: Fraction of reference headings present in candidate

**LlmScorer** (default, requires Bedrock):
- Sends both documents to an LLM via the Bedrock `converse` API
- Prompt asks for JSON with the three dimension scores plus notes
- Uses temperature 0.0 for reproducibility
- Content truncated to 15K characters per document

Output: `qualitative-comparison.yaml`

### 5.6 Stage 6: Report Generation (`packages/reporting`)

Generates consolidated reports by collecting all YAML artifacts from the run folder.

#### Data Collection

`reporting.collector.collect(run_folder)` reads all YAML files and assembles a `ReportData` dataclass containing:
- `RunMeta` — identity, timing, models, rules
- `RunMetrics` — tokens (total + per-agent), wall clock, handoff timeline, artifact counts, error counts, context size stats
- `TestResults` — unit test pass/fail/total with pass percentage
- `QualityReport` — lint, security, duplication findings
- `ContractResults` — per-endpoint test results
- `QualitativeResults` — per-document and per-phase semantic scores

#### Baseline Comparison

If a `golden.yaml` baseline file exists (auto-discovered next to the `--golden` directory), the report includes a regression comparison:
1. `extract_baseline()` flattens `ReportData` into a `BaselineMetrics` with ~30 numeric fields
2. `compare()` computes deltas and classifies each metric as improved/regressed/unchanged
3. Classification respects directionality (e.g., fewer lint errors = improved, higher test pass% = improved)

#### Output Formats

- **Markdown**: `render_markdown()` produces GitHub-flavored Markdown with verdict banners, tables, delta indicators, and collapsible detail sections
- **HTML**: `render_html()` wraps the Markdown with CSS styling for standalone viewing

---

## 6. Orchestrators

### 6.1 Single-Model Pipeline (`run_evaluation.py`)

The main entry point. Orchestrates all six stages sequentially:

```
parse CLI args
  │
  ├── --test mode ──► run pytest on all packages ──► exit
  │
  ├── --evaluate-only mode ──► skip Stage 1
  │     ├── Stage 3 (quantitative)
  │     ├── Stage 4 (contract)
  │     ├── Stage 5 (qualitative)
  │     └── Stage 6 (report)
  │
  └── full pipeline mode
        ├── Stage 1 (execution) ──► creates timestamped run folder
        ├── Save evaluation config and repo info
        ├── Stage 2 (read test-results.yaml from Stage 1)
        ├── Stage 3 (quantitative)
        ├── Stage 4 (contract, if --openapi provided)
        ├── Stage 5 (qualitative)
        ├── Stage 6 (report)
        └── Print summary, exit 0 if all pass
```

**Resilience**: If the Strands swarm exits non-zero but AIDLC documents were produced, evaluation continues (the swarm may fail on a late handoff after all documents are written).

### 6.2 Batch Evaluation (`run_batch_evaluation.py`)

Runs `run_evaluation.py` in a loop for each selected model config:

```
discover_models()     ← scans config/*.yaml, excludes default.yaml
  │
  for each model:
  │  ├── build CLI command with --executor-model override
  │  ├── run as subprocess, capture stdout/stderr to log file
  │  ├── find new timestamped run folder
  │  ├── rename folder: <timestamp>-<slug>-<model-name>
  │  └── write per-model batch-summary.yaml
  │
  write batch-summary.yaml with timing and pass/fail for all models
```

Each model run is fully isolated — a separate subprocess invocation with its own run folder.

### 6.3 Cross-Model Comparison (`run_comparison_report.py`)

Generates a side-by-side comparison matrix after batch evaluation:

```
find_model_runs()     ← discovers run folders by model name suffix
  │
  for each model:
  │  └── collect() + extract_baseline() → BaselineMetrics
  │
  load golden baseline (golden.yaml)
  │
  generate_comparison_markdown()   → comparison-report.md
  generate_comparison_yaml()       → comparison-data.yaml
```

The comparison table includes ~30 metrics across unit tests, contract tests, code quality, qualitative scores, artifacts, execution cost, and context size — with delta indicators (^ better, v worse) relative to the golden baseline.

### 6.4 IDE Evaluation (`run_ide_evaluation.py`)

Runs the AIDLC workflow through third-party IDE AI assistants:

```
get_adapter(name)     ← lazy import from registry
  │
  ├── check_prerequisites()
  ├── adapter.run(config) ──► IDE-specific automation
  ├── normalize_output()  ──► standard run folder layout
  └── run_evaluation.py --evaluate-only  ──► stages 2-6
```

**Adapter pattern**: Each IDE is implemented as a subclass of `IDEAdapter` with three methods:
- `check_prerequisites()` — verify the IDE is installed and configured
- `run(config)` — execute the AIDLC process through the IDE
- `name` — human-readable identifier

**Output normalization**: `normalizer.py` converts IDE-specific output layouts into the standard run folder structure expected by the evaluation pipeline, generating synthetic `run-meta.yaml` and `run-metrics.yaml`.

Supported adapters: Cursor, Cline, Copilot, Kiro, Windsurf, Antigravity.

---

## 7. Data Flow: YAML Artifact Graph

Every stage communicates through YAML files in the run folder. No in-memory state crosses stage boundaries.

```
Stage 1 (execution)
  ├── writes: run-meta.yaml, run-metrics.yaml, test-results.yaml
  ├── writes: aidlc-docs/**/*.md, workspace/**/*
  │
Stage 3 (quantitative) reads: workspace/
  └── writes: quality-report.yaml
  │
Stage 4 (contract) reads: workspace/, openapi.yaml (test input)
  └── writes: contract-test-results.yaml
  │
Stage 5 (qualitative) reads: aidlc-docs/, golden-aidlc-docs/ (test input)
  └── writes: qualitative-comparison.yaml
  │
Stage 6 (report) reads: ALL of the above YAML files + golden.yaml
  └── writes: report.md, report.html
```

The orchestrator also writes `evaluation-config.yaml` (full resolved config snapshot) and updates `run-meta.yaml` with evaluation-level fields.

---

## 8. Key Data Models

### 8.1 Execution Metrics (`run-metrics.yaml`)

```yaml
tokens:
  total: {input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens}
  per_agent:
    executor: {input_tokens, output_tokens, total_tokens}
    simulator: {input_tokens, output_tokens, total_tokens}
timing:
  total_wall_clock_ms: int
  handoffs: [{handoff: int, node_id: str, duration_ms: int}, ...]
handoff_patterns:
  total_handoffs: int
  sequence: [str, ...]
  per_agent: {agent: {turn_count, total_duration_ms, avg_turn_duration_ms}}
artifacts:
  workspace: {source_files, test_files, config_files, total_files, total_lines_of_code}
  aidlc_docs: {inception_files, construction_files, total_files}
errors:
  throttle_events, timeout_events, failed_tool_calls, model_error_events, ...
context_size:
  total: {min_tokens, max_tokens, avg_tokens, median_tokens, sample_count}
  per_agent: {executor: {...}, simulator: {...}}
```

### 8.2 Qualitative Scores (`qualitative-comparison.yaml`)

```yaml
overall_score: float  # 0.0 to 1.0
phases:
  - phase: inception
    avg_intent: float
    avg_design: float
    avg_completeness: float
    avg_overall: float
    documents:
      - path: inception/requirements.md
        intent_similarity: float
        design_similarity: float
        completeness: float
        overall: float
        notes: str
```

### 8.3 Golden Baseline (`golden.yaml`)

A flat numeric snapshot of ~30 key metrics from a promoted run. Used as the regression comparison target. Fields span execution cost, artifacts, test results, code quality, and qualitative scores.

---

## 9. Tool Integration

### 9.1 Strands SDK (Multi-Agent)

The execution package uses the [Strands Agents SDK](https://github.com/strands-agents/sdk-python) for:
- `Agent` — wraps a Bedrock model with a system prompt and tool set
- `Swarm` — orchestrates handoffs between agents with configurable limits (max handoffs, max iterations, execution timeout, node timeout)
- `@tool` decorator — registers Python functions as callable tools for agents
- `BedrockModel` — Bedrock model provider with configurable retry policy
- Hook system — `BeforeNodeCallEvent` / `AfterNodeCallEvent` for progress tracking

### 9.2 Amazon Bedrock

All LLM calls go through Amazon Bedrock via boto3. Configuration:
- Read timeout: 900s (15 min) for execution agents, 300s (5 min) for the qualitative scorer
- Connect timeout: 30s
- Retry policy: 10 attempts with adaptive mode
- Models: Configurable per role (executor, simulator, scorer)

### 9.3 Static Analysis Tools

| Tool | Purpose | Output Format | Graceful Degradation |
|------|---------|--------------|---------------------|
| ruff | Python linting | JSON | Skipped if not on PATH |
| bandit | Python security | JSON | Skipped if not on PATH |
| semgrep | Multi-language security | JSON | Skipped if not on PATH |
| eslint | JS/TS linting | JSON | Falls back to npx |
| npm audit | JS dependency security | JSON | Needs package-lock.json |
| PMD CPD | Code duplication | XML | Configurable path or PATH scan |

---

## 10. Security Model

### 10.1 File Sandboxing

All file operations performed by AI agents are sandboxed to the run folder:
- `_resolve_safe(run_folder, relative_path)` resolves the path and verifies it stays within the run folder boundary
- Path traversal attempts (e.g., `../../etc/passwd`) are rejected with a `ValueError`
- Applied to: `read_file`, `write_file`, `list_files`, `run_command`

### 10.2 Command Sandboxing

The `run_command` tool provides a restricted shell environment:
- Only `PATH`, `HOME`, `LANG`, `TERM` are set (plus tool-specific vars like `UV_CACHE_DIR`)
- `HOME` is set to the run folder to prevent reading host user configuration
- Commands have a configurable timeout (default 120s)
- Output is truncated at 50K characters

### 10.3 Server Isolation (Contract Tests)

The contract test server runs in its own venv:
- `ServerProcess._ensure_venv()` creates an isolated venv in the workspace project
- This prevents `uv run` from walking up the directory tree and resolving the parent project
- The server is started via the venv's own Python binary

---

## 11. Test Cases

Test cases live in `test_cases/` and follow a standard structure:

```
test_cases/<case-name>/
  ├── vision.md              # Project vision and constraints
  ├── tech-env.md            # Technical environment requirements
  ├── openapi.yaml           # API contract spec with x-test-cases
  ├── golden-aidlc-docs/     # Reference aidlc-docs output (golden baseline)
  │   ├── inception/
  │   │   ├── requirements.md
  │   │   └── ...
  │   └── construction/
  │       ├── code-generation.md
  │       └── ...
  └── golden.yaml            # Promoted baseline metrics
```

The default test case is `sci-calc` (a scientific calculator API). All CLI defaults point to this test case.

---

## 12. Extension Points

### Adding a New Model

1. Create `config/<model-name>.yaml` with `models.executor.model_id` set to the Bedrock model ID
2. The batch runner will automatically discover it

### Adding a New IDE Adapter

1. Create `packages/ide-harness/src/ide_harness/adapters/<name>.py`
2. Implement the `IDEAdapter` abstract class (three methods: `name`, `check_prerequisites`, `run`)
3. Register in `_ADAPTER_MAP` in `packages/ide-harness/src/ide_harness/registry.py`

### Adding a New Static Analysis Tool

1. Add an analyzer function in `packages/quantitative/src/quantitative/analyzers.py` (follow the `run_ruff` pattern)
2. Define a finding model if needed in `models.py`
3. Call it from `scanner.py` based on project type detection

### Adding a New Test Case

1. Create a directory under `test_cases/<case-name>/`
2. Provide `vision.md`, `tech-env.md`, and optionally `openapi.yaml`
3. Run the full pipeline once to generate the golden baseline
4. Use `reporting.baseline.promote()` to create `golden.yaml`
5. Copy the run's `aidlc-docs/` as `golden-aidlc-docs/`

---

## 13. Dependency Stack

| Component | Technology |
|-----------|-----------|
| Language | Python 3.13+ |
| Package manager | uv (workspace mode) |
| AI orchestration | Strands Agents SDK |
| LLM provider | Amazon Bedrock (boto3) |
| HTTP client | httpx (contract tests) |
| ASGI server | uvicorn (contract tests) |
| Test framework | pytest |
| Serialization | PyYAML |
| Linting | ruff |
| Security scanning | bandit, semgrep |
| Duplication detection | PMD CPD (external) |
