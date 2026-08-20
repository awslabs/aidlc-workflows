# AI-DLC on GitHub Copilot (CLI + VS Code)

`dist/copilot/` is one of the framework's harness distributions, for **GitHub
Copilot** — and one install serves BOTH Copilot surfaces: the standalone
Copilot CLI (`copilot`) and VS Code agent mode. GitHub converged the two on
the same project discovery paths (`.github/skills/`, `.github/agents/`,
`.github/hooks/`, the root `AGENTS.md`), so the framework ships one tree they
both read. One deterministic core, many harnesses: the engine, state machine,
audit log, graph, swarm referee, and learnings gate are byte-identical across
every distribution — only the shell differs. The tree is **generated** from
`core/` + `harness/copilot/` by `bun scripts/package.ts copilot`; never
hand-edit it (the drift guard fails CI).

## Layout: the engine dir and the .github shell

- **`.aidlc/`** — the AIDLC engine tree (tools, hooks + the Copilot adapter,
  agents, knowledge, scopes, sensors, aidlc-common). Neither Copilot surface
  scans it; everything user-visible rides `.github/`.
- **`.github/`** — only natively-consumed, `aidlc`-named emissions: the hook
  wiring (`hooks/aidlc.json`), the 14 persona custom agents
  (`agents/aidlc-*-agent.md`), and the full skill tree (`skills/aidlc*/` —
  orchestrator, per-stage runners, scope runners, session skills). Your
  repository's own `.github/` content (workflows, templates) is untouched:
  the install MERGES these files in, all collision-free by prefix.

## Prerequisites

- **Copilot CLI ≥ 1.0.74 and/or VS Code ≥ 1.130** — the verified line for
  PascalCase hook registration (both surfaces then deliver identical
  snake_case payloads), the blocking PreToolUse deny channel, the blocking
  Stop hook, and `.github` skills/agents discovery. Check with
  `copilot --version` / `code --version`. (VS Code agent hooks are a Preview
  feature — the doctor pins the floor.)
- **bun** — same requirement as every harness; every tool and hook runs via
  bun, which must be on the PATH of the shells Copilot spawns.
- **Folder trust** — repo hooks run ONLY when the project's absolute path is
  in `trustedFolders` in `~/.copilot/config.json` (the CLI prompts on first
  interactive use). Headless `copilot -p` runs additionally need
  `GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=1`. **Untrusted = every hook
  silently no-ops, with no warning anywhere** — `/aidlc --doctor` is the
  surface that checks both.
- **A model provider** — nothing in this install pins a model. Signed-in
  Copilot works as-is; BYOK works with no GitHub auth at all (e.g. Amazon
  Bedrock's Anthropic-compatible endpoint:
  `COPILOT_PROVIDER_BASE_URL=https://bedrock-runtime.<region>.amazonaws.com/anthropic`,
  `COPILOT_PROVIDER_TYPE=anthropic`, a bearer token, and
  `COPILOT_MODEL=<catalog name>` + `COPILOT_PROVIDER_WIRE_MODEL=<Bedrock
  model id>` — `copilot help providers` documents the set). In VS Code, use
  the model picker or a Custom Endpoint provider.

## Install

The copies below come from a clone of the
[aidlc-workflows](https://github.com/awslabs/aidlc-workflows) repository on the
`v2` branch:

```bash
git clone https://github.com/awslabs/aidlc-workflows.git
cd aidlc-workflows
git checkout v2
```

1. Copy the distribution into your project:

   ```bash
   mkdir -p your-project/.aidlc your-project/aidlc your-project/.github
   cp -R dist/copilot/.aidlc/.  your-project/.aidlc/
   cp -R dist/copilot/aidlc/.   your-project/aidlc/    # the workspace shell — a sibling of .aidlc/, not inside it
   cp -R dist/copilot/.github/. your-project/.github/  # MERGE — everything is aidlc-prefixed, nothing of yours is overwritten
   cp dist/copilot/AGENTS.md    your-project/AGENTS.md # or merge into yours — keep the @-import block (the method include)
   ```

2. Apply the `.gitignore` entries from the shipped `AGENTS.md` § "Git
   Integration" before starting a workflow (per-clone audit shards are
   committed deliberately; cursors and machine-local runtime stay ignored).

3. Trust the folder: start `copilot` interactively once in the project and
   accept the trust prompt (or add the project's absolute path to
   `trustedFolders` in `~/.copilot/config.json`).

4. Run `/aidlc --doctor`, then `/aidlc` followed by what you want to build —
   in either surface.

## What's different on this harness

- **One install, two surfaces.** Skills, personas, instructions, and hooks
  behave identically on the CLI and in VS Code agent mode; the divergences
  below are called out explicitly.
- **Questions render as numbered prose options.** Although both surfaces expose
  native picker tools, picker answers return as tool results and do not fire
  the trusted `UserPromptSubmit` event required by the human-presence guard.
  The human's next chat message does; the questions FILE with `[Answer]:` tags
  stays the source of truth.
- **Hooks enforce natively.** The adapter
  (`.aidlc/hooks/aidlc-copilot-adapter.ts`, wired by
  `.github/hooks/aidlc.json`) converts a core-guard block into Copilot's
  `permissionDecision: deny` — the reviewer read-scope bound and the
  state-transition guard actually refuse the tool call. SessionStart and Stop
  responses carry both the CLI's top-level fields and VS Code's required
  `hookSpecificOutput` envelope.
  Live-verified on the CLI; on VS Code agent mode the same deny/block
  channels are documented and the adapter normalizes documented names such as
  `runTerminalCommand`, `createFile`, `editFiles`, and `readFile`,
  but the IDE side has not yet been verified live — treat IDE enforcement
  as best-effort until it has.
