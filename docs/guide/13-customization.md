# Customization

AI-DLC is designed to adapt to your team's needs. This chapter covers settings overrides, scope configuration, stage customization, statusline, and tool permissions.

> **Harness-specific config.** The harness-neutral customizations — scope
> configuration, stage depth, knowledge, and rules — apply on every harness. The
> mechanism-level config in this chapter (`settings.json` / `settings.local.json`,
> the statusline command, `$CLAUDE_PROJECT_DIR`, tool-permission blocks) is
> **Claude Code-specific**. Kiro configures the equivalents in
> `.kiro/settings/cli.json` + its agent config, and Codex in `.codex/config.toml`
> + Starlark rules — see [Running on Kiro CLI](harnesses/kiro-cli.md) and
> [Running on Codex CLI](harnesses/codex-cli.md) for each harness's surfaces.

---

## Settings Overrides (`settings.local.json`)

The shared `.claude/settings.json` ships with the framework and is committed to version control. To override settings for your local environment without affecting the team, create a personal overrides file:

```bash
cp .claude/settings.local.json.example .claude/settings.local.json
```

This file is listed in `.gitignore` so your personal changes are never committed. Use it to:

- Override model selection (e.g., switch to a different Opus or Sonnet model ID)
- Set environment variables for your local setup
- Adjust tool permissions for your security requirements

---

## Agent Models and Effort (Tiers)

Shipped agents are authored with a `tier:` (`judgment` | `balanced` | `templated`) that the build projects into each harness's native model/effort keys — judgment agents inherit your session's model and effort, balanced agents pin a mid-size model, and templated agents additionally reduce effort. See [Agent System](../reference/05-agent-system.md) for the full projection table.

To change ONE agent's behavior in your installed copy, edit the projected value directly — for example, set `model: opus` in a Claude agent's `.claude/agents/aidlc-*-agent.md` frontmatter, or change the `"model"` field in a Kiro agent JSON. The edit survives until you re-copy the `dist/<harness>/` shell. To cap EVERY agent when building your own distribution from source, set a `tier_cap:` in `core/memory/org.md`/`project.md` frontmatter or run the packager with `AIDLC_TIER_CAP=<tier>` — both are pack-time knobs on `bun scripts/package.ts`, not runtime settings.

---

## Per-Project Default Scope

When every workflow in a project should start at the same scope — for example, a workshop where all participants should run `workshop` — set `AWS_AIDLC_DEFAULT_SCOPE` in the `env` block of `.claude/settings.json` (the shipped file already has this set to `workshop`):

```json
{
  "env": {
    "AWS_AIDLC_DEFAULT_SCOPE": "workshop"
  }
}
```

