# Harness Primitives Mapping

AI-DLC's methodology concepts are harness-neutral; each CLI harness expresses
them through its own native primitives. This chapter maps the AI-DLC concept to
the primitive each harness uses, then details the **Claude Code** expression in
depth (it is the most fully documented harness; Kiro CLI, Kiro IDE, and Codex
express the same concepts through their own equivalents, summarised per chapter in
[Running on other harnesses](../guide/harnesses/README.md), and the source
contract for adding a harness is [Porting to a New Harness](../harness-engineering/09-porting-to-a-new-harness.md)).

For hooks: see [Hooks and Tools](06-hooks-and-tools.md). For knowledge: see [Knowledge System](10-knowledge-system.md).

---

## Concept-to-primitive mapping (per harness)

The AI-DLC concept is the constant; the primitive that carries it is the
harness parameter. Add a column when you port to a new harness.

| AI-DLC Concept | Claude Code | Kiro CLI | Kiro IDE | Codex CLI |
|----------------|-------------|----------|----------|-----------|
| **Orchestrator entry** (`/aidlc` + runners) | Skills (`/aidlc`) | Skills (`/aidlc`) | Skills (`/aidlc`) | Skills (`$aidlc`) |
| **Agent personas** (14 total) | `.claude/agents/*.md` | `.kiro/agents/*.json` + persona `.md` | Persona `.md`; delegation targets add IDE `tools:` grants | `.agents/` TOMLs |
| **Automation** (audit, state, tracking) | Hooks via `settings.json` | Hooks via `agents/aidlc.json` | `.kiro/hooks/*.kiro.hook` files | Hooks via `.codex/hooks.json` (one adapter) |
| **Standing rules** (the layer chain) | `aidlc/spaces/<space>/memory/` (via `.claude/rules/aidlc.md` @-import stub) | `aidlc/spaces/<space>/memory/` (via Kiro resources glob) | `aidlc/spaces/<space>/memory/` (via runtime `rules_in_context` paths) | `aidlc/spaces/<space>/memory/` (via `AIDLC_RULES_DIR`) |
| **Project onboarding doc** | `CLAUDE.md` | `AGENTS.md` | `AGENTS.md` | `AGENTS.md` |
| **Permissions / config** | `.claude/settings.json` | `.kiro/settings/cli.json` + agent config | Agent `.md` `tools:` frontmatter for delegates | `.codex/config.toml` (+ Starlark `rules/`) |

The deterministic engine, state machine, audit log, stage graph, and swarm
referee underneath are byte-identical across every harness — only the primitives
that carry them differ. The rest of this chapter documents the **Claude Code**
expression of each primitive in detail; for the Kiro CLI, Kiro IDE, and Codex
equivalents see their guide chapters.

---

## Claude-specific

The sections that follow describe how Claude Code in particular expresses each
primitive — its skill frontmatter, agent loading modes, `settings.json` blocks,
and `.mcp.json` model. Kiro CLI, Kiro IDE, and Codex carry the same concepts
through the primitives in the table above; where a mechanic is Claude-only (the
`companyAnnouncements` welcome message, the statusline command, the
`AskUserQuestion` gate widget), it is called out as such.

---

## Skills

### SKILL.md as Entry Point

The orchestrator lives at `.claude/skills/aidlc/SKILL.md`. Users invoke it with the `/aidlc` command. The file uses YAML frontmatter to declare metadata:

```yaml
---
name: aidlc
description: >
  AI-DLC workflow orchestrator. Start, resume, or manage an AI-driven
  development lifecycle.
argument-hint: "[description | --status | --stage <slug|#> | --phase <name|#> | --help]"
user-invocable: true
---
```

The orchestrator's frontmatter carries no `hooks:` block. As of v0.6.0 every framework hook is registered project-wide in `settings.json` (the hooks-move, Fork 2→B), so the orchestrator and every packaged or hand-written runner inherit the deterministic spine without copying a per-runner `hooks:` block.

| Field | Purpose |
|-------|---------|
| `name` | Registers the skill as `/aidlc` in Claude Code's command system |
| `description` | Displayed in skill discovery and help text |
| `argument-hint` | Placeholder text shown after `/aidlc` to indicate accepted arguments |
| `user-invocable` | Set to `true` so the user can trigger it directly |

