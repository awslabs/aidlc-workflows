# Architect Agent

> **Agent deep dive** · [User Guide](../00-introduction.md) › [Agents](../06-agents.md) › [deep dives](README.md) · Technical reference: [architect-agent](../../reference/agents/architect-agent.md)

The aidlc-architect-agent is your solutions architect. It translates requirements into robust system architectures, produces Architecture Decision Records (ADRs), designs domain models, and decomposes projects into implementable units of work. It thinks in patterns and trade-offs, producing designs that developers can implement directly.

The aidlc-architect-agent leads the most stages of any single agent in the lifecycle — six in total — spanning Ideation, Inception, and Construction. It is the primary design authority and carries the `judgment` tier along with the seven other high-judgment agents, so it inherits your session's own model and effort rather than pinning one. Only delivery, pipeline-deploy, and operations carry the `templated` tier (a mid-size model at reduced effort) because their output is dominantly templated.

## Stages Led

| Stage | Phase | Description |
|-------|-------|-------------|
| 1.3 Feasibility & Constraints | Ideation | Technical feasibility assessment and constraint analysis |
| 2.6 Application Design | Inception | Component design, API contracts, and ADRs |
| 2.7 Units Generation | Inception | Decomposes design into implementable units of work |
| 3.1 Functional Design | Construction | Detailed domain models and business logic (per unit) |
| 3.2 NFR Requirements | Construction | Non-functional requirements with measurable targets (per unit) |
| 3.3 NFR Design | Construction | Technical approaches for caching, resilience, security (per unit) |

It also leads the synthesis step of stage 2.1 (Reverse Engineering), where it receives code scan results from the aidlc-developer-agent and produces the 9 architectural artifacts.

## Stages Supported

| Stage | Phase | Contribution |
|-------|-------|-------------|
| 1.1 Intent Capture | Ideation | Provides technical context |
| 2.1 Reverse Engineering (dispatched final pipeline link) | Inception | Synthesizes code scan results into a coherent architectural model |
| 2.8 Delivery Planning | Inception | Validates build order against architecture dependencies |

## What to Expect

When the aidlc-architect-agent is active, it focuses on boundaries, patterns, and trade-offs. It asks about existing system constraints, technology preferences, scalability requirements, and operational concerns. It produces structured design documents with explicit decision rationale, component diagrams described in markdown, and ADRs for every significant choice.

## How It Collaborates

The aidlc-architect-agent receives requirements from the aidlc-product-agent and code scan results from the aidlc-developer-agent. It works with the aidlc-aws-platform-agent on AWS service mapping, the aidlc-devsecops-agent on secure design, and the aidlc-compliance-agent on regulatory constraints. Its outputs (unit specs, API contracts, NFR targets) are consumed by the aidlc-developer-agent, aidlc-quality-agent, and aidlc-aws-platform-agent.

## Key Principles

- Every design artifact must trace to a decision with explicit rationale
- Getting component boundaries right matters more than internal details
- Minimize inter-component dependencies aggressively
- Design for change, not for reuse — optimize for modifiability
- Make hidden assumptions explicit — surface data flow, ownership, and failure modes
- Prefer reversible decisions; flag irreversible ones for extra scrutiny
