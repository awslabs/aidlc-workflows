# AIDLC Evaluation Framework — Design Document

## 1. Purpose

This document describes the architecture, design decisions, data flows, and internal mechanics of the **AI-DLC Workflows Evaluation & Reporting Framework**. It is intended for developers who need to understand how the system works, extend it, or debug it.

The framework validates changes to the AI-DLC workflows by running an AI-driven software development lifecycle end-to-end, then scoring the outputs across multiple quality dimensions: functional correctness, code quality, API contract conformance, and semantic similarity to a golden baseline.

---

## 2. High-Level Architecture

Three execution paths are supported. All three funnel into the same 6-stage scoring pipeline (stages 2–6) after producing AIDLC artifacts.

```text
                    ┌──────────────────────────────────────────────────────────┐
                    │                      Entry Points                         │
                    │  run.py (dispatcher) ─► run_evaluation.py                │
                    │                      ─► run_cli_evaluation.py            │
                    │                      ─► run_ide_evaluation.py            │
                    │                      ─► run_batch_evaluation.py          │
                    └──────────┬─────────────────┬──────────────────┬──────────┘
                               │                 │                  │
              ┌────────────────┘        ┌────────┘                  └─────────┐
              │                         │                                     │
  ┌───────────▼──────────┐  ┌───────────▼──────────┐        ┌────────────────▼──────┐
  │  Path A: Strands     │  │  Path B: CLI Harness  │        │  Path C: IDE Harness  │
  │  (packages/execution)│  │  (packages/cli-harness│        │  (packages/ide-harness│
  │                      │  │                       │        │                       │
  │  V1: Executor        │  │  Adapter: kiro-cli    │        │  Adapter: Cursor      │
  │    + Simulator       │  │  Adapter: claude-code │        │  Adapter: Cline       │
  │  V2: Orchestrator    │  │                       │        │  Adapter: Kiro IDE    │
  │    + Simulator       │  │  Human Analog         │        │  Adapter: Copilot     │
  │    + Persona Agents  │  │  (Bedrock)            │        │  Adapter: Windsurf    │
  └──────────┬───────────┘  └──────────┬────────────┘        │  Adapter: Antigravity │
             │                         │                      └────────────┬──────────┘
             │                         │                                   │
             │                         │           ┌───────────────────────┘
             │                         │           │  (runs IDE, normalizes output)
             └──────────────┬──────────┘           │
                            │         └────────────┘
                            │
                 ┌──────────▼──────────┐
                 │  --evaluate-only    │
                 │  (stages 2–6)       │
                 └──────────┬──────────┘
                            │
        ┌───────────────────▼──────────────────────────┐
        │              6-Stage Pipeline                  │
        │  2. Post-Run Tests    (pytest / jest / cargo)  │
        │  3. Quantitative      (ruff, bandit, semgrep)  │
        │  4. Contract Tests    (OpenAPI + httpx)        │
        │  5. Qualitative       (Bedrock LLM scoring)    │
        │  6. Report            (Markdown + HTML)        │
        └───────────────────┬──────────────────────────┘
                            │
        ┌───────────────────▼──────────────────────────┐
        │  runs/<scenario>/<timestamp>-<pid>-<slug>/    │
        │    ├── aidlc-docs/                            │
        │    ├── workspace/                             │
        │    ├── run-meta.yaml                          │
        │    ├── run-metrics.yaml                       │
        │    ├── test-results.yaml                      │
        │    ├── quality-report.yaml                    │
        │    ├── contract-test-results.yaml             │
        │    ├── qualitative-comparison.yaml            │
        │    └── report.md / report.html                │
        └───────────────────────────────────────────────┘
```

---

## 3. Package Structure

The project uses a **uv workspace** with nine internal packages plus a CLI harness.

