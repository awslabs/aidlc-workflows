# AI-DLC Workflows 2.0 - Roadmap

Status as of 2026-08-10.

- The current v2 version is **2.5.62** (`origin/v2` tip `18bcc468`). Version
  numbers describe the committed framework tree;
  they are not GitHub Releases.
- AI-DLC Workflows 2.0 is **GA**. The README announcement landed in #627 after
  the reviewer-as-verifier and three-role ensemble milestones shipped.
- Release publication is not yet aligned with the v2 branch: GitHub still marks
  `v1.0.1` as Latest, tracked by #635. Packaging and release distribution are
  being reconsidered in #722.

The version numbers below describe where work landed on the v2 branch. Future
themes and open pull requests are directional, not committed release promises.

## North star reference

The seven functional goals of the AI-DLC Workflows 2.0 North Star, verbatim in intent:

1. **Mimic what we practice in the real world** - a stage executed by a
   configurable ensemble (Owner, Collaborator, Verifier) with consistent
   semantics across harnesses.
2. **Customization of behaviour** - encode new behaviours, policies, or
   constraints in no more than two targeted changes, reusable across harnesses
   without tool-specific rewrites.
3. **Adaptiveness of workflows** - scale in (report triage to compact Fix, Test,
   PR) and scale out (decide next stages at boundaries); composition not
   hard-wired.
4. **Verifier as a true adversary** - adversarial quality gate; may use a
   different LLM than the producer; validates against machine-checkable
   evidence; budgeted self-heal loop escalating to HITL.
5. **Support for cyclic, directional flows** - forward progression plus
   governed, directional feedback loops.
6. **Preserve artefact traceability** - downstream stages enrich upstream
   artefacts rather than spawning disconnected ones.
7. **Organizational, not project-local, artefact repository** - shared org
   knowledge layer across projects, intents, and repos; six named scenarios.

## Strategic delivery pillars

Two strategic pillars shape how the North Star reaches users and evolves:

