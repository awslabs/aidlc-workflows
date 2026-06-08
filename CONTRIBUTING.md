# Contributing Guidelines

Thank you for your interest in contributing to AI-DLC. Whether it's a bug report, new rule, correction, or documentation improvement, we value feedback and contributions from the community.

Please read through this document before submitting any issues or pull requests.

## Tenets

Before contributing, familiarize yourself with our [tenets](README.md#tenets).

## AI-DLC Authoring Principles

AI-DLC separates stages, personas, skills, templates, and artifacts. Each concept has one job. Keep those boundaries clear so workflows remain adaptive and the generated runtime remains consistent.

- **Stages own workflow placement**: Stage definitions are the source of truth for owners, contributors, reviewers, inputs, and outputs. Do not repeat stage ownership in personas or skills.
- **Personas own identity**: Personas describe perspective, behaviour, judgment style, and associated reusable skills. They should not list stage ownership, contributor mappings, or reviewer mappings.
- **Skills are transferable capabilities**: A skill defines reusable expertise: definition, principles, patterns, and application. Avoid tying a skill to one persona or one stage.
- **Avoid stage leakage in skills**: Prefer wording like "applies wherever contracts are designed or reviewed" over "applied by Systems Architect at functional-design."
- **Artifacts flow by identity**: Later stages copy forward upstream blueprint artifacts and expand them in place. Preserve stable IDs, names, boundaries, responsibilities, and dependency directions.
- **Required means required knowledge**: Stage inputs describe concerns the stage must understand, not hard dependencies on exact upstream paths unless explicitly marked non-skippable.
- **Use artifact roles over rigid filenames**: A stage should resolve "functional behaviour" or "blueprint identity" from the richest available upstream artifact rather than fail because a preferred file is missing.
- **Keep abstraction levels clean**: Early stages stay conceptual. Functional design adds logical behaviour. NFR and infrastructure stages add quality and physical deployment detail. Code generation adds implementation.
- **Templates match stage granularity**: Templates should ask for the level of detail appropriate to their stage. Do not ask domain-design for database tables, IaC, or framework details.
- **Common rules belong in common skills**: Cross-cutting behaviour such as artifact resolution, copy-forward, fallback inference, persistence, and review flow should live in common skills instead of being repeated in every stage.
- **Examples are executable guidance**: LLMs learn from examples. Keep examples aligned with `src/stages/stage-graph.md` and current stage names.
- **Generated resources must resolve**: Runtime agent resources must point only to files that exist. Planned future skills may be listed as backlog intent, but generated `skill://` resources must be resolvable.
- **Review at the artifact's abstraction level**: Do not require later-stage deployment, scaling, or failure-mode details from early conceptual artifacts unless those artifacts make premature or contradictory claims.

## Making Changes

- Edit source files under `src/`.
- Rebuild generated runtime files with `npm run build`.
- Do not hand-edit `dist/kiro-ide/.kiro` except when diagnosing generation issues; generated changes should come from `src/`.
- Add or update stages under `src/stages/<stage-name>/definition.md` and `templates/`.
- Add or update personas under `src/personas/<persona-name>.yaml`.
- Add or update skills under `src/skills/<skill-name>/SKILL.md`.
- Keep target-specific generation logic under `build/` and `src/target-config/`.

## Pull Request Checklist

Before submitting a PR, verify:

- Stage additions or removals are reflected in `src/stages/stage-graph.md`.
- Stage owner, contributor, and reviewer mappings appear only in stage definitions.
- Skill descriptions are persona-neutral and stage-neutral unless the skill is explicitly an orchestration/process skill.
- Templates match the abstraction level of their stage.
- Artifact copy-forward and stable-ID preservation are respected where downstream stages expand upstream artifacts.
- `dist/kiro-ide/.kiro` has been rebuilt from `src/`.
- Generated agent `skill://` resources resolve to real skill files.
- Stale stage names do not remain in examples, conventions, or generated output.

## Testing Changes

Test your changes with at least one supported target runtime, currently Kiro. Describe what you tested in your PR.

If you're adding or updating installation instructions, ensure you've tested them on Mac, Windows CMD, and Windows Powershell.

## Reporting Bugs/Feature Requests

Use GitHub issues to report bugs or suggest features. Before filing, check existing issues to avoid duplicates.

Include:

- Which rule or stage is affected
- Expected vs actual behavior
- The platform/model you tested with

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
