# aidlc-developer-agent -- Technical Reference

## Identity

| Field | Value |
|-------|-------|
| Name | aidlc-developer-agent |
| Tier | **judgment** |
| Allowed Claude Code Tools | Read, Edit, Write, Glob, Grep, Bash, AskUserQuestion |
| Disallowed Claude Code Tools | Task |

---

## Stage Ownership

### Lead Stages

| Stage | Name | What This Agent Does |
|-------|------|----------------------|
| reverse-engineering | Reverse Engineering (Code scan step) | Performs deep code scan to extract dependency graphs, API endpoints, database models, and technical debt indicators |
| code-generation | Code Generation | Implements units of work from architectural specifications as production-quality code |

### Support Stages

| Stage | Name | What This Agent Contributes |
|-------|------|-----------------------------|
| practices-discovery | Practices Discovery (Inception) | Mutually blind code-pattern spoke: naming conventions, layer separation, error handling, and file organisation, written to its own contribution file |
| user-stories | User Stories | Implementability voice in the mob ensemble (dispatched collaborator, writes its own contribution file) |
| functional-design | Functional Design | API contract design and data model specification |
| deployment-execution | Deployment Execution | Database migration execution and validation |

---

## Collaboration Patterns

### Receives From

| Source | Artifacts |
|--------|-----------|
| aidlc-architect-agent | Unit of work specifications, design patterns, API specifications |
| aidlc-quality-agent | Test requirements, bug reports, defect specifications |

### Hands Off To

| Target | Artifacts |
|--------|-----------|
| aidlc-quality-agent | Implemented code for testing, test infrastructure |
| aidlc-architect-agent | Code scan results for reverse engineering synthesis |

---

## Knowledge Sources

### Methodology (Tier 1)

Path: `.claude/knowledge/aidlc-developer-agent/`

| File | Content |
|------|---------|
| api-design-guide.md | API contract design (REST, GraphQL, gRPC) methodology |
| code-analysis-guide.md | Codebase analysis and reverse engineering techniques |
| code-generation-guide.md | Code generation methodology and implementation patterns |
| code-generation-patterns.md | Language-specific code generation patterns and templates |
| data-modelling-patterns.md | Data model design patterns (relational and NoSQL) |
| re-artifacts.md | Reverse engineering artifact specifications |

### Team (Tier 2)

Path: `aidlc/knowledge/aidlc-developer-agent/` (the space-level knowledge dir; user-managed)

A space-level directory the team creates when it has content (the engine ships `aidlc/knowledge/` empty). Populated by the team with project-specific
development context such as coding standards, framework conventions, existing
API patterns, or migration strategies.

---

## Cross-References

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-developer-agent](../../guide/agents/developer-agent.md)
- [Stage Documentation](../04-stages/)
- Source: [`dist/claude/.claude/agents/aidlc-developer-agent.md`](../../../dist/claude/.claude/agents/aidlc-developer-agent.md)
