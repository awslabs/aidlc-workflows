# Cursor Native Surfaces & Hook Adapter — Domain Research

**Domain**: Cursor Native Surfaces & Hook Adapter
**Research Date**: 2026-07-29
**Sources**: Official Cursor Docs (cursor.com/docs), existing project documents, codex adapter source code

---

## ProServe Skills Reference Design

No matching design was found in `.apex/proserve-skills-designs/`. The `ai-dlc/to-harness-pipeline.md`
design covers integrating AI-DLC with an app harness runtime, not with building a new CLI harness surface.
Not applicable to this domain. Proceeding with standard research.

---

## Research Domain

This domain covers four Cursor-native customization surfaces and the hook adapter required to bridge Cursor's
hook contract with AI-DLC's Claude-shaped core contract:

1. **Rules** — `.cursor/rules/*.mdc` with YAML frontmatter
2. **Skills** — `.cursor/skills/*/SKILL.md` (open SKILL.md standard)
3. **Hooks** — `.cursor/hooks.json` v1 schema
4. **Commands** — `.cursor/commands/*.md` plain markdown
5. **Hook Adapter** — `harness/cursor/hooks/aidlc-cursor-adapter.ts`

---

## Reference Architectures

No AWS reference architectures apply — this is a local developer tooling project with no cloud infrastructure.
The relevant reference is the existing codex harness (`harness/codex/`), which provides the closest analogue
for emit.ts + adapter pattern. Examined as the primary reference pattern.

| Pattern | Source | Applicability | Key patterns |
|---------|--------|---------------|--------------|
| Codex harness emit.ts + adapter | `harness/codex/emit.ts`, `hooks/aidlc-codex-adapter.ts` | High | stdin/stdout subprocess pipe; deduplicate delivery; runCore() helper; target dispatch |
| Claude harness settings.json | `harness/claude/settings.json` | Medium | Hook registration reference for event selection |

---

## Managed Services

Not applicable — no AWS managed services involved. All functionality is file-based developer tooling.

---

## Service Lifecycle Status

Not applicable — no AWS services.

---

## Service Limits / Quotas

Not applicable — no AWS services. Platform limits noted in the Constraints section below.

---

## Detailed Research

### 1. Cursor Rules — `.cursor/rules/*.mdc`

**Source**: Official Cursor Docs, `cursor.com/docs/context/rules`

#### Critical Finding: File Extension Is `.mdc`, Not `RULE.md`

The project's existing `cursor-platform-research.md` describes a `.cursor/rules/*/RULE.md` folder format.
The **official Cursor docs (July 2026) contradict this**:

> "Each rule is an `.mdc` file that you can name anything you want. Project rules must use the `.mdc`
> extension. A plain `.md` file in `.cursor/rules` is ignored by the rules system because it has no
> frontmatter to specify `description`, `globs`, and `alwaysApply`."

Official file layout from docs:

```
.cursor/rules/
  react-patterns.mdc       # Recognized as a project rule
  api-guidelines.md        # IGNORED (wrong extension)
  frontend/                # Organize rules in folders
    components.mdc
```

Rules can be organized in subfolders — `frontend/components.mdc` is valid — but the individual rule files
must have the `.mdc` extension, not be named `RULE.md`.

This is a **critical constraint conflict** with the project's stated convention. See CQ-ARCH-001.

#### YAML Frontmatter Fields

Three control fields (source: official docs):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `alwaysApply` | boolean | No (default: false) | When true, always included in every conversation |
| `description` | string | No | Used by the agent to decide relevance (agent-decided rules) |
| `globs` | string | No | Glob pattern for file auto-attachment |

**Activation Logic Table** (from official docs):

| alwaysApply | description | globs | Behavior |
|-------------|-------------|-------|----------|
| `true` | — | — | Always included. Globs and description are ignored. |
| `false` | — | provided | Auto-attached when a matching file is in context. |
| `false` | provided | omitted | Agent reads the description and pulls the rule in when relevant. |
| `false` | omitted | omitted | Included only when you `@`-mention the rule in chat. |

