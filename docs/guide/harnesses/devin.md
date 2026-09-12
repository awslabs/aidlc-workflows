# AI-DLC on Devin CLI

The Devin CLI integration is authored in `core/` and `harness/devin/`. The shared engine is projected with Devin-specific configuration, skills, and a hook adapter; shared source does not imply identical host behavior. `bun scripts/package.ts` generates local `dist/devin/` and `dist-release/devin/` outputs. Never hand-edit or commit generated distributions.

## Prerequisites

- **Devin CLI ≥ 3000.10.21** — the selected AIDLC support baseline, shared by
  config diagnostics and `/aidlc --doctor`. This baseline does not claim that
  every required capability first appeared in this release. Check with
  `devin --version`.
- **Runtime** — a native AI-DLC installation uses the self-contained `aidlc` executable and does not require a separate Bun or Node.js installation. Source-copy tools and hooks under `dist/devin/` require Bun, including in the non-interactive hook environment. Select a release or local build that includes Devin support; this guide does not establish that the latest published asset contains PR #996.
- **Model & environment (user-level)** — model/env/effort are user-level on
  Devin, NOT in the project config. Set your model in
  `~/.config/devin/config.json` (or `%APPDATA%\devin\config.json` on Windows).
- **MCP servers (optional)** — `.devin/mcp_config.json` bundles the same five
  servers as Kiro: `context7`, `aws-mcp`, `aws-pricing`, `aws-iac`, and
  `aws-serverless`. All five MCP servers are disabled by default. Disabled
  registrations provide no tools to the session and do not start server
  processes. MCP availability is not a prerequisite for an AIDLC workflow.

## Install

For a native build containing Devin support, follow [Getting Started](../01-getting-started.md) and [Install and Lifecycle](../18-install-and-lifecycle.md), then run from the project root:

```bash
aidlc config --harness devin
aidlc doctor
```

A fresh project may fail the hook execution-evidence check until a real Devin SessionStart runs; follow the next section rather than creating a marker yourself.

For source development, use the checkout containing the Devin changes and run `bun scripts/package.ts` before consuming `dist/devin/`. A fresh clone has no committed distribution to copy. The copy projection requires Bun; the native release projection uses the installed `aidlc` executable. Do not mix their hook commands or permission grants.

The project layout needs both `.devin/` and its sibling `aidlc/` workspace, plus the generated root `AGENTS.md` and `.gitignore` integration. Copy the whole generated copy tree only into a fresh test project. For existing projects, use the installation/refresh mechanism or carefully merge framework-owned content while preserving user configuration, local policy, and workspace records. Never overwrite an existing project's root files blindly.

Apply the shipped ignore rules before running a workflow. Audit shards are deliberately versioned; personal configuration, per-user cursors, and machine-local runtime evidence are not.

## Approve hooks

