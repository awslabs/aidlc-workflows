# AI-DLC Evaluation Framework - File Structure

```
aidlc-regression/
├── README.md                          # Project overview
├── VISION.md                          # Project vision and goals
├── FAQ.md                             # Frequently asked questions
├── OPERATING_PRINCIPLES.md            # Decision-making guidelines
├── CONTRIBUTING.md                    # Contribution guidelines
├── pyproject.toml                     # Workspace configuration
├── uv.lock                           # Dependency lock file
│
├── aidlc-runner/                      # Execution framework (two-agent AIDLC runner)
│   ├── pyproject.toml
│   ├── config/
│   │   └── default.yaml
│   ├── src/
│   │   └── aidlc_runner/
│   │       ├── cli.py                # CLI entry point
│   │       ├── config.py             # Configuration loading
│   │       ├── runner.py             # Orchestration core
│   │       ├── metrics.py            # NFR metrics collection
│   │       ├── post_run.py           # Post-run test evaluation
│   │       ├── progress.py           # Progress handlers
│   │       ├── agents/               # Executor and simulator agent factories
│   │       └── tools/                # Sandboxed file ops, rule loader, run_command
│   ├── tests/
│   └── planning/                     # Phase plans and backlog
│
├── packages/                          # Evaluation packages (monorepo)
│   ├── qualitative/                   # Semantic evaluation
│   │   ├── pyproject.toml
│   │   ├── src/
│   │   │   └── qualitative/
│   │   │       ├── __init__.py
│   │   │       ├── comparator.py     # Comparison orchestration
│   │   │       ├── document.py       # Document loading and phase mapping
│   │   │       ├── scorer.py         # Scoring protocol + implementations
│   │   │       └── models.py         # Result data models
│   │   └── tests/
│   │
│   ├── quantitative/                  # Code evaluation
│   │   ├── pyproject.toml
│   │   └── src/
│   │       └── quantitative/
│   │           ├── __init__.py
│   │           ├── linting.py        # Ruff/eslint checks
│   │           ├── security.py       # Semgrep/bandit integration
│   │           └── organization.py   # Code duplication, structure
│   │
│   ├── nonfunctional/                 # NFR evaluation
│   │   ├── pyproject.toml
│   │   └── src/
│   │       └── nonfunctional/
│   │           ├── __init__.py
│   │           ├── tokens.py         # Token consumption tracking
│   │           ├── timing.py         # Execution time measurement
│   │           └── consistency.py    # Cross-model consistency
│   │
│   ├── reporting/                     # Report generation
│   │   ├── pyproject.toml
│   │   └── src/
│   │       └── reporting/
│   │           ├── __init__.py
│   │           └── generate.py       # Main report generator
│   │
│   └── shared/                        # Common utilities
│       ├── pyproject.toml
│       └── src/
│           └── shared/
│               └── __init__.py
│
├── test_cases/                        # Golden test cases (AIDLC inputs)
│   ├── instructions.md
│   └── sci-calc/
│       ├── vision.md
│       └── tech-env.md
│
├── runs/                              # Evaluation run outputs
│   └── {timestamp}-{uuid}/
│       ├── run-meta.yaml
│       ├── run-metrics.yaml
│       ├── test-results.yaml
│       ├── vision.md
│       ├── tech-env.md
│       ├── aidlc-docs/               # Generated AIDLC documentation
│       └── workspace/                # Generated application code
│
├── writing-inputs/                    # Guides for writing vision/tech-env docs
│
├── overall_project/                   # Broader project tenets and strategy
│
└── docs/                              # Additional documentation
```

## Big Rocks → Package Mapping

```
1. Golden Test Case        → test_cases/
2. Execution Framework     → aidlc-runner/
3. Semantic Evaluation     → packages/qualitative/
4. Code Evaluation         → packages/quantitative/
5. NFR Evaluation          → packages/nonfunctional/
6. GitHub CI/CD            → .github/workflows/  (planned)
```

## Package Dependencies

```
aidlc-runner (standalone — runs the AIDLC workflow and produces run folders)

qualitative
├── shared
quantitative
├── shared
nonfunctional
├── shared
reporting
├── shared
├── qualitative  (reads semantic evaluation results)
├── quantitative (reads code evaluation results)
└── nonfunctional (reads NFR results)
```

## Key Design Decisions

1. **Monorepo with uv workspace:** Simplifies dependency management and cross-package development
2. **Python 3.13:** Latest stable Python with modern features
3. **Separate packages by evaluation type:** Clear separation of concerns, independent evolution
4. **aidlc-runner as execution engine:** Produces run folders that evaluation packages consume
5. **Golden test cases as versioned inputs:** Reproducible, curated baselines for consistent evaluation
6. **Shared utilities package:** Common code reused across all evaluation packages
7. **Reporting aggregates all:** Single entry point for generating comprehensive reports