| Package                  | PyPI Name             | Purpose                                                       |
| ------------------------ | --------------------- | ------------------------------------------------------------- |
| `packages/execution`     | `aidlc-runner`        | Strands-based multi-agent swarm that runs the AIDLC workflow  |
| `packages/qualitative`   | `aidlc-qualitative`   | Semantic scoring of documents vs golden baseline              |
| `packages/quantitative`  | `aidlc-quantitative`  | Static analysis: linting, security, duplication               |
| `packages/contracttest`  | `aidlc-contracttest`  | API contract testing against OpenAPI specs                    |
| `packages/nonfunctional` | `aidlc-nonfunctional` | NFR evaluation (tokens, timing, consistency)                  |
| `packages/reporting`     | `aidlc-reporting`     | Consolidated report generation (Markdown + HTML)              |
| `packages/cli-harness`   | (internal)            | Path B: programmatic CLI/SDK adapters (kiro-cli, claude-code) |
| `packages/ide-harness`   | (internal)            | Path C: IDE interface automation (Cursor, Cline, Kiro, etc.)  |
| `packages/shared`        | `aidlc-shared`        | Common utilities shared across packages                       |

---

## 4. Execution Paths

### 4.1 Path A: Strands Swarm (`packages/execution`)

Drives the AIDLC workflow programmatically using the Strands SDK. Supports two modes controlled by `config.aidlc.rules_version`.

#### V1 Mode — Two-Agent Swarm

The original architecture. Uses a flat `aidlc-rules/` directory (cloned from the AIDLC rules repo or copied from a local path).

```text
                    ┌──────────────────────┐
                    │   Strands Swarm      │
  initial prompt ──►│  ┌────────────────┐  │
                    │  │   Executor     │◄─┤── handoff ──┐
                    │  │   Agent        ├──┤── handoff ──│
                    │  └────────────────┘  │  ┌──────────▼─┐
                    │                      │  │ Simulator  │
                    │                      │  │ Agent      │
                    └──────────────────────┘  └────────────┘
```

**Executor Agent** — Monolithic AIDLC workflow driver. Loads rule files on demand via `load_rule`, writes all artifacts, executes shell commands, and hands off to Simulator at approval gates.

**Simulator Agent** — Simulated human stakeholder with vision + tech-env embedded in its system prompt. Answers questions and approves documents, always handing back to Executor.

#### V2 Mode — Multi-Agent Persona Swarm

Uses the kiro `src/` directory (skills, stages, conventions, personas). The orchestrator delegates all artifact production to per-persona agents.

```text
                    ┌─────────────────────────────────────────┐
                    │            Strands Swarm (V2)            │
  initial prompt ──►│  ┌──────────────┐                        │
                    │  │ Orchestrator │◄── handoff ──────────┐ │
                    │  │ (read-only)  ├── handoff ──────────┐ │ │
                    │  └──────────────┘                     │ │ │
                    │                          ┌────────────▼─┐│ │
                    │                          │  Simulator   ││ │
                    │                          │  (human)     ││ │
                    │                          └──────────────┘│ │
                    │  ┌─────────────────────────────────────┐  │ │
                    │  │  Persona Agents (one per YAML)       │◄─┘ │
                    │  │  aidlc-product-manager-agent         │    │
                    │  │  aidlc-systems-architect-agent       │    │
                    │  │  aidlc-sw-dev-engineer-agent         │    │
                    │  │  aidlc-app-architect-agent           │    │
                    │  │  aidlc-ux-designer-agent             │    │
                    │  │  aidlc-code-reviewer-agent           │    │
                    │  │  aidlc-product-lead-agent            │    │
                    │  │  aidlc-architecture-reviewer-agent   │────┘
                    │  └─────────────────────────────────────┘
                    └─────────────────────────────────────────┘
```

**Orchestrator** — Pure coordinator, read-only file access. Loads `skills/aidlc-orchestration/SKILL.md` on startup, then dispatches all artifact production to named persona agents via `handoff_to_agent`. Never writes files itself.