- **Productization and distribution (#722)** - make AI-DLC straightforward to
  install, configure, upgrade, release and roll back across supported harnesses.
- **Plugin ecosystem and marketplace (#723)** - make trusted extensions
  discoverable, installable and reusable, with a clear path from external plugin
  to first-party capability.

## Goal scorecard

<!-- markdownlint-disable MD013 -->

| # | Goal | Status | Delivered by | Remaining work |
| --- | --- | --- | --- | --- |
| 1 | Real-world ensemble | Shipped | 2.5.0 independent collaborators and selectable topologies (#568); enforced reviewer receipts (#569) | Native live-team transports and parallel per-unit waves remain enhancements (#617) |
| 2 | Customization | Shipped, with follow-ups | 2.3.0 plugin seam, 2.3.5 content projection/selection (#550), deterministic rule delivery (#658), plugin scopes (#664) | Stage-specific rules, `when:` evaluation, remote discovery and marketplace (#723) |
| 3 | Adaptiveness | Shipped | 2.2.0 composer, entropy-scored composition (#595), deterministic ARS (#644), unit-major Code Generation (#705) | Boundary changes remain human-approved by design |
| 4 | Verifier as adversary | Shipped | 2.4.0 adversarial evidence contract (#566), completion-path enforcement (#569), reviewer-class cost dial (#718) | Blocking sensor severity is an adjacent follow-up (#431) |
| 5 | Cyclic flows | Partial | Within-stage review/revision loops, bounded recovery mechanics, and explicit human-authorized forward/backward/redo stage jumps | Stage-triggered governed cross-stage feedback loops remain unbuilt; #616 is a narrower Build & Test loop-back |
| 6 | Traceability | Partial | Artefact graph, upstream coverage, claim provenance (#647, #686), shared CodeKB safeguards (#670) | Progressive in-place enrichment, stale-result propagation (#716), source-bound receipts (#646), per-stage enforcement (#401), cross-unit discovery |
| 7 | Org repository | Shipped | 2.1.0 spaces/intents/org-KB, declared multi-repo manifest and sync (#674), clone-safe active-space cursor (#709) | Document retrieval and auditable supplemental knowledge are active extensions (#694, #714, #731) |

<!-- markdownlint-enable MD013 -->

## Delivered

<!-- markdownlint-disable MD013 -->

| Version | Capability | Goal | Key PRs |
| --- | --- | --- | --- |
| 2.0.0 - 2.0.2 | GA preview: reviewer mechanism, multi-harness core, agent roster | 1, 4 | v2 baseline |
| 2.1.0 | Per-intent workspace: spaces, intents, multi-repo, org-KB | 7 | #429 |
| 2.1.2 | Per-unit `for_each` iteration | 3 | #444 |
| 2.1.3 - 2.1.8 | Loop integrity and reviewer wiring across harnesses | 1, 4, 5 | #405, #443, #466, #482 |
| 2.2.0 - 2.2.19 | Adaptive workflows, composer, scale-in and Construction hardening | 3 | #477, #491, #509-#512, #520-#522, #525 |
| 2.3.0 - 2.3.5 | Plugin mechanism, agent tiers, install-time plugin selection and content projection | 2, 4 | #475, #546, #550 |
| 2.3.6 - 2.3.11 | Phase progress, citation-aware upstream coverage, pinned lint and gate accounting | 4, 6 | #562, #563, #572, #573 |
| 2.4.0 | Reviewer-as-verifier: adversarial, evidence-grounded review | 4 | #566 |
| 2.4.2 - 2.4.6 | Whole-root packaging, native dispatcher/binaries, documentation parity and opencode harness | 1, 2 | #560, #571, #577, #578, #581 |
| 2.5.0 | Three-role ensemble: independent collaborators, pipeline, mob and hub-and-spoke | 1 | #568 |
| 2.5.1, 2.5.25 | Entropy-scored minimum workflow composition and deterministic ARS | 3 | #595, #644 |
| 2.5.2 | Redacted `/aidlc --doctor --export` diagnostic bundle | - | #576 |
| 2.5.5, 2.5.39, 2.5.41, 2.5.54-2.5.55 | Reviewer receipts, review freeze, plan-before-code guard, reviewer classes and authorization receipts | 1, 4 | #569, #677, #692, #702, #718 |
| 2.5.11, 2.5.38, 2.5.57-2.5.58 | Claim provenance, pre-generation confirmation and project-language grounding | 6 | #647, #686, #703, #707 |
| 2.5.33 - 2.5.36 | Deterministic steering delivery, plugin scopes, CodeKB preservation and workspace manifest/sync | 2, 7 | #658, #664, #670, #674 |
| 2.5.40, 2.5.53 | Per-stage token/cost accounting, opt-in metrics and usage-tracking kill switch | - | #673, #720 |
| 2.5.56 | Code Generation joins the unit-major Construction walk | 3 | #705 |
| 2.5.60 | GitHub Copilot harness for Copilot CLI and VS Code agent mode | 1, 2 | #657 |

<!-- markdownlint-enable MD013 -->

## In flight

Open work is listed without version claims. Merge readiness changes frequently;
the linked pull request is authoritative.

<!-- markdownlint-disable MD013 -->

| PR | Work | Theme |
| --- | --- | --- |
| #731 | DocumentKB S1: index team documents for citation by agents | Knowledge and org repository |
| #716 | Project and propagate stale stage results | Traceability and validity |
| #661 | Cursor harness | Harness expansion |
| #617 | Batch-parallel per-unit waves and foreground reviewers | Ensemble and execution |
| #616 | Bounded Build & Test to Code Generation loop-back | Cyclic flows |
| #646 | Bind Code Generation review receipts to workspace source state | Traceability and validity |
| #653 | Kiro IDE-native agent and settings surfaces | Harness parity |
| #526 | Product discovery in Ideation | Product discovery |
| #401 | Per-stage traceability enforcement sensor | Traceability |
| #402 / #403 / #404 | Design/code boundaries, test ownership and observability consistency | Artefact quality |
| #712 | Tutorial scope for a guided first run | Adoption |
| #730 | Composed-workflow determinism and test-suite hardening | Reliability |

<!-- markdownlint-enable MD013 -->

## Directional themes

These themes are supported by open RFCs, issues or implementation pull requests,
but do not yet have committed release versions.

### Traceability and progressive enrichment

- Enforce per-stage upstream traceability (#401), bind review evidence to source
  state (#646), and propagate stale stage results (#716).
- Define per-unit attribution for Code Generation review receipts (#662) and a
  fresh v2 implementation for cross-unit discovery propagation (#299/#300).
- Preserve progressive enrichment as the North Star destination: downstream
  stages enrich upstream artefacts in place, with ADRs as a core design artefact.
- Commit-level provenance remains an open design question; the current audit
  chain does not provide a durable reverse lookup from an arbitrary source commit
  to its intent and workflow.

### Governed feedback loops

- #616 implements one bounded Build & Test to Code Generation return path for
  #611. It is an incremental loop, not a general cyclic graph engine.
- General cross-stage backward edges still need engine-level governance, stale
  artefact handling and explicit human authorization.

### Plugins and marketplace

- The plugin mechanism, content projection, selection and plugin-contributed
  scopes are shipped.
- Remote discovery, trust, a first-party marketplace and a graduation path are
  proposed in #723. Product discovery (#652) and design (#527) are candidates
  for first-party plugins.

### Knowledge and documents

- #714 defines DocumentKB and #731 implements its first indexing slice.
- #694 proposes auditable supplemental-knowledge selection and delivery across
  stage topologies.

### Product discovery

- Core Ideation delivery remains under review in #526, with an external-handover
  contract in #586 and a plugin-shaped alternative in #652.
- The delivery surface, core versus first-party plugin, is not yet settled.

### Installation, upgrades and releases

- #722 covers binary packaging, installers, npm, release automation, rollback and
  post-install setup. #399 tracks the hard Bun dependency.
- #636 tracks a first-class upgrade contract. The earlier implementation PR #535
  closed without merging.
- #635 tracks the mismatch between the v2 GA announcement and GitHub's Latest
  release still pointing at `v1.0.1`.

### Harness expansion and parity

- GitHub Copilot support shipped in #657; its RFC #472 still needs reconciliation.
- Cursor support is open in #661, and Kiro IDE-native surfaces remain open in #653.
- Antigravity setup is proposed in #690.

### Evaluation and operations

- #684 proposes repeatable benchmarks for measuring AI-DLC outcomes; #223 tracks
  automated harness evaluation, initially for Claude Code and Kiro.
- Operations-phase steering remains a requested direction (#221, #473), not an
  active v2 implementation stream.

## Known gaps

- Stage-specific rules (`aidlc-stage-<slug>.md`) are reserved but unbuilt.
- Plugin `when:` evaluation, remote discovery and marketplace trust remain open.
- Sensor failures are advisory; blocking severity remains open in #431.
- General cross-stage cycles and progressive in-place artefact enrichment remain
  North Star gaps.
- Kiro IDE issue #543 is closed, but #555/#653 still track native agent/settings
  surfaces.
- Several older community PRs remain open and need rebasing or disposition:
  #401-#404, #526 and #553. PRs #432, #535 and #552 closed without merging.
- The Copilot RFC #472 and deterministic ARS issue #618 remain open despite their
  implementations shipping in #657 and #644; their issue state should be
  reconciled.