**Example — Always Apply (core methodology):**

```yaml
---
alwaysApply: true
---

- All source files must include the company copyright header
- Never modify generated files in the `dist/` or `build/` directories
```

**Example — Agent Requested (phase-specific):**

```yaml
---
description: RPC service conventions and patterns for the backend
alwaysApply: false
---

- Define each service in its own file under `src/services/`
- Return structured error objects with a `code` and `message` field
```

**Example — Auto Attached (file-type):**

```yaml
---
globs: src/components/**/*.tsx
alwaysApply: false
---

- Use named exports, not default exports
- Co-locate styles in a module CSS file
```

#### Rule Precedence (highest to lowest)
Team Rules > Project Rules > User Rules > Legacy `.cursorrules` > `AGENTS.md`

#### Platform Constraints
- `.mdc` extension required; `.md` files in `.cursor/rules/` are ignored
- Best practice: under 500 lines per rule; split large rules
- Legacy `.cursorrules` (single file at root) and `*.mdc` in old format are still supported but deprecated
- NFR-100 prohibits legacy formats

**Addresses**: FR-005, NFR-100, NFR-200

---

### 2. Cursor Skills — `.cursor/skills/*/SKILL.md`

**Source**: Official Cursor Docs, `cursor.com/docs/skills`

#### Discovery Paths

Skills are discovered from (in priority order):
1. `~/.cursor/skills/` — user-level
2. `.cursor/skills/` — repo-scoped (project root)
3. Nested `.cursor/skills/` in subdirectories of monorepos

The `/aidlc` skill goes at `.cursor/skills/aidlc/SKILL.md`.

#### SKILL.md File Format

Each skill is a folder containing a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: my-skill
description: Short description of what this skill does and when to use it.
---

# My Skill

Detailed instructions for the agent.
```

#### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill identifier. Lowercase letters, numbers, hyphens only. **Must match the parent folder name.** |
| `description` | Yes | Describes what the skill does. Used by the agent to determine relevance. |
| `paths` | No | Glob patterns that scope the skill to matching files. |
| `disable-model-invocation` | No | When `true`, skill is only included when explicitly invoked via `/skill-name`. Agent will not auto-apply. |
| `metadata` | No | Arbitrary key-value mapping for additional metadata. |

**Key constraint**: The `name` field value must match the parent folder name. For the AI-DLC orchestrator:
- Folder: `.cursor/skills/aidlc/`
- Frontmatter: `name: aidlc`
- Invocation: `/aidlc`

#### Behavior
- At startup, only `name` and `description` are loaded into agent context
- Full SKILL.md content is injected into context only on invocation
- By default, skills are automatically applied when the agent determines relevance
- Set `disable-model-invocation: true` to require explicit `/aidlc` invocation only

#### SKILL.md Standard — Byte Compatibility

The SKILL.md format is identical across Claude Code, Codex, Kiro IDE, and Cursor. Only the `name` field
and any harness-specific command names/paths within the content body differ. NFR-201 requires byte-parity
with the Claude harness SKILL.md (limited to Cursor-specific references).

Skill folders can contain optional directories:
```
.cursor/skills/aidlc/
  SKILL.md           # Required
  scripts/           # Optional helper scripts
  references/        # Optional reference files
