# Codex Manifest Shape: How Codex Manages Add-ins

> **Deep Research Report** | June 26, 2026  
> **Sources**: OpenAI official docs, Codex SDK v0.16.1 (HexDocs), HuggingFace Context Course, community guides, GitHub issues  
> **Confidence**: High — primary source documentation + SDK type specs + practitioner validation

---

## Executive Summary

OpenAI Codex uses a **manifest-first plugin system** where every plugin is identified by a single required file: `.codex-plugin/plugin.json`. This manifest declares the plugin's identity, points to bundled components (skills, MCP servers, app connectors, lifecycle hooks), and provides install-surface metadata for marketplace presentation.

**Key facts:**
- Only `name` (kebab-case) is strictly required in the manifest
- Plugins bundle up to 4 component types: Skills (brain), Apps (hands), MCP Servers (nervous system), Hooks (lifecycle)
- Distribution uses Git-native marketplaces — JSON catalogs that can be repo-scoped, personal, or official
- Plugins install into `~/.codex/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION/`
- The system is forward-compatible: unknown keys survive round-trip serialization via `extra` maps

---

## 1. Manifest File: `plugin.json`

### Location & Role

The manifest lives at `.codex-plugin/plugin.json` — the only file permitted inside the `.codex-plugin/` directory. All other components (`skills/`, `hooks/`, `assets/`, `.mcp.json`, `.app.json`) live at the plugin root.

The manifest has three jobs:
1. **Identify** the plugin (name, version, author)
2. **Point to bundled components** (skills, MCP servers, apps, hooks)
3. **Provide marketplace metadata** (descriptions, icons, legal links, starter prompts)

