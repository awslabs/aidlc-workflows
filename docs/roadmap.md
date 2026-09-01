# AI-DLC Workflows 2.0 - Roadmap

Status as of 2026-09-01.

- The current v2 version is **2.6.124** (`origin/main` tip `82d2e304`).
  Version numbers describe the committed framework tree, not GitHub Releases.
- AI-DLC Workflows 2.0 is **GA** on the default `main` branch. Use `main` for
  new installations and upgrades. The earlier implementation is maintained
  separately on `v1`.
- Release publication is not yet aligned with `main`: GitHub still marks
  `v1.0.1` as Latest, tracked by #635. The native distribution implementation
  for #722 remains under review in #756; no public v2 native release exists yet.
- PR validation now includes the deterministic integration and end-to-end tiers
  in addition to smoke, unit, packaging, typecheck and lint (#791).

The version numbers below describe where work landed on `main`. Future
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
| 1 | Real-world ensemble | Shipped | 2.5.0 independent collaborators and selectable topologies (#568), enforced reviewer receipts (#569), batch-parallel per-unit waves (#617), team-owned parallel Units (#879) | Harness-native live-team transports remain an enhancement |
| 2 | Customization | Shipped, with follow-ups | 2.3.0 plugin seam, 2.3.5 content projection/selection (#550), deterministic rule delivery (#658), plugin scopes (#664), reusable plugin test kit (#792), plugin doctor extensions (#797), standalone authoring toolchain (#892) | Stage-specific rules, `when:` evaluation, remote discovery and marketplace (#723) |
| 3 | Adaptiveness | Shipped | 2.2.0 composer, entropy-scored composition (#595), deterministic ARS (#644), unit-major Code Generation (#705), Classic/Express scopes and conditional protocol modules (#767), per-session workflow bindings (#858) | Boundary changes remain human-approved by design |
| 4 | Verifier as adversary | Shipped | 2.4.0 adversarial evidence contract (#566), gate-and-completion enforcement (#569, #551), reviewer-class cost dial (#718), turn/recovery backstops (#613, #758), gate-bound blocking sensors (#836) | Pull-request-level adversarial review is under development in #799 |
| 5 | Cyclic flows | Partial | Within-stage review/revision loops, bounded recovery mechanics, explicit human-authorized forward/backward/redo stage jumps, and bounded Build & Test to Code Generation loop-back (#616) | General governed cross-stage feedback loops remain unbuilt |
| 6 | Traceability | Partial | Artefact graph, upstream coverage, per-stage enforcement (#401), claim provenance (#647, #686), shared CodeKB safeguards (#670), domain/contract boundaries (#711), stale-result propagation (#716), source-bound and per-Unit review receipts (#646, #813) | Progressive in-place enrichment and cross-unit discovery propagation (#299) |
| 7 | Org repository | Shipped | 2.1.0 spaces/intents/org-KB, declared multi-repo manifest and sync (#674), clone-safe active-space cursor (#709), DocumentKB indexing and citations (#731), summaries and tags (#894) | Auditable supplemental-knowledge selection remains an active extension (#694) |

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
| 2.5.63 | Cursor harness | 1, 2 | #661 |
| 2.5.67 | Batch-parallel per-unit waves and foreground reviewers | 1, 4 | #617 |
| 2.5.71 - 2.5.75 | Per-stage traceability enforcement, design-stage code boundaries, test-instruction ownership and first-class observability artifacts | 4, 6 | #401-#404 |
| 2.6.1 - 2.6.2 | Domain/contract design restructuring, consolidated infrastructure design and follow-up guards | 1, 6 | #711, #751 |
| 2.6.8 - 2.6.9 | Reviewer turn backstop and bounded stale-receipt recovery | 4 | #613, #758 |
| 2.6.12 - 2.6.14 | Copilot continuation stability, gate authorship enforcement and audit timestamp normalization | 1, 4 | #749, #750, #759 |
| 2.6.15 | DocumentKB S1 indexing and citation delivery | 7 | #731 |
| 2.6.16 | Code Generation plans bound to the affirmed Testing Posture | 4, 6 | #772 |
| 2.6.17 | Reusable plugin test kit and plugin-author testing tiers | 2 | #792 |
| 2.6.18 | Classic and Express scopes, Classic implicit default and conditional protocol modules | 2, 3 | #767 |
| 2.6.20 | Bounded Build & Test to Code Generation failure loop-back | 5 | #616 |
| 2.6.37 | Code Generation review receipts bound to workspace source state | 4, 6 | #646 |
| 2.6.51 - 2.6.64 | Continuation cursor, Kiro reliability, plugin-extensible doctor checks, stage-validity receipts and native Kiro IDE surfaces | 1, 2, 4, 6 | #822, #788, #797, #716, #824 |
| 2.6.69 | Per-Unit source attribution for Code Generation review receipts | 4, 6 | #813 |
| 2.6.72 - 2.6.74 | Gate-bound blocking sensors and binding quality-target verification | 4, 6 | #836, #842 |
| 2.6.80 | Per-session workflow bindings for concurrent intents in one space | 3, 7 | #858 |
| 2.6.87 | DocumentKB summaries and tags | 7 | #894 |
| 2.6.105 | Standalone plugin create, validate, build and test toolchain | 2 | #892 |
| 2.6.107 | Team-owned Units and parallel Construction across teams | 1, 3 | #879 |
| 2.6.114 | No-DAG per-Unit review continuity | 1, 4 | #947 |
| 2.6.121 - 2.6.124 | Immutable reviewer evidence, Git-independent source binding and portable workflow state paths | 4, 6 | #888, #904, #962 |

<!-- markdownlint-enable MD013 -->

## In flight

Selected open work is listed without version claims. Merge readiness changes
frequently; each linked pull request is authoritative.

<!-- markdownlint-disable MD013 -->

| PR | Work | Theme |
| --- | --- | --- |
| [#756](https://github.com/awslabs/aidlc-workflows/pull/756) | Native distribution, six-command CLI, config policy and release hardening | Installation and releases |
| [#775](https://github.com/awslabs/aidlc-workflows/pull/775) | Unified Kiro distribution aligned to the agent harness | Harness parity |
| [#782](https://github.com/awslabs/aidlc-workflows/pull/782) | Product-discovery plugin (AI-PLC) | Plugins and product discovery |
| [#799](https://github.com/awslabs/aidlc-workflows/pull/799) | Adversarial AI pull-request review agent | CI and verification |
| [#969](https://github.com/awslabs/aidlc-workflows/pull/969) | Construction integration through pull requests | Delivery workflow |
| [#968](https://github.com/awslabs/aidlc-workflows/pull/968) | Devin CLI and Desktop harness | Harness expansion |
| [#907](https://github.com/awslabs/aidlc-workflows/pull/907) | mabl verification plugin | Plugins and verification |
| [#753](https://github.com/awslabs/aidlc-workflows/pull/753) | Evaluator integration | Evaluation |
| [#526](https://github.com/awslabs/aidlc-workflows/pull/526) | Product discovery in Ideation | Product discovery |

<!-- markdownlint-enable MD013 -->

## Directional themes

These themes are supported by open RFCs, issues or implementation pull requests,
but do not yet have committed release versions.

### Traceability and progressive enrichment

- Per-stage upstream traceability enforcement shipped in
  [#401](https://github.com/awslabs/aidlc-workflows/pull/401). Source-bound review
  evidence shipped in
  [#646](https://github.com/awslabs/aidlc-workflows/pull/646), stale stage-result
  propagation shipped in
  [#716](https://github.com/awslabs/aidlc-workflows/pull/716), and per-Unit
  attribution shipped in
  [#813](https://github.com/awslabs/aidlc-workflows/pull/813).
- Cross-unit discovery propagation remains open
  ([#299](https://github.com/awslabs/aidlc-workflows/issues/299)/[#300](https://github.com/awslabs/aidlc-workflows/pull/300)).
- Preserve progressive enrichment as the North Star destination: downstream
  stages enrich upstream artefacts in place, with ADRs as a core design artefact.
- Commit-level provenance remains an open design question; the current audit
  chain does not provide a durable reverse lookup from an arbitrary source commit
  to its intent and workflow.

### Governed feedback loops

- [#616](https://github.com/awslabs/aidlc-workflows/pull/616) shipped one
  bounded Build & Test to Code Generation return path for
  [#611](https://github.com/awslabs/aidlc-workflows/issues/611). It is an
  incremental loop, not a general cyclic graph engine.
- General cross-stage backward edges still need engine-level governance, stale
  artefact handling and explicit human authorization.

### Plugins and marketplace

- The plugin mechanism, content projection, selection and plugin-contributed
  scopes are shipped; the plugin test kit and authoring tiers shipped in
  [#792](https://github.com/awslabs/aidlc-workflows/pull/792).
- Plugin-extensible doctor checks shipped in
  [#797](https://github.com/awslabs/aidlc-workflows/pull/797). The offline plugin
  CREATE, VALIDATE, BUILD, and TEST authoring tiers ship as
  the standalone `aidlc-plugin-create.ts`, `aidlc-plugin-validate.ts`,
  `aidlc-plugin-build.ts`, and `aidlc-plugin-test.ts` tools. The top-level
  command routes remain proposed in
  [#723](https://github.com/awslabs/aidlc-workflows/issues/723).
  Remote discovery, trust, a first-party marketplace and a graduation path are
  also proposed in #723.
  Product discovery
  ([#652](https://github.com/awslabs/aidlc-workflows/issues/652),
  [#782](https://github.com/awslabs/aidlc-workflows/pull/782)) and design
  ([#527](https://github.com/awslabs/aidlc-workflows/issues/527)) are candidates
  for first-party plugins.
- `aidlc-plugin-test.ts` exercises composition against a disposable copy of an
  install for external plugin authors.

### Knowledge and documents

- [#731](https://github.com/awslabs/aidlc-workflows/pull/731) shipped
  DocumentKB's first indexing and citation slice. Summaries and tags shipped in
  [#894](https://github.com/awslabs/aidlc-workflows/pull/894), completing the
  tracked [#714](https://github.com/awslabs/aidlc-workflows/issues/714) RFC.
- [#694](https://github.com/awslabs/aidlc-workflows/issues/694) proposes auditable
  supplemental-knowledge selection and delivery across stage topologies.

### Product discovery

- Core Ideation delivery remains under review in
  [#526](https://github.com/awslabs/aidlc-workflows/pull/526), with an
  external-handover contract in
  [#586](https://github.com/awslabs/aidlc-workflows/issues/586) and a
  plugin-shaped alternative in
  [#652](https://github.com/awslabs/aidlc-workflows/issues/652).
- The delivery surface, core versus first-party plugin, is not yet settled.

### Installation, upgrades and releases

- The GA implementation and its active development line now live on `main`.
  The earlier implementation remains on `v1`.
- [#722](https://github.com/awslabs/aidlc-workflows/issues/722) covers binary
  packaging, installers, release automation, rollback and post-install setup;
  its milestones 1-3 implementation is under review in
  [#756](https://github.com/awslabs/aidlc-workflows/pull/756). The earlier Bun
  dependency tracker [#399](https://github.com/awslabs/aidlc-workflows/issues/399)
  is closed as superseded by #722.
- [#636](https://github.com/awslabs/aidlc-workflows/issues/636) tracks a
  first-class upgrade contract. The earlier implementation PR
  [#535](https://github.com/awslabs/aidlc-workflows/pull/535) closed without
  merging.
- [#635](https://github.com/awslabs/aidlc-workflows/issues/635) tracks the
  mismatch between the v2 GA `main` branch and GitHub's Latest release still
  pointing at `v1.0.1`.

### Harness expansion and parity

- GitHub Copilot support shipped in
  [#657](https://github.com/awslabs/aidlc-workflows/pull/657), and its RFC
  [#472](https://github.com/awslabs/aidlc-workflows/issues/472) is closed.
- Cursor support shipped in
  [#661](https://github.com/awslabs/aidlc-workflows/pull/661). A unified Kiro
  distribution is under review in
  [#775](https://github.com/awslabs/aidlc-workflows/pull/775). Native Kiro IDE
  surfaces shipped in
  [#824](https://github.com/awslabs/aidlc-workflows/pull/824), closing
  [#555](https://github.com/awslabs/aidlc-workflows/issues/555), and hook matcher
  hardening shipped in
  [#788](https://github.com/awslabs/aidlc-workflows/pull/788).
- Antigravity setup is proposed in
  [#690](https://github.com/awslabs/aidlc-workflows/issues/690).

### Evaluation and operations

- [#684](https://github.com/awslabs/aidlc-workflows/issues/684) proposes
  repeatable benchmarks for measuring AI-DLC outcomes. Evaluator work is active
  in [#753](https://github.com/awslabs/aidlc-workflows/pull/753); the earlier
  harness-evaluation tracker
  [#223](https://github.com/awslabs/aidlc-workflows/issues/223) closed as not
  planned for v1.
- Operations-phase steering remains a requested direction
  ([#221](https://github.com/awslabs/aidlc-workflows/issues/221),
  [#473](https://github.com/awslabs/aidlc-workflows/issues/473)), not an active
  `main` implementation stream.

## Known gaps

- Stage-specific rules (`aidlc-stage-<slug>.md`) are reserved but unbuilt.
- Plugin `when:` evaluation, remote discovery and marketplace trust remain open.
- Write-fired sensors remain advisory; gate-bound sensors support blocking
  severity and human-backed override.
- General cross-stage cycles and progressive in-place artefact enrichment remain
  North Star gaps.
- The unified Kiro distribution remains under review in #775.
- Older community PR #526 remains open and needs rebasing or disposition. PRs
  #432, #535, #552, #653 and #712 closed without merging.