**Persona Agents** — One Strands `Agent` per YAML file in `src/personas/`. Each is built with:

- System prompt from the persona's `name`, `description`, and `behaviour` fields
- `AgentSkills` plugin loaded from `src/skills/common/` plus the persona's `associated-skills`
- Full file tools (`read_file`, `write_file`, `list_files`) and `run_command` (sw-dev-engineer only)

**Simulator** — Same role as V1 but only invoked for genuine human gates (plan approvals, clarification answers).

**ProcessCheckerHook** — Fires after every agent turn in V2. Reads `state.json` and enforces the AIDLC state machine, blocking invalid transitions.

**Rules setup:**

- `rules_source: "git"` — clones the AIDLC rules repo into `run_folder/src/`
- `rules_source: "local"` — copies `<rules_local_path>/src/` into `run_folder/src/`

### 4.2 Path B: CLI Harness (`packages/cli-harness`)

Drives the AIDLC workflow through external CLI tools or SDKs. After execution, normalizes output to the standard run folder layout and invokes `run_evaluation.py --evaluate-only` for stages 2–6.

#### Adapter Registry

| Adapter Name  | Class               | Backend                           |
| ------------- | ------------------- | --------------------------------- |
| `kiro-cli`    | `KiroCLIAdapter`    | `kiro-cli chat` subprocess        |
| `claude-code` | `ClaudeCodeAdapter` | `claude-agent-sdk` Python package |

#### kiro-cli Adapter

Runs `kiro-cli chat --no-interactive --trust-all-tools` in a subprocess. Supports two execution modes:

**V1 mode** (no `--kiro-dist`): Concatenates all AIDLC rules markdown files into `.kiro/steering/aidlc-rules.md`. Sends a monolithic `EXECUTOR_SYSTEM_PROMPT`. Detects completion via `aidlc-docs/` quiescence.

**V2 mode** (`--kiro-dist <path>`): Copies the built kiro distribution (`.kiro/` tree with agents, skills, stages, hooks) into the workspace. Sends `/skill aidlc-orchestration\n<vision>` as the initial prompt. Detects completion via `state.json` with all stages at terminal status and construction-phase artifacts present.

**Multi-turn resume loop:** After each SDK session expires (kiro-cli is stateless), the adapter:

1. Checks `state.json` — if all stages complete and code exists, done
2. If the agent's last turn contained waiting signals ("What do you think?", "awaiting approval"), calls the **Human Analog** (Bedrock Simulator) to generate a response and resumes
3. If stages remain incomplete, sends a nudge prompt listing the pending stages

#### claude-code Adapter

Uses the `claude-agent-sdk` Python package for fully programmatic execution. No subprocess management. **Requires `bun`** on PATH — the claude-code framework's tools and hooks run via `bun .claude/tools/*.ts`.

**V2 mode** (`--claude-dist <path>`, auto-detected at `claude-code/dist/claude/.claude`): Copies the claude-code distribution (`.claude/` tree) into the workspace, writes a `settings.local.json` overriding `AWS_REGION` to the run's region, and drives the `/aidlc <intent> --scope <scope> --test-run` skill. The skill runs its own self-directed forwarding loop over the 32-stage workflow. Scope (`--claude-scope`, default `mvp`) controls how many stages run. Uses `ClaudeSDKClient` for multi-turn sessions.

**AskUserQuestion interception:** The `can_use_tool` callback intercepts every `AskUserQuestion` tool call, routes it to the Bedrock Human Analog, and injects the answer back as structured `answers` — all within the running SDK session. Under `--test-run` (the default) the engine auto-approves gates, so this rarely fires.

**Completion detection** (checked after every SDK turn):

1. `aidlc-docs/aidlc-state.md` shows `Status: Completed` AND Python source files exist in workspace → done
2. SDK returned non-success subtype → stop
3. Agent output contains waiting signals → call Human Analog, resume with response
4. `aidlc-state.md` shows an incomplete `Next Stage`/`In Progress` → send nudge prompt, continue loop

