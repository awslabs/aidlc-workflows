# Cursor IDE Harness for AI-DLC Workflows 2.0 — Design Specification

**Generated**: 2026-07-29

## Overview

This specification package defines the architecture for a new Cursor IDE harness for the AI-DLC multi-harness framework. The harness enables AI-DLC's 14-agent, 32-stage methodology to run natively inside Cursor's agent mode (IDE, CLI, and cloud agents) via a `dist/cursor/` distribution tree.

**Problem Solved**: Cursor IDE users currently cannot run AI-DLC workflows natively. This harness adds Cursor as the sixth supported platform, using Cursor's native file-based customization surfaces (rules, skills, hooks, commands) to deliver the full AI-DLC methodology without switching tools.

**Target Delivery**: Feature branch (`feature/cursor`) — no hard deadline.

**Scope**: New harness surface at `harness/cursor/` consumed by the packager to generate `dist/cursor/`. Includes manifest, emitter, hook adapter, orchestrator skill, onboarding fills, tests, and doctor health-check extension.

**Solution**: A thin authored surface (`harness/cursor/manifest.ts` + `emit.ts` + adapter + SKILL.md) that the existing packager auto-discovers and transforms into a complete Cursor distribution. The emitter generates `.mdc` rules with YAML frontmatter, `hooks.json` with failClosed security gates, CLI permissions, and slash commands. A hook adapter bridges Cursor's permission-deny contract to AI-DLC's exit-code-2 core hooks.

## Business Value

- Extends AI-DLC to Cursor's growing user base without methodology changes
- Same orchestrator, same methodology — one framework, six platforms
- Zero changes to `scripts/package.ts` required (auto-discovery via manifest.ts)
- Works across all three Cursor environments (IDE, CLI, cloud agents) from one distribution

## Key Architectural Decisions

1. **`.mdc` file format for rules**: Official Cursor docs require `.mdc` extension; `.md` files in `.cursor/rules/` are ignored. Format: `.cursor/rules/<name>/<name>.mdc`.
2. **Emitter owns all Cursor-native surfaces**: `emit.ts` generates rules, hooks.json, commands, cli.json, and plugin manifests — structural divergence that can't be simple file copies.
3. **Permission-deny via JSON stdout**: Hook adapter maps core exit-code-2 to `{permission:"deny"}` JSON (Cursor's native blocking contract), always exiting 0.
4. **Session init via beforeSubmitPrompt**: Uses `beforeSubmitPrompt` (not `sessionStart`) with conversation_id marker for cloud agent compatibility.
5. **tierFlavor "claude"**: Cursor uses Anthropic model identifiers natively — no new tier flavor needed.
6. **Tests t145 + t146**: Packaging parity test and hook adapter contract test following established codex/kiro patterns.

## Technology Stack

- **Runtime**: bun (TypeScript strict, ES modules)
- **Linter/Formatter**: Biome
- **Build Tool**: `bun scripts/package.ts` (packager)
- **Target Platform**: Cursor IDE 3.11+ (Anysphere, Inc.)
- **Model Provider**: Anthropic Claude (user-governed via Cursor UI)
- **Test Runner**: bun test (custom runner, 4 tiers)
- **License**: MIT-0

## Navigation Guide

### For Technical Implementers
- [Functional Requirements](requirements/functional-requirements.md) — 13 requirements (9 P0, 2 P1, 2 P2)
- [Non-Functional Requirements](requirements/non-functional-requirements.md) — 13 requirements (8 P0, 2 P1, 3 P2)
- [System Architecture](architecture/system-architecture.md) — components, interfaces, deployment
- [Data Flows](architecture/data-flows.md) — sequence diagrams for all hook and build flows
- [Architecture Decision Records](architecture/architecture-decision-records/) — 6 ADRs

### For Security Reviewers
- [Threat Analysis](security/threat-analysis.md) — STRIDE model: 10 threats, 12 mitigations
- [Security Controls](security/security-controls.md) — threat-to-control mapping
- [Implementation Guidance](security/implementation-guidance.md) — developer security checklist
- [Testing Framework](security/testing-framework.md) — 33 security test cases

### For Project Managers
- [User Stories](project-management/user-stories.md) — 12 stories across 6 epics, 3 sprints

### For Quality Reviewers
- [Input Assessment](appendices/input-assessment-analysis.md) — document readiness analysis
- [Requirements Traceability](appendices/requirements-traceability-matrix.md) — full RTM
- [Architecture Validation](appendices/architecture-integration-validation.md) — quality score 96/100
- [Clarification Questions](appendices/clarification-questions.md) — all 7 resolved
- [Architecture Research](appendices/architecture-research/) — 3 domain research files

## Folder Structure

```
generated/design/
├── README.md
├── AGENTS.md
├── requirements/
│   ├── functional-requirements.md
│   └── non-functional-requirements.md
├── architecture/
│   ├── system-architecture.md
│   ├── data-flows.md
│   └── architecture-decision-records/
│       ├── ADR-001-cursor-rule-file-format.md
│       ├── ADR-002-emitter-owns-cursor-native-surfaces.md
│       ├── ADR-003-hook-adapter-permission-deny-contract.md
│       ├── ADR-004-session-initialization-via-beforesubmitprompt.md
│       ├── ADR-005-tierflavor-claude-for-cursor.md
│       └── ADR-006-test-file-numbering-and-pattern.md
├── security/
│   ├── threat-analysis.md
│   ├── security-controls.md
│   ├── testing-framework.md
│   └── implementation-guidance.md
├── project-management/
│   └── user-stories.md
└── appendices/
    ├── input-assessment-analysis.md
    ├── requirements-traceability-matrix.md
    ├── architecture-integration-validation.md
    ├── clarification-questions.md
    └── architecture-research/
        ├── packager-integration-research.md
        ├── cursor-native-surfaces-research.md
        └── testing-and-distribution-quality-research.md
```

## Glossary

| Term | Definition |
|------|-----------|
| AI-DLC | AI-Driven Development Life Cycle — the multi-harness framework |
| Harness | A thin per-CLI distribution surface that projects core/ into a specific IDE |
| dist/ | Generated distribution trees (never hand-edited) |
| .mdc | Cursor's rule file extension (Markdown with YAML frontmatter) |
| failClosed | Hook option where process failure blocks the operation |
| Byte-parity | `--check` mode that byte-compares generated vs committed dist/ |
| EmitContext | TypeScript type passed to emit() with repo paths and token substitution |
| SKILL.md | Open standard for slash-command skills (shared across Claude, Codex, Cursor) |
