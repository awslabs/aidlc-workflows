# Contributing Guidelines

Thank you for your interest in contributing to AI-DLC. Whether it's a bug report, new rule, correction, or documentation improvement, we value feedback and contributions from the community.

Please read through this document before submitting any issues or pull requests.

## Where the detailed guide lives

This file covers the project-wide conventions (reporting, PR flow, security, licensing). The authoritative, hands-on contributor guide — prerequisites, the edit → regenerate → test loop, and step-by-step recipes for adding a stage, scope, agent, or utility handler — is [`docs/reference/11-contributing.md`](docs/reference/11-contributing.md). Read it before making code changes.

For the path from PR review through nightly previews and stable publication,
see [Development and Releases](DEVELOPERS.md).

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

`main` is not production: PR CI runs contract checks, Linux smoke, unit shards
and integration tests, plus focused platform and production-guard checks.
`deterministic-tests.yml` supplies the shared test definition; nightly
`full-suite.yml` runs it across Linux, macOS and Windows alongside required live
coverage. Preview runs contract checks and Full Suite without repeating the PR
test matrix. Stable publication does not consume that evidence; it validates
the selected tag source and its newly built artifacts through `release.yml`.

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
decision; AIDA does not approve or merge the PR. The next action follows
finding severity alone: any open P0 or P1 finding means `author/change`; only
P2/P3 findings, or none, means `maintainer/merge`. Readiness and risk scores
explain the assessment to the maintainer and never change the action, so a P3
can never block a PR.

AIDA keeps one **findings ledger** comment per PR. Every finding gets a stable
id (`F1`, `F2`, …) anchored to the exact content of the lines it cites, so a
follow-up review recognizes the same finding across commits instead of
rediscovering it. Model output can match only open findings. Accepted and
rejected decisions persist when the model omits them, but model-selected ids
never inherit or reopen those decisions; any newly reported defect, including
one on the same exact lines, receives a new id. Maintainers with repository
write access act on findings by commenting on the PR. Commands go on the first
lines of the comment, one per line, and a line may name several findings:

```text
/aida accept F3 F7 we own this launch risk; tracked in #1290
/aida reject F5 documented behavior, not a defect
/aida reopen F2
/aida status
```

- `accept` — the named maintainer owns this risk; the finding stays visible
  under *Accepted risks* in every later review and no longer affects the next
  action. P0 and P1 findings can be accepted but not rejected.
- `reject` — not a defect; AIDA stops reporting it while the cited code is
  unchanged.
- `reopen` — reverse an accept or reject. A resolved finding cannot be
  reopened; a review re-establishes it if it still applies.
- `status` — re-render the ledger.
- `full` — make the next review cover the whole head instead of only the lines
  changed since the last review (see below).

A comment is applied all-or-nothing: if one line is invalid (an unknown
command, a missing reason, a reason over 500 characters, a rejected P0/P1),
nothing is applied and AIDA replies naming the line. The workflow verifies the commenter's
permission through GitHub's collaborators API before applying anything and
reacts 👍 (applied), 👎 (no write access), or 😕 (usage error, with a reply).
After a command changes the ledger, AIDA re-derives the decision for the
reviewed head from persisted state under the same rule the review uses (only
open P0/P1 findings decide; readiness and risk stay informational) and
refreshes the managed labels. When that
decision is `maintainer/merge`, it dismisses its own `CHANGES_REQUESTED`
review so the head can proceed without an artificial commit; when a `reopen`
turns it back into `author/change`, it posts a blocking review for the head.
The check of the original review run is not rewritten. Review and command
workflows share one non-cancelling per-PR execution group, so opposing verdict
mutations are serialized. On every later review the judge must dispose of each open ledger entry:
*still-open* (restating it under the same id, whatever the new wording or
lines) or *resolved* (the head corrected it). A restatement never opens a new
id for a defect an open entry already names. An open P0/P1 the judge leaves
undisposed while at least one of its cited lines is provably unchanged is
*retained*: it stays in the review and keeps the next action with the author
until the code changes, the judge disposes of it, or a maintainer accepts it. It is also retained when a current,
evaluable anchor has an unknown result. A finding resolves when all current,
evaluable anchors are gone; legacy-only identity anchors do not keep it open.

The active ledger holds up to 200 findings. When it is full, resolved entries
are removed first; decided entries move to an archive that keeps their ids,
exact anchors, and maintainer decisions available for later reviews. If the
200-decision archive or the ledger byte limit is exhausted, AIDA refuses the
new write instead of discarding an authoritative decision.

After its first review of a PR, AIDA reviews **incrementally**: the direction,
user-experience, and AIDLC lenses and the judge's non-security categories only
cover the lines of the PR diff that changed since the head AIDA last reviewed;
the code that did not change was reviewable then and its findings are in the
ledger; lines or files deleted since, and renamed files, stay in scope. The
security and prompt-attack lenses always review the full head and emit
structured evidence, and a finding on a line or file they cited is never
deferred whatever category the judge assigns it. A non-security
finding the judge still reports on unchanged lines is listed under *Deferred*
and never affects the decision. The review header states the scope.
AIDA falls back to a full review on the first review, after a force-push, or
when a maintainer comments `/aida full`.

The ledger comment carries a digest of its data. Do not edit it: AIDA refuses
to run on an edited or unreadable ledger and says so. To recover, restore the
body from the comment's edit history or delete the comment to start a fresh
ledger (earlier reviews keep every finding). Decisions written anywhere other
than through these commands are not decisions to AIDA.

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
