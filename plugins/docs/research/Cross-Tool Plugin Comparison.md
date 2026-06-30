# Cross-Tool Plugin Manifest Comparison

> **Addendum to Codex Manifest Shape Report** | June 26, 2026  
> **Sources**: OpenAI Codex docs, Anthropic Claude Code docs, Cursor official plugins repo, OpenCode docs, HuggingFace Context Course  
> **Platforms compared**: Codex, Claude Code, Cursor, OpenCode, Pi

---

## Platform Architecture Models

The AI coding tool ecosystem splits into two fundamental approaches:

| Model | Platforms | Characteristics |
|-------|-----------|-----------------|
| **Manifest-first** | Codex, Claude Code | Declarative JSON manifest + root-level component dirs. No code runs at install time. |
| **Code-first** | OpenCode | JS/TS modules export hook functions. Plugin IS the code. |
| **IDE-extension** | Cursor (VS Code fork) | Inherits VS Code extension model + new plugin specs |
| **Package-based** | Pi | `package.json` with convention-based directories |

---

## Side-by-Side Manifest Comparison

### Codex `.codex-plugin/plugin.json`

```json
{
  "name": "text-processor-plugin",
  "version": "1.0.0",
  "description": "Text analysis skills",
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "apps": "./.app.json",
  "hooks": "./hooks/hooks.json",
  "interface": {
    "displayName": "Text Processor",
    "shortDescription": "Analyze text with AI",
    "category": "Productivity",
    "capabilities": ["Read", "Write"],
    "defaultPrompt": ["Analyze this text for readability"],
    "brandColor": "#10A37F",
    "logo": "./assets/logo.png"
  }
}
```

### Claude Code `.claude-plugin/plugin.json`

```json
{
  "name": "text-processor-plugin",
  "version": "1.0.0",
  "description": "Text analysis skills",
  "author": { "name": "Your Name" }
}
```

**Notable**: Claude Code's manifest is much leaner — components are discovered by convention (directory presence), not pointed to by explicit paths. No `interface` object.

### OpenCode (No Manifest — Code is the plugin)

```typescript
// .opencode/plugins/text-processor-plugin.ts
import type { Plugin } from "@opencode-ai/plugin"

export const TextProcessorPlugin: Plugin = async ({ project, client, $, directory }) => {
  return {
    "tool.execute.before": async (input) => {
      if (input.tool === "read") {
        await client.app.log({ body: { message: "Consider text analysis" } })
      }
    }
  }
}
```

### Pi `package.json`

```json
{
  "name": "text-processor-plugin",
  "version": "1.0.0",
  "keywords": ["pi-package"],
  "pi": {
    "skills": ["./skills"],
    "extensions": ["./extensions"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

---

## Directory Structure Comparison

### Codex
```
my-plugin/
├── .codex-plugin/
│   └── plugin.json          ← Manifest (ONLY file here)
├── skills/
│   └── analyze-text/
│       └── SKILL.md
├── .mcp.json                ← MCP server config
├── .app.json                ← App/connector config  
├── hooks/
│   └── hooks.json
└── assets/
    ├── logo.png
    └── screenshot-1.png