The body of SKILL.md is a thin forwarding loop — the conductor. It calls the orchestration engine (`aidlc-orchestrate next`), acts on the typed directive it returns (run a stage, ask a question, fan out a swarm), reports the outcome (`report`), and repeats. The between-stage decisions — session detection, scope-to-stage mapping, the stage graph, routing, and stage advancement — live in the engine and the compiled data it reads (`tools/data/stage-graph.json`, `scope-grid.json`), not in this file. See [Engine and Skill System](17-skill-system.md).

### Project-Wide Hooks

All framework hooks are registered project-wide in `settings.json` (the workflow-spine hooks join the session-lifecycle and statusline hooks there). Each hook **self-gates** — it early-exits when no workflow is active — so they no-op during normal Claude Code usage outside of AI-DLC. See [Hooks and Tools](06-hooks-and-tools.md) for full details.

### Companion Files

SKILL.md references two companion file sets in `.claude/skills/aidlc/`:

- **`stage-protocol.md`** -- Mandatory protocol for all 32 stages (approval gates, question formatting, audit logging rules, completion messages, phase-boundary verification).
- **Stage files** in `stages/initialization/`, `stages/ideation/`, `stages/inception/`, `stages/construction/`, `stages/operation/` -- 32 individual stage definitions.

---

## Agents

### Agent File Format

This implementation renders AI-DLC's agent roles as flat `.md` files in `.claude/agents/` — 14 files: the 11 domain-expert personas, 2 review-only agents (product-lead, architecture-reviewer), and the adaptive-workflows composer. Each uses YAML frontmatter followed by a markdown body. The frontmatter controls Claude Code's behavior when the agent is activated; the body provides persona, responsibilities, stage ownership, collaboration patterns, knowledge loading order, and key principles.

For full agent system documentation, see [Agent System](05-agent-system.md).

### Inline vs Subagent Loading

The conductor uses two modes of agent activation:

**Inline execution (30 of 32 stages):**
The conductor reads the agent's `.md` file and adopts the persona directly within the main conversation. The user interacts with the agent in real time.

**Subagent execution (2 stages: 2.1, 3.5):**
The conductor delegates to a separate Claude instance via the Claude Code Task tool. The subagent runs in isolation, receives context via the prompt, and returns a structured summary.

| Stage | Claude Code Subagent Type | Agent | Reason |
|-------|---------------------------|-------|--------|
| 2.1 Reverse Engineering | `aidlc-developer-agent` then `aidlc-architect-agent` (two-step) | aidlc-developer-agent + aidlc-architect-agent | Deep code analysis produces large intermediate output |
| 3.5 Code Generation | `aidlc-developer-agent` | aidlc-developer-agent | Code writing benefits from clean context focused on the unit specification |

Workspace detection (0.2) used to be a subagent; it now runs deterministically inside `aidlc-utility init`.

### Agent Tiers (projected model + effort)

The authored dial on every agent is `tier:`; the packager projects it into the `model:`/`effort:` frontmatter keys Claude Code reads. Previous behaviour (v2.2.15 through v2.2.19; before that the key was the inert `modelOverride:`) pinned `model: opus` on the nine judgment-shaped agents, which forcibly downgraded sessions running a bigger model.

| Tier | Agents | Claude Code projection | Rationale |
|------|--------|------------------------|-----------|
| `judgment` | architect, product, design, developer, quality, devsecops, compliance, aws-platform, composer (9) | `model: inherit`, no `effort:` line - the session's model and effort win | Multi-constraint reasoning whose decisions cascade downstream - architectural boundaries, intent interpretation, UX trade-offs, code synthesis, threat prioritisation, regulatory edge-cases, cloud architecture |
| `balanced` | architecture-reviewer, product-lead (2) | `model: sonnet`, no `effort:` line | Review against an explicit checklist; the criteria encode the method, so a mid-size model at session effort suffices |
| `templated` | delivery, pipeline-deploy, operations (3) | `model: sonnet`, `effort: medium` | Output is dominantly templated planning tables, CI/CD YAML, or observability/runbook scaffolding; methodology is encoded in the agent's knowledge files |

