# Delivery Agent

> **Agent deep dive** · [User Guide](../00-introduction.md) › [Agents](../06-agents.md) › [deep dives](README.md) · Technical reference: [delivery-agent](../../reference/agents/delivery-agent.md)

The aidlc-delivery-agent is your engineering manager and delivery planner. It translates scope definitions and architectural designs into actionable delivery plans with team assignments, build ordering, and sequencing. It owns the initiative brief that bridges Ideation into Construction and ensures smooth phase handoffs with full traceability.

The aidlc-delivery-agent leads three stages spanning Ideation and Inception. It is the agent responsible for ensuring that what has been designed can actually be delivered, and in what order.

## Stages Led

| Stage | Phase | Description |
|-------|-------|-------------|
| 1.5 Team Formation | Ideation | Assesses required skills and composes team structure |
| 1.7 Approval & Handoff | Ideation | Compiles initiative brief for phase gate approval |
| 2.8 Delivery Planning | Inception | Plans the Bolt sequence (economic ordering through 2.7's DAG), with team allocation, risk/sequencing rationale, and external dependency map |

## Stages Supported

| Stage | Phase | Contribution |
|-------|-------|-------------|
| 1.4 Scope Definition | Ideation | Validates scope against delivery feasibility |
| 1.11 Discovery Decision | Ideation | Handoff perspective on the decision pack (discovery scope only) |
| 2.7 Units Generation | Inception | Aligns unit granularity with planning needs |

## What to Expect

When the aidlc-delivery-agent is active, it focuses on sequencing and feasibility. It asks about team size, available expertise, and delivery preferences. It produces structured plans that map units of work to a build order, identify the critical path, and flag dependencies that could block progress.

## How It Collaborates

The aidlc-delivery-agent receives scope and priorities from the aidlc-product-agent, and unit specifications and complexity estimates from the aidlc-architect-agent. Its delivery plan is consumed by all Construction agents to understand build order and team assignments.

## Key Principles

- Plans are living documents — a plan that cannot change will fail
- Small batches, fast feedback — smaller increments surface risks earlier
- Every unit of work must trace back to a requirement
- Phase transitions require explicit completeness checks
- Confidence is earned bolt by bolt — each shipped bolt de-risks the next