```

**Addresses**: FR-004, NFR-201

---

### 3. Cursor Hooks — `.cursor/hooks.json`

**Source**: Official Cursor Docs, `cursor.com/docs/agent/hooks`

#### hooks.json v1 Full Schema

```json
{
  "version": 1,
  "hooks": {
    "sessionStart":          [{ "command": "./hooks/session-init.sh" }],
    "sessionEnd":            [{ "command": "./hooks/audit.sh" }],
    "beforeShellExecution":  [{ "command": "./hooks/audit.sh" }, { "command": "./hooks/block-git.sh" }],
    "beforeMCPExecution":    [{ "command": "./hooks/audit.sh" }],
    "afterShellExecution":   [{ "command": "./hooks/audit.sh" }],
    "afterMCPExecution":     [{ "command": "./hooks/audit.sh" }],
    "afterFileEdit":         [{ "command": "./hooks/audit.sh" }],
    "beforeSubmitPrompt":    [{ "command": "./hooks/audit.sh" }],
    "preCompact":            [{ "command": "./hooks/audit.sh" }],
    "stop":                  [{ "command": "./hooks/audit.sh", "loop_limit": 10 }],
    "beforeTabFileRead":     [{ "command": "./hooks/redact-secrets-tab.sh" }],
    "afterTabFileEdit":      [{ "command": "./hooks/format-tab.sh" }],
    "workspaceOpen":         [{ "command": "./hooks/register-workspace-plugins.sh" }],
    "subagentStart":         [{ "command": "./hooks/validate-subagent.sh" }],
    "subagentStop":          [{ "command": "./hooks/log-subagent.sh" }],
    "preToolUse":            [{ "command": "./hooks/validate-tool.sh", "matcher": "Shell|Read|Write" }],
    "afterAgentThought":     [{ "command": "./hooks/observe-thought.sh" }],
    "afterAgentResponse":    [{ "command": "./hooks/log-response.sh" }]
  }
}
```

All hook script paths are relative to the project root (not `.cursor/hooks/`).
Use `.cursor/hooks/...` paths in `command` values for correct resolution.

#### Hook Definition Options (per-hook-entry fields)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `command` | string | required | Script path or command (relative to project root) |
| `type` | `"command"` \| `"prompt"` | `"command"` | Hook execution type |
| `timeout` | number | platform default | Execution timeout in seconds |
| `loop_limit` | number \| null | `5` | Per-script loop limit for `stop`/`subagentStop` hooks. `null` = no limit. |
| `failClosed` | boolean | `false` | When `true`, hook failures (crash, timeout, invalid JSON) block the action |
| `matcher` | object | — | Filter criteria for when hook runs (string = regex match) |

**Critical**: `failClosed` defaults to `false` (fail-open). Security gate hooks (beforeShellExecution,
preToolUse) MUST set `failClosed: true`. Addresses NFR-101 (F-007).

#### Base Stdin Fields (All Hooks)

All hooks receive this base payload on stdin:

```json
{
  "conversation_id": "string",
  "generation_id": "string",
  "model": "string",
  "model_id": "string",
  "model_params": [{ "id": "string", "value": "string" }],
  "hook_event_name": "string",
  "cursor_version": "string",
  "workspace_roots": ["<path>"],
  "user_email": "string | null",
  "transcript_path": "string | null"
}
```

**Exception**: `workspaceOpen` and IDE lifecycle hooks that fire outside an agent session omit
`conversation_id`, `generation_id`, and `model` fields.

#### Event-Specific Stdin Fields

**beforeShellExecution / beforeMCPExecution:**

```json
// beforeShellExecution additional fields
{
  "command": "<full terminal command>",
  "cwd": "<current working directory>",
  "sandbox": false
}

// beforeMCPExecution additional fields
{
  "tool_name": "<tool name>",
  "tool_input": "<json params>"
}
// Plus either:
{ "url": "<server url>" }
// Or:
{ "command": "<command string>" }
```

**Permission Output (for gating hooks):**

```json
{
  "permission": "allow" | "deny" | "ask",
  "user_message": "<message shown in client>",
  "agent_message": "<message sent to agent>"
}
```

Note: field names in output are `user_message` and `agent_message` (snake_case), not `userMessage`/`agentMessage`.

**beforeSubmitPrompt:**

```json
// Input additional fields
{
  "prompt": "<user prompt text>",
  "attachments": [
    {
      "type": "file" | "rule",
      "file_path": "<absolute path>"
    }
  ]
}

