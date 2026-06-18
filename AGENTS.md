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
├── workflows/                    # CI/CD pipelines (8 workflows)
├── dependabot.yml                # Dependabot dependency update configuration
├── CODEOWNERS                    # Code ownership rules for PR reviews
├── ISSUE_TEMPLATE/               # Issue templates
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
- [docs/writing-inputs/](docs/writing-inputs/) — guides and examples for vision and
  technical environment documents

**Which docs to read by task type:**

- CI/CD, workflows, or releases → `ADMINISTRATIVE_GUIDE.md`, `DEVELOPERS_GUIDE.md`
- aidlc-rules content → `WORKING-WITH-AIDLC.md`, `GENERATED_DOCS_REFERENCE.md`
- Vision or technical environment documents → `docs/writing-inputs/`

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

## Agent-run snippets (added by Copilot)

Short guidance for agents: prefer the repository uv wrapper and npx-based tools. Read docs/DEVELOPERS_GUIDE.md and docs/ADMINISTRATIVE_GUIDE.md before running any commands.

Tests (uv):

```bash
uv run pytest
uv run pytest --cov --cov-report=term-missing
```

Markdown lint (npx):

```bash
npx markdownlint-cli2 "**/*.md"
npx markdownlint-cli2 --fix "**/*.md"
```

Dockerized security scans (recommended for local, cross-platform):

```bash
# Grype
docker run --rm -v "$PWD:/workspace" anchore/grype:latest grype dir:/workspace -o sarif=grype.sarif
# Gitleaks
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest detect --source /repo --report-format sarif --report-path gitleaks.sarif
# Semgrep
docker run --rm -v "$PWD:/src" returntocorp/semgrep semgrep --config=r/all --sarif /src > semgrep.sarif
# Checkov
docker run --rm -v "$PWD:/src" bridgecrew/checkov --directory /src --output-file-path checkov.sarif --output sarif
# Bandit
docker run --rm -v "$PWD:/src" python:3.12-slim bash -c "pip install -q bandit && bandit -r /src -f sarif -o /src/bandit.sarif"
# ClamAV
docker run --rm -v "$PWD:/data" mkodockx/docker-clamav clamscan -r /data --log=/data/clamdscan.txt
```

Notes:

- These commands write SARIF/text artifacts to the project root so CI/agents can consume them.
- CI already runs scanners; use these for local verification when Docker is available.
- If Docker is unavailable, use the platform-specific installs documented in docs/DEVELOPERS_GUIDE.md.