An omitted `effort:` key inherits the session effort, and a pinned one overrides the session in both directions (a pin is a cap, not a floor) - absence is deliberate for the first two tiers. The full per-harness projection table, the Kiro collapse rule, and the `tier_cap` override live in [Agent System](05-agent-system.md).

---

## Rules

### The layered rule files

This implementation reads behavioral rules from the space memory layer at `aidlc/spaces/<space>/memory/`, pulled into Claude's context via the `.claude/rules/aidlc.md` @-import stub. One file per layer of the inheritance chain:

```
aidlc/spaces/<space>/memory/
├── org.md                        # framework defaults (shipped)
├── team.md                       # this team's affirmed practices
├── project.md                    # this project's specialization
└── phases/                       # rules scoped to a phase
    ├── ideation.md
    ├── inception.md
    ├── construction.md
    └── operation.md
```

Each file carries topical `##` headings (Way of Working, Testing Posture, Deployment, Code Style, Forbidden, Mandated, and so on). At workflow start the compile resolver walks the chain **org → team → project → phase → stage** and bakes the resolved rule set onto each stage's graph node. The model is **strict-additive**: every applicable rule from every layer appears in the agent's context simultaneously — a narrower layer never silently overrides a broader one. A rule that would *contradict* a broader-scope rule is rejected at the admission gate when it is written, not reconciled at runtime. The authoritative layout, scope derivation, and conflict semantics are in [Rule System](08-rule-system.md).

**Why the org/team files stay lean:** Claude Code loads the space memory files (via the `.claude/rules/aidlc.md` @-import stub) into each conversation, including non-AI-DLC ones. Keeping the shipped layers to concise, topical structure avoids polluting regular development sessions. Detailed methodology that the upstream specification places in rules instead lives in `.claude/knowledge/aidlc-shared/` or in SKILL.md and stage-protocol.md, loaded only when `/aidlc` is active.

### The Learning Loop

The rule files are not static — the v0.5.0 learning loop turns an in-workflow correction into a standing rule for next time. The division of labor is deliberate: the LLM's only job is to write observations to the stage's `memory.md` diary while the stage runs (Interpretations / Deviations / Tradeoffs / Open questions). Everything else is a deterministic tool or a human decision:

1. **Diary (LLM).** During the stage, observations accumulate in the intent's record dir at `<record>/<phase>/<stage>/memory.md` (`<record>/` = `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`).
2. **Surface (tool).** At the approval gate, `aidlc-learnings.ts surface` reads the diary and emits structured candidates — the LLM does not re-parse or classify.
3. **Confirm (human).** The conductor renders the candidates; you pick which to keep and, for free-text additions, pick the single heading that derives the destination.
4. **Admission check (knowledge).** Each kept learning is checked against `org.md`'s matching section; a contradiction is surfaced for you to revise, skip, or escalate.
5. **Persist (tool).** `aidlc-learnings.ts persist` writes each confirmed learning as a practice to `aidlc/spaces/<space>/memory/{project,team}.md` as dated entries and, for a sensor-binding learning, installs the manifest plus the stage `sensors:` import inside one locked transaction. It emits `RULE_LEARNED` / `SENSOR_PROPOSED`.

The user-facing walk-through (with a worked example) is in [Rules and the Learning Loop](../guide/09-rules-and-the-learning-loop.md); the harness-engineer authoring angle is in [Rules and the Learning Loop](../harness-engineering/05-rules-and-the-loop.md).

---

## CLAUDE.md

### Project-Level Instructions

`.claude/CLAUDE.md` provides project-level instructions loaded into every conversation. For AI-DLC, it serves as the bootstrap document.

**Key sections:**

| Section | Contents |
|---------|----------|
| Prerequisites | `bun` (only runtime dependency); `mkdir`-based locking |
| AI-DLC Structure | Skill, agent, rules, knowledge, and hook locations |
| Conventions | Artifacts go to the intent's record dir under `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`; application code goes to workspace root |
| Session Resumption | Check for `aidlc-state.md` on startup, offer resume options |
| Git Integration | Commit policy (see below) |

