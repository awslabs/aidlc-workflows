# Introduction

> Part of the [AI-DLC documentation](../README.md) · **User Guide** · [Harness Engineer Guide](../harness-engineering/00-overview.md) · [Developer Reference](../reference/00-overview.md)

## What is AI-DLC?

AI-DLC (AI-Driven Development Life Cycle) is a methodology for structuring AI-assisted software development into repeatable, traceable phases. It originated from the [AWS AI-DLC methodology](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/). This repository implements it natively from one harness-neutral core, so it runs inside the CLI harness you already use — today Claude Code, Kiro CLI, Kiro IDE, Codex CLI, or opencode. This guide is harness-neutral; where a detail differs by harness, it says so and points you to your harness's chapter (see [Running on other harnesses](harnesses/README.md)). Examples are shown in Claude Code unless noted.

You invoke it with a single command:

```
/aidlc Build a REST API for inventory management
```

AI-DLC then guides you through a structured workflow — from capturing your intent, through requirements, design, implementation, testing, and deployment — while keeping you in control at every decision point.

## Philosophy: Small Mob, Broad Agents

Rather than dozens of narrow specialists (an approach that recreates waterfall handoff chains), AI-DLC uses **11 broadly capable agents** that each participate across multiple stages and phases. Each agent carries context across stages, eliminating handoffs and reducing coordination overhead.

This mirrors how effective human teams work: a mob of 3-5 people covers an entire feature, each bringing broad skills rather than a single narrow specialty.

## How the Orchestrator Works

At its core, AI-DLC runs a simple loop. A deterministic **engine** decides what happens next; the **conductor** (the `/aidlc` session, `SKILL.md`) carries it out, then asks the engine for the next move. Across that loop the framework:

1. **Reads stage files** — 32 stage definitions across 5 phases, each specifying inputs, steps, outputs, and the lead agent
2. **Loads agent personas** — Activates domain-expert perspectives (architect, developer, product manager, etc.) with specialized knowledge
3. **Manages state and audit** — Tracks progress in `aidlc-state.md` and logs every decision to the intent's `audit/` shards for traceability
4. **Delegates across stage topologies** — For focused autonomous work and multi-agent collaboration, dispatches subagents as a hub-and-spoke, pipeline, or mob
5. **Presents approval gates** — After each stage, you review and approve before the workflow advances

The engine owns the routing (which stage is next, which scope, when to stop); the conductor owns execution quality (running the stage well, asking good questions, surfacing decisions to you). Most stages run **inline**: the conductor adopts the agent's perspective and works directly with you in conversation. Four stages use dispatched topologies: Practices Discovery and Code Generation run as `subagent` hubs, Reverse Engineering as a two-link `pipeline`, and User Stories as a `mob`. The complete topology is 28 inline / 2 subagent / 1 pipeline / 1 mob. For the full architecture, see the Developer Reference's [Engine and Skill System](../reference/17-skill-system.md).

## Who This Guide Is For

This guide is for anyone **using** AI-DLC to build software:

- **New users** — Start with [Getting Started](01-getting-started.md), [Your First Workflow](02-your-first-workflow.md), and [Spaces and Intents](03-spaces-and-intents.md)
- **Regular users** — Reference [CLI Commands](12-cli-commands.md), [Scopes, Depth, and Test Strategy](05-scopes-and-depth.md), and [Troubleshooting](15-troubleshooting.md)
- **Team leads** — See [Knowledge](08-knowledge.md) and [Rules and the Learning Loop](09-rules-and-the-learning-loop.md) for customizing AI-DLC to your team's standards

To reshape *how* AI-DLC behaves — add a stage or an agent, define a scope, author rules and sensors, or add team knowledge (all configuration, no code) — see the [Harness Engineer Guide](../harness-engineering/00-overview.md). For changing the AI-DLC codebase itself, see the [Developer Reference](../reference/00-overview.md).

## Key Numbers

| Metric | Value |
|--------|-------|
| Phases | 5 (Initialization, Ideation, Inception, Construction, Operation) |
| Stages | 32 |
| Agents | 14 total: 11 domain experts, 2 reviewers, and the composer |
| Scopes | 9 (enterprise through workshop) + auto-detect |
| Depth levels | 3 (Minimal, Standard, Comprehensive) |
| Test strategy levels | 3 (Minimal, Standard, Comprehensive) |
| Audit event types | 74 |

## Guide Map

| Chapter | What You'll Learn |
|---------|------------------|
| [Getting Started](01-getting-started.md) | Prerequisites, installation, first health check |
| [Your First Workflow](02-your-first-workflow.md) | Annotated walkthrough of a complete run |
| [Spaces and Intents](03-spaces-and-intents.md) | The workspace layout: running many pieces of work across spaces and intents |
| [Phases and Stages](04-phases-and-stages.md) | The 5 phases and 32 stages explained |
| [Scopes, Depth, and Test Strategy](05-scopes-and-depth.md) | How to choose and override scope/depth/test strategy |
| [Agents](06-agents.md) | The 14-agent roster: 11 domain experts, 2 reviewers, and the composer |
| [Agent deep dives](agents/README.md) | Per-agent reference pages: responsibilities, stages, knowledge |
| [Interaction Modes](07-interaction-modes.md) | Guide Me / Edit File / Chat and approval gates |
| [Knowledge](08-knowledge.md) | Adding company standards and conventions |
| [Rules and the Learning Loop](09-rules-and-the-learning-loop.md) | Self-learning behavioral rules |
| [State and Audit](10-state-and-audit.md) | How progress and decisions are tracked |
| [Session Management](11-session-management.md) | Resume, redo, jump, recovery, and session reporting skills |
| [CLI Commands](12-cli-commands.md) | Complete flag reference with examples |
| [Customization](13-customization.md) | Settings, scope config, agent tuning |
| [Artifacts Reference](14-artifacts-reference.md) | The per-intent record dir (`aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`) explained |
| [Troubleshooting](15-troubleshooting.md) | Symptom-based problem solving |
| [Worked Examples](16-worked-examples.md) | Full bugfix and feature walkthroughs |
| [Skills and Runner Commands](17-skills.md) | The `/aidlc-*` stage- and scope-runner commands and the author-your-own-runner path |
| [Workshop Mode](workshop-mode.md) | Multi-developer manual recipe for the workshop scope (claim semantics via git push) |
| [Running on other harnesses](harnesses/README.md) | Install and run on Kiro CLI, Kiro IDE, Codex CLI, or opencode, and what differs per harness |
| [Glossary](glossary.md) | All terminology defined |