Devin may prompt to approve project hooks on first run. Inspect the loaded
hooks via `/hooks` — per the official
[hooks reference](https://docs.devin.ai/cli/extensibility/hooks/overview),
`/hooks` lists the currently loaded hooks and their source files — approve the
AI-DLC hooks if prompted, then **fully restart Devin CLI** (`/clear` is not
enough for this setup procedure). The SessionStart adapter records
each successful run in `.devin/.aidlc-session-start.local.json` (gitignored,
machine-local); `/aidlc --doctor` fails when that evidence is absent or
invalid. A valid marker is historical execution evidence only — it does not
verify current hook approval, that every hook/gate works, or that approval was
not later revoked.

## Optional MCP setup

Review the server you want to use and supply its prerequisites before enabling
it. In `.devin/mcp_config.json`, change only that entry's `"disabled": true` to
`"disabled": false`. Leave unused servers disabled; the registry already ships
with the installation, so there is no separate example file to copy.

Alternatively, use the native project-scoped commands:

```bash
devin mcp enable -s project context7
devin mcp disable -s project context7
devin mcp list
```

The enable and disable commands are alternatives for the desired state, not
steps to run together. `/mcp` shows MCP status. After changing settings, restart
the session if needed before verifying the selected server. Live MCP
verification is optional and does not gate an AIDLC workflow.

- **Context7** — the existing HTTP header uses the literal placeholder
  `${CONTEXT7_API_KEY}`. When opting in, supply `CONTEXT7_API_KEY` securely
  through the environment or private local configuration. Never commit a
  literal key or put it in shell history. The shipped placeholder is a configuration string, not proof of interpolation; verify the current host's header substitution behavior when enabling the server.
- **AWS servers** — install `uvx` and the chosen package's supported Python
  runtime, and supply appropriate AWS credentials and permissions when enabled.
  The shipped AWS proxy endpoint and metadata retain `us-east-1`; review them
  for your account. Missing credentials are not a substitute for `disabled: true`.
- **Package versions** — the four `@latest` launchers are retained to match
  Kiro. Enabling a server can resolve a changing third-party package version;
  default-off behavior is not dependency pinning or a supply-chain lock. You
  may pin your own enabled configuration to reviewed versions.
- **Permissions** — MCP tool calls are not blanket-pre-approved. Enabling a
  server and approving its tools are separate decisions; approve only the tools
  or servers you intend to use, subject to Devin's effective permission mode
  and user/team policies.

The project registry `.devin/mcp_config.json` is shared with the team. Keep
personal MCP settings and credentials in `.devin/mcp_config.local.json` and
keep that file gitignored. User-wide MCP configuration lives in
`~/.config/devin/mcp_config.json` (`%APPDATA%\devin\mcp_config.json` on Windows).
Use personal settings for individual choices without changing shared defaults;
inspect local and user configurations when checking the effective server state.

**Existing installs:** these flags apply to the shipped defaults, not an
automatic migration. Before replacing or merging configuration, preserve custom
server entries and deliberate enablement choices. To adopt default-off behavior
in an existing install, explicitly set `disabled: true` on the relevant entries
and inspect local/user overrides. Do not delete your configurations.

## Use

Invoke the orchestrator with `/aidlc` followed by a scope or description — same
commands as the Claude harness (`/aidlc --status`, `/aidlc --help`, …). Stage
runners are explicit-only: `/aidlc-domain-design`, `/aidlc-bugfix`, etc.

## What's different on Devin

- **No custom statusline** — Devin has no `statusLine`/`status_bar` config
  field. Run `/aidlc --status` on demand for the current phase, stage, progress,
  and cost.
- **Welcome message** — delivered via the SessionStart hook's
  `additionalContext` (Devin has no equivalent broadcast field).
- **Structured gates** — render via Devin's native `ask_user_question` tool
  (per `question-rendering.md`). Gate semantics live in the engine.
- **Subagent dispatch** — the ensemble protocol uses `run_subagent` with a named `profile` and native task text. Current native-field translation, reviewer attribution, and background completion have [known limitations](../../reference/research/devin/07-subagent-lifecycle-and-ensemble.md); hook registration alone does not establish complete support. Shipped AI-DLC custom profiles
  carry no `model:` and use the **default subagent model**, not automatic
  inheritance of the parent's model. The documented Subagent router default is
  SWE-1.6; an org/enterprise admin can select another model in **Default
  subagent model**, or **None** to disable subagents. The default can coincide
  with the parent's selected model. Custom profiles can also pin `model:`;
  AI-DLC does not project those overrides. `/aidlc --doctor` warns about the
  shipped policy but does not inspect the effective organization
  setting/model. See
  [Devin model resolution](https://docs.devin.ai/cli/subagents#which-model-does-a-subagent-use).
- **Subagent tool restriction** — the Devin projection adds an explicit
  `allowed-tools` list to every shipped core agent profile, excluding
  `run_subagent`, `read_subagent`, and `skill`; the parent conductor owns
  dispatch. This enforces direct tool exclusion independently of the default
  nesting depth. The retained `disallowedTools: Task` metadata is for other
  harnesses and is not the Devin enforcement mechanism. Devin documents
  `allowed-tools` as a restrictive list (all tools when omitted; `tools` is an
  alias), and always withholds `ask_user_question` from subagents. Shell and
  external-service behavior still depend on host permissions; this is not a
  general sandbox. This profile-level tool availability is distinct from the
  project permission auto-approval list in `.devin/config.json`. See
  [Devin profile fields](https://docs.devin.ai/cli/subagents#frontmatter-fields).
- **Method ambient context** — `.devin/rules/aidlc.md` has `trigger: always_on` and provides a short pointer to active-space memory. It does not import the pointed-to files. AI-DLC's resolver loads the actual method from `aidlc/spaces/<space>/memory/`.
- **Hook wiring** — `.devin/hooks.v1.json` is the hooks object itself, without a `hooks` wrapper. Seven lifecycle kinds route through the adapter. `fold-usage` has no registration because a supported Claude-style transcript usage source was not established for Devin; do not infer complete token/cost accounting from generic reporting commands.
- **Permissions** — `.devin/config.json` pre-approves reads, edits, writes,
  search, subagent dispatch, structured questions, web search, and web fetch.
  Copy installs pre-approve `bun .devin/tools/*`, `bun run .devin/tools/*`, and
  `date -u`; native installs pre-approve the installed `aidlc engine` command
  prefix and `date -u`. General Bun, Git, Node, npm, npx, and uvx commands are
  not blanket-pre-approved. Personal overrides live in
  `.devin/config.local.json` and `.devin/mcp_config.local.json` (both
  gitignored).

### Permission and guard boundaries

The shipped configuration uses an allow-list only; it does not enforce a
general prohibition on destructive commands. Removing the previous deny rules
also removes their explicit restrictions on `sudo`, matching `rm -rf` commands,
and matching `.env*` writes. An unmatched operation follows Devin's effective
permission mode and other configured rules; absence from the allow-list is not
an unconditional denial.

AI-DLC guard hooks implement workflow-specific checks for state transitions, review scope, frozen review artifacts, and approval before code generation. Enforcement depends on the adapter's supported tools, payloads, identity, and error paths; in particular, reviewer-specific native read/search enforcement is not established. These are not a general destructive-command security boundary or a replacement for Devin permission policies, organization controls, or OS sandboxing. Inspect project hooks via `/hooks`, approve them if prompted, and fully restart Devin CLI to collect execution evidence.

The allow-only shape and broad file-tool grants follow Claude Code;
framework-scoped shell grants follow both Claude Code and Kiro CLI. This does
not copy Kiro's explicit recursive-`rm` and `git push` denials. The
`read_config_from` settings for Cursor, Windsurf, and Claude remain `false`
intentionally.

For existing installs, review the generated configuration before applying or
merging it. Preserve deliberate local/team policy; local or user-level grants
may still pre-approve commands or MCP tools removed from these shipped
defaults. No workflow-record migration is required.

## Known limitations and upgrade checks

The [Devin engineering findings](../../reference/research/devin/index.md) distinguish implemented behavior from open acceptance gaps. Native dispatch field translation, reviewer-specific read/search identity, and background terminal bookkeeping need additional work/evidence; a configured hook or completion row does not establish these guarantees. Question-response compatibility does not make an unknown or skipped choice an approval. Desktop binary discovery is not verified Desktop execution, and a version check is not a full workflow certification.

Use the [regression and evidence checklist](../../reference/research/devin/14-regression-and-evidence.md) when AI-DLC or Devin changes. Historical runs and synthetic fixtures retain their original scope; this documentation does not claim a fresh interactive acceptance run.

## Git integration

Same as every harness — commit the `aidlc/` workspace tree (state, audit
shards, memory, codekb, knowledge); the shipped `.gitignore` excludes per-user
cursors and machine-local runtime.

## Doctor

Run `/aidlc --doctor` after install. It checks the adapter and the four wiring
files (`hooks.v1.json`, `config.json`, `mcp_config.json`, and `rules/aidlc.md`),
checks the Devin CLI version, and verifies hook execution evidence: the
SessionStart adapter writes `.devin/.aidlc-session-start.local.json` after a
successful run, and doctor fails when that marker is absent or invalid —
inspect `/hooks`, approve the AI-DLC hooks if prompted, fully restart Devin
CLI, then rerun doctor (if evidence is still missing, check
`.devin/hooks.v1.json`, the hook runtime, and `.devin` write permissions). A
valid marker is historical execution evidence only; it does not verify current
hook approval. The marker path is ignored by the shipped `.gitignore`;
existing installs must update the adapter and doctor together, merge the new
ignore entry, and fully restart Devin CLI to generate evidence. The MCP check
verifies registry presence, not live MCP availability; disabled servers do not
fail it. `/aidlc --doctor` also warns (non-failing) about the shipped subagent
model policy but does not inspect the effective organization setting/model.
Existing installs should update AIDLC, refresh the shipped agent profiles and
onboarding while preserving intentional local customizations, and restart
Devin CLI; no workflow-record migration is required.

Historical `devin doctor --json` checks reported CFG005 warnings for retained `display_name`, `examples`, `disallowedTools`, and `maxTurns` fields on custom profiles. These fields serve the shared AI-DLC metadata contract, not Devin-native enforcement. The native `allowed-tools` list supplies direct tool restrictions. Recheck current host diagnostics after an upgrade rather than stripping shared metadata merely to silence a warning.

## Regenerating

```bash
bun scripts/package.ts devin          # regenerate dist/devin from core/ + harness/devin/
bun scripts/package.ts --check        # independent-build determinism (every harness)
```

The Devin copy-tree engine TypeScript parity is checked by `tests/unit/t331-devin-packaging.test.ts`. Markdown receives harness substitutions and frontmatter additions; native projections rewrite invocation surfaces. `--check` proves independent-build determinism, not live host behavior or equality with an existing checked-in distribution.

## Next steps

Installed and hooks approved? The methodology is the same on every harness —
keep going with the neutral chapters:

- [Your First Workflow](../02-your-first-workflow.md) — an annotated end-to-end run.
- [Phases and Stages](../04-phases-and-stages.md) — the 5 phases and 33 stages.
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) — right-sizing a run.
- [Glossary](../glossary.md) — every term defined.

Other harnesses: [AI-DLC on Codex CLI](codex-cli.md) · [AI-DLC on Cursor](cursor.md) · [the harness family index](README.md).