### Git Integration

```
Commit: aidlc/ workspace (memory layer, intents registry, per-intent
        aidlc-state.md, audit/ shards, and stage artifacts)
Gitignore:
  - aidlc/active-space, aidlc/spaces/*/intents/active-intent  (per-user cursors)
  - aidlc/.aidlc-clone-id, aidlc/.aidlc-sessions/             (machine-local)
  - aidlc/spaces/*/intents/*/runtime-graph.json              (re-derivable)
  - aidlc/spaces/*/intents/*/.aidlc-*                          (incl. .aidlc-recovery.md)
```

The audit trail is committed as **per-clone shards** (`audit/<host>-<clone>.md`): each clone appends to its own shard, so concurrent appends never git-conflict. Per-user session cursors and machine-local derived state are ignored.

---

## Settings

### Permissions Configuration

`.claude/settings.json` pre-approves Claude Code tools so workflows run without per-invocation permission prompts:

```json
{
  "permissions": {
    "allow": [
      "Read", "Edit", "Write", "Bash",
      "Glob", "Grep", "Task", "WebSearch"
    ]
  }
}
```

Without this, Claude Code would prompt "Allow this tool?" on each first use, disrupting the workflow -- particularly during subagent delegation where the user is not directly interacting.

### Status Line Configuration

```json
"statusLine": {
  "type": "command",
  "command": "bun \"$CLAUDE_PROJECT_DIR/.claude/hooks/aidlc-statusline.ts\""
}
```

Runs periodically (not just on tool use) to keep the terminal status current.

### SessionStart and SessionEnd Hook Configuration

```json
"hooks": {
  "SessionStart": [{
    "matcher": "",
    "hooks": [{
      "type": "command",
      "command": "bun \"$CLAUDE_PROJECT_DIR/.claude/hooks/aidlc-session-start.ts\""
    }]
  }],
  "SessionEnd": [{
    "matcher": "",
    "hooks": [{
      "type": "command",
      "command": "bun \"$CLAUDE_PROJECT_DIR/.claude/hooks/aidlc-session-end.ts\""
    }]
  }]
}
```

Registered in `settings.json` (project-wide) — as are all framework hooks since the v0.6.0 hooks-move. Session lifecycle events must be project-wide regardless, because they fire before `/aidlc` activates and after it exits: `session-start.ts` injects resume context, `session-end.ts` emits `SESSION_ENDED` for audit completeness.

### Personal Settings Override

`.claude/settings.local.json` (gitignored) overrides shared settings without affecting the repository:

```bash
cp .claude/settings.local.json.example .claude/settings.local.json
```

---

## MCP Servers

### .mcp.json as the Server Registry

This implementation declares its Model Context Protocol (MCP) servers in `.mcp.json` at the project root, beside `.claude/` rather than inside it. The file maps server names to their transport and launch configuration:

```json
{
  "mcpServers": {
    "context7": {
      "type": "http",
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"
      }
    },
    "aws-mcp": {
      "command": "uvx",
      "args": [
        "mcp-proxy-for-aws@latest",
        "https://aws-mcp.us-east-1.api.aws/mcp",
        "--metadata",
        "AWS_REGION=us-east-1"
      ]
    },
    "aws-pricing": { "command": "uvx", "args": ["awslabs.aws-pricing-mcp-server@latest"] },
    "aws-iac": { "command": "uvx", "args": ["awslabs.aws-iac-mcp-server@latest"] },
    "aws-serverless": { "command": "uvx", "args": ["awslabs.aws-serverless-mcp-server@latest"] }
  }
}
```

The five shipped servers cover the integrations the framework's agents reach for:

| Server | Transport | Auth | Purpose |
|--------|-----------|------|---------|
| `context7` | HTTP | `${CONTEXT7_API_KEY}` env passthrough | Library/SDK documentation lookups |
| `aws-mcp` | `uvx` (`mcp-proxy-for-aws@latest`, `AWS_REGION=us-east-1`) | Standard AWS credential chain | AWS API access |
| `aws-pricing` | `uvx` (`awslabs.aws-pricing-mcp-server@latest`) | AWS credential chain | AWS pricing |
| `aws-iac` | `uvx` (`awslabs.aws-iac-mcp-server@latest`) | AWS credential chain | Infrastructure-as-code tooling |
| `aws-serverless` | `uvx` (`awslabs.aws-serverless-mcp-server@latest`) | AWS credential chain | Serverless tooling |