### Complete Manifest Example

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "Bundle reusable skills and app integrations.",
  "author": {
    "name": "Your team",
    "email": "team@example.com",
    "url": "https://example.com"
  },
  "homepage": "https://example.com/plugins/my-plugin",
  "repository": "https://github.com/example/my-plugin",
  "license": "MIT",
  "keywords": ["research", "crm"],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "apps": "./.app.json",
  "hooks": "./hooks/hooks.json",
  "interface": {
    "displayName": "My Plugin",
    "shortDescription": "Reusable skills and apps",
    "longDescription": "Distribute skills and app integrations together.",
    "developerName": "Your team",
    "category": "Productivity",
    "capabilities": ["Read", "Write"],
    "websiteURL": "https://example.com",
    "privacyPolicyURL": "https://example.com/privacy",
    "termsOfServiceURL": "https://example.com/terms",
    "defaultPrompt": [
      "Use My Plugin to summarize new CRM notes.",
      "Use My Plugin to triage new customer follow-ups."
    ],
    "brandColor": "#10A37F",
    "composerIcon": "./assets/icon.png",
    "logo": "./assets/logo.png",
    "screenshots": ["./assets/screenshot-1.png"]
  }
}
```

> Source: [developers.openai.com/codex/plugins/build](https://developers.openai.com/codex/plugins/build)

---

## 2. Field Reference

### Top-Level Required Fields

| Field | Type | Validation |
|-------|------|------------|
| `name` | string | Must be **non-empty kebab-case** (lowercase, numbers, hyphens only) |

> Only `name` is strictly required. Everything else is optional.

### Top-Level Optional Fields

| Field | Type | Purpose |
|-------|------|---------|
| `version` | string | Semver string (e.g., `"1.0.0"`) — determines cache path |
| `description` | string | Human-readable summary |
| `author` | object | `{name, email?, url?}` |
| `homepage` | string | Landing page URL |
| `repository` | string | Source code repo URL |
| `license` | string | SPDX identifier (e.g., `"MIT"`) |
| `keywords` | string[] | Discovery tags |
| `skills` | string | Path to skills directory (must start with `./`) |
| `mcpServers` | string | Path to `.mcp.json` file |
| `apps` | string | Path to `.app.json` file |
| `hooks` | string/array/object | Path(s) or inline hook definitions |
| `interface` | object | Install-surface metadata (see §3) |

### The `interface` Object

| JSON Key | Purpose | Constraint |
|----------|---------|------------|
| `displayName` | Plugin title in marketplace | — |
| `shortDescription` | One-liner on plugin cards | — |
| `longDescription` | Detail page description | — |
| `developerName` | Publisher name | — |
| `category` | Marketplace category | e.g., `"Productivity"` |
| `capabilities` | Capability badges | e.g., `["Read", "Write"]` |
| `websiteURL` | External link | — |
| `privacyPolicyURL` | Privacy policy | Required for published plugins |
| `termsOfServiceURL` | Terms of service | — |
| `defaultPrompt` | Starter prompts in composer | **Max 3 entries, each ≤128 chars** |
| `brandColor` | Hex color | e.g., `"#10A37F"` |
| `composerIcon` | Icon path | `./assets/icon.png` |
| `logo` | Logo path | `./assets/logo.png` |
| `screenshots` | Screenshot paths | Array of `./assets/*` paths |

---

## 3. Validation Rules (SDK-Enforced)

The Codex SDK (Elixir, `Codex.Plugins.Manifest.parse!/1`) enforces these stable rules:

| Rule | Detail |
|------|--------|
| Kebab-case name | Non-empty, lowercase + numbers + hyphens only |
| `./` prefix required | All component paths and asset paths must start with `./` |
| No `..` escape | Paths cannot traverse above the plugin root |
| defaultPrompt limit | At most **3** entries |
| Prompt length cap | Each ≤**128 characters** after whitespace normalization |
| Deterministic JSON | Writes produce stable JSON with trailing newline |
| Forward-compatible keys | Unknown keys preserved in `extra` maps, survive round-trips |

```elixir
# Validation API
{:ok, manifest} = Codex.Plugins.Manifest.parse(data)
Codex.Plugins.Manifest.parse!(data)  # raises on error
```

---

## 4. Directory Layout

```
my-plugin/                          ← plugin root
├── .codex-plugin/
│   └── plugin.json                 ← REQUIRED (only file in this dir)
├── skills/                         ← "skills": "./skills/"
│   ├── code-review/
│   │   └── SKILL.md
│   └── deploy/
│       └── SKILL.md
├── hooks/
│   └── hooks.json                  ← "hooks": "./hooks/hooks.json"
├── .app.json                       ← "apps": "./.app.json"
├── .mcp.json                       ← "mcpServers": "./.mcp.json"
└── assets/
    ├── icon.png
    ├── logo.png
    └── screenshot-1.png
```

---

## 5. Component Wiring: How Add-ins Are Referenced

### 5.1 Skills (The "Brain" Layer)

**Manifest pointer**: `"skills": "./skills/"`

Codex scans the directory for subdirectories containing `SKILL.md` files. Each skill has YAML frontmatter:

```markdown
---
name: deploy-kubernetes
description: Deploy containerized apps to Kubernetes clusters.
---

## Workflow
1. Verify kubectl context...
2. Generate manifests...
```

**Activation modes:**
- **Implicit** (default): Auto-loaded when user's task semantically matches the `description`
- **Explicit**: Invoked with `$skill-name` syntax

**Config override** (`config.toml`):
```toml
[skills.deploy-kubernetes]
enabled = true
invocation = "explicit"    # or "implicit"
priority = 10              # higher wins on conflicts
```

**Resolution precedence**: REPO > USER > ADMIN > SYSTEM > DEFAULTS

---

### 5.2 MCP Servers (The "Nervous System" Layer)

**Manifest pointer**: `"mcpServers": "./.mcp.json"`

Two equivalent formats:

```json
// Direct server map
{
  "docs": {
    "command": "docs-mcp",
    "args": ["--stdio"]
  }
}

// Wrapped (alternative)
{
  "mcp_servers": {
    "docs": {
      "command": "docs-mcp",
      "args": ["--stdio"]
    }
  }
}
```

Each server entry: `command` (required), `args` (required), `env` (optional).

**Per-server policy override** (`config.toml`):
```toml
[plugins."my-plugin".mcp_servers.docs]
enabled = true
default_tools_approval_mode = "prompt"
enabled_tools = ["search"]

[plugins."my-plugin".mcp_servers.docs.tools.search]
approval_mode = "approve"
```

**Approval modes**: `"approve"` (auto-execute), `"prompt"` (ask user), `"deny"` (block)

---

### 5.3 Apps/Connectors (The "Hands" Layer)

**Manifest pointer**: `"apps": "./.app.json"`

Defines third-party service connectors with authentication:

```json
{
  "apps": [{
    "name": "github-connector",
    "auth": {
      "type": "oauth2",
      "client_id": "${GITHUB_CLIENT_ID}",
      "authorization_url": "https://github.com/login/oauth/authorize",
      "token_url": "https://github.com/login/oauth/access_token",
      "scopes": ["repo", "read:org"]
    }
  }]
}
```

**Auth types**: OAuth 2.0, API key  
**Auth timing**: Controlled by marketplace policy — `ON_INSTALL` or `ON_FIRST_USE`

---

### 5.4 Lifecycle Hooks

**Manifest pointer**: `"hooks": "./hooks/hooks.json"` (auto-discovered if not specified)

The `hooks` field accepts **four formats**:
1. Single path: `"./hooks/hooks.json"`
2. Array of paths: `["./hooks/session.json", "./hooks/tools.json"]`
3. Inline object
4. Array of inline objects

**Hook event schema**:
```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "python3 ${PLUGIN_ROOT}/hooks/session_start.py",
        "statusMessage": "Loading plugin context"
      }]
    }]
  }
}
```

**Supported events**: `SessionStart`, `TurnStarted`, `TurnCompleted`, `ToolCallRequested`, `ToolCallCompleted`

**Environment variables** available to hook commands:
| Variable | Description |
|----------|-------------|
| `PLUGIN_ROOT` | Installed plugin root path |
| `PLUGIN_DATA` | Plugin's writable data directory |
| `CLAUDE_PLUGIN_ROOT` | Compatibility alias |
| `CLAUDE_PLUGIN_DATA` | Compatibility alias |

**⚠️ Trust model**: Plugin hooks are **non-managed** — Codex skips them until the user explicitly reviews and trusts the hook definition. Installing a plugin does NOT auto-trust its hooks.

---

## 6. Distribution: The Marketplace System

### Marketplace JSON Structure

```json
{
  "name": "repo-marketplace",
  "interface": { "displayName": "Team Plugins" },
  "plugins": [
    {
      "name": "demo-plugin",
      "source": {
        "source": "local",
        "path": "./plugins/demo-plugin"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL",
        "products": ["codex-app", "codex-cli"]
      },
      "category": "Productivity"
    }
  ]
}
```

### Marketplace Scopes

| Tier | Location | Visibility |
|------|----------|------------|
| Official | OpenAI-hosted | Everyone |
| Repository | `$REPO_ROOT/.agents/plugins/marketplace.json` | Repo collaborators |
| Personal | `~/.agents/plugins/marketplace.json` | Current user |
| Legacy | `$REPO_ROOT/.claude-plugin/marketplace.json` | Cross-tool compat |

### Source Types

| Type | Format | Use Case |
|------|--------|----------|
| `local` | `"./relative/path"` | Same-repo plugins |
| `url` | Full HTTPS/SSH URL | Standalone plugin repos |
| `git-subdir` | URL + subdirectory path | Monorepo plugins |
| GitHub shorthand | `owner/repo[@ref]` | Quick references |

**Git-backed marketplace entry example:**
```json
{
  "name": "remote-helper",
  "source": {
    "source": "git-subdir",
    "url": "https://github.com/example/codex-plugins.git",
    "path": "./plugins/remote-helper",
    "ref": "main"
  },
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_INSTALL"
  },
  "category": "Productivity"
}
```

### Policy Controls

| Field | Values | Effect |
|-------|--------|--------|
| `policy.installation` | `AVAILABLE`, `PREINSTALLED`, `HIDDEN` | Discovery/auto-install behavior |
| `policy.authentication` | `ON_INSTALL`, `ON_FIRST_USE`, `NONE` | Auth timing |
| `policy.products` | string[] | Restrict to specific Codex surfaces |

### CLI Commands

```bash
# Marketplace management
codex plugin marketplace add owner/repo
codex plugin marketplace add ./local-path
codex plugin marketplace list
codex plugin marketplace upgrade
codex plugin marketplace remove <name>

# Plugin lifecycle
codex plugin install <plugin-name>
codex plugin enable <plugin-id>
codex plugin disable <plugin-id>
codex plugin remove <plugin-id>
codex plugin upgrade <plugin-id>
```

### Install Cache

Plugins install to:
```
~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/
```

- Local plugins: `$VERSION = "local"`
- Codex loads from **cache**, not source (enables offline use)
- Cache persists after uninstall (supports re-activation)
- Tracks `gitCommitSha` for version verification

### Plugin State

Controlled via settings files:
- User: `~/.codex/settings.json`
- Project: `./.codex/settings.json` (git-tracked)
- Local: `./.codex/settings.local.json` (gitignored)

```json
{
  "enabledPlugins": {
    "my-plugin@repo-marketplace": true,
    "experimental@personal": false
  }
}
```

---

## 7. Runtime Resolution Flow

```
                    ┌─────────────────────────────┐
                    │    .codex-plugin/plugin.json │
                    └──────────────┬──────────────┘
           ┌───────────┬──────────┼──────────┬──────────────┐
           ▼           ▼          ▼          ▼              ▼
      "skills"    "mcpServers"  "apps"    "hooks"     "interface"
      "./skills/" "./.mcp.json" ".app"   "./hooks/"   (metadata)
           │           │          │          │
           ▼           ▼          ▼          ▼
    ┌──────────┐ ┌─────────┐ ┌────────┐ ┌─────────┐
    │ Scan for │ │ Spawn   │ │Resolve │ │ Await   │
    │ SKILL.md │ │ process │ │ creds  │ │ user    │
    │ files    │ │ per     │ │(OAuth/ │ │ trust   │
    │          │ │ entry   │ │ APIkey)│ │ review  │
    └────┬─────┘ └────┬────┘ └───┬────┘ └────┬────┘
         ▼            ▼          ▼           ▼
    ┌──────────┐ ┌─────────┐ ┌────────┐ ┌─────────┐
    │ Index by │ │Register │ │Register│ │ Execute │
    │ name+desc│ │ tools   │ │ caps   │ │ command │
    │ for auto │ │ in agent│ │ as     │ │ on      │
    │ matching │ │         │ │ tools  │ │ event   │
    └──────────┘ └─────────┘ └────────┘ └─────────┘
```

**At install**: Files copied to cache → components registered  
**At runtime**: Enabled plugins loaded → skills indexed → MCP servers spawned → apps activated → trusted hooks armed

---

## 8. Ecosystem Comparison

| Dimension | Codex | Claude Code | Cursor | VS Code |
|-----------|-------|-------------|--------|---------|
| Model | Manifest-first | Manifest-first | IDE-native | Extension API |
| Manifest | `.codex-plugin/plugin.json` | `.claude-plugin/plugin.json` | N/A | `package.json` |
| Distribution | Git repos + cache | Git repos + cache | Central store | `.vsix` packages |
| Components | Skills + MCP + Apps + Hooks | Skills + MCP + Hooks + LSP | Extensions | Extensions |
| Offline | ✅ | ✅ | ❌ | ✅ |
| Cross-tool MCP | ✅ | ✅ | ✅ (consumer) | ❌ |

**Key insight**: MCP is the universal interop layer. A well-built MCP server works across Codex, Claude Code, and Cursor. The wrapping layer (marketplace metadata, skill definitions) is tool-specific, but the functional infrastructure is portable.

---

## 9. Minimal → Published Progression

### Absolute Minimum (Valid)
```json
{ "name": "my-plugin" }
```

### Minimal Functional
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Reusable greeting workflow",
  "skills": "./skills/"
}
```

### Published-Quality
All fields from §1 example, with particular attention to:
- `interface.privacyPolicyURL` and `termsOfServiceURL` (required for official directory)
- `interface.defaultPrompt` (max 3 × 128-char starter prompts)
- `interface.logo` and `screenshots` (marketplace presence)
- `author` with at least `name`
- `keywords` for discoverability

---

## 10. Key Takeaways

1. **Manifest-first is declarative** — no code runs at install time; JSON is inspectable and portable
2. **Only `name` is required** — start minimal, add complexity as needed
3. **Three-layer architecture** separates concerns: Skills (knowledge), Apps (auth), MCP (tools)
4. **Trust is explicit** — hooks don't auto-execute; users must review and approve
5. **Forward-compatible** — unknown keys survive SDK round-trips via `extra` maps
6. **Git-native distribution** — plugins live in repos; no compilation, no build step
7. **MCP is the portability layer** — same servers work across Codex, Claude Code, and Cursor

---

*Compiled from 3 parallel research tracks. Individual agent files available in `artifacts/research/codex-manifest-shape/`.*  
*Primary sources: [OpenAI Codex Docs](https://developers.openai.com/codex/plugins/build), [Codex SDK HexDocs](https://hexdocs.pm/codex_sdk/13-plugin-authoring.html), [HuggingFace Context Course](https://huggingface.co/learn/context-course/unit3/anatomy.md)*
