# Contributing Guidelines

Thank you for your interest in contributing to AI-DLC. Whether it's a bug report, new rule, correction, or documentation improvement, we value feedback and contributions from the community.

Please read through this document before submitting any issues or pull requests.

## Where the detailed guide lives

This file covers the project-wide conventions (reporting, PR flow, security, licensing). The authoritative, hands-on contributor guide — prerequisites, the edit → regenerate → test loop, and step-by-step recipes for adding a stage, scope, agent, or utility handler — is [`docs/reference/11-contributing.md`](docs/reference/11-contributing.md). Read it before making code changes.

## How this repository is built

AI-DLC ships to many CLI harnesses (today Claude Code, Kiro CLI, Kiro IDE, Codex CLI, opencode, and GitHub Copilot) from a single hand-authored source. The layout has three zones:

- **`core/`** — the harness-neutral source of truth (tools, stages, agents, rules, scopes, sensors, knowledge, hooks, session skills). **Edit here.**
- **`harness/<name>/`** — the thin per-harness surface (`manifest.ts`, the orchestrator skill, harness-specific files). **Edit here.**
- **`dist/<harness>/`** — ignored local Bun copy-channel projection. **Never hand-edit or commit.**
- **`dist-release/<harness>/`** — ignored local native-`aidlc` release projection. **Never hand-edit or commit.**

Both generated trees are materialized from `core/` + `harness/`.
`bun scripts/package.ts --check` builds both channels twice in independent
temporary roots and fails if their bytes differ.

After editing `core/` or `harness/<name>/`, regenerate the distributions:

```bash
bun scripts/package.ts            # regenerate dist/ + dist-release/ for every harness
bun scripts/package.ts --check    # two-build determinism guard (run in CI)
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

- You edited the hand-authored source in `core/` or `harness/<name>/`, **not** `dist/` or `dist-release/`.
- You ran `bun scripts/package.ts` to materialize the ignored local projections.
- `bun scripts/package.ts --check` reports deterministic output.
- `bun tests/run-tests.ts` passes (see [Testing](docs/reference/09-testing.md)).
- Ordinary feature, fix, documentation, refactor, and test PRs leave `core/tools/aidlc-version.ts`, the README version badge, and `CHANGELOG.md` release entries unchanged. The release-preparation PR updates those three surfaces together (see the Release Metadata Policy in [`AGENTS.md`](AGENTS.md)).
- Stale stage names, paths, or flags do not remain in examples, docs, or generated output (grep `docs/` and `README.md` when renaming anything).
- If the change adds an input to any fingerprint, epoch, or receipt identity, the PR names the human-visible change that input detects (see the Authority Policy in [`docs/reference/11-contributing.md`](docs/reference/11-contributing.md#authority-policy)).

By maintainer decision on 2026-09-21, `main` is not production: PR CI stays fast
with contract checks, smoke, unit shards, native-terminal units and production
guards; deterministic and live deep tiers gate previews in `full-suite.yml`
called by `preview-release.yml`.

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

AIDA's pre-implementation review starts when a maintainer opens or updates an
issue, or when a human adds to its conversation. External issue conversations
require a maintainer to apply the `ai-review` opt-in label first. Maintainers can
also dispatch the **AI Issue Intent Review** workflow with an issue number. The
review evaluates the current issue and conversation for intent, project
direction, user experience, scope, feasibility, dependencies, and open
decisions. For a bug report, it may run up to five relevant existing tests in
an isolated, network-disabled test process and reports the bounded result as
evidence. It updates one advisory comment; it does not prioritize, approve,
reject, assign, close, or implement the issue. It also replaces deterministic
`aida:*` assessment labels after a successful review. The final assessment names
the next human decision: `author/clarify` when an aligned issue still has
blocking questions, `maintainer/direction` when the proposal conflicts with the
current AI-DLC direction, or `maintainer/plan` when the issue is ready to move
into planning or implementation. Planning requires alignment, no blocking
question, readiness of at least 4/5, and risk of at most 3/5.

After a successful Issue review, AIDA replaces its Issue assessment labels with
exactly one direction label (`aida:aligned` or `aida:not-aligned`) and, when
findings exist, the highest priority found (`aida:p0`, `aida:p1`, `aida:p2`, or
`aida:p3`). P0 and P1 block planning; P2 and P3 are bounded recommendations.
These labels describe AIDA's latest successful assessment and do not assign,
prioritize, close, or implement the Issue.

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

AIDA's PR review ends with an advisory next decision. `author/change` means the
author should address the reported gaps. `maintainer/merge` means the review
found no blocking issue and considers the PR ready for a maintainer's merge
decision; AIDA does not approve or merge the PR. The merge decision requires no
P0 or P1 finding, readiness of at least 4/5, and risk of at most 2/5.

Every PR review includes a User Experience section before its UX assessment.
For user-visible changes, it explains the affected user, the previous and
proposed experience, and a concise before/after example when useful.
Internal-only changes receive a brief no-user-visible-change explanation.

The PR workflow reflects its latest state through three label dimensions. A new
review clears all six managed labels. A successfully published
`author/change` review applies `aida:reviewed`, `next:author`, and
`action:change`; `maintainer/merge` applies `aida:reviewed`,
`next:maintainer`, and `action:merge`. A failed review applies only
`aida:review-error`. Canceled, skipped, and superseded runs do not replace a
newer state. The workflow creates missing managed labels with AIDA-specific
descriptions and stable colors, but does not overwrite metadata on labels that
already exist.

### PR closure

We review every PR and want to help contributions land. To maintain project quality, we may close PRs that are out of scope or don't follow the guidelines described here. If that happens, you're always welcome to open an issue and try again.

## Code of Conduct

This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct).

For more information see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact <opensource-codeofconduct@amazon.com> with any additional questions or comments.

## Security Issue Notifications

If you discover a potential security issue, notify AWS/Amazon Security via the [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Please do not create a public GitHub issue.

## Licensing

See the [LICENSE](LICENSE) file for our project's licensing. We will ask you to confirm the licensing of your contribution.
