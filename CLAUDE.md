# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

AI-DLC Workflows is a distributable methodology for guiding AI coding agents through structured software development workflows. The **product** is the `aidlc-rules/` directory — markdown rule files that get copied into AI coding agent configuration directories (`.cursor/rules/`, `.kiro/steering/`, `.claude/`, etc.). The `scripts/aidlc-evaluator/` contains the evaluation framework for validating workflow quality.

## Commands

### Markdown Linting (primary CI check)

```bash
# Lint all markdown files
npx markdownlint-cli2 "**/*.md"

# Auto-fix markdown issues
npx markdownlint-cli2 --fix "**/*.md"
```

### Evaluator (from `scripts/aidlc-evaluator/`)

```bash
# Install dependencies (requires Python 3.13+, uv)
uv sync

# Run unit tests
uv run pytest

# Run a single test file
uv run pytest packages/qualitative/tests/test_evaluator.py

# Full evaluation pipeline (requires AWS Bedrock access)
uv run python run.py full \
  --vision test_cases/sci-calc/vision.md \
  --tech-env test_cases/sci-calc/tech-env.md \
  --golden test_cases/sci-calc/golden-aidlc-docs \
  --openapi test_cases/sci-calc/openapi.yaml

# Score an existing run without re-executing
uv run python run.py full \
  --evaluate-only runs/<run-folder>/aidlc-docs \
  --golden test_cases/sci-calc/golden-aidlc-docs
```

### Pre-commit Hook

```bash
pre-commit run --all-files
```

## Architecture

### Rule System (`aidlc-rules/`)

The distributable product has two layers:

- **`aws-aidlc-rules/core-workflow.md`** — The master orchestrator. This is what users install in their AI agent's rules directory. It loads phase-specific rules on demand and implements the adaptive decision logic for which stages to run.
- **`aws-aidlc-rule-details/`** — The detail rules, organized by phase:
  - `common/` — Loaded at every workflow start (welcome message, question format, session continuity, error handling, content validation)
  - `inception/` — Planning stages (workspace detection, requirements analysis, user stories, application design, reverse engineering, units generation, workflow planning)
  - `construction/` — Implementation stages (functional design, NFR requirements/design, infrastructure design, code generation, build & test)
  - `extensions/` — Optional constraints with paired `*.opt-in.md` files (security baseline, property-based testing)
  - `operations/` — Placeholder for future deployment/monitoring rules

**Extension loading pattern**: At workflow start, the orchestrator scans `extensions/` for `*.opt-in.md` files only (not full rules). These opt-in prompts are presented to users during Requirements Analysis. Full extension rules load only when a user opts in — conserving context tokens. Extensions without opt-in files are always enforced.

### Evaluator (`scripts/aidlc-evaluator/`)

A uv workspace with 11 packages coordinated by `run.py`. Key packages:

- `execution` — Orchestrates workflow runs against AI agents via `packages/ide-harness` or `packages/cli-harness`
- `qualitative` — LLM-based semantic scoring of generated documents against golden outputs
- `quantitative` — Static analysis (linting, security scanning, code duplication)
- `contracttest` — Validates generated API endpoints against OpenAPI spec
- `nonfunctional` — Token consumption, latency, cross-model consistency
- `reporting` — Aggregates results into Markdown and HTML reports
- `shared` — Common utilities and data models

Configuration lives in `config/default.yaml`.

### CI/CD (`.github/workflows/`)

Eight workflows with specific triggers:

| Workflow | Trigger | Key action |
|---|---|---|
| `ci.yml` | PR + push to main | Markdownlint |
| `pull-request-lint.yml` | PR | Enforce conventional commit title, labels, contributor statement |
| `security-scanners.yml` | Daily + PR + push | 6 scanners (Gitleaks, Semgrep, CodeQL, ClamAV, Trivy, Grype) |
| `codebuild.yml` | PR with `codebuild` label touching `aidlc-rules/` | Runs full evaluator pipeline via AWS CodeBuild |
| `release-pr.yml` | Manual dispatch | Generates CHANGELOG.md via git-cliff, opens release PR |
| `tag-on-merge.yml` | Release PR merge | Creates `vX.Y.Z` tag |
| `release.yml` | Tag push | Creates draft GitHub Release with zipped rules artifact |

The `codebuild` workflow requires both: (a) the `codebuild` label on the PR, and (b) paths under `aidlc-rules/` to be changed. It also requires manual environment approval.

## Conventions

**Commit format**: Conventional commits are enforced on PRs. Types used: `feat`, `fix`, `docs`, `test`, `chore`, `ci`, `build`, `perf`, `refactor`, `style`. The `CHANGELOG.md` is generated from these via git-cliff — do not hand-edit it.

**Markdown rules**: `.markdownlint-cli2.yaml` disables MD013 (line length), MD033 (inline HTML), MD024 (duplicate headings), and MD036 (emphasis as heading). MD060 (fenced code language) is enforced.

**PRs**: Must include the contributor statement (from `.github/pull_request_template.md`), must have a valid conventional commit title, and must have labels. Non-trivial changes should start with an issue.

**File tenets**: No duplication between rule files — single source of truth. Rules must be methodology-first and agent/model-agnostic. The same rule files must work across Cursor, Claude Code, Amazon Q Developer, Kiro, Cline, Copilot, and Codex.

## Key Docs for Context

- `docs/DEVELOPERS_GUIDE.md` — How to run CodeBuild locally, security scanner configuration
- `docs/ADMINISTRATIVE_GUIDE.md` — CI/CD architecture, secrets management, release process
- `docs/WORKING-WITH-AIDLC.md` — Interaction patterns and best practices for using the workflow
- `docs/GENERATED_DOCS_REFERENCE.md` — The `aidlc-docs/` output directory structure that workflow runs produce
- `AGENTS.md` — Repository overview and structural guidance for AI agents working in this repo
