# Adding an Agent

An agent is the *who* of the framework — a persona with a domain, a tool
allowlist, and a model. The 11 shipped agents cover product, design, delivery,
architecture, AWS platform, compliance, DevSecOps, development, quality,
pipeline-deploy, and operations. When your team needs a domain the framework
doesn't cover (a data-governance reviewer or a mobile specialist, say), you
add a persona by dropping a single Markdown file
into `.claude/agents/`. No TypeScript.

This chapter walks the workflow: what a persona file is, the judgment calls in
its frontmatter, and the two-step truth that an agent which is *visible* is not
yet *active*. For the field-by-field contract, it links down to the Developer
Reference. For who these agents are from a user's seat, see the [User Guide —
Agents](../guide/05-agents.md).

---

## What a persona file is, and where it lives

Every agent is one flat file at `.claude/agents/<slug>-agent.md`: YAML
frontmatter on top, a Markdown body below. The shipped files all carry the
`aidlc-` prefix (`aidlc-architect-agent.md`, `aidlc-developer-agent.md`); a file
you add is yours and need not use that prefix. Treat the shipped 11 as
framework files — they get overwritten on upgrade, so customize *what an
existing agent knows* through team knowledge rather than editing the file (see
[Team knowledge](07-team-knowledge.md)). A genuinely new persona is a different
move: a new file, owned by you, that survives upgrades.

The frontmatter is the part the framework parses. The body is prose the agent
reads about itself when it activates — its responsibilities, the stages it
owns, how it loads knowledge, its working principles. Only the frontmatter is
machine-read; the body is for the agent's own framing, and you write it to
match the structure of the shipped files.

Here is the frontmatter from a real shipped agent,
`.claude/agents/aidlc-architect-agent.md`:

```yaml
---
name: aidlc-architect-agent
display_name: Architect Agent
examples:
  - tech-stack.md
  - infrastructure-preferences.md
description: >
  Solutions architect responsible for application design, domain modelling,
  NFR patterns, and component decomposition.
disallowedTools: Task
modelOverride: opus
---
```

---

## The frontmatter contract, and the calls you make

The full field-by-field schema lives in the reference; here are the judgment
calls you actually make when authoring one.

**`name` must match the filename stem.** A file at
`aidlc-data-governance-agent.md` declares `name: aidlc-data-governance-agent`.
The parser keys off this, and a mismatch is the easiest way to author an agent
that never resolves.

**An agent inherits the full session toolset by default.** None of the 11
shipped agents declare a `tools:` allowlist, so each one reaches every tool the
session provides — `Read`, `Edit`, `Write`, `Glob`, `Grep`, `AskUserQuestion`,
`Bash`, `WebSearch`, and the inherited MCP tools alike. To narrow a persona,
add an optional `tools:` allowlist naming only the tools it may use. Listing
`tools:` narrows the persona to exactly the tools it names, and it drops the inherited
MCP tools unless you also name the fully-qualified `mcp__<server>__<tool>` ids
(see the MCP-inheritance note below). Reach for it only when a domain genuinely
needs a smaller surface; most personas are best left to inherit everything.

**MCP servers are inherited, not granted per agent.** The five MCP servers declared in the project-root `.mcp.json` are provisioned to the session, and every agent inherits all of them automatically — there is no per-agent grant to author. To keep a persona *away* from a server, narrow its `tools:` allowlist to a fully-qualified `mcp__<server>__<tool>` list that omits that server (a bare `mcp__<server>` token is a no-op, not a server-level grant). The inheritance and restriction model is exercised by the `t110` registry-integrity test (see [Testing](../reference/09-testing.md)).

**`disallowedTools` must include `Task`.** This is not optional. Agents run as
delegated workers; the conductor (the live `/aidlc` session) performs the `Task`
call when the engine's `run-stage` directive carries `mode: subagent`. Allowing
`Task` would let an agent spawn its own subagents, cascading delegation chains
the framework is built to prevent. Every shipped agent disallows `Task`, and so
must yours.

**`modelOverride` is opus or sonnet, and the default is opus.** Reach for
`opus` for any persona whose work is high-judgment, multi-constraint reasoning
that cascades downstream — interpreting ambiguous intent and weighing
architectural trade-offs under dense context. Eight of the
11 agents run on opus for exactly this reason. Use `sonnet` only when the
output is dominantly templated or pattern-following and the methodology is
already encoded in the agent's knowledge files — the three sonnet agents
(delivery, pipeline-deploy, operations) produce delivery plans, CI/CD YAML, and
runbook scaffolding. When in doubt, opus.

