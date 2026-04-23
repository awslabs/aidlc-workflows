# Contributing Guidelines

Thank you for your interest in contributing to AI-DLC. Whether it's a bug report, new rule, correction, or documentation improvement, we value feedback and contributions from the community.

Please read through this document before submitting any issues or pull requests.

## Tenets

Before contributing, familiarize yourself with our [tenets](README.md#tenets).

## Contributing Rules

AI-DLC rules live in `aidlc-rules/aws-aidlc-rule-details/`. When contributing:

- **Be reproducible**: Changes should be consistently reproducible either via test case or a series of steps.
- **Single source of truth**: Don't duplicate content. If guidance applies to multiple stages, put it in `common/` and reference it.
- **Keep it agnostic**: The core methodology shouldn't assume specific IDEs, agents, or models. Tool-specific files are generated from the source.

### Directory Structure — Do Not Rename or Move

The folder names `aws-aidlc-rules/` and `aws-aidlc-rule-details/` under `aidlc-rules/` are part of the public contract. Workshops, tests, and the `core-workflow.md` path-resolution logic all depend on these exact names. Do not flatten, rename, or reorganize them.

```text
aidlc-rules/
├── aws-aidlc-rules/            # Core workflow entry point
│   └── core-workflow.md
└── aws-aidlc-rule-details/     # Detailed rules referenced by the workflow
    ├── common/
    ├── inception/
    ├── construction/
    ├── extensions/
    └── operations/
```

### Rule Structure

Rules are organized by phase:

- `common/` - Shared guidance across all phases
- `inception/` - Planning and architecture rules
- `construction/` - Design and implementation rules
- `operations/` - Deployment and monitoring rules
- `extensions/` - Optional cross-cutting constraint rules

### Testing Changes

Test your rule changes with at least one supported platform (Amazon Q Developer, Kiro, or other tools) before submitting. Describe what you tested in your PR.

If you're adding or updating installation instructions, ensure you've tested them on Mac,
Windows CMD, and Windows Powershell.

## Reporting Bugs/Feature Requests

Use GitHub issues to report bugs or suggest features. Before filing, check existing issues to avoid duplicates.

Include:

- Which rule or stage is affected
- Expected vs actual behavior
- The platform/model you tested with

## Contributing via Pull Requests

Before sending a pull request:

1. Work against the latest `main` branch
2. Check existing open and recently merged PRs
3. Open an issue first for significant changes

To submit:

1. Fork the repository
2. Make your changes (keep them focused)
3. Use clear commit messages following [conventional commits](https://www.conventionalcommits.org/) (e.g., `feat:`, `fix:`, `docs:`)
4. Submit the PR and respond to feedback

## Code of Conduct

This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct).

For more information see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact <opensource-codeofconduct@amazon.com> with any additional questions or comments.

## Security Issue Notifications

If you discover a potential security issue, notify AWS/Amazon Security via the [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Please do not create a public GitHub issue.

## Licensing

See the [LICENSE](LICENSE) file for our project's licensing. We will ask you to confirm the licensing of your contribution.