// Output
{
  "continue": true | false,
  "user_message": "<message shown in client>",
  "agent_message": "<message sent to agent>"
}
```

**afterFileEdit:**

```json
// Input additional fields
{
  "file_path": "<absolute path>",
  "edits": [{ "old_string": "<search>", "new_string": "<replace>" }]
}
// Output: none currently supported
```

**stop hook (full TypeScript type from official docs):**

```typescript
type StopHookInput = {
  conversation_id: string;
  generation_id: string;
  model: string;
  model_id?: string;
  model_params?: Array<{ id: string; value: string }>;
  status: 'completed' | 'aborted' | 'error';
  loop_count: number;
};

type StopHookOutput = {
  followup_message?: string;
};
```

The `followup_message` field triggers a re-entry of the agent with the provided message.
The `loop_count` field tracks iterations. Use `loop_limit` in hooks.json to cap retries
(default: 5; `null` = unlimited; recommended: 4-5 for AI-DLC self-correction loops).

**subagentStart:**

```json
// Input additional fields
{
  "subagent_id": "abc-123",
  "subagent_type": "generalPurpose",
  "task": "Explore the authentication flow",
  "parent_conversation_id": "conv-456",
  "tool_call_id": "tc-789",
  "subagent_model": "claude-sonnet-4-20250514",
  "is_parallel_worker": false,
  "git_branch": "feature/auth"
}

