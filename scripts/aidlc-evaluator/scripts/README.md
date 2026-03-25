# AIDLC Evaluation Scripts

This directory contains the specialized run scripts for the AIDLC evaluation framework.

## Overview

All run scripts have been consolidated into this `scripts/` directory for better organization. The main entry point is now `run.py` in the repository root, which dispatches to these specialized scripts based on the evaluation mode.

## Scripts

### Core Evaluation Scripts

- **run_evaluation.py** - Full evaluation pipeline (execute AIDLC workflow + score outputs)
  - Orchestrates all 6 stages: execution, post-run tests, quantitative analysis, contract tests, qualitative evaluation, and reporting
  - Can run in test mode with `--test` flag

- **run_cli_evaluation.py** - CLI-based evaluation
  - Runs evaluation through CLI AI assistants (kiro-cli, claude-code, etc.)
  - Uses adapters from `packages/cli-harness`

- **run_ide_evaluation.py** - IDE-based evaluation
  - Runs evaluation through IDE AI assistants (cursor, cline, kiro)
  - Uses adapters from `packages/ide-harness`

### Batch Processing Scripts

- **run_batch_evaluation.py** - Batch evaluation runner
  - Runs AIDLC evaluation across multiple Bedrock models sequentially
  - Reads model configs from `config/` directory
  - Delegates to `run_evaluation.py` for each model

- **run_comparison_report.py** - Cross-model comparison
  - Aggregates results from batch runs
  - Generates comparison matrices in Markdown and YAML formats
  - Compares against golden baseline

- **run_extension_test.py** - Extension hook testing
  - Tests AIDLC evaluations with different extension opt-in configurations
  - Runs multiple evaluations with "all yes" vs "all no" opt-in answers
  - Generates comparison report showing impact of extension choices
  - Uses the extension hook feature branch (feat/extension_hook_question_split)

### Trend Reporting

- **run_trend_report.py** - Cross-release trend report generation
  - Fetches evaluation bundles from GitHub releases and Actions artifacts
  - Generates HTML, Markdown, and YAML trend reports comparing metrics across releases
  - Uses the `packages/trend-reports` package
  - Executive summary cards show: Qualitative Score, Contract Tests, Unit Test pass rate (%), Lint Findings, Execution Time, and Total Tokens
  - Execution Time and Total Tokens are "lower is better" metrics (shown with green indicators since lower values are desirable)

## Usage

### Using the Master Entry Point (Recommended)

The recommended way to run evaluations is through the master `run.py` script in the repository root:

```bash
# Full pipeline evaluation
python run.py full --vision test_cases/sci-calc/vision.md

# CLI evaluation
python run.py cli --cli kiro-cli --scenario sci-calc

# IDE evaluation
python run.py ide --ide cursor --scenario sci-calc

# Batch evaluation across models
python run.py batch --models all --scenario sci-calc

# Generate comparison report
python run.py compare --scenario sci-calc

# Test extension hooks (all yes vs all no)
python run.py ext-test --scenario sci-calc

# Generate trend report across releases
python run.py trend --baseline test_cases/sci-calc/golden.yaml

# Run tests
python run.py test
```

### Direct Script Invocation

Scripts can also be invoked directly if needed:

```bash
# Full evaluation
python scripts/run_evaluation.py --vision test_cases/sci-calc/vision.md

# CLI evaluation
python scripts/run_cli_evaluation.py --cli kiro-cli --scenario sci-calc

# Batch evaluation
python scripts/run_batch_evaluation.py --models all --scenario sci-calc

# Extension hook testing
python scripts/run_extension_test.py --scenario sci-calc

# Trend report
python scripts/run_trend_report.py --baseline test_cases/sci-calc/golden.yaml
```

## Path Resolution

All scripts properly resolve paths relative to the repository root, so they work correctly whether invoked:
- Through the master `run.py` dispatcher
- Directly from the repository root
- Directly from the `scripts/` directory

## Architecture Notes

- **REPO_ROOT**: All scripts use `Path(__file__).resolve().parent.parent` to locate the repository root
- **Output**: Run outputs go to `runs/<scenario>/` by default
- **Config**: Configuration files are read from `config/` in the repository root
- **Test Cases**: Test case scenarios are located in `test_cases/` in the repository root
