# Getting Started

This guide takes you from installation to a verified first workflow. The native
installer includes every supported harness runtime and does not require Bun or
Node.js.

## Quick Start

### 1. Install AI-DLC

macOS, Linux, or WSL:

```bash
curl -fsSL https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.ps1 | iex
```

The installer adds the native `aidlc` command and every harness runtime. If a
new shell cannot find `aidlc`, apply the PATH instruction printed by the
installer.

If you prefer to manage the project files manually, install the matching
native `aidlc` command, download `aidlc-runtime-X.Y.Z.tar.gz` from the
[release](https://github.com/awslabs/aidlc-workflows/releases/latest), and copy
`runtime/<harness>/` into the project.

### 2. Configure a project

From the project root:

```bash
cd /path/to/your-project
aidlc config --harness claude
aidlc doctor
```

Replace `claude` with the harness you use:

| Harness | Config value | Open | Invoke |
| --- | --- | --- | --- |
| Claude Code | `claude` | `claude` | `/aidlc` |
| Kiro CLI | `kiro` | `kiro-cli chat` | `/aidlc` |
| Kiro IDE | `kiro-ide` | Open the project | `/aidlc` |
| Codex CLI | `codex` | `codex` | `$aidlc` |
| Cursor | `cursor` | Open Cursor or run `agent` | `/aidlc` |
| opencode | `opencode` | `opencode` | `/aidlc` |
| GitHub Copilot CLI >= 1.0.74 / VS Code >= 1.130 | `copilot` | Copilot CLI or VS Code | `/aidlc` |

A bare `aidlc config` starts the interactive setup when a terminal is
available. It detects installed harnesses, provider state, runtime needs, and
trust actions before writing anything.

### 3. Start the first workflow

Open the configured harness in the project and describe the work:

```text
/aidlc Build a REST API for inventory management
```

Codex CLI uses:

```text
$aidlc Build a REST API for inventory management
```

AI-DLC selects a workflow profile from the request. You can also choose one:

```text
/aidlc express
/aidlc feature Add customer notifications
/aidlc bugfix Fix the login timeout
```

See [Workflow Profiles](workflow-profiles.md) for the available workflows and
[Your First Workflow](02-your-first-workflow.md) for an annotated walkthrough.

## Harness Prerequisites

Install and authenticate the host harness before opening it. The native AI-DLC
runtime itself does not require Git, Bun, or Node.js, but host requirements
still apply.

| Harness | Important first-run requirement | Guide |
| --- | --- | --- |
| Claude Code | Configure a supported provider; the shipped default is Amazon Bedrock | [Claude setup below](#aws-bedrock-setup) |
| Kiro CLI >= 2.6 | Sign in with `kiro-cli login` | [Kiro CLI](harnesses/kiro-cli.md) |
| Kiro IDE | Sign in and open the configured project | [Kiro IDE](harnesses/kiro-ide.md) |
| Codex CLI >= 0.145.0 | Use a Git repository and approve project hook trust | [Codex CLI](harnesses/codex-cli.md) |
| Cursor | Sign in to the IDE or CLI | [Cursor](harnesses/cursor.md) |
| opencode >= 1.17 | Configure the session provider globally | [opencode](harnesses/opencode.md) |
| GitHub Copilot | Trust the project folder; use GitHub sign-in or BYOK | [GitHub Copilot](harnesses/copilot.md) |

## AWS Bedrock Setup

The Claude Code distribution ships configured for Amazon Bedrock. Codex also
ships with a Bedrock provider default; other harnesses use their own provider
configuration.

### Why Bedrock is the default

AI-DLC needs a predictable runtime baseline across the conductor and its
tier-pinned subagents. Bedrock lets the distribution pin exact global inference
profiles and context variants, avoiding silent model-alias differences between
machines. It also uses the standard AWS SDK credential chain and IAM controls,
so teams do not need to commit provider keys to a project.

This is a distribution default, not a methodology requirement. AI-DLC does not
call the Bedrock API directly and remains provider-independent.

### Configure Bedrock

Before the first Claude Code run:

1. Enable access to the configured Anthropic models in the Amazon Bedrock model
   catalog.
2. Provide AWS credentials through the normal SDK credential chain, for example
   `aws configure` or `aws sso login --profile <profile>`.
3. Use a region where those models are available. The shipped default is
   `us-east-1`.
4. Start `claude` and choose Amazon Bedrock at the provider prompt. You can run
   `/setup-bedrock` later to change the account or region.

The shipped Claude settings map these aliases:

| Setting | Default |
| --- | --- |
| `CLAUDE_CODE_USE_BEDROCK` | `1` |
| `AWS_REGION` | `us-east-1` |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | `global.anthropic.claude-fable-5[1m]` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `global.anthropic.claude-opus-4-8[1m]` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `global.anthropic.claude-sonnet-4-6[1m]` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `global.anthropic.claude-haiku-4-5-20251001-v1:0` |

Keep credentials and personal overrides out of the shared
`.claude/settings.json`. Put them in `.claude/settings.local.json` or the
standard AWS credential files.

To use another Claude Code-supported provider, remove or replace the Bedrock
environment mappings in `.claude/settings.json` and any higher-precedence
`.claude/settings.local.json`, then complete that provider's Claude Code
authentication flow. See the
[Claude Code authentication guide](https://code.claude.com/docs/en/authentication).

For IAM detail, model access, SSO, and regional troubleshooting, see
[Claude Code on Amazon Bedrock](https://community.aws/content/2tXkZKrZzlrlu0KfH8gST5Dkppq/claude-code-on-amazon-bedrock-quick-setup-guide)
and the [Amazon Bedrock documentation](https://docs.aws.amazon.com/bedrock/).

## MCP Servers (optional)

Claude projects can install the shipped MCP defaults during config:

```bash
aidlc config --harness claude --mcp defaults
```

Use `--mcp none` to omit them. The default set is:

| Server | Provides | Credentials |
| --- | --- | --- |
| `context7` | Library and SDK documentation | `CONTEXT7_API_KEY` |
| `aws-mcp` | AWS API access | AWS credential chain |
| `aws-pricing` | AWS pricing queries | AWS credential chain |
| `aws-iac` | Infrastructure-as-code tools | AWS credential chain |
| `aws-serverless` | Serverless development tools | AWS credential chain |

The four AWS servers require `uvx` and use the standard AWS credential chain.

Every agent in the Claude session inherits available MCP servers. Missing
credentials make a server unavailable but do not block a workflow. Never put
secrets in the committed `.mcp.json`.

## Configuration and Trust

`aidlc config` is local-only and transactional. It writes the selected harness
runtime, creates the `aidlc/` workspace, merges managed project integrations,
and records an ownership baseline for later refreshes.

Preview any change:

```bash
aidlc config --dry-run
```

After config, complete any action named in its output:

| Harness | Typical action |
| --- | --- |
| Claude Code | Approve project hooks through `/hooks`, then restart Claude Code |
| Kiro CLI | Start `kiro-cli chat`; the project selects the AI-DLC agent |
| Kiro IDE | Open the configured project |
| Codex CLI | Approve the hook trust prompt or apply the generated trust seed |
| Cursor | Open the configured project or run `agent` |
| opencode | Start `opencode` in the project |
| GitHub Copilot | Trust the project folder |

Run `aidlc doctor` after completing the action. It reports runtime, project,
provider, hook, trust, and workflow-state problems with a remediation command.

## Updating

`aidlc update` updates the machine runtime. It does not rewrite configured
projects. Refresh each project between workflows:

```bash
aidlc update
cd /path/to/your-project
aidlc doctor
aidlc config
```

Config preserves project-owned content and refuses to refresh while a workflow
is active. Projects using plugins should run `/aidlc plugin sync` after an
engine refresh.

For version selection, project pins, offline installation, mirrors, custom CAs,
release authentication, automation, and uninstall, see
[Install and Lifecycle](18-install-and-lifecycle.md).

## What Config Creates

A configured project contains the harness integration plus an `aidlc/`
workspace. The first workflow creates an intent record under:

```text
aidlc/spaces/<space>/intents/<YYMMDD>-<label>/
```

That record contains workflow state, audit shards, questions, decisions, and
stage artifacts. Team knowledge and learned rules live at the space level so
later intents can reuse them.

See [Spaces and Intents](03-spaces-and-intents.md) for the layout and
[State and Audit](10-state-and-audit.md) for the recorded evidence.

## Troubleshooting

Start with:

```bash
aidlc doctor
```

Then use [Troubleshooting](15-troubleshooting.md) for hooks, provider access,
approval gates, stale state, and diagnostics. Harness-specific setup problems
belong in the matching [harness guide](harnesses/README.md).

## Next Steps

- [Workflow Profiles](workflow-profiles.md) - choose the right workflow
- [Your First Workflow](02-your-first-workflow.md) - follow a complete run
- [Spaces and Intents](03-spaces-and-intents.md) - understand project state
- [Interaction Modes](07-interaction-modes.md) - work with questions and gates
- [Install and Lifecycle](18-install-and-lifecycle.md) - manage the native runtime