> The shipped `env` block also contains Bedrock model IDs (`CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, etc.). Those are listed separately — the example above only shows the scope key for clarity.

With this set, bare `/aidlc` invocations use `workshop` as the default scope. Participants don't need to remember `/aidlc workshop` on every run. The env var is read at workflow initialization only; once the intent's `aidlc-state.md` exists (under its record dir), the state file is authoritative and env changes don't affect an in-flight workflow.

**Precedence (highest to lowest):**

1. Explicit CLI flag: `/aidlc feature` or `/aidlc --scope bugfix` wins.
2. Keyword detection in freeform text: `/aidlc fix the login bug` still maps to `bugfix`. Users can override the detected scope at the existing confirmation prompt.
3. `AWS_AIDLC_DEFAULT_SCOPE` env var from `.claude/settings.json`.
4. Hard-coded fallback (`poc` at intent birth, `feature` for unmatched freeform).

**Valid values:** `enterprise`, `feature`, `mvp`, `poc`, `bugfix`, `refactor`, `infra`, `security-patch`, `workshop`. An invalid value errors at invocation time with a clear message. Teams can define additional scopes by dropping a `.claude/scopes/aidlc-<name>.md` file and tagging the member stages' `scopes:` lists — see [Contributing: Adding a Scope](../reference/11-contributing.md#adding-a-scope). Teams can also define additional agents in `.claude/agents/` — see [Contributing: Adding an Agent](../reference/11-contributing.md#adding-an-agent).

**Verifying the config:** run `/aidlc --doctor` to confirm the env var is set and valid:

```
✓  AWS_AIDLC_DEFAULT_SCOPE=workshop (valid)
```

**Init notice:** when the env default is applied, the orchestrator prints a one-line notice at workflow start (`Using scope=<value> from AWS_AIDLC_DEFAULT_SCOPE (.claude/settings.json)`) so the scope source is visible at the moment it takes effect.

Why only scope and not depth or test-strategy? Each scope already declares its own depth and test-strategy defaults (workshop → Standard depth, Minimal test strategy). Setting the scope cascades those automatically. If you need to override either, pass `--depth` or `--test-strategy` on the CLI.

**Sensitive values:** `.claude/settings.json` is committed to version control. Don't put secrets, credentials, or personal overrides here — use `.claude/settings.local.json` (gitignored) for anything sensitive.

---

## Scope Configuration

Scopes control which stages execute and at what depth and test strategy. AI-DLC provides 9 named scopes; the full table (EXECUTE/total stage counts, default depth, test strategy, and use case for each) is the single source in [Scopes, Depth, and Test Strategy § The 9 Scopes](05-scopes-and-depth.md#the-9-scopes). This section covers *configuring* and overriding them.

### Choosing a scope

Specify explicitly or let the orchestrator auto-detect:

```
/aidlc enterprise       # Explicit scope
/aidlc Build a payments API  # Auto-detects "feature"
/aidlc Fix the login bug     # Auto-detects "bugfix"
```

### Overriding at runtime

You can override scope at any time during a workflow:

- **At any approval gate**: request a different scope or depth
- **Via utility command**: `/aidlc --scope enterprise` changes the active scope
- **Stage inclusion**: at approval gates in Ideation and Inception, you can add a previously skipped stage back into the workflow

---

## Stage Customization

Each stage is a self-contained `.md` file in `.claude/aidlc-common/stages/[phase]/`. Stage files specify:

- **Metadata** — Stage number, phase, execution mode, lead/support agents
- **Inputs** — Prior artifacts to load
- **Steps** — Numbered execution sequence
- **Outputs** — Artifacts to produce
- **Completion** — Approval gate pattern

To modify a stage's behavior, edit its stage file directly. All stages reference the stage protocol for shared patterns (approval gates, question format, state tracking).

### Depth levels

Each scope has a default depth that controls artifact detail:

| Depth | Description |
|-------|-------------|
| **Minimal** | Brief artifacts, targeted analysis, no optional content |
| **Standard** | Balanced detail, covers primary and secondary concerns |
| **Comprehensive** | Full detail, extensive analysis, all optional content included |

You can override depth at any approval gate by requesting a different level.

---

## Statusline (Claude Code only)

On **Claude Code**, this implementation displays a statusline in the terminal status bar showing workflow progress. Kiro and Codex have no statusline — they surface workflow position through `/aidlc --status` (Kiro) and the `update_plan` task-progress item plus `$aidlc --status` (Codex):

```
[AIDLC] IDEATION [▓▓▓▓▓░░░░░] 4/7 > Intent Capture -- Product Agent
```

This shows, in order: current phase, phase progress (as a bar and a ratio — both scoped to the current phase), stage display name, and lead agent. Context usage appears on the right (e.g., `ctx:15%`), color-coded as the remaining context drops.

### Configuration

The statusline is configured in `.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "bun \"$CLAUDE_PROJECT_DIR/.claude/hooks/aidlc-statusline.ts\""
}
```

### Customizing the format

Edit `.claude/hooks/aidlc-statusline.ts` directly. The output format is defined in the `main()` function near the end of the file. The hook reads phase, stage, and agent from `aidlc-state.md`, maps stage slugs to display names, and builds both the unicode progress bar and the `n/m` ratio from the same phase-local checkbox parse.

### Disabling the statusline

Remove the `statusLine` block from `settings.json`. The terminal status bar reverts to Claude Code's default.

---

## Tool Permissions

The `permissions.allow` list in `.claude/settings.json` pre-approves Claude Code tools so workflows run without per-call permission prompts:

```json
"permissions": {
  "allow": [
    "Read", "Edit", "Write",
    "Bash(bun \"$CLAUDE_PROJECT_DIR/.claude/tools/\"*)",
    "Bash", "Glob", "Grep", "Task", "WebSearch"
  ]
}
```

The scoped `Bash(bun "$CLAUDE_PROJECT_DIR/.claude/tools/"*)` entry sits ahead of the bare `Bash` so the framework's own tool invocations always match the narrower rule first. `$CLAUDE_PROJECT_DIR` stays double-quoted (with the `*` outside the quotes) so the command survives word-splitting shells when the project path contains spaces while the permission matcher still globs.

### How permissions work

- **Project-wide ceiling**: The `settings.json` allow list is the maximum set of tools available
- **Agents inherit the full session toolset** by default; the only shipped restriction is `disallowedTools: Task`, which blocks nested subagent spawning
- **Optional per-agent narrowing**: An agent can be narrowed by adding a `tools:` allowlist to its frontmatter — omit it to inherit everything. Listing `tools:` drops inherited MCP tools unless the fully-qualified `mcp__<server>__<tool>` ids are also listed

### Expanding permissions

Only add tools to the allow list if you create custom stages that need additional capabilities.

### Narrowing permissions

Remove tools from the allow list to require manual approval for each use. Note that removing `Task` causes subagent stages (2.1 Reverse Engineering, 3.5 Code Generation) to prompt for permission on each delegation. Workspace detection (0.2) runs deterministically inside `aidlc-utility init` — it does not use `Task`.

---

## Extending AI-DLC

The settings, scopes, depth, and stage edits above cover day-to-day tuning of a workflow you run. When you want to reshape the framework itself for your team — add a stage, add an agent, define a scope, teach a standing rule, wire a deterministic check, or add domain knowledge — that's a distinct job with its own guide: the **[Harness Engineer Guide](../harness-engineering/00-overview.md)**.

The dividing line is data versus code. Everything in that guide is a Markdown file with YAML frontmatter or a JSON config that the framework reads — no TypeScript edits. Where to go for each extension:

| You want to… | Start at |
|--------------|----------|
| Edit what a stage does, or add a new stage | [Anatomy of a Stage](../harness-engineering/01-anatomy-of-a-stage.md), [Adding a Stage](../harness-engineering/02-adding-a-stage.md) |
| Add or modify an agent | [Adding an Agent](../harness-engineering/03-adding-an-agent.md) |
| Define or tune a scope | [Scopes](../harness-engineering/04-scopes.md) |
| Teach a standing rule, or operate the learning loop | [Rules and the Learning Loop](../harness-engineering/05-rules-and-the-loop.md) |
| Wire a deterministic check (sensor) into a stage | [Sensors](../harness-engineering/06-sensors.md) |
| Add team domain knowledge | [Team Knowledge](../harness-engineering/07-team-knowledge.md) |

If your change is to the framework's *code* — the orchestrator, a hook, a CLI tool, the compile pipeline — that's the [Developer Reference](../reference/00-overview.md).

---

## Knowledge and Rules

For details on the two-tier knowledge system and the rule/learning-loop system, see:

- [Knowledge](08-knowledge.md) — Team knowledge directories and methodology reference files
- [Rules and the Learning Loop](09-rules-and-the-learning-loop.md) — Behavioral rules and the self-learning flow

---

## Next Steps

- [Scopes, Depth, and Test Strategy](05-scopes-and-depth.md) — Full scope-to-stage mapping
- [Agents](06-agents.md) — Agent permissions and capabilities
- [Troubleshooting](15-troubleshooting.md) — Statusline issues, hook configuration
- [Glossary](glossary.md) — Definitions for scope, depth, guardrail, knowledge