### 4.3 Path C: IDE Harness (`packages/ide-harness`)

Drives the AIDLC workflow through third-party AI IDE assistants by automating the IDE's own interface. After the IDE run completes, normalizes output to the standard run folder layout and invokes `run_evaluation.py --evaluate-only` for stages 2–6.

#### Adapter Registry

| Adapter Name  | Backend                                  |
| ------------- | ---------------------------------------- |
| `cursor`      | Cursor IDE via headless subprocess       |
| `cline`       | Cline VS Code extension                  |
| `kiro`        | Kiro IDE via `kiro-cli` with pexpect PTY |
| `copilot`     | GitHub Copilot                           |
| `windsurf`    | Windsurf IDE                             |
| `antigravity` | Antigravity IDE                          |

Each adapter implements three methods:

- `check_prerequisites()` — verify the IDE tool is installed and configured
- `run(config)` — execute the AIDLC process through the IDE's own interface
- `name` — human-readable identifier

**Output normalization:** `ide_harness/normalizer.py` converts IDE-specific workspace layouts into the standard run folder structure, generating synthetic `run-meta.yaml` and `run-metrics.yaml`. Handles both v1 flat `aidlc-docs/` and v2 `org-ai-kb/aidlc-docs/` layouts.

**Key difference from CLI Harness (Path B):** The CLI harness invokes tools programmatically (subprocess or SDK). The IDE harness automates the IDE's own user-facing interface — it drives the IDE as a user would, capturing whatever the IDE produces. This makes it suitable for benchmarking the full user experience including IDE-specific features (steering files, hooks, agent invocations).

#### Human Analog

`packages/cli-harness/src/cli_harness/human_analog.py` — Generates contextually appropriate human responses at approval gates. Uses the same simulator system prompt as the Strands Simulator agent, grounded in vision.md and tech-env.md. Falls back to "Approve & Continue." if Bedrock is unavailable.

#### Output Normalization

After any adapter run, aidlc-docs are located using `_find_aidlc_docs()` which checks:

1. `run_folder/aidlc-docs/` (v1 flat layout, already normalized)
2. `run_folder/workspace/org-ai-kb/aidlc-docs/` (v2 kiro layout)
3. One level deep under workspace (fallback)

The found directory is copied to `run_folder/aidlc-docs/` for consistent downstream processing.

---

## 5. Configuration System

### 5.1 Layered Config Resolution

```text
CLI flags  >  YAML config file  >  Built-in Python defaults
```

### 5.2 Config Dataclass Hierarchy (Strands Path)

```python
RunnerConfig
  ├── aws: AwsConfig              # profile, region
  ├── models: ModelsConfig
  │     ├── executor: ModelConfig  # provider, model_id
  │     └── simulator: ModelConfig
  ├── aidlc: AidlcConfig           # rules_source, rules_repo, rules_ref, rules_version
  ├── swarm: SwarmConfig            # max_handoffs, max_iterations, timeouts
  ├── runs: RunsConfig              # output_dir
  └── execution: ExecutionConfig    # enabled, command_timeout, post_run_tests
```

`rules_version: "v2"` switches the Strands runner from the two-agent swarm to the multi-agent persona swarm.

### 5.3 Config Files

| File                          | Purpose                                           |
| ----------------------------- | ------------------------------------------------- |
| `config/default.yaml`         | Baseline (Opus 4.6, git rules, standard timeouts) |
| `config/opus-4-6.yaml`        | Override executor to Opus 4.6                     |
| `config/sonnet-4-6.yaml`      | Override executor to Sonnet 4.6                   |
| `config/nova-pro.yaml`        | AWS Nova Pro                                      |
| `config/nova-lite.yaml`       | AWS Nova Lite                                     |
| `config/nova-premier.yaml`    | AWS Nova Premier                                  |
| `config/mistral-large-3.yaml` | Mistral Large 3                                   |
| `config/devstral-2.yaml`      | Mistral Devstral 2                                |
| `config/kiro-v2-local.yaml`   | V2 Strands swarm with local kiro rules            |

