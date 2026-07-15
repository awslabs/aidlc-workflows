# Design Agent

> **Agent deep dive** · [User Guide](../00-introduction.md) › [Agents](../06-agents.md) › [deep dives](README.md) · Technical reference: [design-agent](../../reference/agents/design-agent.md)

The aidlc-design-agent is your UX/UI designer. It produces wireframes and concept sketches during Ideation, then evolves them into high-fidelity mockups with interaction specifications during Inception. It defines information architecture, navigation design, responsive behavior, and accessibility requirements. For non-UI projects, it produces system context diagrams and API experience designs.

The aidlc-design-agent leads two stages and supports two others. It ensures that every user-facing interface is usable, accessible, and consistent with design system standards.

## Stages Led

| Stage | Phase | Description |
|-------|-------|-------------|
| 1.6 Rough Mockups | Ideation | Low-fidelity wireframes and concept visualization |
| 2.5 Refined Mockups | Inception | High-fidelity mockups with interaction specs and accessibility |

## Stages Supported

| Stage | Phase | Contribution |
|-------|-------|-------------|
| 1.8 Discovery Current State | Ideation | Captures the design language record (discovery scope only) |
| 1.9 Discovery Future State | Ideation | Visual expression of the future-state options (discovery scope only) |
| 1.10 Discovery Experimentation | Ideation | Mock-up work in the captured design language (discovery scope only) |
| 2.4 User Stories | Inception | Enriches stories with interaction details and UX acceptance criteria |
| 2.6 Application Design | Inception | Contributes UI component specifications |

## What to Expect

When the aidlc-design-agent is active, it produces detailed descriptions of screen layouts, user flows, and interaction patterns in markdown. It asks about target devices, accessibility requirements, and design system preferences. It describes interactions in terms of concrete screen states and transitions — loading, success, error, empty, and partial states.

## How It Collaborates

The aidlc-design-agent receives intent and user stories from the aidlc-product-agent, and component constraints from the aidlc-architect-agent. Its mockups and interaction specs are handed off to the aidlc-developer-agent for implementation and to the aidlc-quality-agent for UX acceptance testing.

## Key Principles

- Design for scannability — important actions must be immediately visible
- Consistency reduces cognitive load — every interaction pattern should be predictable
- Error prevention over error messages — make errors difficult to commit
- WCAG accessibility compliance is a baseline, not a stretch goal
- Design for the worst case — empty states, error states, slow connections
