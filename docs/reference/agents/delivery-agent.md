# aidlc-delivery-agent -- Technical Reference

## Identity

| Field | Value |
|-------|-------|
| Name | aidlc-delivery-agent |
| Tier | **templated** |
| Allowed Claude Code Tools | Read, Edit, Write, Glob, Grep, AskUserQuestion |
| Disallowed Claude Code Tools | Task |

---

## Stage Ownership

### Lead Stages

| Stage | Name | What This Agent Does |
|-------|------|----------------------|
| team-formation | Team Formation | Assesses required skill sets, composes mob teams, defines communication norms |
| approval-handoff | Initiative Approval and Handoff | Compiles initiative brief, validates completeness, presents for stakeholder approval, executes phase handoff |
| delivery-planning | Delivery Planning | Plans the Bolt sequence (economic ordering through the units-generation stage's dependency DAG), assigns mobs, defines per-Bolt Definition of Done and confidence hypothesis |

### Support Stages

| Stage | Name | What This Agent Contributes |
|-------|------|-----------------------------|
| scope-definition | Scope Definition and Prioritization | Validates scope against delivery feasibility and available capacity |
| units-generation | Units Generation | Aligns unit granularity with planning needs and delivery sequencing requirements |

---

## Collaboration Patterns

### Receives From

| Source | Artifacts |
|--------|-----------|
| aidlc-product-agent | Scope, priorities, initiative framing, prioritized backlog |
| aidlc-architect-agent | Units, complexity estimates, dependency graphs |

### Hands Off To

| Target | Artifacts |
|--------|-----------|
| All construction agents | Delivery plan, mob assignments, Bolt sequence |
| Orchestrator | Initiative brief for phase gate approval |

---

## Knowledge Sources

### Methodology (Tier 1)

Path: `.claude/knowledge/aidlc-delivery-agent/`

| File | Content |
|------|---------|
| mob-programming-guide.md | Mob programming patterns, roles (driver, navigator, researcher), and team composition |
| team-topologies.md | Team formation patterns and communication structures |
| workflow-planning-guide.md | Delivery planning: economic-vs-topological sequencing, WSJF, walking skeleton, Bolt DoD patterns |

### Team (Tier 2)

Path: `aidlc/knowledge/aidlc-delivery-agent/` (the space-level knowledge dir; user-managed)

A space-level directory the team creates when it has content (the engine ships `aidlc/knowledge/` empty). Populated by the team with project-specific
delivery context such as team conventions, bolt-sizing preferences, or
organizational capacity constraints.

---

## Cross-References

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-delivery-agent](../../guide/agents/delivery-agent.md)
- [Stage Documentation](../04-stages/)
- Source: [`dist/claude/.claude/agents/aidlc-delivery-agent.md`](../../../dist/claude/.claude/agents/aidlc-delivery-agent.md)
