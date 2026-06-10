# AI-DLC for Claude Code

A Claude Code-native implementation of the **AI-DLC methodology** (AI-Driven Development Life Cycle). Run a full software-development lifecycle inside Claude Code: 11 domain-expert agents working through a 32-stage workflow, and you approve every gate.

![version](https://img.shields.io/badge/version-0.6.4-blue)
![license](https://img.shields.io/badge/license-MIT--0-green)
![Claude Code](https://img.shields.io/badge/Claude%20Code-required-orange)

## Methodology and implementation

**AI-DLC is a methodology** — a structured, gated approach to AI-driven software development, defined by AWS (see the [blog post](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/) and [method paper](https://prod.d13rzhkk8cj2z0.amplifyapp.com/) under [References](#references)). **This repository is its Claude Code-native implementation** — the methodology rendered as Claude Code skills, agents, hooks, and tools, so it runs natively inside Claude Code. The methodology is the *what*; this harness is the *how* for one runtime.

## Why AI-DLC

Ad-hoc AI coding works until the project gets real. Then context drifts between prompts, the reasoning behind a decision goes unrecorded, and the model quietly does something you never asked for. AI-DLC puts structure around the work: each stage has a clear owner, every decision passes an approval gate before the next one starts, and this implementation records what it learns from your corrections so it stops repeating them. The same engine runs a throwaway proof-of-concept and a regulated enterprise rollout — it just runs more of the stages, in more depth.

## Quick Start

### 1. Install prerequisites

This implementation needs just two things: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [bun](https://bun.sh). Every hook and CLI tool is TypeScript run via bun, so there's no jq/sed/awk or Git Bash requirement.

**macOS**

```bash
# Claude Code (native install — recommended; auto-updates)
curl -fsSL https://claude.ai/install.sh | bash
# bun
curl -fsSL https://bun.sh/install | bash
```

`bun` must be on your `PATH` for non-interactive shells — Claude Code sources `~/.zshenv` (zsh) or `~/.bashrc` (bash), **not** `~/.zshrc`. The bun installer appends to `~/.zshrc`; if `which bun` fails inside Claude Code, copy the `BUN_INSTALL`/`PATH` export into `~/.zshenv`. (Prefer Homebrew? `brew install --cask claude-code`.)

**Linux**

```bash
# Claude Code (native install — recommended; auto-updates)
curl -fsSL https://claude.ai/install.sh | bash
# bun
curl -fsSL https://bun.sh/install | bash
```

Add the bun `PATH` export to `~/.bashrc` (the file non-interactive bash sources) if `which bun` fails inside Claude Code.

**Windows** — use *either* PowerShell *or* Command Prompt (CMD), not both. Your prompt shows `PS C:\` in PowerShell and `C:\` (no `PS`) in CMD.

In **PowerShell**:

```powershell
# Claude Code (native install — recommended; auto-updates)
irm https://claude.ai/install.ps1 | iex
# bun
irm bun.sh/install.ps1 | iex
```

In **Command Prompt (CMD)**:

```batch
:: Claude Code (native install — recommended; auto-updates)
curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd
:: bun (bun ships only a PowerShell installer — invoke it from CMD)
powershell -c "irm bun.sh/install.ps1 | iex"
```

> If you see `The token '&&' is not a valid statement separator`, you're in PowerShell — use the PowerShell block. If you see `'irm' is not recognized…`, you're in CMD — use the CMD block.

Everything runs on native Windows — WSL is not required. [Git for Windows](https://git-scm.com/downloads/win) is recommended so Claude Code can use the Bash tool (without it, Claude Code uses PowerShell as its shell tool). If you use Git Bash, put the bun `PATH` export in `~/.bashrc`.

> Verify both are ready: `claude --version` and `where.exe bun`.

### 2. Set up your project

```bash
# Copy the implementation into your project
cp -r dist/claude/.claude/ your-project/.claude/

# Verify the setup
cd your-project && /aidlc --doctor

# Start a workflow — describe what you want to build
/aidlc Build a task management API with user authentication
```

The shipped `.claude/settings.json` runs on **AWS Bedrock** (`AWS_REGION=us-east-1`, Opus/Sonnet/Haiku pinned). Before your first run, enable Anthropic model access in your AWS account and have AWS credentials on your SDK credential chain — see [Getting Started § AWS Bedrock Setup](docs/guide/01-getting-started.md#aws-bedrock-setup) for the model-access form, IAM policy, credential options, and how to change the region. Not on Bedrock? The same section covers the Anthropic-API override.

> See [Getting Started](docs/guide/01-getting-started.md) for the full prerequisites table, PATH troubleshooting, and Bedrock/Anthropic-API model configuration.

## Key Features

- **[5 phases, 32 stages](docs/guide/03-phases-and-stages.md)** — Initialization, Ideation, Inception, Construction, Operation
- **[11 domain-expert agents](docs/guide/05-agents.md)** — product, design, delivery, architect, aws-platform, compliance, devsecops, developer, quality, pipeline-deploy, operations
- **[9 adaptive scopes](docs/guide/04-scopes-and-depth.md)** (enterprise through workshop) with auto-detection from freeform intent
- **[3 depth levels](docs/guide/04-scopes-and-depth.md#the-3-depth-levels)** (Minimal/Standard/Comprehensive) — control artifact detail per stage
- **[3 test strategy levels](docs/guide/04-scopes-and-depth.md#the-3-test-strategy-levels)** (Minimal/Standard/Comprehensive) — independent of depth for flexible test coverage
- **[CLI utilities](docs/guide/11-cli-commands.md)** — jump to any stage or phase, check status, change scope/depth/test strategy mid-workflow
- **[Approval gates at every stage](docs/guide/06-interaction-modes.md)** — you stay in control of all decisions
- **[Two-tier knowledge system](docs/guide/07-knowledge.md)** — methodology knowledge ships with the framework; team knowledge is user-managed
- **[Rules and a learning loop](docs/guide/08-rules-and-the-learning-loop.md)** — human corrections become persistent behavioral rules
- **[67-event audit trail](docs/guide/09-state-and-audit.md)** — structured logging for enterprise traceability
- **[Session resume](docs/guide/10-session-management.md)** — continue from checkpoint, redo, jump to stage, or start fresh

## Documentation

Three guides, one per reader — pick by what you're trying to change:

| | For | Covers |
|---|---|---|
| **[User Guide](docs/guide/00-introduction.md)** | Building software *with* AI-DLC | Getting started, workflows, scopes, agents, interaction modes, troubleshooting |
| **[Harness Engineer Guide](docs/harness/00-overview.md)** | Shaping *how* AI-DLC behaves | Stages, agents, scopes, rules, sensors, and team knowledge — configuration, not code |
| **[Developer Reference](docs/reference/00-overview.md)** | Changing AI-DLC *itself* | Architecture, orchestrator, stage protocol, hooks, state machine, testing, contributing |

## Testing

```bash
bash tests/run-tests.sh              # L1: smoke + unit + feature (no dependencies)
bash tests/run-tests.sh --ci         # L2: + integration + stage (requires claude CLI)
bash tests/run-tests.sh --release    # L3: + workflow (full acceptance)
```

See [Testing Reference](docs/reference/09-testing.md) for the full strategy and test registry.

## Contributing

See [Contributing Guide](docs/reference/11-contributing.md) for prerequisites, workflow, and submission process.

## References

- [AWS AI-DLC Blog Post](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)
- [AI-DLC Method Definition Paper](https://prod.d13rzhkk8cj2z0.amplifyapp.com/)