```

### Claude Code
```
my-plugin/
├── .claude-plugin/
│   └── plugin.json          ← Manifest (ONLY file here)
├── skills/
│   └── analyze-text/
│       └── SKILL.md
├── agents/                  ← UNIQUE: agent definitions
│   └── reviewer.md
├── .mcp.json                ← MCP server config
├── .lsp.json                ← UNIQUE: LSP server config
├── hooks/
│   └── hooks.json
├── monitors/                ← UNIQUE: background monitors
│   └── monitors.json
├── themes/                  ← UNIQUE: color themes
│   └── dracula.json
└── README.md
```

### OpenCode
```
my-project/
├── .opencode/
│   ├── plugins/
│   │   └── text-processor.ts   ← Plugin IS the code
│   └── package.json
├── opencode.json               ← npm plugin references
└── README.md
```

### Pi
```
my-package/
├── package.json                ← Manifest (no hidden dir)
├── skills/
│   └── analyze-text/
│       └── SKILL.md
├── extensions/                 ← Runtime TS/JS extensions
│   └── text-processor.ts
├── prompts/
└── themes/
```

---

## Manifest Field Comparison

| Field | Codex | Claude Code | OpenCode | Pi |
|-------|-------|-------------|----------|-----|
| **Location** | `.codex-plugin/plugin.json` | `.claude-plugin/plugin.json` | N/A (code-first) | `package.json` |
| **Required** | Only `name` | Only `name` | N/A | `name` |
| **Name format** | kebab-case | kebab-case | module export | npm-style |
| **Version** | Optional (semver) | Optional (semver or git SHA) | N/A | Required (semver) |
| **Component pointers** | Explicit (`"skills": "./skills/"`) | Convention-based (dirs auto-detected) | N/A | Explicit (`"pi": {"skills": [...]}`) |
| **Interface/UI metadata** | Rich `interface` object (15 fields) | None — marketplace metadata in marketplace.json | N/A | None |
| **MCP config** | `.mcp.json` (pointed by manifest) | `.mcp.json` (auto-detected at root) | Separate config | Optional `.mcp.json` |
| **Path rules** | Must start with `./`, no `..` | Must start with `./`, no `..` | N/A | Standard node resolution |
| **Forward-compat** | `extra` maps preserve unknowns | Unrecognized fields fail validation | N/A | Standard JSON |
| **Validation** | SDK (Elixir) — lenient, preserves extra | Strict schema — rejects unknowns | N/A | npm validation |

---

## Component Types Supported

| Component | Codex | Claude Code | OpenCode | Cursor | Pi |
|-----------|:-----:|:-----------:|:--------:|:------:|:---:|
| Skills (SKILL.md) | ✅ | ✅ | ❌ (hooks instead) | ❌ | ✅ |
| MCP Servers | ✅ | ✅ | ❌ (separate) | ✅ (consumer) | ✅ (via adapter) |
| App Connectors | ✅ (.app.json) | ❌ | ❌ | ❌ | ❌ |
| Lifecycle Hooks | ✅ | ✅ (30+ events) | ✅ (25+ events) | ❌ | ❌ |
| Agents/Subagents | ❌ | ✅ (agents/) | ❌ | ❌ | ❌ |
| LSP Servers | ❌ | ✅ (.lsp.json) | ❌ | ❌ (VS Code native) | ❌ |
| Monitors | ❌ | ✅ (experimental) | ❌ | ❌ | ❌ |
| Themes | ❌ | ✅ (experimental) | ❌ | ❌ (VS Code native) | ✅ |
| Custom Tools | ❌ (via MCP) | ❌ (via MCP) | ✅ (in code) | ❌ | ✅ (in extensions) |

---

## Distribution Models

| Dimension | Codex | Claude Code | OpenCode | Cursor |
|-----------|-------|-------------|----------|--------|
| **Primary distribution** | Git repos | Git repos | npm + local files | VS Code Marketplace (OpenVSX) |
| **Marketplace format** | `marketplace.json` (JSON catalog) | `marketplace.json` (JSON catalog) | `opencode.json` array | `.vsix` packages |
| **Scopes** | Official, Repo, Personal | User, Project, Local, Managed | Project-local | Global |
| **Install cache** | `~/.codex/plugins/cache/` | `~/.claude/plugins/` | `node_modules` | `~/.vscode/extensions/` |
| **Offline support** | ✅ (cache persists) | ✅ (cache persists) | ✅ (npm cache) | ✅ |
| **Version pinning** | `ref`/`sha` in marketplace entry | git SHA or explicit version | npm semver | Extension version |
| **CLI install** | `codex plugin install` | `claude plugin install` | npm install | ext install |
| **Marketplace CLI** | `codex plugin marketplace add` | (marketplace.json file) | N/A | N/A |
| **Policy controls** | `AVAILABLE`/`PREINSTALLED`/`HIDDEN` | Scoped settings | N/A | N/A |

---

## Hook/Event Systems

| Aspect | Codex | Claude Code | OpenCode |
|--------|-------|-------------|----------|
| **Event count** | ~5-6 (SessionStart, Turn*, ToolCall*) | 30+ events | 25+ events |
| **Hook types** | `command` only | `command`, `http`, `mcp_tool`, `prompt`, `agent` | JS/TS handler functions |
| **Trust model** | Non-managed (explicit user trust required) | Non-managed (explicit trust) | Auto-loaded (code in project) |
| **Env vars** | `PLUGIN_ROOT`, `PLUGIN_DATA` | `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR` | Context object in code |
| **Event matchers** | N/A | Regex patterns (e.g., `"Write|Edit"`) | Tool name matching |
| **Blocking** | No | Yes (PreToolUse can block) | Yes (before hooks can block) |

---

## Key Architectural Differences

### 1. Explicit Pointers vs Convention Discovery

**Codex** requires explicit manifest pointers:
```json
{ "skills": "./skills/", "mcpServers": "./.mcp.json" }
```

**Claude Code** auto-discovers by directory presence — if `skills/` exists at plugin root, skills are loaded. The manifest only needs `name`. This makes Claude Code plugins simpler to create but harder to reason about (implicit behavior).

### 2. Interface Metadata: Codex-Only

Codex has a rich `interface` object for marketplace presentation (brand colors, logos, screenshots, starter prompts). Claude Code has **no equivalent** in the manifest — all presentation metadata lives in the marketplace entry, not the plugin itself.

**Why it matters**: Codex plugins are self-describing for marketplace purposes. Claude Code plugins depend on their marketplace entry for discoverability.

### 3. App Connectors: Codex-Exclusive

Only Codex has `.app.json` for third-party service authentication (OAuth, API keys). Claude Code, OpenCode, and Cursor don't bundle auth connectors in their plugin systems — they expect MCP servers to handle external service integration.

**Why it matters**: Codex treats "connecting to Slack/GitHub/Figma" as a first-class plugin concern. Others offload this entirely to MCP.

### 4. Subagents: Claude Code-Exclusive

Only Claude Code supports `agents/` directories with agent definitions (model selection, tool restrictions, isolation). Codex has no agent bundling — its "subagent" concept operates outside the plugin system.

### 5. LSP + Monitors + Themes: Claude Code's Breadth

Claude Code has the richest component surface: LSP servers (real-time code intelligence), monitors (background stdout watchers), and themes. These make Claude Code plugins closer to full IDE extensions. Codex is narrower but cleaner.

### 6. Validation Philosophy

| | Codex | Claude Code |
|--|-------|-------------|
| Unknown keys | **Preserved** in `extra` maps | **Rejected** — validation fails |
| Forward compat | ✅ Survives round-trips | ❌ Must remove unknowns |
| Strictness | Lenient (only name required) | Strict (schema enforcement) |

This is a significant divergence: Codex plugins can carry forward-compatible experimental fields. Claude Code's strict validation means older tools break on newer manifest features.

### 7. Cross-Tool Portability

| Layer | Portable? | Notes |
|-------|-----------|-------|
| MCP servers | ✅ Universal | Same `.mcp.json` works across Codex, Claude Code, Cursor |
| Skills (SKILL.md) | 🟡 Near-portable | Same format, different auto-discovery/invocation |
| Hooks | ❌ Tool-specific | Different events, different schemas |
| Manifest | ❌ Tool-specific | `.codex-plugin/` ≠ `.claude-plugin/` |
| Marketplace | 🟡 Near-portable | Same JSON format, different paths |

**MCP is the universal interop layer.** A well-built MCP server works across all tools. Everything above MCP (skills, hooks, marketplace metadata) is tool-specific — but the functional logic (the MCP server code) is write-once, run-anywhere.

---

## Summary: When to Use Which Model

| If you want... | Best platform model |
|----------------|-------------------|
| Declarative, inspectable plugins | Codex or Claude Code (manifest-first) |
| Rich marketplace presentation | Codex (interface object) |
| Maximum component variety | Claude Code (agents, LSP, monitors, themes) |
| Cross-team distribution | Codex or Claude Code (Git marketplaces) |
| Code-level hook control | OpenCode (programmatic hooks) |
| IDE-native extensions | Cursor (VS Code model) |
| MCP portability | All (MCP is universal) |
| Forward-compatible schemas | Codex (extra maps) |
| Strict validation safety | Claude Code (rejects unknowns) |
| Third-party service auth | Codex (.app.json connectors) |

---

## The Convergence Thesis

Despite surface differences, the ecosystem is converging:

1. **MCP as universal glue** — All tools consume MCP servers. This is the write-once layer.
2. **Skills as a shared concept** — SKILL.md with YAML frontmatter appears in Codex, Claude Code, and Pi. The format is nearly identical.
3. **Git-native distribution** — Both Codex and Claude Code use `marketplace.json` catalogs pointing at Git repos. No compilation step, no build system.
4. **Plugin = directory** — Both manifest-first platforms share the same physical pattern: a hidden config dir (`.codex-plugin/` or `.claude-plugin/`) with `plugin.json`, and all components at the plugin root.

The key difference is **scope of ambition**: Codex focuses on Skills + MCP + Apps (clean, portable). Claude Code maximizes component variety (agents, LSP, monitors, themes). OpenCode goes programmatic (full JS/TS control). But MCP underneath means the functional tools are portable regardless of which wrapper you choose.

---

*Sources: [OpenAI Codex Plugins](https://developers.openai.com/codex/plugins/build), [Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference), [Cursor Plugin Ecosystem](https://pyshine.com/Cursor-Plugins-AI-Code-Editor-Plugin-Specification/), [OpenCode Plugins](http://opencode.ai/docs/plugins), [HuggingFace Context Course Unit 3](https://huggingface.co/learn/context-course/unit3/anatomy.md)*
