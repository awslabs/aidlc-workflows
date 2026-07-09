# aidlc-quality-agent -- Technical Reference

## Identity

| Field | Value |
|-------|-------|
| Name | aidlc-quality-agent |
| Tier | **judgment** |
| Allowed Claude Code Tools | Read, Edit, Write, Glob, Grep, Bash, AskUserQuestion |
| Disallowed Claude Code Tools | Task |

---

## Stage Ownership

### Lead Stages

| Stage | Name | What This Agent Does |
|-------|------|----------------------|
| build-and-test | Build and Test | Defines test strategy, generates test suites, validates coverage against acceptance criteria, enforces quality gates |
| performance-validation | Performance Validation and Load Testing | Designs and executes load tests, validates NFR targets, identifies bottlenecks, produces capacity planning recommendations |

### Support Stages

| Stage | Name | What This Agent Contributes |
|-------|------|-----------------------------|
| practices-discovery | Practices Discovery | Scans testing posture (TDD vs after-the-fact), coverage floor, and CI block-or-warn behaviour to surface team testing practices |
| nfr-requirements | NFR Requirements | Defines testable quality attribute scenarios and measurable NFR targets |

---

## Collaboration Patterns

### Receives From

| Source | Artifacts |
|--------|-----------|
| aidlc-product-agent | User stories with acceptance criteria for test case derivation |
| aidlc-architect-agent | NFR targets, design testability assessment, test boundaries |
| aidlc-developer-agent | Implemented code for testing |

### Hands Off To

| Target | Artifacts |
|--------|-----------|
| aidlc-pipeline-deploy-agent | Test suite integration into CI/CD, quality gate definitions |
| aidlc-operations-agent | Performance baselines for production monitoring |

---

## Knowledge Sources

### Methodology (Tier 1)

Path: `.claude/knowledge/aidlc-quality-agent/`

| File | Content |
|------|---------|
| nfr-reliability-guide.md | Reliability testing methodology and resilience validation |
| nfr-validation-methods.md | NFR validation techniques (load testing, performance profiling) |
| test-strategy-patterns.md | Test pyramid patterns, test data strategies, quality gate design |
| testing-guide.md | Testing methodology and test case design principles |

### Team (Tier 2)

Path: `aidlc/knowledge/aidlc-quality-agent/` (the space-level knowledge dir; user-managed)

A space-level directory the team creates when it has content (the engine ships `aidlc/knowledge/` empty). Populated by the team with project-specific
QA context such as existing test frameworks, coverage targets, performance
baselines, or quality gate thresholds.

---

## Cross-References

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-quality-agent](../../guide/agents/quality-agent.md)
- [Stage Documentation](../04-stages/)
- Source: [`dist/claude/.claude/agents/aidlc-quality-agent.md`](../../../dist/claude/.claude/agents/aidlc-quality-agent.md)