// Output
{
  "permission": "allow" | "deny",
  "user_message": "<message shown when denied>"
}
```

#### Hook Locations (precedence)
1. Project: `.cursor/hooks.json` (committed to repo)
2. User: `~/.cursor/hooks.json` (personal)
3. Enterprise: `/etc/cursor/hooks.json`
4. Plugins (installed via Cursor Customize)

**Cloud agent limitation**: Only project-level hooks run in cloud agents. User-level hooks do NOT run.
`sessionStart`/`sessionEnd` and IDE lifecycle events do NOT fire in cloud agents.

#### Matcher Configuration

```json
{
  "hooks": {
    "preToolUse": [
      { "command": "./validate-shell.sh", "matcher": "Shell" }
    ],
    "subagentStart": [
      { "command": "./validate-explore.sh", "matcher": "explore|shell" }
    ],
    "beforeShellExecution": [
      { "command": "./approve-network.sh", "matcher": "curl|wget|nc " }
    ]
  }
}
```

- For `subagentStart`: matcher runs against `subagent_type` (values: `generalPurpose`, `explore`, `shell`)
- For `beforeShellExecution`: matcher runs against the command string
- Matcher value is a regex string

#### AI-DLC Hook Wiring Plan

| AI-DLC Hook Target | Cursor Event | failClosed | Purpose |
|---|---|---|---|
| `session-start` | `beforeSubmitPrompt` | false | Session init on first prompt (cloud-compatible) |
| `state-transition-guard` | `beforeShellExecution` | **true** | Block invalid state transitions |
| `reviewer-scope` | `preToolUse` | **true** | Per-reviewer read-scope gate |
| `audit-and-sensors` | `afterFileEdit` | false | File edit audit trail |
| `log-subagent` | `subagentStop` | false | Subagent tracking |
| `stop` | `stop` | false | Self-correction + session end |
| `validate-state` | `preCompact` | false | State validation before compaction |

Note: AI-DLC uses `beforeSubmitPrompt` instead of `sessionStart` to ensure cloud agent compatibility (F-008).

**Addresses**: FR-006, FR-007, NFR-101

---

### 4. Cursor Commands — `.cursor/commands/*.md`

**Source**: Project `cursor-platform-research.md` (official docs page returned empty)

Commands are plain Markdown files. No YAML frontmatter.

```
.cursor/commands/
  aidlc-status.md    → /aidlc-status
  aidlc-jump.md      → /aidlc-jump
  aidlc-scope.md     → /aidlc-scope
```

- Filename without `.md` extension becomes the slash command name
- Invoked via `/command-name` in chat
- Support parameterized arguments via `$1`, `$2`, etc.
- Content is plain markdown injected into the chat when the command is invoked

**Addresses**: FR-003

---

### 5. Hook Adapter Contract

**Source**: Analyzed from `harness/codex/hooks/aidlc-codex-adapter.ts` as reference pattern

The Cursor adapter (`harness/cursor/hooks/aidlc-cursor-adapter.ts`) must bridge two contracts:

#### Contract Diff: Cursor vs Claude/Core

| Aspect | Claude/Core | Cursor |
|--------|-------------|--------|
| Block mechanism | exit code 2 + stderr | `"permission": "deny"` in JSON stdout |
| Tool gating event | `PreToolUse` | `beforeShellExecution` + `preToolUse` |
| File edit audit | `PostToolUse` (Write tool) | `afterFileEdit` (dedicated event) |
| Session start | `SessionStart` event | `beforeSubmitPrompt` (first prompt) |
| Self-correction | `Stop` hook body | `stop` hook with `followup_message` |
| Field naming | snake_case | camelCase (base fields) but mixed — see below |
| Subagent events | `SubagentStop` | `subagentStop` |
| State validation | `PreCompact` | `preCompact` |

#### Stdin Field Naming: Cursor Uses snake_case Already

Important: Despite the API documentation using camelCase for conceptual names, Cursor's actual stdin
JSON payload fields are in **snake_case** for the base fields:
- `conversation_id` (not `conversationId`)
- `generation_id` (not `generationId`)
- `hook_event_name` (not `hookEventName`)
- `workspace_roots` (not `workspaceRoots`)
- `cursor_version` (not `cursorVersion`)
- `model_id` (not `modelId`)
- `model_params` (not `modelParams`)
- `transcript_path` (not `transcriptPath`)
- `user_email` (not `userEmail`)

Hook-specific fields (beforeShellExecution, subagentStart) also use snake_case:
- `tool_name`, `tool_input`, `subagent_type`, `parent_conversation_id`, `tool_call_id`

**The "camelCase Cursor payload" claim in the requirements and vision documents is not accurate**.
Cursor's stdio JSON is already in snake_case. This changes the adapter complexity significantly:

- The adapter does NOT need to perform snake_case ↔ camelCase translation
- The adapter DOES need to normalize: permission-deny → exit-code-2 mapping for gating hooks
- The adapter DOES need to map `beforeSubmitPrompt` → `SessionStart`-shaped input for the core session-start hook
- The adapter DOES need to map `afterFileEdit` → PostToolUse Write-shaped input for the audit hook
- The adapter DOES need to map `preToolUse` + Cursor-specific tool names → Claude-shaped PreToolUse
- The adapter DOES need to map `subagentStop` → SubagentStop-shaped input

#### Permission Deny Mapping

For gating hooks (`beforeShellExecution`, `preToolUse`, `subagentStart`):
- Core hooks signal block via exit code 2 + stderr
- Cursor expects JSON stdout with `"permission": "deny"` and optional `user_message` / `agent_message`
- Adapter: run core hook → if exit code 2: emit `{"permission":"deny","user_message":"...", "agent_message":"..."}` → exit 0
- For non-gating hooks: core exit code irrelevant; Cursor reads JSON stdout

#### afterFileEdit → PostToolUse Write Mapping

```typescript
// Cursor afterFileEdit input
{
  file_path: string,
  edits: Array<{ old_string: string; new_string: string }>
}

// Forward to core as:
{
  hook_event_name: "PostToolUse",
  tool_name: "Write",
  tool_input: { file_path: <absolute path> }
}
```

#### beforeSubmitPrompt → SessionStart Mapping

```typescript
// Cursor beforeSubmitPrompt input has:
// conversation_id, generation_id, prompt, attachments, ...

// Forward to core session-start hook as:
{
  hook_event_name: "SessionStart",
  source: "startup",
  session_id: conversation_id  // reuse conversation_id as session identifier
}
```

#### stop Hook followup_message

The stop hook can return `{"followup_message": "..."}` to trigger re-entry. AI-DLC's self-correction
mechanism maps naturally:
- Core `aidlc-stop.ts` returns `{"decision":"block","reason":"..."}` for loop enforcement
- Adapter maps `decision:block` → `followup_message` with the reason text
- `loop_count` from Cursor stdin provides the iteration counter; compare with `loop_limit` in hooks.json

**Addresses**: FR-007, NFR-101

---

### 6. CLI Permissions — `.cursor/cli.json`

**Source**: Project `cursor-platform-research.md`

Controls what `cursor-agent` CLI can do without prompting:

```json
{
  "allow": ["Shell(npm test)", "Read(**)", "Write(src/**)"],
  "deny": ["Shell(rm -rf *)"]
}
```

Permission tokens: `Shell(command)`, `Read(path)`, `Write(path)`, `Delete(path)`, `Grep(path)`, `LS(path)`.

Safe default for AI-DLC:
- Allow: `Read(**)` (full read access), `Shell(bun *)` (bun tool execution), `Shell(git add)`, `Shell(git commit)`, `Shell(git status)`, `Shell(git log)`, `Shell(git diff)`
- Deny: `Shell(rm -rf *)`, `Shell(git push *)`, `Shell(git reset --hard *)`, `Shell(curl *)`, `Shell(wget *)`

**Addresses**: FR-003

---

## Options Summary (Neutral)

### Option A: `.mdc` flat files at `.cursor/rules/`
- **Structure**: `.cursor/rules/aidlc-method.mdc`, `.cursor/rules/aidlc-phase-ideation.mdc`, etc.
- **Pro**: Matches official Cursor docs; files are directly recognized by the rules engine
- **Con**: Breaks the "folder with RULE.md" convention described in project research doc; emitter output changes

### Option B: `.mdc` files in subfolders at `.cursor/rules/`
- **Structure**: `.cursor/rules/aidlc-method/aidlc-method.mdc`, etc.
- **Pro**: Preserves folder organization for grouping assets; matches the docs example `frontend/components.mdc`
- **Con**: Extra folder nesting; name must still be `.mdc`

### Option C: `RULE.md` files in subfolders (as described in project research)
- **Structure**: `.cursor/rules/aidlc-method/RULE.md`
- **Pro**: Matches project's existing specification docs; cleaner naming
- **Con**: **Contradicts official Cursor docs** — `.md` files in `.cursor/rules/` are explicitly ignored. Requires confirmation that this is a new Cursor feature post-3.11 not yet in docs.

---

## Decision Points for Design Agent

1. **Rule file format**: `.mdc` (official) vs `RULE.md` (project research doc) — see CQ-ARCH-001
2. **Hook adapter field naming**: Stdin is already snake_case; no camelCase translation needed
3. **permission deny output**: Use JSON `{"permission":"deny","agent_message":"<reason>"}` not exit code
4. **Session init event**: Use `beforeSubmitPrompt` with first-prompt detection, not `sessionStart`
5. **stop hook self-correction**: Map core `decision:block` → `followup_message` with loop_count guard

---

## External Dependencies

| Dependency | Type | Notes |
|---|---|---|
| Cursor IDE 3.11+ | Platform | Required for `beforeSubmitPrompt`, subagent hooks, cloud agent hooks |
| Bun runtime | Build/exec | All hook scripts executed via `bun`; required by NFR-001 |
| `harness/codex/hooks/aidlc-codex-adapter.ts` | Code reference | Template for adapter implementation pattern |
| `scripts/manifest-types.ts` — `HarnessManifest` | Type contract | emit.ts must implement this interface |
| `core/hooks/aidlc-*.ts` | Core hooks | Adapter pipes stdin to these via `runCore()` subprocess |
| `core/memory/` | Content source | Emitter reads org.md, team.md, phases/*.md for rule content |

---

*Sources*:
- Official Cursor Hooks Docs: `cursor.com/docs/agent/hooks` (fetched 2026-07-29)
- Official Cursor Rules Docs: `cursor.com/docs/context/rules` (fetched 2026-07-29)
- Official Cursor Skills Docs: `cursor.com/docs/skills` (fetched 2026-07-29)
- Project research: `project-doc/project-context/cursor-platform-research.md`
- Project technical environment: `project-doc/project-context/technical-environment.md`
- Existing codex adapter: `harness/codex/hooks/aidlc-codex-adapter.ts`