- **Command tracking is exact and best-effort.** AI-DLC tracks simple direct
  orchestrator, source-dispatcher, and real compiled `next`, `continue`,
  `report`, and `park` commands. One trailing `2>&1` is supported. Inspection
  commands are not classified from `aidlc` substrings; ambiguous wrappers and
  commands whose arguments contain active shell expansion (`$VAR`, globs,
  brace expansion, or a leading `~`) run unchanged and untracked, because the hook cannot hash the
  argv the shell will eventually produce. Direct-looking compounds are refused. An
  explicit `--project-dir` outside the current physical project is refused
  before current-project coordination is written.
- **The engine owns continuation replay on every harness.** Copilot uses the
  same record-local, atomic single-use cursor as Claude, Codex, Cursor, Kiro,
  Kiro IDE, and opencode. Native token validation runs first; the engine then
  compares the complete token SHA-256 and publishes the exact successor before
  stdout under the active-directive lock. Copilot's session ownership and
  delivery evidence enrich that marker but do not own replay. Missing,
  malformed, v1, and pre-shared markers recover once inside the same
  transaction; a fresh `next` resets the cursor. See the shared cursor contract
  in the Developer Reference for crash, migration, rollback, and filesystem
  limits.
- **Stop preserves the current delivered Copilot directive.** An exact host
  `tool_use_id`, or the adapter ID carried through rewritten engine input and
  returned by PostToolUse, can settle delivery for session-scoped Stop and
  Resume behavior. If exact correlation is unavailable, execution is allowed
  untracked and Post does not guess. A fresh simple `next` restores tracked
  delivery; correlation loss does not create a permanent deny. Once a claim is
  attempted, project, state, or session ownership rejection is an explicit deny:
  another session cannot execute the owner's current token as untracked work.
- **Legacy Resume and conversation waits are session-scoped.** Stop allows a
  genuine conversational response to end cleanly. A Resume marker written by a
  pre-2.6.19 installation remains owner-scoped; explicit `next --resume`
  supersedes it and continues directly. Prompt text and rules content are not
  persisted in the coordination marker.
- **Host evidence is intentionally bounded.** Rewriting and carried-ID echo
  were live-verified on Copilot CLI 1.0.79 on macOS in noninteractive mode.
  VS Code's `tool_use_id`, `updatedInput`, and `tool_response` path is covered
  from its documented Preview contract but is not live-verified here. Copilot
  cloud agent is outside this release's supported AI-DLC surface.
- **Hook wiring is matcher-free by design**: VS Code parses but IGNORES hook
  matchers, so every adapter target self-filters on `tool_name` instead — a
  matcher would silently broaden on the IDE.
- **Reviewer identity is correlated, not delivered**: PreToolUse payloads
  carry no per-call agent field; the adapter brackets delegations via
  SubagentStart/SubagentStop (including VS Code's `agent_type`/`agent_id`
  fields) and forwards the identity when exactly one subagent is active.
  Ambiguous overlap fails open for that call (the reviewer-module prose bound still
  governs).
- **Personas carry no `model:` pin.** The two surfaces disagree on model
  value syntax (the CLI forwards frontmatter strings verbatim to the BYOK
  provider; an IDE display name 400s there). Agents inherit the session
  model — tier projection on this harness is model-omitted by type.
- **Worker personas use an explicit built-in `tools:` allowlist.** It omits
  Copilot's `agent` delegation tool to enforce no nested delegation. Copilot
  has no all-except-agent form, so delegated workers do not inherit arbitrary
  MCP tools.
- **AIDLC plugins use Copilot-native surfaces.** Composed plugin personas and
  generated stage/scope runners land in `.github/{agents,skills}`; plugin
  selection regenerates those paths and never creates `.aidlc/skills` or
  `.opencode/agents`.
- **Session-end**: VS Code does not document SessionEnd, so the shared hook
  manifest omits it on both hosts. The adapter reconciles the prior session at
  the next SessionStart with inferred provenance (the codex pattern).
- **The method include rides AGENTS.md `@`-imports** (live-verified on the
  CLI; VS Code documents `@`-import expansion but it has not been verified
  live there). `/aidlc space <name>` re-points the block in place, including
  the `.github/agents/` persona twins.
- **No statusline**; use `/aidlc --status` and the progress lines at gates.
- **Construction swarm is subagent fan-out only** (`AIDLC_USE_SWARM=1` is a
  loud no-op).
- **MCP**: none ships. If you add servers, note the surfaces diverge here —
  the CLI reads `~/.copilot/mcp-config.json`, VS Code reads `.vscode/mcp.json`;
  the conductor can use them, but delegated worker personas cannot.

## Verify

```bash
cd your-project
copilot -p "/aidlc --doctor" -s --allow-all-tools   # or run /aidlc --doctor in VS Code chat
```

The doctor checks the engine tree and every adapter dependency, root
`AGENTS.md`, the `.github` wiring files, the CLI version floor, folder trust,
and reminds about the headless env var. The deterministic engine tests for
this harness are `tests/unit/t248-copilot-packaging.test.ts`,
`t249-copilot-adapter.test.ts`, and `t250-copilot-adapter-security.test.ts`;
the live journey is `tests/e2e/t-exec-copilot-status.serial.test.ts`, gated
on `AIDLC_COPILOT_EXEC_LIVE=1`.
