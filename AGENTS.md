# AGENTS.md

## Project overview

AI-DLC (AI-Driven Development Life Cycle) is a methodology for guiding AI coding
agents through structured software development workflows. This repository contains
the core workflow rules, detailed phase-specific rules, and an evaluator framework.

The distributable product is the `aidlc-rules/` directory, which is zipped and
published via GitHub Releases.

## Repository structure

```text
aidlc-rules/
├── aws-aidlc-rules/              # Core workflow entry point (DO NOT rename)
│   └── core-workflow.md
└── aws-aidlc-rule-details/       # Detailed rules referenced by the workflow (DO NOT rename)
    ├── common/                   # Shared guidance across all phases
    ├── inception/                # Planning and architecture rules
    ├── construction/             # Design and implementation rules
    ├── extensions/               # Optional cross-cutting constraint rules
    └── operations/               # Deployment and monitoring rules
scripts/aidlc-evaluator/          # Python evaluation framework (uv-managed)
docs/
├── ADMINISTRATIVE_GUIDE.md       # CI/CD, workflows, secrets, release process
├── DEVELOPERS_GUIDE.md           # Local builds (CodeBuild, act), security scanners
├── WORKING-WITH-AIDLC.md         # User guide for the AI-DLC methodology
├── GENERATED_DOCS_REFERENCE.md   # Full aidlc-docs/ directory reference
└── writing-inputs/               # Guides and examples for vision/tech-env documents
.github/
├── workflows/                    # CI/CD pipelines (6 workflows)
├── pull_request_template.md      # PR template with contributor statement
└── labeler.yml                   # Auto-label rules (path → label mapping)
.claude/                          # Claude Code project settings
```

## Key documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution process and conventions
- [docs/ADMINISTRATIVE_GUIDE.md](docs/ADMINISTRATIVE_GUIDE.md) — CI/CD architecture,
  protected environments, secrets, permissions, and release process
- [docs/DEVELOPERS_GUIDE.md](docs/DEVELOPERS_GUIDE.md) — running CodeBuild locally,
  security scanner details and remediation instructions
- [docs/WORKING-WITH-AIDLC.md](docs/WORKING-WITH-AIDLC.md) — user guide for the
  AI-DLC methodology (context management, prompt patterns, phase walkthroughs)
- [docs/GENERATED_DOCS_REFERENCE.md](docs/GENERATED_DOCS_REFERENCE.md) — complete
  reference for the `aidlc-docs/` directory structure generated during workflows

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
- MD024 (duplicate headings) is disabled — section names repeat across platform guides
- MD036 (emphasis as heading) is disabled — bold text used as sub-labels in lists
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

## Security scanners

Six scanners run on every push to `main`, every PR, and daily. All HIGH and CRITICAL
findings must be remediated or have documented risk acceptance before merge.

| Scanner  | Detects                | Fails on                    | Config                                      |
| -------- | ---------------------- | --------------------------- | ------------------------------------------- |
| Bandit   | Python SAST issues     | High confidence findings    | `.bandit`                                   |
| Semgrep  | Multi-language SAST    | Any finding (PRs: new only) | `.semgrepignore`                            |
| Grype    | Dependency CVEs        | High/critical CVEs          | `.grype.yaml`                               |
| Gitleaks | Secrets in git history | Any non-baselined secret    | `.gitleaks.toml`, `.gitleaks-baseline.json` |
| Checkov  | IaC misconfigurations  | Any check failure           | `.checkov.yaml`                             |
| ClamAV   | Malware                | Any detection               | None                                        |

Inline suppression patterns:

- Bandit: `# nosec BXXX — justification`
- Semgrep: `# nosemgrep: rule-id — justification`
- Checkov: `# checkov:skip=CKV_ID:justification`

For full remediation and suppression details, see
[docs/DEVELOPERS_GUIDE.md](docs/DEVELOPERS_GUIDE.md#security-scanners).

## Important constraints

- The folder names `aws-aidlc-rules/` and `aws-aidlc-rule-details/` are part of the
  public contract — do not rename, move, or reorganize them
- Do not duplicate content across rules — place shared guidance in `common/` and
  reference it
- Keep the core methodology IDE/agent/model agnostic
- Security issues must be reported via
  [AWS vulnerability reporting](http://aws.amazon.com/security/vulnerability-reporting/),
  not public GitHub issues
- `CHANGELOG.md` is auto-generated by git-cliff — do not edit manually