### 5.4 Run Folder Naming

```text
runs/<scenario>/<YYYYMMDDTHHMMSS>-<PID>-<rules_slug>/
```

The `<PID>` component was added to guarantee uniqueness when multiple runs start within the same second (parallel evaluation). `<rules_slug>` is derived from the rules source (e.g., `aidlc-workflows_v2` for the git repo at ref `v2`, or `local_kiro` for a local path named `kiro`).

---

## 6. Entry Points

All entry points are exposed through `run.py` which dispatches to the appropriate script:

| Command           | Script                     | Description                                    |
| ----------------- | -------------------------- | ---------------------------------------------- |
| `run.py full`     | `run_evaluation.py`        | Full pipeline: execute + score (Strands swarm) |
| `run.py cli`      | `run_cli_evaluation.py`    | CLI adapter: kiro-cli or claude-code           |
| `run.py ide`      | `run_ide_evaluation.py`    | IDE adapter: Cursor, Cline, Kiro IDE, etc.     |
| `run.py batch`    | `run_batch_evaluation.py`  | Loop across multiple Bedrock models            |
| `run.py compare`  | `run_comparison_report.py` | Cross-model comparison matrix                  |
| `run.py ext-test` | `run_extension_test.py`    | Extension hook testing (all-yes vs all-no)     |
| `run.py trend`    | `run_trend_report.py`      | Cross-release trend reports                    |
| `run.py test`     | `run_evaluation.py --test` | Run unit tests for all packages                |

### 6.1 `run_evaluation.py` — Full Pipeline

```text
parse CLI args
  │
  ├── --test mode ──► run pytest on all packages ──► exit
  │
  ├── --evaluate-only <aidlc-docs-path> ──► skip Stage 1
  │     ├── Stage 3 (quantitative)
  │     ├── Stage 4 (contract)
  │     ├── Stage 5 (qualitative)
  │     └── Stage 6 (report)
  │
  └── full pipeline mode
        ├── Stage 1 (Strands swarm execution) ──► timestamped run folder
        ├── _normalize_aidlc_docs()  ──► move org-ai-kb docs to run root
        ├── Stage 2 (post-run tests, embedded in Stage 1)
        ├── Stage 3 (quantitative)
        ├── Stage 4 (contract, if --openapi provided)
        ├── Stage 5 (qualitative)
        ├── Stage 6 (report)
        └── print summary, exit 0 if all pass
```

`_find_aidlc_docs()` is used at Stage 5 to locate aidlc-docs regardless of whether they landed at the run root or under `workspace/org-ai-kb/aidlc-docs/`.

### 6.2 `run_cli_evaluation.py` — CLI Adapter Pipeline

```text
parse CLI args (--cli, --kiro-dist, --claude-dist, --rules-path, ...)
  │
  ├── --list ──► show adapter registry ──► exit
  ├── --check-only ──► check prerequisites ──► exit
  │
  └── run mode
        ├── _setup_rules() ──► git clone or copy to output_dir/aidlc-rules/
        ├── resolve kiro_dist_path / claude_dist_path (arg or auto-detect)
        ├── adapter.run(config) ──► workspace/ + aidlc-docs/ produced
        ├── _normalize_run_folder() ──► clean workspace, copy inputs to root
        ├── run_post_tests() ──► test-results.yaml
        └── run_evaluation.py --evaluate-only ──► stages 3–6
```

### 6.3 `run_batch_evaluation.py` — Multi-Model Loop

Runs `run_evaluation.py` as a subprocess for each selected model config:

