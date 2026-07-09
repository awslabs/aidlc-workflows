# Agent System

This chapter documents the agent architecture: how agents are structured, configured, loaded by the framework, and how to add or modify them.

For user-facing agent descriptions, see the [User Guide -- Agents](../guide/06-agents.md).

---

## Agent Structure

Each agent is a flat `.md` file in `.claude/agents/` with YAML frontmatter followed by a markdown body. The conductor reads these files to frame its perspective during inline stage execution or to build context for subagent delegation.

### Frontmatter Contract

Every agent file must include this YAML frontmatter:

```yaml
---
name: aidlc-architect-agent               # Agent identifier (matches filename without .md)
description: >                      # Brief role summary (shown in Claude Code agent list)
  System architect responsible for application design,
  NFR design, and component decomposition.
disallowedTools: Task               # Agents cannot spawn subagents
tier: judgment                      # judgment | balanced | templated (see Agent Tiers)
---
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Agent identifier, must match filename |
| `description` | Yes | Brief role summary |
| `tools` | No | Optional allowlist; omit to inherit the full session toolset. Listing it narrows the agent and drops inherited MCP tools unless `mcp__<server>__<tool>` ids are also listed |
| `disallowedTools` | Yes | Must include `Task` -- only the conductor delegates |
| `tier` | Yes | `judgment`, `balanced`, or `templated`. The AUTHORED dial: the packager projects it into each harness's native model/effort keys (see Agent Tiers below). Raw `model:`/`effort:` never appear in authored frontmatter -- they are projection OUTPUTS in `dist/<harness>/` |

### Markdown Body Sections

Below the frontmatter, the markdown body defines:

| Section | Purpose |
|---------|---------|
| **Core Responsibilities** | What the agent does in each of its owned stages |
| **Stages Owned** | Lead and supporting stage assignments |
| **Collaboration** | Receives from / Works with / Hands off to |
| **Knowledge Loading** | The 6-step loading order (see [Knowledge System](10-knowledge-system.md)) |
| **Key Principles** | Behavioral guidelines for the agent |

---

## Shared Configuration

All 14 agents share a common configuration baseline. None declares a `tools:` allowlist, so every agent inherits the **full session toolset** — all of Claude Code's built-in tools plus any MCP tools provisioned to the session. The one shipped restriction is `disallowedTools: Task`.

### The session toolset (inherited by every agent)

Every agent inherits the built-in Claude Code tools, including:

| Tool | Purpose |
|------|---------|
| Read | Read files from the filesystem |
| Edit | Perform exact string replacements in files |
| Write | Write files to the filesystem |
| Glob | Fast file pattern matching |
| Grep | Content search using ripgrep |
| AskUserQuestion | Interactive user prompts (main-thread stages only) |

### Common Disallowed Claude Code Tools

| Tool | Reason |
|------|--------|
| Task | Agents operate as delegated workers. Only the SKILL.md conductor performs the Task call. `disallowedTools: Task` avoids cascading subagent chains. |

### Tools each persona is expected to exercise

Every agent *can* reach Bash and WebSearch by inheritance; the table records which personas the methodology **expects** to use them in their stage work, not a per-agent grant. To genuinely restrict a persona, add an optional `tools:` allowlist (which drops inherited MCP unless `mcp__<server>__<tool>` ids are also listed) — this implementation ships no such restrictions.

| Tool | Expected to exercise it |
|------|---------------------|
| Bash | aidlc-aws-platform-agent, aidlc-devsecops-agent, aidlc-developer-agent, aidlc-quality-agent, aidlc-pipeline-deploy-agent, aidlc-operations-agent |
| WebSearch | aidlc-product-agent, aidlc-design-agent, aidlc-compliance-agent |

### Agent Tiers

The authored dial on every agent is `tier:` -- it names the KIND of work the persona does, and the packager (`bun scripts/package.ts`) projects it into each harness's native model/effort form. Previous behaviour (v2.2.15 through v2.2.19; before that the key was the inert `modelOverride:`) pinned a raw `model: opus|sonnet` per agent, which forcibly downgraded sessions running a bigger model; the tier projection replaces that pin.

| Tier | Agents | Meaning |
|------|--------|---------|
| `judgment` | architect, aws-platform, compliance, composer, design, developer, devsecops, product, quality | Multi-constraint reasoning under ambiguity; output cascades downstream. Never downgraded: inherits the session's model AND effort |
| `balanced` | architecture-reviewer, product-lead | Reviewer-shaped work -- novel input against explicit criteria. Mid-size model, session effort |
| `templated` | delivery, operations, pipeline-deploy | Dominantly pattern-following output; methodology already in knowledge (delivery plans, CI/CD YAML, runbooks). Mid-size model at reduced effort -- the one deliberate downgrade |

The projection per harness (`core/tools/aidlc-tiers.ts` is the single source of truth):

| Tier | Claude Code (.md frontmatter) | Codex CLI (.toml) | Kiro CLI/IDE (agent JSON `"model"`) | Kiro cli.json `chat.modelDefaults` |
|------|-------------------------------|-------------------|--------------------------------------|-------------------------------------|
| `judgment` | `model: inherit`, no `effort:` line | no `model`/`model_reasoning_effort` keys (config.toml session defaults apply) | field OMITTED (schema fallback: the user's default model) | no entry (default model's own default effort) |
| `balanced` | `model: sonnet`, no `effort:` line | `model = "openai.gpt-5.4"`, no effort key | `claude-sonnet-4.5` | sonnet-4.5 -> `high` |
| `templated` | `model: sonnet`, `effort: medium` | `model = "openai.gpt-5.4"`, `model_reasoning_effort = "medium"` | `claude-sonnet-4.5` (collapses with balanced) | (shares the sonnet-4.5 entry; balanced's `high` wins the collapse) |

Key facts behind the table:

- **Omission is the inherit mechanism.** On Claude Code an agent .md with no `effort:` key inherits the session effort, and a pinned `effort:` overrides the session in BOTH directions (a pin is a cap, not a floor) -- so absence is the contract for judgment and balanced. On Codex a role TOML without `model` spawns on the shipped `.codex/config.toml` session defaults (verified live on codex-cli 0.139.0, the doctor-enforced minimum, and 0.142.5). On Kiro the agent-v1 schema documents the absent-`"model"` fallback: "If not specified, uses the default model" (the `/model` persisted preference).
- **Kiro has NO per-agent effort surface.** kiro-cli fail-closes on any effort-like key in agent JSON, so effort rides on the MODEL via `settings/cli.json` `chat.modelDefaults[<modelId>].output_config.effort` -- one entry per distinct pinned model. That file is CLI-only: the Kiro IDE ignores cli.json entirely and applies its extension-embedded per-model default (or the user's `/effort` session state).
- **The Kiro collapse rule.** Two tiers sharing a Kiro model ID are indistinguishable there; the shared cli.json entry takes the HIGHER tier's effort (balanced's `high` beats templated's `medium` on sonnet-4.5). This collapse is deliberate and documented, not a bug.

### Tier cap (cost override)

A project can cap every projection at pack time, without editing any agent file:

- **Persistent knob:** a `tier_cap:` key in the YAML frontmatter of the space memory layer files (`core/memory/org.md` -> `team.md` -> `project.md`, last writer wins -- a project may lower OR raise the org ceiling). Example: `tier_cap: balanced` collapses `judgment` to `balanced` in every harness's projection.
- **Per-invocation override:** the `AIDLC_TIER_CAP` env var beats the memory layers for one packager run (`AIDLC_TIER_CAP=templated bun scripts/package.ts`). To build UNCAPPED once while a memory cap is in force, set it to the top tier -- `AIDLC_TIER_CAP=judgment` -- which beats the memory layer and clamps nothing (an empty value means unset, not uncapped).

The two knobs differ in scope: the memory cap travels with the repo, so it applies in BOTH write and `--check` modes (a project that commits a capped dist stays self-consistent). The env var is a one-shot WRITE knob and is IGNORED under `--check` - the drift guard compares what the committed dist was legitimately built from, and a stray `AIDLC_TIER_CAP` in a CI or test runner's environment must neither fail nor mask drift (the packager prints a notice when it ignores one). The packager also prints the active cap and its source on every capped run.

To opt a SINGLE agent out instead, edit the projected value in your installed `dist/<harness>/` copy (e.g. set `model: opus` on one Claude agent .md) -- the edit survives until you re-copy the dist shell.

---

## Agent Comparison Matrix

| Agent | Bash | WebSearch | Tier | Lead Stages | Support Stages | Total |
|-------|------|-----------|------|-------------|----------------|-------|
| aidlc-product-agent | No | Yes | judgment | 5 | 3 | 8 |
| aidlc-design-agent | No | Yes | judgment | 2 | 2 | 4 |
| aidlc-delivery-agent | No | No | templated | 3 | 2 | 5 |
| aidlc-architect-agent | No | No | judgment | 6 | 3 | 9 |
| aidlc-aws-platform-agent | Yes | No | judgment | 2 | 4 | 6 |
| aidlc-compliance-agent | No | Yes | judgment | 0 | 4 | 4 |
| aidlc-devsecops-agent | Yes | No | judgment | 0 | 5 | 5 |
| aidlc-developer-agent | Yes | No | judgment | 2 | 3 | 5 |
| aidlc-quality-agent | Yes | No | judgment | 2 | 2 | 4 |
| aidlc-pipeline-deploy-agent | Yes | No | templated | 4 | 0 | 4 |
| aidlc-operations-agent | Yes | No | templated | 3 | 0 | 3 |

**Observations:**
- aidlc-architect-agent has the broadest stage involvement (9 stages across 3 phases).
- Across the full 14-agent roster, nine agents carry the `judgment` tier and five step down (the two `balanced` reviewers plus the three `templated` planners); the stepped-down agents produce reviews against explicit checklists or dominantly templated planning, CI/CD, and runbook work. The matrix above covers the 11 domain-expert agents.
- aidlc-compliance-agent operates purely in an advisory capacity (4 support stages, no lead stages).
- Six of 11 agents have Bash access, all in roles that need CLI interaction.
- Three agents have WebSearch access for research tasks.

---

## Phase Participation

| Agent | Init (0) | Ideation (1) | Inception (2) | Construction (3) | Operation (4) |
|-------|----------|--------------|---------------|-------------------|---------------|
| aidlc-product-agent | -- | L (intent-capture, market-research, scope-definition), S (rough-mockups, approval-handoff) | L (requirements-analysis, user-stories), S (refined-mockups) | -- | -- |
| aidlc-design-agent | -- | L (rough-mockups) | L (refined-mockups), S (user-stories, application-design) | -- | -- |
| aidlc-delivery-agent | -- | L (team-formation, approval-handoff), S (scope-definition) | L (delivery-planning), S (units-generation) | -- | -- |
| aidlc-architect-agent | -- | L (feasibility), S (intent-capture) | L (application-design, units-generation), S (reverse-engineering, delivery-planning) | L (functional-design, nfr-requirements, nfr-design) | -- |
| aidlc-aws-platform-agent | -- | S (feasibility) | S (application-design) | L (infrastructure-design), S (nfr-design) | L (environment-provisioning), S (feedback-optimization) |
| aidlc-compliance-agent | -- | S (feasibility) | -- | S (nfr-requirements, infrastructure-design) | S (environment-provisioning) |
| aidlc-devsecops-agent | -- | -- | S (practices-discovery) | S (nfr-requirements, infrastructure-design, build-and-test) | S (environment-provisioning) |
| aidlc-developer-agent | -- | -- | L (reverse-engineering), S (practices-discovery) | L (code-generation), S (functional-design) | S (deployment-execution) |
| aidlc-quality-agent | -- | -- | S (practices-discovery) | L (build-and-test), S (nfr-requirements) | L (performance-validation) |
| aidlc-pipeline-deploy-agent | -- | -- | L (practices-discovery) | L (ci-pipeline) | L (deployment-pipeline, deployment-execution) |
| aidlc-operations-agent | -- | -- | -- | -- | L (observability-setup, incident-response, feedback-optimization) |

L = Lead, S = Support

---

## How to Add an Agent

Agent display names and example knowledge files are authoritative in each agent's `.md` frontmatter via the `display_name` and `examples` fields — no TypeScript edits required. See [Contributing: Adding an Agent](11-contributing.md#adding-an-agent) for the full recipe (required frontmatter fields, verification steps, and what validates automatically vs. manually). Quick summary of the steps:

1. Create `core/agents/{name}-agent.md` with the required frontmatter: `name`, `display_name`, `examples`, `description`, `disallowedTools` (including `Task`), `tier`. Never author raw `model:`/`effort:` in core frontmatter -- they are projection outputs (see Agent Tiers above). An optional `tools:` allowlist narrows the inherited toolset; omit it to inherit the full session toolset. `loadAgents()` in `core/tools/aidlc-lib.ts` discovers the file on next invocation.
2. Add knowledge files to `core/knowledge/{name}-agent/`
3. Add the agent to the stage files (`core/aidlc-common/stages/`) where it participates — set `lead_agent` / `support_agents` in each stage's frontmatter. The compiled `tools/data/stage-graph.json` is GENERATED from that frontmatter by `bun scripts/package.ts`; never hand-edit it (the `package.ts --check` drift guard fails CI on a hand-edited dist).
4. Regenerate the distributions: `bun scripts/package.ts` (then `--check` to confirm no drift)
5. Add the agent→examples row to the hand-maintained knowledge tables (the space-level team-knowledge dir is `aidlc/knowledge/{name}-agent/`, created by the team when it has content — the engine does not scaffold it)
6. Update tests: smoke tests for file existence, feature tests for stage-agent cross-references
7. Update documentation in this file and [reference/agents/](agents/)

## How to Modify an Agent

- **Change tools**: Add or edit a `tools:` allowlist in frontmatter to narrow the agent; omit it to inherit the full session toolset. A `tools:` list drops inherited MCP tools unless the `mcp__<server>__<tool>` ids are also listed.
- **Change tier**: Edit `tier:` to `judgment`, `balanced`, or `templated` and regenerate (`bun scripts/package.ts`). To force a specific model on ONE agent in an installed copy instead, edit the projected `model:` in your `dist/<harness>/` agent file (Claude Code accepts aliases, full ids, and `inherit`).
- **Change behavior**: Edit the markdown body sections (responsibilities, principles).
- **Change stage assignments**: Edit both the agent file (Stages Owned section) and the relevant stage files (`core/aidlc-common/stages/`), then regenerate with `bun scripts/package.ts` — the compiled stage graph is derived from stage frontmatter, never hand-edited.

---

## Cross-References

- [Architecture](01-architecture.md) -- 5-layer model including agent layer
- [Knowledge System](10-knowledge-system.md) -- knowledge loading order
- [Agents Technical Reference](agents/) -- per-agent technical details
- [Stage Protocol](04-stage-protocol.md) -- agent persona loading rules