Two more fields drive scaffolding rather than behavior. `display_name` is the
human-readable label the statusline and `--init` render (the architect shows as
"Architect Agent"). `examples` lists knowledge filenames that appear as bullets
in the scaffolded team-knowledge README — they are *suggestions surfaced to the
user*; the runtime never loads them.

For the exact required/optional table and the shared-configuration matrices,
see [Agent System: Frontmatter Contract](../reference/05-agent-system.md#frontmatter-contract).

---

## Visible is not active: the two-step truth

This is the one thing to internalize. Dropping the file makes the agent
*visible*; wiring it into a stage makes it *active*. Both steps are required, or
you get an agent that exists and never runs.

- **Discovery makes it visible.** `loadAgents()` in
  `dist/claude/.claude/tools/aidlc-lib.ts` reads every `.md` file in
  `.claude/agents/` on the next invocation and derives the metadata map. No code
  edit, no registration step — the file's presence is the registration. From
  this point `--init` will scaffold its knowledge directory and the statusline
  can render its display name.
- **Stage binding makes it active.** A stage names its lead and support agents
  by slug in `dist/claude/.claude/tools/data/stage-graph.json` (and in the
  matching stage file). Until some stage's `lead_agent` or `support_agents`
  field references your slug, no `run-stage` directive names it, so the conductor never delegates to the persona.

This mirrors the framework's core asymmetry — a stage names its agent; an agent
never names its stages. So the agent file alone is inert by design. To put your
new persona to work, edit the stage that should use it; the binding mechanics
live in [Adding a Stage](02-adding-a-stage.md).

Each agent also pairs with a knowledge directory at
`.claude/knowledge/<slug>-agent/` (framework methodology) and a team overlay at
`aidlc-docs/knowledge/<slug>-agent/` (your standards). `--init` scaffolds the
team-knowledge README from the `display_name` and `examples` you declared. The
two-tier knowledge workflow is covered in
[Team knowledge](07-team-knowledge.md).

---

## The steps

Mirroring the reference recipe, here is the workflow end to end.

1. **Create the agent file** — `.claude/agents/<slug>-agent.md` with the
   required frontmatter: `name`, `display_name`, `examples`, `description`,
   `disallowedTools` (including `Task`), `modelOverride`. An optional `tools:`
   allowlist narrows the persona; omit it to inherit the full session toolset.
   Write the body to match the shipped files' structure (Core Responsibilities,
   Stages Owned, Collaboration, Knowledge Loading, Key Principles).
2. **Add knowledge files** under `.claude/knowledge/<slug>-agent/` for the
   methodology the persona should load on activation.
3. **Wire it into stages** — add the slug to the relevant entries'
   `lead_agent` / `support_agents` fields in `stage-graph.json`, and to the
   stage files where it leads or supports. This is the step that makes it active.
4. **Scaffold the team-knowledge README entry** for
   `aidlc-docs/knowledge/<slug>-agent/` so teams have a place to add their
   standards.
5. **Update the hand-maintained doc tables** — the Phase Participation matrix
   and the agent→examples table do not regenerate themselves (see what does NOT
   validate, below).

The full recipe — with the discovery, `--init`, and statusline verification
commands — is in [Contributing: Adding an Agent](../reference/11-contributing.md#adding-an-agent).
To change an existing agent's tools, model, or stage assignments rather than add
one, see [Agent System: How to Modify an Agent](../reference/05-agent-system.md#how-to-modify-an-agent).

### What validates automatically

- `loadAgents()` discovers any new `.md` file in `.claude/agents/` on next
  invocation — no code edit, no registration.
- The parser throws if `name` or `display_name` is missing, naming the file and
  the missing field.
- Agents are returned alphabetically sorted by slug, so discovery order is
  identical on every platform.
- `/aidlc --init` scaffolds the per-agent knowledge directory from the derived
  metadata.
- The statusline renders the display name from the same source, so it never
  drifts from `--init` output.

### What does NOT validate automatically

- **Stage-graph participation.** `stage-graph.json` references agents by slug;
  add an agent without wiring it there and it exists but never runs. Discovery
  and activation are separate steps.
- **Knowledge-file existence.** `examples` are suggested filenames surfaced in
  the scaffolded README — nothing creates or checks them. You place the real
  content under `aidlc-docs/knowledge/<slug>-agent/`.
- **The hand-maintained doc tables.** The Phase Participation matrix in
  [Agent System](../reference/05-agent-system.md#phase-participation) and the
  agent→examples table in the knowledge README template are edited by hand.
  Update them in the same change that adds the agent.
- **The agent file's body.** Only the frontmatter is parsed; the body prose is
  read by the agent itself when it activates, so write it carefully to match the
  shipped 11.

---

## Next

[Scopes](04-scopes.md) — decide which stages (and therefore which agents) run
for a given kind of work.
