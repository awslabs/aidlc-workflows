# AI-DLC Workflows roadmap

**Reviewed October 29, 2026.** The latest stable release at this review is
[v2.11.2](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.11.2).

This roadmap records delivered capabilities and proposed minor-release outcomes.
The linked RFCs hold the designs; their issues and pull requests hold current
implementation status. Complete release contents, compatibility notes, and upgrade
instructions live in [GitHub Releases](https://github.com/awslabs/aidlc-workflows/releases).

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

Existing team and parallel Unit support is the foundation for the proposed 2.12
increment below. The proposed 2.13 marketplace builds on the existing plugin
mechanism and authoring tools.

## Release cadence

- **Patch releases:** weekly, with additional releases for urgent fixes.
  Prioritize customer-impacting bugs at the start of each week and adjust as
  new issues arrive. Track individual fixes in issues and release notes.
- **Minor releases:** target roughly three-week cycles around substantial RFCs
  and customer outcomes. Confirm scope, ownership, and testing capacity before
  committing to a release date.
- **Development continues throughout the cycle.** Select what will ship from a
  specific published preview. When release scope or timing changes, update this
  roadmap and the linked RFC, and communicate the change early.

## Proposed minor releases

The outcomes and dates below are planning targets for maintainer feedback. Confirm
the scope, date, and release, testing, and communications owners for each cycle.
The 2.12 target is three weeks after 2.11.2; the 2.13 target is one further
three-week cycle.

<!-- markdownlint-disable MD013 -->

| Release | Customer outcome | Proposed target | RFC and implementation |
| --- | --- | --- | --- |
| **2.12.0** | Teams build Units from a shared plan in separate workspaces, integrate results across mapped repositories, and see overall progress. | **November 18, 2026** | [RFC #2410](https://github.com/awslabs/aidlc-workflows/issues/2410), [PR #2783](https://github.com/awslabs/aidlc-workflows/pull/2783) |
| **2.13.0** | Users discover, install, and update plugins from registered marketplaces through a documented, tested experience. | **December 9, 2026** | [RFC #723](https://github.com/awslabs/aidlc-workflows/issues/723), [PR #1104](https://github.com/awslabs/aidlc-workflows/pull/1104) |
| **2.14.0 and later** | Select the next substantial RFC using customer need, dependencies, and delivery capacity. | **To be agreed** | No feature allocation yet. |

<!-- markdownlint-enable MD013 -->

### 2.12: parallel Units

The proposed increment extends existing team/Unit support into a complete
delivery flow: assign Units to teams, build in separate workspaces, return
results, and track integration in the shared home where Inception ran.

**Scope to confirm**

- Unit ownership, independent builds, and dependency-aware progression.
- Mapped repository layouts, per-repository integration, and final Build and Test.
- Progress reporting, safe resume, approvals, and compatibility with existing
  team work.
- A collaboration guide and a reproducible end-to-end example.

Before confirming scope, select which RFC variants ship: separate team workspace
repositories, file-based handoffs, early starts on unfinished dependencies,
shared-input amendments, and solo-to-team transitions. Record the selected
platforms and harnesses in the RFC's acceptance plan.

**Release evidence to collect:** two independent Units progressing concurrently
and a dependent Unit waiting for integration; merge, squash, and rebase;
interrupted-work recovery; preservation of users' changes; and final Build and
Test. Record results from the agreed live-use tests on each selected harness and
platform, plus installation and upgrade checks, using the packaged candidate.

### 2.13: plugin store

The proposed increment adds a marketplace experience to the existing plugin
mechanism. Include the first-party catalog, its publishing process, and its
ownership in the scope discussion alongside the CLI work.

**Scope to confirm**

- Explicit marketplace registration and plugin discovery.
- Installation and updates with source/integrity checks and the agreed
  host-native or managed installation flow.
- Clear installed, composed, and published version information.
- A first-party catalog with an initial plugin and a worked example for a
  private marketplace.
- User and publisher guidance, including catalog review and release ownership.

Confirm the supported harnesses and the RFC's trust decisions before scope closes.
Decide whether plugin graduation into core and setup-selection changes belong in
2.13 or a later release. The existing implementation PR leaves the first-party
repository and publishing setup, and the first real graduation, as separate work.

**Release evidence to collect:** registration, search, installation, update,
composition, and recovery from failure. Exercise a private marketplace, offline
behavior, integrity failures, and each selected installation flow. Record results
from existing-plugin regression tests and installation/upgrade checks against the
packaged candidate.

## Proposed checkpoints for each minor release

Testing starts during implementation. These checkpoints use the existing preview
and promotion process to confirm scope, collect evidence, and prepare users.

<!-- markdownlint-disable MD013 -->

| Approximate timing | Decision and preparation |
| --- | --- |
| **Start of the cycle** | Select the RFC outcome and tentative scope. Name release, testing, and communications owners; identify dependencies and available test environments. |
| **Two weeks before the target** | Confirm the minimum release scope and explicit deferrals. Identify a preview for early feedback when the core journey can be exercised; publish its known gaps and pilot instructions. Brief customer-facing teams on the intended outcome and target. |
| **One week before the target** | Aim for feature completion and identify a preview for broader testing. Run the agreed regression, live-use, and install/upgrade checks. Prepare the example, release notes, and user communications. |
| **About two business days before** | Review the selected preview's exact source and recorded test results, including failures and gaps. Make the go/no-go decision under the existing release process and confirm contents and communications. |
| **Release and follow-up** | Publish the selected release, verify installation routes, communicate what shipped, and update this roadmap from the published release. Prioritize reported regressions for patches. |

<!-- markdownlint-enable MD013 -->

When scope changes after confirmation, record its effect on testing and timing.
For a changed candidate, refresh the relevant test evidence. If the target moves,
update the date and reason promptly; weekly patches continue.

## Longer-term direction

Future RFC selection continues to follow the North Star: configurable ensembles,
cross-harness customization, adaptive workflows, evidence-based verification,
governed feedback loops, artifact traceability, and shared organizational knowledge.
Maintainers select release allocations as the designs and delivery capacity become
clear.

The [previous roadmap snapshot](https://github.com/awslabs/aidlc-workflows/blob/764553d96fb80a41d5dfc7b17d4399199f6766da/docs/roadmap.md)
preserves the earlier North Star scorecard and delivery history. Its September 11,
2026 status statements are historical; use the release links above for subsequent
delivery.
