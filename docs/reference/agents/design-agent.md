# aidlc-design-agent -- Technical Reference

## Identity

| Field | Value |
|-------|-------|
| Name | aidlc-design-agent |
| Tier | **judgment** |
| Allowed Claude Code Tools | Read, Edit, Write, Glob, Grep, WebSearch, AskUserQuestion |
| Disallowed Claude Code Tools | Task |

---

## Stage Ownership

### Lead Stages

| Stage | Name | What This Agent Does |
|-------|------|----------------------|
| rough-mockups | Rough Mockups and Concept Visualization | Creates low-fidelity wireframes, concept sketches, and initial information architecture during Ideation |
| refined-mockups | Refined Mockups and UX Design | Evolves wireframes into mid-to-high fidelity mockups with interaction specs, responsive design, and accessibility annotations |

### Support Stages

| Stage | Name | What This Agent Contributes |
|-------|------|-----------------------------|
| user-stories | User Stories | Enriches stories with interaction details and UX acceptance criteria |
| application-design | Application Design | Contributes UI component specifications and design system mapping |

---

## Collaboration Patterns

### Receives From

| Source | Artifacts |
|--------|-----------|
| aidlc-product-agent | User stories, personas, intent, user journey context |
| aidlc-architect-agent | Component design constraints, technology limitations affecting UI |

### Hands Off To

| Target | Artifacts |
|--------|-----------|
| aidlc-developer-agent | Interaction specifications for implementation, component specs |
| aidlc-quality-agent | UX acceptance criteria for testing, accessibility requirements |

---

## Knowledge Sources

### Methodology (Tier 1)

Path: `.claude/knowledge/aidlc-design-agent/`

| File | Content |
|------|---------|
| accessibility-wcag.md | WCAG 2.1 AA guidelines and implementation patterns |
| component-spec-template.md | Template for documenting component specifications (states, props, behaviour) |
| interaction-design-patterns.md | Interaction patterns for navigation, forms, feedback, state transitions |
| ux-guide.md | UX design methodology and principles |
| wireframing-guide.md | Wireframing techniques for low and high fidelity |

### Team (Tier 2)

Path: `aidlc/knowledge/aidlc-design-agent/` (the space-level knowledge dir; user-managed)

A space-level directory the team creates when it has content (the engine ships `aidlc/knowledge/` empty). Populated by the team with project-specific
design assets such as existing design systems, brand guidelines, typography
rules, or component libraries.

---

## Cross-References

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-design-agent](../../guide/agents/design-agent.md)
- [Stage Documentation](../04-stages/)
- Source: [`dist/claude/.claude/agents/aidlc-design-agent.md`](../../../dist/claude/.claude/agents/aidlc-design-agent.md)
