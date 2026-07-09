# aidlc-product-agent -- Technical Reference

## Identity

| Field | Value |
|-------|-------|
| Name | aidlc-product-agent |
| Tier | **judgment** |
| Allowed Claude Code Tools | Read, Edit, Write, Glob, Grep, WebSearch, AskUserQuestion |
| Disallowed Claude Code Tools | Task |

---

## Stage Ownership

### Lead Stages

| Stage | Name | What This Agent Does |
|-------|------|----------------------|
| intent-capture | Intent Capture and Framing | Captures business intent, problem statement, success metrics, and initial constraints from stakeholder input |
| market-research | Market Research and Competitive Analysis | Researches competitive landscape, market trends, build-vs-buy trade-offs, and differentiation opportunities |
| scope-definition | Scope Definition and Prioritization | Defines scope boundaries (in/out), applies prioritization frameworks, creates the Intent Backlog |
| requirements-analysis | Requirements Analysis | Structures and formalizes requirements from Ideation artifacts into traceable, testable specifications |
| user-stories | User Stories | Transforms requirements into INVEST-compliant user stories with personas, acceptance criteria, and dependency mapping |

### Support Stages

| Stage | Name | What This Agent Contributes |
|-------|------|-----------------------------|
| rough-mockups | Rough Mockups and Concept Visualization | Validates wireframes against captured intent and user needs |
| approval-handoff | Initiative Approval and Handoff | Validates completeness of the initiative brief before phase transition |
| refined-mockups | Refined Mockups and UX Design | Validates refined designs against user stories and acceptance criteria |

---

## Collaboration Patterns

### Receives From

| Source | Artifacts |
|--------|-----------|
| User/stakeholder input | Raw business needs, domain knowledge, project descriptions |
| Existing documentation | Prior artifacts, legacy system documentation |
| aidlc-operations-agent | Operational feedback from production for next Ideation cycle (closes the lifecycle loop) |

### Hands Off To

| Target | Artifacts |
|--------|-----------|
| aidlc-architect-agent | Validated requirements for system design and decomposition |
| aidlc-developer-agent | Story specifications for code generation |
| aidlc-quality-agent | Acceptance criteria for test case design |
| aidlc-delivery-agent | Prioritized backlog for delivery planning |

---

## Knowledge Sources

### Methodology (Tier 1)

Path: `.claude/knowledge/aidlc-product-agent/`

| File | Content |
|------|---------|
| functional-design-guide.md | Functional design methodology |
| market-research-methods.md | Market research techniques and templates |
| prioritization-frameworks.md | MoSCoW, WSJF, RICE, Kano frameworks |
| product-guide.md | Product management methodology |
| requirements-elicitation.md | Requirements gathering techniques |
| requirements-guide.md | Requirements analysis methodology |
| user-story-patterns.md | INVEST criteria, story patterns, acceptance criteria templates |

### Team (Tier 2)

Path: `aidlc/knowledge/aidlc-product-agent/` (the space-level knowledge dir; user-managed)

A space-level directory the team creates when it has content (the engine ships `aidlc/knowledge/` empty). Populated by the team with project-specific
product knowledge such as existing personas, market research, domain glossaries,
or stakeholder communication preferences.

---

## Cross-References

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-product-agent](../../guide/agents/product-agent.md)
- [Stage Documentation](../04-stages/)
- Source: [`dist/claude/.claude/agents/aidlc-product-agent.md`](../../../dist/claude/.claude/agents/aidlc-product-agent.md)