```text
discover_models()     ← scans config/*.yaml, excludes default.yaml
  │
  for each model:
  ├── build CLI command with --executor-model override
  ├── run as subprocess, capture stdout/stderr to log file
  ├── find new timestamped run folder (via .last_run_folder sentinel)
  ├── rename folder: <timestamp>-<pid>-<slug>-<model-name>
  └── write per-model batch-summary.yaml
  │
  write batch-summary.yaml with timing and pass/fail for all models
```

### 6.4 `run_comparison_report.py` — Cross-Run Comparison

Generates a side-by-side comparison matrix across multiple completed runs. Used after a batch evaluation or to compare across any set of run folders.

```text
scan runs/ for model-specific subdirectories
  │
  for each model run:
  └── collect() + extract_baseline() → BaselineMetrics (~30 numeric fields)
  │
  load golden.yaml baseline
  │
  generate_comparison_markdown()   → comparison-report.md
  generate_comparison_yaml()       → comparison-data.yaml
```

The comparison table spans ~30 metrics: unit tests, contract tests, code quality, qualitative scores, artifact counts, execution cost, and context size — with delta indicators relative to the golden baseline. This path **reads existing run artifacts only** — it never re-executes anything.

### 6.5 `run_trend_report.py` — Cross-Release Trend Reports

Delegates to the `trend_reports` package to generate trend analysis across multiple AIDLC rules releases. Compares key metrics over time to surface regressions or improvements as the rules evolve.

```text
python -m trend_reports trend --baseline golden.yaml [--format html] [--gate]
  │
  read multiple run folders (one per release/tag)
  │
  compute metric deltas across releases
  │
  write trend-report.md / trend-report.html
```

The `--gate` flag exits non-zero if any metric regressed beyond threshold — suitable for CI use.

### 6.6 `run_extension_test.py` — Extension Hook Testing

Tests the impact of AIDLC rules extensions by running two evaluations back-to-back with different opt-in configurations (`all-extensions` vs `no-extensions`) and generating a comparison report.

```text
for each config (all-extensions, no-extensions):
  ├── run_evaluation.py with --rules-ref feat/extension_hook_question_split
  ├── rename run folder: <timestamp>-ext-<config-name>
  └── collect metrics
  │
generate_extension_comparison()  → extension-comparison/
  ├── extension-test-summary.yaml
  └── extension-test-report.md
```

---

## 7. Stage-by-Stage Pipeline Design

### 7.1 Stage 1: Execution

See Section 4 for the two execution paths (Strands Swarm and CLI Harness).

**Resilience:** If the Strands swarm exits non-zero but AIDLC documents were produced, evaluation continues — the swarm may fail on a late handoff after all documents are written.

### 7.2 Stage 2: Post-Run Tests

`post_run.py` auto-detects and runs the project's test suite:

1. BFS scan of `workspace/` for marker files (`pyproject.toml`, `package.json`, etc.)
2. Install dependencies (`uv sync`, `npm install`, etc.)
3. Run tests (`uv run pytest`, `npm test`, etc.)
4. Parse output → `test-results.yaml`

### 7.3 Stage 3: Quantitative Analysis (`packages/quantitative`)

| Project Type | Linter | Security Scanner    | Duplication |
| ------------ | ------ | ------------------- | ----------- |
| Python       | ruff   | bandit + semgrep\*  | PMD CPD     |
| Node.js      | eslint | npm audit + semgrep | PMD CPD     |

\* semgrep targets `src/` when present to avoid scanning `.venv/`.

Output: `quality-report.yaml`

### 7.4 Stage 4: Contract Tests (`packages/contracttest`)

Starts the generated application in an isolated venv, then validates every endpoint in the OpenAPI spec against the `x-test-cases` extensions.

The server startup uses `uv sync` inside the workspace project's own directory — isolated from the evaluator's own dependencies.

Output: `contract-test-results.yaml`

### 7.5 Stage 5: Qualitative Evaluation (`packages/qualitative`)

Compares generated AIDLC docs against the golden baseline using LLM-based semantic scoring.

**Document matching:** Two passes:

