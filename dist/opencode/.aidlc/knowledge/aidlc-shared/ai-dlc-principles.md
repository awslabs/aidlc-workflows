# AI-DLC Methodology Principles

## Design Principle: Small Mob, Broad Agents

AI-DLC is built on the mob model — a small cross-functional group moving fast together. The agents mirror that. Rather than dozens of narrow specialists (which recreates waterfall handoff chains), we define **11 broadly capable agents** that each participate across multiple stages and phases, just as a real architect or developer would in a mob session.

Each agent carries context across stages because they are present throughout. This eliminates handoffs, reduces coordination overhead, and keeps the process agile.

## Core Principles

1. **User decides, AI executes** — Every material decision goes through an approval gate where the user reviews, revises, or overrides.
2. **Adaptive depth** — Simple projects skip heavyweight stages. Complex projects get full coverage. The workflow adapts to project needs.
3. **Traceable artifacts** — Every stage produces versioned markdown documents in `aidlc-docs/`, creating a complete decision record.
4. **Multi-role expertise** — Each stage is guided by domain-expert agent personas to ensure appropriate depth.
5. **No emergent behavior** — Agents follow prescribed protocols. Approval menus, completion messages, and state transitions are standardized.
6. **Questions before assumptions** — When in doubt, ask. Incomplete answers lead to poor designs.
7. **Contradiction detection** — Cross-check all answers for scope mismatches, risk mismatches, and technology conflicts.

## Five-Phase Structure

| Phase | Purpose | Key Outcome |
|-------|---------|-------------|
| **INITIALIZATION** | Bootstrap — state files, directory scaffold, workspace scan, routing | Configured workspace ready for workflow |
| **IDEATION** | Validate the initiative — intent, market, feasibility, scope, team | Approved initiative brief |
| **INCEPTION** | Elaborate — requirements, stories, design, architecture, units, delivery plan | Detailed execution plan |
| **CONSTRUCTION** | Build — functional design, NFRs, infrastructure, code, tests, CI | Working tested code |
| **OPERATION** | Deploy & operate — pipelines, environments, observability, incidents, feedback | Production system with monitoring |

## Scope System

Not every task requires all 32 stages. Scopes (enterprise, feature, mvp, poc, bugfix, refactor, infra, security-patch, workshop) determine which stages execute and at what depth.

## Self-Learning Guardrails

When a human corrects agent behavior, the correction becomes a permanent guardrail so the mistake never repeats. Guardrails are classified as organization-level (all projects) or project-level (this repo only).
