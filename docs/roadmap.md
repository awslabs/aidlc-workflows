# AI-DLC Workflows roadmap

**Reviewed October 29, 2026.** The latest stable release at this review is
[v2.11.2](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.11.2).

This roadmap records delivered capabilities and the project's North Star
direction. Issues and pull requests hold current implementation status.
Complete release contents, compatibility notes, and upgrade instructions live in
[GitHub Releases](https://github.com/awslabs/aidlc-workflows/releases).

## What is available

- **Stable:** capabilities included in a published stable release.
- **Preview:** candidate builds for feedback; read the selected preview's test
  report and known limitations before trying it.
- **On `main`:** integrated development work, which may be ahead of the latest
  stable release. A merged PR becomes eligible for preview publication.

The [development and release guide](../DEVELOPERS.md) explains preview testing,
stable promotion, and release decisions.

## Recently shipped

These are selected customer-facing improvements from the releases since the
previous roadmap review. Follow each release link for its full scope and upgrade
requirements.

<!-- markdownlint-disable MD013 -->

| Stable release | Published | Delivered capabilities |
| --- | --- | --- |
| [2.11.2](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.11.2) | October 28, 2026 | More reliable handling of replies and workflow control across chats; fixes to existing parallel Unit builds and landings; multi-repository Reverse Engineering and adding repositories during work; configuration and Windows repairs. |
| [2.11.1](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.11.1) | October 20, 2026 | Code Generation approvals for work in worktrees, nested checkouts, and clones; plugin identity and composition improvements; project refresh from older releases. |
| [2.11.0](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.11.0) | October 8, 2026 | Human-directed workflow changes and Plan Approval; preservation of finished Unit work when plans change; leaner starting workflows and configuration that preserves team files. |
| [2.10.0](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.10.0) | September 24, 2026 | Verified Unit and batch Construction checkpoints; compatible harnesses sharing a project; provider-preserving configuration and intent-scoped worktrees. |
| [2.9.0](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.9.0) | September 15, 2026 | Updated Classic workflow; commit-to-Unit provenance; intent archive/unarchive; separate native and manual-copy runtime assets and preview-channel improvements. |

<!-- markdownlint-enable MD013 -->

## North Star reference

The project's existing North Star covers configurable ensembles,
cross-harness customization, adaptive workflows, evidence-based verification,
governed feedback loops, artifact traceability, and shared organizational knowledge.

The [previous roadmap snapshot](https://github.com/awslabs/aidlc-workflows/blob/764553d96fb80a41d5dfc7b17d4399199f6766da/docs/roadmap.md)
preserves the earlier North Star scorecard and delivery history. Its September 11,
2026 status statements are historical; use the release links above for subsequent
delivery.