1. **Exact path match** — after normalizing v2 intent prefixes (`intent-NNN-<slug>/`) and unit names (`construction/<unit>/` → `construction/_unit_/`)
2. **LLM-assisted match** — for remaining unmatched candidate docs, asks the LLM "which golden doc best matches this?" Handles numbered stage names (`01-requirements-analysis/`) and renamed files across v1/v2 structure differences

**Scoring dimensions:**

| Dimension         | Weight | What It Measures                        |
| ----------------- | ------ | --------------------------------------- |
| Intent Similarity | 0.4    | Same goals, requirements, purpose       |
| Design Similarity | 0.4    | Same architecture, components, patterns |
| Completeness      | 0.2    | Candidate covers all reference topics   |

Output: `qualitative-comparison.yaml`

### 7.6 Stage 6: Report Generation (`packages/reporting`)

Collects all YAML artifacts and generates Markdown + HTML reports with:

- Verdict table (unit tests, contracts, code quality, qualitative, time, tokens)
- Per-stage breakdown
- Baseline comparison deltas (vs `golden.yaml`)
- Collapsible per-document qualitative scores

---

## 8. Data Flow

Every stage communicates through YAML files. No in-memory state crosses stage boundaries.

```text
Stage 1 (execution)
  ├── writes: run-meta.yaml, run-metrics.yaml, test-results.yaml
  └── writes: aidlc-docs/**/*.md, workspace/**/*

Stage 3 (quantitative)  reads: workspace/
  └── writes: quality-report.yaml

Stage 4 (contract)      reads: workspace/, openapi.yaml
  └── writes: contract-test-results.yaml

Stage 5 (qualitative)   reads: aidlc-docs/, golden-aidlc-docs/
  └── writes: qualitative-comparison.yaml

Stage 6 (report)        reads: all of the above + golden.yaml
  └── writes: report.md, report.html
```

---

## 9. Key Data Models

### 9.1 Run Metrics (`run-metrics.yaml`)

```yaml
tokens:
  total:
    {
      input_tokens,
      output_tokens,
      total_tokens,
      cache_read_tokens,
      cache_write_tokens,
    }
  per_agent:
    executor: { input_tokens, output_tokens, total_tokens } # or "orchestrator" in V2
    simulator: { input_tokens, output_tokens, total_tokens }
  repeated_context: { input_tokens, output_tokens, total_tokens }
  api_total: { input_tokens, output_tokens, total_tokens }
timing:
  total_wall_clock_ms: int
  handoffs: [{ handoff: int, node_id: str, duration_ms: int }, ...]
handoff_patterns:
  total_handoffs: int
  sequence: [str, ...]
  per_agent: { agent: { turn_count, total_duration_ms, avg_turn_duration_ms } }
artifacts:
  workspace:
    { source_files, test_files, config_files, total_files, total_lines_of_code }
  aidlc_docs: { inception_files, construction_files, total_files }
errors: throttle_events, timeout_events, failed_tool_calls, model_error_events, ...
context_size:
  total: { min_tokens, max_tokens, avg_tokens, median_tokens, sample_count }
  per_agent: { executor: { ... }, simulator: { ... } }
```

Note: In V2 Strands mode, the orchestrator's tokens are recorded under `per_agent.orchestrator` and aliased to `executor` by the reporting layer for baseline compatibility.

### 9.2 Qualitative Scores (`qualitative-comparison.yaml`)

```yaml
overall_score: float
reference_path: str
candidate_path: str
phases:
  - phase: inception
    avg_intent: float
    avg_design: float
    avg_completeness: float
    avg_overall: float
    documents:
      - relative_path: str
        intent_similarity: float
        design_similarity: float
        completeness: float
        overall: float
        notes: str
unmatched_reference: [str, ...]
unmatched_candidate: [str, ...]
```

### 9.3 Golden Baseline (`golden.yaml`)

