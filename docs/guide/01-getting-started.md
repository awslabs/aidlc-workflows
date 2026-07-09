# Getting Started

This chapter walks you through installing this implementation, verifying your environment, and preparing for your first workflow.

---

## Prerequisites

This implementation requires two tools on your system:

| Prerequisite | Purpose | Install |
|-------------|---------|---------|
| **Claude Code** | This implementation runs as a Claude Code command. The orchestrator, agents, and hooks all execute within Claude Code. | Native install (recommended, auto-updates): macOS/Linux/WSL `curl -fsSL https://claude.ai/install.sh \| bash`; Windows PowerShell `irm https://claude.ai/install.ps1 \| iex`. Or `brew install --cask claude-code`. ([docs](https://code.claude.com/docs/en/quickstart)) |
| **bun** | Required for all CLI tools and all 12 hooks (state management, audit logging, sensor dispatch, runtime-graph compile, loop enforcement, reviewer scope enforcement, statusline, human-turn mint). Everything is TypeScript, run via bun (~20ms startup). No additional dependencies — works identically on macOS, Linux, and native Windows PowerShell. | `curl -fsSL https://bun.sh/install \| bash` ([docs](https://bun.sh)). On Windows: `npm install -g bun` or `powershell -c "irm bun.sh/install.ps1 \| iex"` |

> **Important**: `bun` must be on your `PATH` for non-interactive shells. Claude Code runs your shell non-interactively, so it sources `~/.zshenv` (zsh) or `~/.bashrc` (bash) — NOT `~/.zshrc`. On Windows with Git Bash, `~/.bashrc` is the correct file. If `which bun` fails inside Claude Code, add the bun PATH export to the appropriate file.

Verify prerequisites:

```bash
command -v claude >/dev/null && echo "✓ Claude Code installed" || echo "✗ Install Claude Code first"
command -v bun    >/dev/null && echo "✓ bun installed"          || echo "✗ Install bun first"
```

## AWS Bedrock Setup

This implementation ships configured for **AWS Bedrock**. The shipped `.claude/settings.json` sets:

| Variable | Value | Purpose |
|----------|-------|---------|
| `CLAUDE_CODE_USE_BEDROCK` | `1` | Routes Claude Code through Bedrock |
| `AWS_REGION` | `us-east-1` | Bedrock region — **required**; Claude Code does not read it from `~/.aws`. Override per-region (see below). |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | `global.anthropic.claude-fable-5[1m]` | Fable alias for users who opt into `fable`/`fable[1m]` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `global.anthropic.claude-opus-4-8[1m]` | Orchestrator model (used at `opus[1m]`, the 1M-context variant) |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `global.anthropic.claude-sonnet-4-6[1m]` | Subagent model |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `global.anthropic.claude-haiku-4-5-20251001-v1:0` | Background/fast tasks (no `[1m]`: Haiku 4.5 is a 200K model with no 1M variant) |

These model pins use global Bedrock inference profile IDs (the `global.` prefix). The `[1m]` suffix on the Fable, Opus, and Sonnet pins selects the 1M-context variant — so tier-pinned subagents (not just the `opus[1m]` orchestrator) get the 1M window; Claude Code strips the suffix before the model ID reaches Bedrock. You still need to do the AWS-account-side setup once.

### One-time AWS account setup (manual path)

1. **Enable Anthropic model access.** In the [Amazon Bedrock console](https://console.aws.amazon.com/bedrock/), open the **Model catalog**, select each Anthropic model you'll use (Fable, Opus, Sonnet, Haiku), and submit the use-case form. Access is granted immediately. This is required once per AWS account before any model can be invoked. (AWS Organizations can submit once from the management account; approval extends to child accounts.)

2. **Attach the IAM permissions** your role/user needs to invoke models and resolve inference profiles:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "AllowModelAndInferenceProfileAccess",
         "Effect": "Allow",
         "Action": [
           "bedrock:InvokeModel",
           "bedrock:InvokeModelWithResponseStream",
           "bedrock:ListInferenceProfiles",
           "bedrock:GetInferenceProfile"
         ],
         "Resource": [
           "arn:aws:bedrock:*:*:inference-profile/*",
           "arn:aws:bedrock:*:*:application-inference-profile/*",
           "arn:aws:bedrock:*:*:foundation-model/*"
         ]
       }
     ]
   }
   ```

3. **Provide AWS credentials.** Claude Code uses the default AWS SDK credential chain. Any one of:

   ```bash
   aws configure                         # static access key / secret
   # — or — an SSO profile:
   aws sso login --profile <your-profile>
   export AWS_PROFILE=<your-profile>
   # — or — credentials already exported in your environment (AWS_ACCESS_KEY_ID, etc.)
   ```

   Keep secrets out of the shared `settings.json`. Put `AWS_PROFILE` (or other env you don't want to leak) in `.claude/settings.local.json` (gitignored) instead.

4. **Set your region** if it isn't `us-east-1`. The shipped default is `us-east-1`; override it without editing shared config:

   ```bash
   cp .claude/settings.local.json.example .claude/settings.local.json
   # then add  "AWS_REGION": "<your-region>"  to the env block
   ```

   `settings.local.json` takes precedence over `settings.json`. Confirm the model is available in your region with `aws bedrock list-inference-profiles --region <your-region>`.

> **Easier path:** instead of the manual steps above, run `claude`, choose **3rd-party platform → Amazon Bedrock** at the login prompt, and the wizard detects your credentials, region, and accessible models and writes them to your user settings. Re-run `/setup-bedrock` any time to change them. You still complete step 1 (model access) once in the console.

For the authoritative, always-current setup — IAM detail, SSO refresh, inference profiles, troubleshooting — see the AWS guide: **[Claude Code on Amazon Bedrock: Quick Setup Guide](https://community.aws/content/2tXkZKrZzlrlu0KfH8gST5Dkppq/claude-code-on-amazon-bedrock-quick-setup-guide)** and the [Amazon Bedrock documentation](https://docs.aws.amazon.com/bedrock/).

## MCP Servers (optional)

This implementation declares its MCP servers in `.mcp.json` at the project root (beside `.claude/`). Claude Code provisions them to the session, and every AI-DLC agent inherits all of them — so any agent can reach any declared server with no per-agent grant. The shipped `.mcp.json` declares five MCP servers:

| Server | Provides | Transport | Credentials |
|--------|----------|-----------|-------------|
| `context7` | Library/SDK documentation lookups | HTTP | `CONTEXT7_API_KEY` from your environment |
| `aws-mcp` | AWS API access | `uvx` (`mcp-proxy-for-aws@latest`, `AWS_REGION=us-east-1`) | Standard AWS credential chain |
| `aws-pricing` | AWS pricing queries | `uvx` (`awslabs.aws-pricing-mcp-server@latest`) | AWS credential chain |
| `aws-iac` | Infrastructure-as-code tooling | `uvx` (`awslabs.aws-iac-mcp-server@latest`) | AWS credential chain |
| `aws-serverless` | Serverless tooling | `uvx` (`awslabs.aws-serverless-mcp-server@latest`) | AWS credential chain |

### Prerequisites

The four AWS servers launch through `uvx`. Install `uv`/`uvx` once:

```bash
curl -fsSL https://astral.sh/uv/install.sh | sh
```

`context7` is an HTTP server and needs no local install. To use it, export an API key:

```bash
export CONTEXT7_API_KEY=<your-key>
```

Put `CONTEXT7_API_KEY` (and any other secret env) in `.claude/settings.local.json` (gitignored) rather than the shared `settings.json`. `.mcp.json` itself carries only the env-var placeholder — no secrets are committed.

### What becomes available

The four AWS servers authenticate with the same default AWS SDK credential chain Claude Code already uses for Bedrock (see [AWS Bedrock Setup](#aws-bedrock-setup)). Once `uvx` is installed and AWS credentials resolve, those servers come up automatically; `context7` comes up once `CONTEXT7_API_KEY` is set. Because the servers are inherited at the session level, every agent reaches every declared server — there is no per-agent grant to perform.

> **Restricting an agent (advanced):** inheritance is additive — declaring a server makes it available to all agents, and you cannot grant servers per-agent. To *prevent* a specific agent from using a server, narrow that agent's `tools:` allowlist to the fully-qualified `mcp__<server>__<tool>` ids it may call (a bare `mcp__<server>` token is not honoured). See [Agents](06-agents.md) for how agent tool access works.

### Not using these?

Missing credentials are not blocking. A server you have no credentials for — no AWS chain, no `CONTEXT7_API_KEY` — is simply unavailable; the workflow runs without it and never stalls waiting on it. To drop a server entirely, remove its entry from `.mcp.json`.

---

## Installation

AI-DLC installs by copying its distribution for your harness into your project. The steps below cover **Claude Code** (the `dist/claude/.claude/` tree). Running Kiro or Codex? Each ships its own distribution and install steps — see [Running on Kiro IDE](harnesses/kiro-ide.md) or [Running on Codex CLI](harnesses/codex-cli.md). The Claude Code implementation ships as a `.claude/` directory that you copy into your project.

### Step 1: Copy the implementation

```bash
cp -r dist/claude/.claude/ your-project/.claude/
cp -r dist/claude/aidlc/   your-project/aidlc/     # the workspace shell — a sibling of .claude/, not inside it
```

The first line copies the engine — the orchestrator, stage files, agent personas, hooks, knowledge files, and default settings. The second copies the **workspace shell**: the pre-built `aidlc/spaces/default/memory/` method tree the engine reads. It ships as a **sibling** of `.claude/` (not inside it), so it must be copied separately — or copy the whole `dist/claude/` tree at once. `/aidlc --doctor` fails its "workspace shell ready" check if `aidlc/spaces/default/memory/` is missing.

### Step 2: Navigate to your project

```bash
cd your-project
```

All `/aidlc` commands run relative to the project root.

---

## The Workspace Shell

There is no scaffold step. The distribution you copied in already ships the
workspace shell — the `.claude/` engine plus a pre-built `aidlc/spaces/default/`
holding the memory layer (`aidlc/spaces/default/memory/`, where team-affirmed
practices and learnings live). You do not run any init command.

The first time you run `/aidlc` (or describe what to build), the engine
**auto-births** the first intent into the active space. Each intent gets its own
record dir at `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`, which holds:

- `aidlc-state.md` — the per-intent workflow state
- `audit/` — the audit trail, written as per-clone shards (`<host>-<clone>.md`)
- `<phase>/<stage>/...` — the stage artifacts (e.g. `inception/requirements-analysis/requirements.md`)

Team knowledge lives one level up, at the space level —
`aidlc/spaces/<space>/knowledge/` (a sibling of `intents/`) — so it accumulates
across every intent in the space. The engine creates it empty; you add free-form
files under an optional `aidlc-shared/` and per-agent subdirectories.

To add [team knowledge](08-knowledge.md) or team practices before your first run,
edit the shipped `aidlc/spaces/default/memory/` files; the space-level
`aidlc/knowledge/` directory is created (empty) once your first `/aidlc` runs.

For the full picture of the workspace layout — how it holds many intents at once,
what spaces are for, and the commands to move between them — see
[Spaces and Intents](03-spaces-and-intents.md).

---

## Verify the Setup

Run the health check to confirm everything is in place:

```
/aidlc --doctor
```

`--doctor` exits 0 when every check passes and 1 when any check fails; the full report writes to stdout in both cases.

### What `--doctor` checks

| Check | What It Validates |
|-------|-------------------|
| Prerequisites | `bun` is installed and on `$PATH` |
| Hook presence | Every hook `settings.json` wires (its `hooks` blocks + the `statusLine` command — all 12 framework hooks) exists in `.claude/hooks/`; a wired-but-missing hook fails loudly. Sourcing the expected roster from `settings.json` means adding a hook there auto-checks it |
| Project structure | `.claude/settings.json` exists with expected configuration |
| Workspace shell | `.claude/` + `aidlc/spaces/default/memory/` are present (the shipped shell) |
| State file | the active intent's `aidlc-state.md` matches its audit trail (no drift) |
| Hook heartbeats | `.aidlc-hooks-health/` contains recent timestamps from hook executions |
| Graph integrity | No cycles in `stage-graph.json`; every slug has a matching stage file |
| Scope validation | All 9 scopes walk cleanly against the graph (advisories for scope-truncation gaps are expected) |
| Schema + references | Every stage's YAML frontmatter validates, and every consumes/requires_stage reference resolves |
| Keyword overlap | No keyword is claimed by more than one scope across the `.claude/scopes/*.md` files |
| Pending-compose marker | Reports a present `aidlc/.aidlc-compose-pending` (the in-flight compose gate marker) with its age. Fresh (under 24h, the normal state at an open compose gate) passes as advisory; stale (a crashed compose gate stranded it) fails. Silent when absent. Remediation: delete it if no compose gate is pending, or resolve the gate |

### Example output

```
✓ bun installed (required for CLI tools and hooks)
✓ aidlc-audit-logger.ts present
✓ aidlc-sync-statusline.ts present
✓ aidlc-validate-state.ts present
✓ aidlc-log-subagent.ts present
✓ aidlc-session-start.ts present
✓ aidlc-session-end.ts present
✓ aidlc-statusline.ts present
✓ settings.json present
✓ AWS_AIDLC_DEFAULT_SCOPE (unset — no project default)
✓ workspace shell ready (.claude/ + aidlc/spaces/default/memory/)
✓ Hook heartbeats: not yet fired (first workflow stage will populate)
✓ State matches last audit event (no drift)
✓ Cycle detection: 0 cycles
✓ Orphan stage files: 32 graph entries all have files
✓ Scope validation: 9 scopes valid (29 advisories)
✓ Schema validation: 32/32 stages valid
✓ Graph references: 122 artifacts + edges resolved
✓ Keyword overlap: no conflicts
```

### Fixing failures

| Failure | Fix |
|---------|-----|
| `bun` not installed | Install via `curl -fsSL https://bun.sh/install \| bash`. On Windows: `npm install -g bun` or `powershell -c "irm bun.sh/install.ps1 \| iex"`. Ensure it is on PATH for non-interactive shells. |
| Hook not present | Re-copy the `.claude/` directory from the distribution |
| `settings.json` missing | Re-copy from the distribution: `cp dist/claude/.claude/settings.json .claude/settings.json` |
| Workspace shell missing | Re-copy the workspace shell from `dist/claude/` into your project root |
| State file issues | Archive the active intent's record dir under `aidlc/spaces/<space>/intents/` and run `/aidlc` to start fresh |
| Graph/scope/schema/keyword failures | The diagnostic reports the specific artifact, slug, or scope name at fault. These indicate authoring drift in `.claude/aidlc-common/stages/` or `.claude/scopes/`; regenerate the compiled graph + scope grid with `bun .claude/tools/aidlc-graph.ts compile` or inspect the named stage/scope directly. |

---

## Start Your First Workflow

Once `--doctor` passes, you are ready to run:

```
/aidlc Build a REST API for inventory management
```

Or specify a scope directly:

```
/aidlc feature
/aidlc bugfix Fix the login timeout issue
```

See [Your First Workflow](02-your-first-workflow.md) for a step-by-step walkthrough of what happens next.

---

## Quick Reference

In your shell:

```bash
# Verify prerequisites
command -v claude >/dev/null && echo "✓ Claude Code" || echo "✗ Claude Code"
command -v bun    >/dev/null && echo "✓ bun"          || echo "✗ bun"

# Install (engine + the workspace shell sibling)
cp -r dist/claude/.claude/ your-project/.claude/
cp -r dist/claude/aidlc/   your-project/aidlc/

# Launch Claude Code in your project
cd your-project && claude
```

Inside the Claude Code session:

```
# Verify (exits 1 on any check failure; read stdout for the full report)
/aidlc --doctor

# Start
/aidlc Build a task management API with user authentication
```

---

## Tool Permissions

The included `.claude/settings.json` pre-approves Claude Code tools (Read, Edit, Write, Bash, Glob, Grep, Task, WebSearch) so workflows run without per-call permission prompts. Review this file before use and adjust to your security requirements.

See [Customization](13-customization.md) for details on modifying tool permissions.

---

## Next Steps

- [Your First Workflow](02-your-first-workflow.md) — annotated walkthrough of a complete run
- [Scopes, Depth, and Test Strategy](05-scopes-and-depth.md) — choosing the right scope for your task
- [Troubleshooting](15-troubleshooting.md) — common issues and fixes
- [Glossary](glossary.md) — terminology reference