The registry carries only environment-variable placeholders — no committed secrets. Credentials flow through your shell: `context7` reads `CONTEXT7_API_KEY` from the environment, and the four `uvx`-launched AWS servers authenticate against your standard AWS credential chain (install `uv`/`uvx` via `curl -fsSL https://astral.sh/uv/install.sh | sh`). A server you have no credentials for is simply unavailable to the session and never blocks a workflow.

`.mcp.json` lives at the project root because that is the path Claude Code reads for project-scoped MCP servers. This implementation currently ships as a `.claude/` directory copy rather than a Claude Code plugin, but the project-root `.mcp.json` placement is also the canonical plugin location, so the registry is plugin-portable without change.

### Provisioning and Inheritance

The access model is provisioning followed by inheritance, with no grant step between them:

1. **Declare once.** Servers are listed in `.mcp.json` at the project root.
2. **Provision to the session.** Claude Code starts the declared servers and exposes their tools to the session as `mcp__<server>__<tool>` ids.
3. **Inherit everywhere.** Subagents inherit all session MCP tools by default. Every AI-DLC agent — whether running inline or as a delegated subagent (stages 2.1, 3.5) — reaches every declared server.

There is no per-agent grant step, and none is needed: inheritance is the default and it is additive across all agents. A new agent file gains MCP access by existing, not by listing servers in its frontmatter.

### Why There Is No Per-Agent Grant

This is the load-bearing lesson, and it is worth stating plainly so it is not re-litigated. **MCP access cannot be granted to an agent by addition — it is inherited, and the only lever is restriction.** An empirical spike against Claude Code 2.1.159 established the boundaries:

- An agent gains nothing by *naming* a server in its frontmatter. There is no additive grant field. Inheritance has already given the agent every session MCP tool.
- To *prevent* an agent from using a server, narrow its `tools:` allowlist (the real Claude Code frontmatter field) to the fully-qualified `mcp__<server>__<tool>` ids it is permitted to call. Omitting a tool from a populated `tools:` list is what denies it.
- A bare `mcp__<server>` token is **not** honored — there is no server-level wildcard. Only fully-qualified `mcp__<server>__<tool>` ids match.
- `disallowedTools` is a real, working field on the denylist side. This implementation uses `disallowedTools: Task` to block nested subagent spawning; that denial does not affect MCP server access.

The spike also surfaced a separate frontmatter footgun: `allowedTools` is **not** a recognized Claude Code subagent field and is silently ignored. An agent declaring `allowedTools: Read` still reached an MCP tool, behaving identically to inherit-all, whereas the same agent with `tools: Read` correctly denied it. The resolution (v0.5.4): the silently-ignored `allowedTools` field has been removed from every shipped agent file (`.claude/agents/*.md`). The agents now intentionally inherit the full session toolset — built-in tools and MCP tools alike — and the only declared restriction is `disallowedTools: Task`. The documented opt-in narrowing is the real `tools:` allowlist, which drops inherited MCP unless the fully-qualified `mcp__<server>__<tool>` ids are also listed. So inherit-all is now the deliberate, documented model rather than an accident of an ignored field: every agent reaches every declared server today.

### Relationship to settings.json Permissions

The two configuration files answer different questions and do not overlap:

