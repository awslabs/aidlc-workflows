# Contributing Guidelines

Thank you for your interest in contributing to AI-DLC. Whether it's a bug report, new rule, correction, or documentation improvement, we value feedback and contributions from the community.

Please read through this document before submitting any issues or pull requests.

## Where the detailed guide lives

This file covers the project-wide conventions (reporting, PR flow, security, licensing). The authoritative, hands-on contributor guide — prerequisites, the edit → regenerate → test loop, and step-by-step recipes for adding a stage, scope, agent, or utility handler — is [`docs/reference/11-contributing.md`](docs/reference/11-contributing.md). Read it before making code changes.

## How this repository is built

AI-DLC ships to many CLI harnesses (today Claude Code, Kiro CLI, Kiro IDE, Codex CLI, opencode, and GitHub Copilot) from a single hand-authored source. The layout has three zones:

- **`core/`** — the harness-neutral source of truth (tools, stages, agents, rules, scopes, sensors, knowledge, hooks, session skills). **Edit here.**
- **`harness/<name>/`** — the thin per-harness surface (`manifest.ts`, the orchestrator skill, harness-specific files). **Edit here.**
- **`dist/<harness>/`** — generated, committed, and drift-guarded. **Never hand-edit** — `bun scripts/package.ts --check` fails CI on any drift.

After editing `core/` or `harness/<name>/`, regenerate the distributions:

```bash
bun scripts/package.ts            # regenerate every dist/<harness>/
bun scripts/package.ts --check    # byte-parity drift guard (run in CI)
```

Adding a whole new harness? See [Porting to a New Harness](docs/harness-engineering/09-porting-to-a-new-harness.md).

## AI-DLC Authoring Principles

AI-DLC separates stages, agents, skills, templates, and artifacts. Each concept has one job. Keep those boundaries clear so workflows remain adaptive and the generated runtime stays consistent.

- **Stages own workflow placement**: stage definitions are the source of truth for owners, contributors, reviewers, inputs, and outputs. Do not repeat stage ownership in agents or skills.
- **Agents own identity**: agent personas describe perspective, behaviour, judgment style, and associated reusable skills. They should not list stage ownership, contributor mappings, or reviewer mappings.
- **Skills are transferable capabilities**: a skill defines reusable expertise — definition, principles, patterns, and application. Avoid tying a skill to one agent or one stage.
- **Avoid stage leakage in skills**: prefer wording like "applies wherever contracts are designed or reviewed" over "applied by the architect at functional-design."
- **Artifacts flow by identity**: later stages copy forward upstream blueprint artifacts and expand them in place. Preserve stable IDs, names, boundaries, responsibilities, and dependency directions.
- **Required means required knowledge**: stage inputs describe concerns the stage must understand, not hard dependencies on exact upstream paths unless explicitly marked non-skippable.
- **Use artifact roles over rigid filenames**: a stage should resolve "functional behaviour" or "blueprint identity" from the richest available upstream artifact rather than fail because a preferred file is missing.
- **Keep abstraction levels clean**: early stages stay conceptual; functional design adds logical behaviour; NFR and infrastructure stages add quality and physical deployment detail; code generation adds implementation.
- **Templates match stage granularity**: templates should ask for the level of detail appropriate to their stage. Do not ask domain-design for database tables, IaC, or framework details.
- **Generated resources must resolve**: runtime resources must point only to files that exist. Planned future skills may be listed as backlog intent, but generated resource references must be resolvable.

## Pull Request Checklist

Before submitting a PR, verify:

- You edited the hand-authored source in `core/` or `harness/<name>/`, **not** `dist/`.
- You ran `bun scripts/package.ts` and committed the regenerated `dist/` trees alongside your source change.
- `bun scripts/package.ts --check` reports no drift.
- `bun tests/run-tests.ts` passes (see [Testing](docs/reference/09-testing.md)).
- User-visible changes bump `core/tools/aidlc-version.ts`, the README version badge, and add a matching `CHANGELOG.md` entry in the same commit (see the Changelog Policy in [`AGENTS.md`](AGENTS.md)).
- Stale stage names, paths, or flags do not remain in examples, docs, or generated output (grep `docs/` and `README.md` when renaming anything).

## Testing Changes

Run the suite before submitting:

```bash
bun tests/run-tests.ts               # default: smoke + unit + integration
bun tests/run-tests.ts --release     # + e2e (full acceptance)
```

Describe what you tested in your PR. If you're adding or updating installation instructions, ensure you've tested them on macOS, Windows CMD, and Windows PowerShell.

## Reporting Bugs/Feature Requests

Use GitHub issues to report bugs or suggest features. Before filing, check existing issues to avoid duplicates.

Include:

- Which rule, stage, agent, or harness is affected
- Expected vs actual behavior
- The platform, harness, and model you tested with

## Contributing via Pull Requests

### Start with an issue

We encourage opening an issue before working on a PR. It helps us and the community understand what you have in mind, discuss the approach, and align on scope before you invest time writing code. For small fixes like typos or lint corrections, feel free to go straight to a PR.

### AI-generated contributions

PRs produced by AI coding agents are welcome and follow the same process. Start with an issue, align on scope, and meet the quality bar.

### Submitting your PR

1. Work against the latest `main` branch
2. Check existing open and recently merged PRs
3. Fork the repository
4. Make your changes (keep them focused)
5. Use clear commit messages following [conventional commits](https://www.conventionalcommits.org/) (e.g., `feat:`, `fix:`, `docs:`)
6. Submit the PR and respond to feedback

### PR closure

We review every PR and want to help contributions land. To maintain project quality, we may close PRs that are out of scope or don't follow the guidelines described here. If that happens, you're always welcome to open an issue and try again.

## Code of Conduct

This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct).

For more information see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact <opensource-codeofconduct@amazon.com> with any additional questions or comments.

## Security Issue Notifications

If you discover a potential security issue, notify AWS/Amazon Security via the [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Please do not create a public GitHub issue.

## Licensing

See the [LICENSE](LICENSE) file for our project's licensing. We will ask you to confirm the licensing of your contribution.
