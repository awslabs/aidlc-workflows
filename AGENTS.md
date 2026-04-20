# AGENTS.md

## Project overview

AI-DLC (AI-Driven Development Life Cycle) is a methodology for guiding AI coding
agents through structured software development workflows. This repository contains
the core workflow rules, detailed phase-specific rules, and an evaluator framework.

## Repository structure

```text
aidlc-rules/
├── aws-aidlc-rules/            # Core workflow entry point (DO NOT rename)
│   └── core-workflow.md
└── aws-aidlc-rule-details/     # Detailed rules referenced by the workflow (DO NOT rename)
    ├── common/                 # Shared guidance across all phases
    ├── inception/              # Planning and architecture rules
    ├── construction/           # Design and implementation rules
    ├── extensions/             # Optional cross-cutting constraint rules
    └── operations/             # Deployment and monitoring rules
scripts/aidlc-evaluator/        # Python evaluation framework (uv-managed)
.github/workflows/              # CI/CD pipelines
docs/                           # Project documentation and guides
```

## Setup commands

```bash
# Lint all markdown files
npx markdownlint-cli2 "**/*.md"

# Fix markdown lint issues automatically
npx markdownlint-cli2 --fix "**/*.md"

# Run evaluator tests (from scripts/aidlc-evaluator/)
cd scripts/aidlc-evaluator && uv run pytest
```

## Code style

- All content is Markdown — follow the `.markdownlint-cli2.yaml` configuration
- MD013 (line length) is disabled — long URLs, tables, and code examples are acceptable
- MD033 (inline HTML) is disabled — `<img>` tags are used for screenshots
- MD060 (table alignment) is enforced — table pipes must be vertically aligned
- MD040 (fenced code language) is enforced — always specify a language on code fences
- Commit messages follow [conventional commits](https://www.conventionalcommits.org/)
  (e.g., `feat:`, `fix:`, `docs:`, `chore:`)

## Testing instructions

- Test rule changes with at least one supported platform (Amazon Q Developer, Kiro,
  Cursor, Cline, Claude Code, or GitHub Copilot) before submitting
- If adding or updating installation instructions, test on macOS, Windows CMD, and
  Windows PowerShell
- Run `npx markdownlint-cli2 "**/*.md"` before committing to catch lint issues
- The pre-commit hook runs markdownlint automatically if configured

## PR instructions

- PR titles must follow conventional commits format (e.g., `fix: description`)
- Always include this contributor statement at the end of the PR body:

  > By submitting this pull request, I confirm that you can use, modify, copy,
  > and redistribute this contribution, under the terms of the
  > [project license](https://github.com/awslabs/aidlc-workflows/blob/main/LICENSE).

- CI enforces: conventional commit title, contributor statement, markdownlint, and
  a do-not-merge label check
- Use the structure from `.github/pull_request_template.md`

## Important constraints

- The folder names `aws-aidlc-rules/` and `aws-aidlc-rule-details/` are part of the
  public contract — do not rename, move, or reorganize them
- Do not duplicate content across rules — place shared guidance in `common/` and
  reference it
- Keep the core methodology IDE/agent/model agnostic
- Security issues must be reported via
  [AWS vulnerability reporting](http://aws.amazon.com/security/vulnerability-reporting/),
  not public GitHub issues
