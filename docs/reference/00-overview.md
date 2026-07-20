# Developer Reference Overview

> Part of the [AI-DLC documentation](../README.md) · [User Guide](../guide/00-introduction.md) · [Harness Engineer Guide](../harness-engineering/00-overview.md) · **Developer Reference**

This reference documents the internal architecture and implementation of AI-DLC. It is intended for contributors changing the AI-DLC codebase itself -- the orchestrator, hooks, CLI tools, the stage-graph compile pipeline, the audit taxonomy, or the test suite.

If you are **using** AI-DLC to build software, start with the [User Guide](../guide/00-introduction.md). If you are **reshaping how AI-DLC behaves** through configuration -- adding a stage or an agent, defining a scope, authoring rules and sensors, adding team knowledge -- start with the [Harness Engineer Guide](../harness-engineering/00-overview.md); those are data changes, not code changes, and the chapters there narrate the workflow before pointing back here for the exhaustive schema.

> **Paths in this reference.** AI-DLC is authored once and generated per harness, so a file is named by one of three conventions, by intent:
> - **`core/…`** -- the hand-authored, harness-neutral **source of truth** (e.g. `core/tools/aidlc-orchestrate.ts`, `core/aidlc-common/stages/`). This is where you edit. When a path names where a file is *authored* or *changed*, it is a `core/` path.
> - **`dist/<harness>/…`** -- the **generated, committed, drift-guarded** distribution (`dist/claude/.claude/`, `dist/kiro/.kiro/`, `dist/kiro-ide/.kiro/`, `dist/codex/`). Never hand-edited; reproduced byte-for-byte by `bun scripts/package.ts`. Cited only when describing what *ships*.
> - **`<harness-dir>/…`** (e.g. `.claude/`, `.kiro/`, `.codex/`) -- the **runtime** location inside an *installed* project, where commands run and the framework reads/writes during a workflow (`bun .claude/tools/aidlc-graph.ts compile`, `loadAgents()` reading `.claude/agents/`). The directory is a parameter of the harness.
>
> Where this reference shows a bare `.claude/` path, read it as the runtime location for the Claude harness specifically; the same file is authored in `core/` and ships to each harness's own directory.

## What This Reference Covers

| Chapter | Topic |
|---------|-------|
| [Architecture](01-architecture.md) | 5-layer model, [Configuration layers](01-architecture.md#configuration-layers) routing principle, execution model, design decisions |
| [Plane Architecture](02-plane-architecture.md) | The control / data / management plane separation and its boundaries |
| [Orchestrator](03-orchestrator.md) | The SKILL.md conductor: the forwarding loop, the gate ritual, the state machine it drives |
| [Stage Protocol](04-stage-protocol.md) | Behavioral contract: approval gates, compliance checklist |
| [Stages](04-stages/) | Per-phase stage documentation (5 files) |
| [Agent System](05-agent-system.md) | Agent structure, frontmatter contract, configuration matrix |
| [Hooks and Tools](06-hooks-and-tools.md) | Hook system, CLI tools, 74-event audit taxonomy |
| [Sensor System](07-sensor-system.md) | Sensor manifest schema, PULL imports, fire model, default severity |
| [Rule System](08-rule-system.md) | Rule file layout, scope derivation, the layer-chain resolver, conflict gates |
| [Testing](09-testing.md) | Test pyramid, tiers, stubs, fixtures, test registry |
| [Knowledge System](10-knowledge-system.md) | Two-tier architecture, loading order, templates |
| [Contributing](11-contributing.md) | Development workflow, utility handler checklist, documentation policy |
| [State Machine](12-state-machine.md) | Workflow / phase / stage machines, 74-event taxonomy, audit-first rules |
| [Runtime Graph](13-runtime-graph.md) | The compiled `runtime-graph.json` artifact: data-plane mirror of the stage graph |
| [Harness Primitives Mapping](14-claude-features.md) | How each AI-DLC concept maps to a harness's native primitives (Claude Code in depth) |
| [Stage Definition](15-stage-definition.md) | YAML frontmatter contract, three-compartment body, compile pipeline |
| [Artifact Vocabulary](16-artifact-vocabulary.md) | Naming rules, collision policy, filesystem mapping, and how to view the live registry |
| [Engine and Skill System](17-skill-system.md) | The orchestration engine (`next`/`report`/`park`), the typed directive contract, the conductor, plural skills, scope shape, and the swarm referee |
| [Plugin Mechanism](18-plugin-mechanism.md) | The AIDLC plugin system: manifest, install-time composition as a real host plugin, the additive contribution seam, multi-tenant guards, and as-built status. Authoring walkthrough at [harness-engineering/10](../harness-engineering/10-authoring-a-plugin.md) |
| [Diagrams](diagrams.md) | All Mermaid diagrams in one place |
| [Agents](agents/) | Technical agent reference (frontmatter, tooling, stage ownership) |

## How to Navigate

- **Where does a new concern (rule, methodology, knowledge fact) belong?** Read [Architecture: Configuration layers](01-architecture.md#configuration-layers) — the two-axis model (authorship × consumption) with boundary tests routes any new concern to the correct file.
- **Adding a new stage?** Read [Stage Protocol](04-stage-protocol.md), then the relevant phase file in [Stages](04-stages/), then [Contributing](11-contributing.md).
- **Changing the stage definition format?** Read [Stage Definition](15-stage-definition.md) before editing any stage `.md` file. Stage file format is data-driven; runtime reads a compiled JSON.
- **Adding or renaming an artifact?** Read [Artifact Vocabulary](16-artifact-vocabulary.md) — the chapter explains the naming rules, the stability policy (rename/removal = major, addition = minor), and points at `bun aidlc-graph.ts artifacts` for the live list. The registry is derived from stage files, not written.
- **Adding a new scope?** Read [Contributing: Adding a Scope](11-contributing.md#adding-a-scope). Scopes are file-authored — a `.claude/scopes/aidlc-<name>.md` file plus a `scopes:` tag on each member stage — no TypeScript edits required.
- **Adding a new agent?** Read [Contributing: Adding an Agent](11-contributing.md#adding-an-agent). Agents are data-driven via their `.md` frontmatter — no TypeScript edits required.
- **Modifying an agent?** Read [Agent System](05-agent-system.md) and the agent's file in [Agents](agents/).
- **Working on hooks?** Read [Hooks and Tools](06-hooks-and-tools.md) and [Testing](09-testing.md) for hook test patterns.
- **Changing the orchestrator?** Read [Orchestrator](03-orchestrator.md) and [Architecture](01-architecture.md). If you're adding or modifying audit events, start with the [State Machine](12-state-machine.md) chapter — the drift test will catch you if you don't.

## Relationship to the User Guide

The User Guide (`docs/guide/`) explains **what** AI-DLC does and **how to use it**. This Developer Reference explains **how it works** and **how to change it**. Some topics appear in both:

| Topic | User Guide | Developer Reference |
|-------|-----------|-------------------|
| Agents | What they do, when they appear | Frontmatter contract, how to add/modify |
| Knowledge | How to add company standards | Loading order internals, template system |
| Hooks | What gets logged | Hook implementation, audit event taxonomy |
