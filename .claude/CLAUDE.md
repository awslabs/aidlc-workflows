# Claude Code — Project Instructions

This file contains Claude Code-specific guidance for the `aidlc-workflows` repository.
For agent-agnostic instructions, see [AGENTS.md](../AGENTS.md) at the project root.

## Project settings

`.claude/settings.json` configures the contributor attribution statement that Claude
Code automatically appends to PR bodies. This keeps PRs compliant with the CI
`contributorStatement` check without manual copy-paste.

## Markdown-first repository

Nearly all content in this repo is Markdown. When making changes:

- Run `npx markdownlint-cli2 "**/*.md"` before committing
- Use `npx markdownlint-cli2 --fix "**/*.md"` for auto-fixable issues
- Refer to `.markdownlint-cli2.yaml` for the full rule configuration

## Evaluator workflow

The Python evaluator lives in `scripts/aidlc-evaluator/` and uses `uv` for dependency
management:

```bash
cd scripts/aidlc-evaluator && uv run pytest
```

## Key docs for context

When working on CI/CD, workflows, or release-related changes, read these first:

- `docs/ADMINISTRATIVE_GUIDE.md` — full CI/CD architecture, workflow reference,
  secrets, permissions, and release process
- `docs/DEVELOPERS_GUIDE.md` — local build instructions, security scanner details,
  and remediation/suppression patterns

When working on aidlc-rules content:

- `docs/WORKING-WITH-AIDLC.md` — how users interact with the AI-DLC methodology
- `docs/GENERATED_DOCS_REFERENCE.md` — full `aidlc-docs/` directory reference

When working on installation or setup instructions:

- `docs/writing-inputs/` — guides and examples for vision and technical environment
  documents

## Folder contract

The folder names `aidlc-rules/aws-aidlc-rules/` and
`aidlc-rules/aws-aidlc-rule-details/` are part of the public contract. Workshops,
tests, and `core-workflow.md` path resolution depend on these exact names. Do not
rename, move, or reorganize them.
