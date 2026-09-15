# AI-DLC Documentation

AI-DLC is a structured, gated methodology for AI-driven software development.
This repository runs it natively in Claude Code, Kiro CLI, Kiro IDE, Codex CLI,
Cursor, opencode, and GitHub Copilot.

## Quick Start

### 1. Install

macOS, Linux, or WSL:

```bash
curl -fsSL https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.ps1 | iex
```

The native installer includes every harness runtime and does not require Bun or
Node.js.

### 2. Configure

Run from your project root:

```bash
aidlc config --harness claude
aidlc doctor
```

Replace `claude` with `kiro`, `kiro-ide`, `codex`, `cursor`, `opencode`, or
`copilot`. A bare `aidlc config` starts the interactive setup.

### 3. Start

Open the configured harness and describe the work:

```text
/aidlc Build a REST API for inventory management
```

Codex CLI uses `$aidlc`. See [Getting Started](guide/01-getting-started.md) for
provider setup, trust prompts, project refreshes, and the first workflow.

## Choose Your Harness

| Harness | Guide |
| --- | --- |
| Claude Code | [Getting Started](guide/01-getting-started.md) |
| Kiro CLI | [Running AI-DLC on Kiro CLI](guide/harnesses/kiro-cli.md) |
| Kiro IDE | [Running AI-DLC on Kiro IDE](guide/harnesses/kiro-ide.md) |
| Codex CLI | [AI-DLC on Codex CLI](guide/harnesses/codex-cli.md) |
| Cursor | [AI-DLC on Cursor](guide/harnesses/cursor.md) |
| opencode | [AI-DLC on opencode](guide/harnesses/opencode.md) |
| GitHub Copilot | [AI-DLC on GitHub Copilot](guide/harnesses/copilot.md) |

## Choose Your Guide

| Guide | Use it when |
| --- | --- |
| [User Guide](guide/00-introduction.md) | Building software with AI-DLC |
| [Workflow Profiles](guide/workflow-profiles.md) | Choosing Classic, Express, or a focused workflow |
| [Install and Lifecycle](guide/18-install-and-lifecycle.md) | Updating, pinning, installing offline, using mirrors, or uninstalling |
| [Harness Engineer Guide](harness-engineering/00-overview.md) | Reshaping stages, agents, scopes, rules, sensors, or knowledge |
| [Developer Reference](reference/00-overview.md) | Changing the engine, hooks, packaging, or test suite |

## Development

Maintainers author in `core/` and `harness/`. Generated `dist/` and
`dist-release/` trees are local outputs and must not be hand-edited.

See the [Contributing Guide](reference/11-contributing.md) for the development
workflow and [Porting to a New Harness](harness-engineering/09-porting-to-a-new-harness.md)
to add another runtime.