A flat numeric snapshot of ~30 key metrics from a promoted run. Used for regression comparison. Fields span execution cost, artifacts, test results, code quality, and qualitative scores.

---

## 10. Test Cases

```text
test_cases/<case-name>/
  ├── vision.md               # Project vision
  ├── tech-env.md             # Technical environment constraints
  ├── openapi.yaml            # API contract spec with x-test-cases
  ├── golden-aidlc-docs/      # Reference AIDLC output (full v2 lifecycle)
  │   ├── inception/
  │   │   ├── requirements-analysis/
  │   │   ├── story-generation/
  │   │   ├── domain-design/
  │   │   ├── units-generation/
  │   │   └── contract-design/
  │   └── construction/
  │       └── sci-calc/
  │           ├── functional-design/
  │           ├── nfr-design/
  │           ├── code-generation/
  │           └── build-and-test/
  ├── golden.yaml             # Promoted baseline metrics
  └── scenario.yaml           # Scenario metadata
```

Available test cases: `sci-calc-v2` (the canonical v2 golden master; default for all runs).

---

## 11. Security

### 11.1 File Sandboxing

All file operations by AI agents use `_resolve_safe(run_folder, path)` — resolves the path and verifies it stays within the run folder. Path traversal attempts are rejected.

### 11.2 Command Sandboxing

`run_command` sets a restricted environment: only `PATH`, `HOME` (set to run folder), `LANG`, `TERM`, plus tool-specific vars (`UV_CACHE_DIR`, etc.). Commands have a configurable timeout (default 120s). Output truncated at 50K characters. Uses `shell=True` to support compound commands (`&&`, pipes).

### 11.3 Contract Test Server Isolation

Each contract test run creates an isolated venv inside the workspace project directory, preventing the package manager from resolving the evaluator's own dependencies.

---

## 12. Extension Points

### Adding a New CLI Adapter

1. Create `packages/cli-harness/src/cli_harness/adapters/<name>.py`
2. Implement `CLIAdapter` (`name`, `check_prerequisites`, `run`)
3. Register in `packages/cli-harness/src/cli_harness/registry.py`

### Adding a New IDE Adapter

1. Create `packages/ide-harness/src/ide_harness/adapters/<name>.py`
2. Implement `IDEAdapter` (`name`, `check_prerequisites`, `run`)
3. Register in `packages/ide-harness/src/ide_harness/registry.py`

### Adding a New Model Config

1. Create `config/<model-name>.yaml` with `models.executor.model_id`
2. The batch runner auto-discovers it

### Adding a New Test Case

1. Create `test_cases/<case-name>/` with `vision.md`, `tech-env.md`, `openapi.yaml`
2. Run the full pipeline once: `uv run python run.py full --scenario <case-name> ...`
3. Run 5–10 times in parallel to generate consensus golden: `uv run python run.py full --scenario <case-name>` (workflow available)
4. Copy the consensus `aidlc-docs/` as `golden-aidlc-docs/`
5. Promote metrics: use `reporting.baseline.promote()` to create `golden.yaml`

---

## 13. Dependency Stack

| Component               | Technology                               |
| ----------------------- | ---------------------------------------- |
| Language                | Python 3.13+                             |
| Package manager         | uv (workspace mode)                      |
| AI orchestration        | Strands Agents SDK                       |
| CLI automation (kiro)   | kiro-cli subprocess                      |
| CLI automation (claude) | claude-agent-sdk                         |
| LLM provider            | Amazon Bedrock (boto3, global endpoints) |
| HTTP client             | httpx (contract tests)                   |
| ASGI server             | uvicorn >= 0.34.2 (contract test server) |
| Test framework          | pytest                                   |
| Serialization           | PyYAML                                   |
| Linting                 | ruff                                     |
| Security scanning       | bandit, semgrep                          |
| Duplication detection   | PMD CPD (external, optional)             |
| Report rendering        | pandoc / Chrome headless (PDF export)    |