- `.claude/settings.json` `permissions.allow` pre-approves *built-in Claude Code tools* (Read, Edit, Write, Bash, Glob, Grep, Task, WebSearch) so the session does not prompt on first use (see [Settings](#settings) above). It says nothing about MCP servers.
- `.mcp.json` declares *which MCP servers exist* and how to launch them. Provisioning and inheritance are governed by Claude Code's MCP layer, not by `settings.json`.

An MCP server appearing in the session is a function of `.mcp.json` plus available credentials, not of any `settings.json` allow-list entry. Per-agent narrowing, when it is wired, lives in the agent's `tools:` frontmatter — not in `settings.json` and not in `.mcp.json`.

---

## Feature Interaction Map

| Feature | File(s) | When It Loads | Role |
|---------|---------|---------------|------|
| CLAUDE.md | `.claude/CLAUDE.md` | Every conversation | Bootstrap: structure, prerequisites, conventions |
| Settings | `.claude/settings.json` | Every conversation | Pre-approve Claude Code tools |
| Rules | `aidlc/spaces/<space>/memory/*.md` (via `.claude/rules/aidlc.md` @-stub) | Every conversation | Minimal guardrails; self-learning corrections |
| Skill | `.claude/skills/aidlc/SKILL.md` | On `/aidlc` invocation | Orchestrator: session, scope, stage graph, delegation |
| Workflow-spine hooks | `.claude/settings.json` | Always on; self-gate when no workflow | PostToolUse, PreCompact, SubagentStop, Stop |
| Agents (inline) | `.claude/agents/*.md` | Persona activation | 30 of 32 stages: conductor adopts agent persona |
| Agents (subagent) | `.claude/agents/*.md` | Task tool delegation | 2 stages (2.1, 3.5): isolated execution |
| Knowledge (Tier 1) | `.claude/knowledge/` | Persona activation (steps 2-3) | 56 methodology reference files |
| Knowledge (Tier 2) | space-level `aidlc/knowledge/` (sibling of `intents/`) | Persona activation (steps 4-5) | Team-managed customization |
| Stage protocol | `stage-protocol.md` | Every stage execution | Mandatory behavioral contract |
| Stage files | `stages/**/*.md` | Engine routing | 32 individual stage definitions |
| State file | `aidlc-state.md` | Session start + throughout | Persistent workflow state |
| Audit file | `audit.md` | Throughout execution | Append-only audit trail |

### Loading Sequence

When a user runs `/aidlc feature`:

```
1.  CLAUDE.md loads              (every conversation)
1a. statusLine command starts    (settings.json -- runs continuously)
2.  settings.json loads          (every conversation; all hooks register here, project-wide)
2a. SessionStart hook fires      (settings.json -- if session resume)
3.  memory/ rules load            (every conversation)
4.  SKILL.md activates           (skill invocation -- the conductor)
5.  Conductor calls the engine   (`aidlc-orchestrate next $ARGUMENTS`)
6.  Engine reads state + graph   (decides the move, emits a typed directive)
7.  Conductor acts on directive  (run-stage: load agent .md + knowledge, run the body)
8.  Stage executes               (stage work)
9.  Hooks fire as needed         (Claude Code tool calls, compaction, subagent stop)
10. Conductor reports the outcome (`aidlc-orchestrate report` -- commits state)
11. Loop back to step 5          (next directive) until the engine emits `done`
```

Steps 1-2a happen for every conversation, even non-AI-DLC ones — and because every hook is registered project-wide in `settings.json` (not on skill activation), the deterministic spine is in place before `/aidlc` is ever invoked; each hook self-gates to a no-op when no workflow is active. Step 3 loads the rule layers. Steps 4 onward set up and drive the workflow only when the user invokes `/aidlc`; steps 5-11 repeat once per directive — the engine, not SKILL.md, decides what each iteration does.

---

## Cross-References

- [Architecture](01-architecture.md) -- 5-layer model including all feature layers
- [Orchestrator](03-orchestrator.md) -- SKILL.md deep-dive
- [Agent System](05-agent-system.md) -- agent frontmatter, tool restrictions, agent tiers
- [Hooks and Tools](06-hooks-and-tools.md) -- hook system, audit taxonomy, CLI tools
- [Knowledge System](10-knowledge-system.md) -- two-tier knowledge, loading order
- [Porting to a New Harness](../harness-engineering/09-porting-to-a-new-harness.md) -- how to add a column to the mapping above: the manifest, hook adapter, and `emit.ts` contract
- [Running on other harnesses](../guide/harnesses/README.md) -- the Kiro CLI, Kiro IDE, and Codex expressions of these primitives
