# Product Agent

> **Agent deep dive** · [User Guide](../00-introduction.md) › [Agents](../06-agents.md) › [deep dives](README.md) · Technical reference: [product-agent](../../reference/agents/product-agent.md)

The aidlc-product-agent is your product manager and business analyst. It transforms raw business needs, user requests, and domain knowledge into structured requirements, prioritized user stories, and well-defined scope boundaries. It ensures that every downstream artifact traces back to a validated requirement, bridging the gap between what stakeholders want and what developers build.

The aidlc-product-agent leads nine stages spanning Ideation and Inception, including all four discovery stages. It is the primary agent you interact with early in a workflow, asking clarifying questions about your intent, defining what is in and out of scope, and producing the requirements and stories that drive all subsequent design and implementation.

## Stages Led

| Stage | Phase | Description |
|-------|-------|-------------|
| 1.1 Intent Capture & Framing | Ideation | Captures your project intent and stakeholder context |
| 1.2 Market Research | Ideation | Competitive analysis and build-vs-buy assessment |
| 1.4 Scope Definition | Ideation | Defines scope boundaries and prioritized intent backlog |
| 1.8 Discovery Current State | Ideation | Builds the evidenced as-is picture (discovery scope only) |
| 1.9 Discovery Future State | Ideation | Framings, options, and typed assumptions (discovery scope only) |
| 1.10 Discovery Experimentation | Ideation | Tests the riskiest assumptions first (discovery scope only) |
| 1.11 Discovery Decision | Ideation | The decision pack and the commit, pivot, or park decision (discovery scope only) |
| 2.3 Requirements Analysis | Inception | Produces structured functional and non-functional requirements |
| 2.4 User Stories | Inception | Creates user stories with acceptance criteria from personas |

## Stages Supported

| Stage | Phase | Contribution |
|-------|-------|-------------|
| 1.6 Rough Mockups | Ideation | Validates mockups against captured intent |
| 1.7 Approval & Handoff | Ideation | Validates initiative brief completeness |
| 2.5 Refined Mockups | Inception | Validates mockups against user stories |

## What to Expect

When the aidlc-product-agent is active, expect structured questions about your project goals, target users, priorities, and constraints. It uses the tri-mode question flow (Guide Me, Edit File, or Chat) and asks targeted questions to surface ambiguities and fill gaps. It prioritizes ruthlessly — helping you distinguish must-have from nice-to-have.

## How It Collaborates

The aidlc-product-agent works closely with the aidlc-architect-agent on feasibility and dependencies, the aidlc-design-agent on UX alignment, and the aidlc-delivery-agent on capacity and scope validation. Its outputs (requirements, stories, scope) are consumed by nearly every downstream agent.

## Key Principles

- Every requirement must trace to a stakeholder need — no invented requirements
- If a requirement cannot be verified through a test, it is not a requirement
- Ambiguity is the enemy — when something seems obvious, confirm it
- Value over volume — fewer well-defined stories beat a large vague backlog
- Stories should cut vertically through all layers, not horizontally
