# AI-DLC on GitHub Copilot (CLI + VS Code)

The Copilot runtime is one of the framework's harness distributions, for **GitHub
Copilot** — and one install serves BOTH Copilot surfaces: the standalone
Copilot CLI (`copilot`) and VS Code agent mode. GitHub converged the two on
the same project discovery paths (`.github/skills/`, `.github/agents/`,
`.github/hooks/`, the root `AGENTS.md`), so the framework ships one tree they
both read. One deterministic core, many harnesses: the engine, state machine,
audit log, graph, swarm referee, and learnings gate are byte-identical across
every distribution — only the shell differs. The source/development tree is
**generated** into ignored local `dist/copilot/` from `core/` +
`harness/copilot/` by `bun scripts/package.ts copilot`; never hand-edit it.

The full onboarding remains in the root `AGENTS.md`: Copilot-specific setup
and the live `@`-import block for method files, followed by neutral project
guidance. Copilot's managed root block stays exclusive, not shared with harnesses
that ship the neutral-only block. Keep those imports when merging project instructions.

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
- **`.vscode/settings.json`**: one VS Code setting, `chat.agent.maxRequests`,
  added only when your project does not set it (see
  [VS Code request cap](#vs-code-request-cap)). The copy runtime leaves this
  file out.

## Prerequisites

- **Copilot CLI ≥ 1.0.74 and/or VS Code ≥ 1.130** — the verified line for
  PascalCase hook registration (both surfaces then deliver identical
  snake_case payloads), the blocking PreToolUse deny channel, the blocking
  Stop hook, and `.github` skills/agents discovery. Check with
  `copilot --version` / `code --version`. VS Code agent hooks are a Preview
  feature, and the doctor checks only the optional Copilot CLI version, so
  check `code --version` yourself. The
  [Facilitator Guide](../facilitator-guide.md#github-copilot-on-windows)
  has a readiness check that proves the hooks run.
- **bun** only when generating or running the source/development `dist/`
  projection. Native installs and versioned release runtimes use `aidlc`.
- **Folder trust**: each Copilot surface checks its own.
  - The Copilot CLI runs repo hooks only in a folder its `trustedFolders`
    list covers (the folder itself or a folder above it). The list is in
    `config.json` under `COPILOT_HOME`, else `~/.copilot`
    (`%USERPROFILE%\.copilot` on Windows). An interactive `copilot` run asks
    you to confirm folder trust before it takes a prompt; choose "Yes, and
    remember this folder for future sessions" to record it. `aidlc config`
    tells you when the list does not cover the folder. Headless
    `copilot -p` runs additionally need
    `GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=1`.
  - VS Code agent mode never reads that list. Its hooks run only in a
    trusted workspace (VS Code Workspace Trust) with the **Chat: Use Hooks**
    setting (`chat.useHooks`) on. That setting is a preview feature your
    organization can switch off. A skipped hook leaves no message in the
    chat; the Agent Debug Logs panel shows it.
  - `/aidlc --doctor` warns when the CLI list does not cover the folder. It
    cannot see the VS Code switches.
- **A model provider** — nothing in this install pins a model. Signed-in
  Copilot works as-is; BYOK works with no GitHub auth at all (e.g. Amazon
  Bedrock's Anthropic-compatible endpoint:
  `COPILOT_PROVIDER_BASE_URL=https://bedrock-runtime.<region>.amazonaws.com/anthropic`,
  `COPILOT_PROVIDER_TYPE=anthropic`, a bearer token, and
  `COPILOT_MODEL=<catalog name>` + `COPILOT_PROVIDER_WIRE_MODEL=<Bedrock
  model id>` — `copilot help providers` documents the set). In VS Code, use
  the model picker or a Custom Endpoint provider.

## Install

### Native channel (recommended)

```bash
tmp="$(mktemp -d)"
curl -fsSL \
  https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh \
  -o "$tmp/install.sh"
sh "$tmp/install.sh"
rm -rf "$tmp"
cd your-project
aidlc config --harness copilot
aidlc doctor
```

### Versioned manual-copy alternative

Download and extract a specific release's `aidlc-copy-runtime-X.Y.Z.tar.gz` as described in
[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel),
then set `RUNTIME_ROOT` to the extracted `runtime/` directory.

1. Copy the distribution into your project:

   ```bash
   mkdir -p your-project/.aidlc your-project/aidlc your-project/.github
   cp -R "$RUNTIME_ROOT/copilot/.aidlc/."  your-project/.aidlc/
   cp -R "$RUNTIME_ROOT/copilot/aidlc/."   your-project/aidlc/    # the workspace shell — a sibling of .aidlc/, not inside it
   cp -R "$RUNTIME_ROOT/copilot/.github/." your-project/.github/  # MERGE — everything is aidlc-prefixed, nothing of yours is overwritten
   cp "$RUNTIME_ROOT/copilot/AGENTS.md"    your-project/AGENTS.md # or merge into yours — keep the @-import block (the method include)
   ```

2. Apply the `.gitignore` entries from the shipped `AGENTS.md` § "Git
   Integration" before starting a workflow (per-clone audit shards are
   committed deliberately; cursors and machine-local runtime stay ignored).
   For VS Code, also add `"chat.agent.maxRequests": 200` to your
   `.vscode/settings.json` if it does not set that key (see
   [VS Code request cap](#vs-code-request-cap)). The copy runtime does not
   include that file, so copying it never replaces your own.

3. Trust the folder: start `copilot` interactively once in the project and
   accept the trust prompt (or add the project's absolute path to
   `trustedFolders` in `~/.copilot/config.json`).

4. Run `/aidlc --doctor`, then `/aidlc` followed by what you want to build —
   in either surface.

Framework developers who need the Bun-shaped projection can clone the
repository, run `bun install --frozen-lockfile` and `bun scripts/package.ts`,
then use the ignored local `dist/copilot/` output.

## What's different on this harness

- **One install, two surfaces.** Skills, personas, instructions, and hooks
  behave identically on the CLI and in VS Code agent mode; the divergences
  below are called out explicitly.
- **Questions render as numbered prose options.** Although both surfaces expose
  native picker tools, picker answers return as tool results and do not fire
  the trusted `UserPromptSubmit` event required by the human-presence guard.
  While the session-selected workflow has valid `Status: Running` state, the
  matcher-free PreToolUse guard denies those picker calls and directs the model
  to render numbered prose and end the turn; without a running workflow,
  including completed or unusable state, it leaves native pickers untouched.
  The human's next chat message does; the questions FILE with `[Answer]:` tags
  stays the source of truth.
- **Only what you type counts as your reply.** When the agent hands work to a
  subagent (a reviewer, a builder), VS Code delivers the agent's written brief
  to the hooks the same way it delivers your chat messages. AI-DLC recognizes
  that brief and never records it as your turn: it does not satisfy an
  approval, is not read as your answer or your requested changes, and does not
  apply a typed switch. Anything you type, including while a subagent is still
  running, counts as before. The exception is the first few seconds after a
  subagent starts in your chat: a message then that AI-DLC cannot match to a
  brief is taken to be that brief and is not counted, and if it was yours you
  are asked to reply again.
- **AI-DLC's agents get the stage rules, and the builder waits for your plan
  approval.** Whether the agent starts one of AI-DLC's agents with VS Code's
  `runSubagent` tool or the CLI's `task` tool, AI-DLC hands it the current
  stage's rules, and during Code Generation it does not start the developer
  agent until you have approved the plan. The agent gets the same "approve the
  plan first" refusal on both surfaces.
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
- **In VS Code, AI-DLC's routine commands run without an Allow prompt.** VS
  Code agent mode normally asks "Run command? Allow / Skip" before every
  terminal command, so each workflow step would wait for a click. The adapter
  answers `allow` for the routine commands AI-DLC runs during a stage: `next`,
  `continue`, `report`, and `park`, the read-only `next` forms, `doctor` with
  the flags the engine names, and the project commands in AI-DLC's own command
  table (`engine log`, `engine state`, `engine runtime`, `engine learnings`,
  `engine testing-posture`, `engine intent list`, and the rest), in the
  direct, source-dispatcher, compiled, or tool-script spelling. It answers only
  when all of these hold:
  - the call carries VS Code's chat session, every AI-DLC guard has passed,
    and a workflow command is matched to this session's workflow;
  - it is one plain command that PowerShell, cmd, and a POSIX shell all read
    the same way: no chaining, pipe, redirect other than one trailing `2>&1`,
    environment assignment in front, or shell expansion, and no character any
    of those shells treats specially (such as `$`, a backtick, `%`, `^`, `!`,
    `&`, `|`, `<`, `>`, `;`, `#`, parentheses, braces, `@`, `\`, or a
    typographic quote), even inside quotes. A quoted word may hold spaces and
    `?`, and an apostrophe inside double quotes. Text outside plain ASCII
    (accented letters, for example) also keeps the prompt. On Windows, where
    VS Code's terminal is PowerShell or cmd, a backslash is a plain path
    separator, so a path such as `C:\work\app` or `.aidlc\tools\...` runs
    without a click; only a backslash right before a double quote keeps the
    prompt. In a Git Bash or WSL terminal a backslash still keeps it. In a
    PowerShell terminal one `cd` or `Set-Location` to the project folder
    itself, by its full path, may come first:
    `cd C:\work\app; aidlc engine orchestrate next` runs like
    `aidlc engine orchestrate next`, also while a plan waits for approval. A
    `cd` to any other folder, a subfolder included, keeps the prompt, because
    the installed `aidlc` takes the folder it runs in as the project;
  - every argument that reads as a path stays inside the project;
  - no option hands AI-DLC a command of its own to run (`--check-cmd`);
  - a bare `aidlc` is the installed launcher: when the project holds a file
    named `aidlc` (such as `aidlc.cmd`, or any extension your `PATHEXT` lists)
    in its root or in a folder on your `PATH`, the command keeps the prompt,
    because cmd runs a file in the working folder before it searches `PATH`.

  Everything else gets no answer from AI-DLC, so VS Code's prompt or your own
  approval settings apply: commands the agent writes for your project (build,
  test, `git`, and the like), machine-level commands (`update`, `uninstall`,
  `use`, `config`, `system ...`), the hook, adapter, and statusline entries the
  host runs, and these AI-DLC commands, which keep the prompt so you see each
  one before it runs:
  - commands that throw away or merge your work: `engine worktree discard`,
    `purge`, and `merge`, `unit land`, `engine intent archive`,
    `engine swarm finalize`, and `engine bolt abort` (with or without
    `--discard`, since aborting a Bolt needs your consent);
  - commands that change which stages, gates, or reviews you see:
    `engine recompose` when you have not replied since the last question
    (after you approve a plan change, the recompose that applies it runs
    without a click), `next --skip`, `next --add`, `engine jump execute`,
    `engine scope change`, `engine intent create --skip`, `engine config set`
    and `next config set`,
    `engine bolt set-autonomy`, the `engine state` status changes, and the
    gate setters (`set-unit-gate-rhythm`, `set-construction-checkpoints`,
    `set-skeleton-stance`, `set-status`). `set-construction-checkpoints` runs
    without a click when it applies the checkpoints choice you just recorded
    (its policy receipt for exactly that value);
  - commands that switch the work in progress: `engine intent switch` (or
    `engine intent <name>`) and `engine space switch` (or `engine space <name>`);
  - the team `unit` commands, which share claims and approvals through your
    remote (all but `unit merge-status`);
  - commands that run code AI-DLC does not ship or rewrite its installed
    skills: `engine sensor fire` and the `engine sensor-*` checks (they run
    your project's linter and type checker), `engine knowledge onboard` and
    `sync` (they run the document extractor your harness names),
    `engine plugin sync`, `select`, and `build`, `plugin build`, and
    `engine gen runners` and `runner-scopes`.

  A conditional stage the engine lets the agent skip by its own applicability
  check stays click-free, and so does `doctor`, which may refresh its update
  check from the release feed as it does when you run it yourself. Skipping
  the click records no decision for you: before the engine records a stage
  approval, you must have sent a chat message after the gate was shown, which
  the prompt hook records. That check confirms you took a turn, not what you
  meant, so read what the agent reports back. This does not use VS Code's own
  auto-approve, so it also works where an organization policy turns that off;
  it does need chat hooks enabled, as the rest of AI-DLC does. On the Copilot
  CLI the adapter gives no permission decision, so your own `--allow-tool` and
  `--deny-tool` rules decide as before.
- **Command tracking is exact and best-effort.** AI-DLC tracks simple direct
  orchestrator, source-dispatcher, and real compiled `next`, `continue`,
  `report`, and `park` commands. One trailing `2>&1` is supported. Inspection
  commands are not classified from `aidlc` substrings; ambiguous wrappers and
  commands whose arguments contain active shell expansion (`$VAR`, globs,
  brace expansion, or a leading `~`) run unchanged and untracked, because the hook cannot hash the
  argv the shell will eventually produce. Direct-looking compounds are refused. An
  explicit `--project-dir` outside the current physical project is refused
  before current-project coordination is written.
- **A `continue` AI-DLC cannot match still moves on.** When the hook cannot
  find or trust its record for an AI-DLC command (for example after the record
  was deleted, or when the hook and the terminal spell the project path
  differently), it lets the command run instead of refusing it, and the engine
  answers from disk: the next part when its own record matches, the current
  step when it does not. You no longer get "could not match this Copilot
  command" followed by part 1 again. The audit keeps one
  `COORDINATION_STOOD_ASIDE` row for each such pass. In VS Code, a routine
  command that passes this way still runs without an Allow click.
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
  A `report` that moves the workflow on (an approval, a skip, a finished
  step) is not a stopping point: the agent runs `next` straight away (or parks,
  when the person asked in the same reply to stop the workflow there for now),
  and if it stops anyway, Stop names a fresh `next`, and `park` for a person who
  asked to stop, so the next stage starts in the same turn. Only the workflow-complete report and an isolated single-stage run end
  the turn there.
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
- **Most stages load their rules in one extra step.** VS Code's terminal tool
  keeps a command result whole only up to 20,000 characters; a longer one is
  saved to a file and the chat sees only its start and end. AI-DLC keeps every
  instruction it prints on Copilot under 19,000 bytes, so a stage whose rules
  do not fit beside it sends them first and the model runs the `continue`
  command printed with them before the stage starts. In Construction that
  happens for each stage of each Unit. On a native install this reaches a
  workflow already in progress as soon as you run `aidlc update`; no
  `aidlc config` refresh is needed. A project pinned to an earlier release in
  `.aidlc-version` keeps running that release, and AI-DLC does not move a pin
  while a workflow is in progress, so a pinned project gets this once its
  workflow completes and you run `aidlc config --pin` with this release or
  later.
- **Let the extra steps run without a click.** If VS Code asks you to allow
  each terminal command, choose **Configure Auto Approve...** from its Allow
  options and add `"aidlc engine orchestrate": true` to the
  `chat.tools.terminal.autoApprove` setting. VS Code then runs AI-DLC's
  workflow steps without asking, and other commands keep their usual
  confirmation. The one-click **Allow `aidlc ...` in this Session** or
  **Allow `aidlc ...` in this Workspace** also works, but it skips the click for
  every `aidlc` command, including `aidlc config`, `aidlc update`, and
  `aidlc uninstall`. On a copied Bun runtime the steps start with
  `bun .aidlc/tools/`, so the one-click option there would allow every `bun`
  command. AI-DLC itself installs no auto-approve setting.
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

## VS Code request cap

VS Code agent mode stops after `chat.agent.maxRequests` requests in one turn
(default 50) and asks "Continue to iterate?". The chat then waits silently
until someone answers, so an unattended Construction stage, which easily
makes more than 50 tool calls, sits paused mid-way. `aidlc config --harness
copilot` (first install and every refresh) therefore adds
`"chat.agent.maxRequests": 200` to the project's `.vscode/settings.json`:

- only when the project does not set that key; a value your team already
  set is never changed, even with `--force`;
- without touching other keys, comments, or layout (the file is JSONC), and
  it creates the file when there is none;
- only the value AI-DLC added is recorded as AI-DLC's. If a later release
  stops shipping the setting, config removes it only while it still holds
  the value AI-DLC wrote, and removes the file only if AI-DLC created it.
  `aidlc uninstall` never edits project files, so your settings stay;
- once AI-DLC has added the key, taking it out of a settings file you keep
  is your choice, and config does not add it back. A checkout with no
  settings file at all gets it again.

The setting is window-scoped, so the project value wins over a user setting.
AI-DLC's `.gitignore` block keeps `.vscode/*` out of git, so the value
belongs to each checkout: config adds it where it runs. A copied project
(the copy channel) has no config step that merges this file, and its
runtime does not ship one, so add the key yourself. `/aidlc --doctor` warns
when the project value is below 100, unset (your user setting, else VS
Code's default of 50, then applies), not a number (a number in quotes
included), or unreadable, and names the line to write. It does not warn
about a key your team took out of a settings file it keeps after AI-DLC
added it.

A multi-root window reads this window-scoped setting from its
`.code-workspace` file, not from a folder's `.vscode/settings.json`. So in a
Copilot project, `aidlc system workspace-sync` also writes
`"settings": { "chat.agent.maxRequests": 200 }` into the `aidlc.code-workspace`
it generates, once: only into a file that has no settings yet. The keys and
values already in the file's settings are your team's and stay, including a
removed key; workspace-sync rewrites the file, so comments in it are not kept. When that file exists, doctor checks it too, since it is the file in
charge whenever you open the workspace.

## Verify

```bash
cd your-project
copilot -p "/aidlc --doctor" -s --allow-all-tools   # or run /aidlc --doctor in VS Code chat
```

The doctor checks the engine tree and every adapter dependency, root
`AGENTS.md`, the `.github` wiring files, the Copilot CLI version floor, folder
trust, and reminds about the headless env var. The Copilot CLI is optional: a
VS Code-only install reports `Harness CLI: optional copilot is not installed`
and passes. VS Code puts its own `copilot` command on its terminals' PATH that
only prints "Cannot find GitHub Copilot CLI" when the CLI is absent; the doctor
reads that as not installed, not as an old version. An installed CLI below the
floor is a warning, never a failure. The deterministic engine tests for
this harness are `tests/unit/t248-copilot-packaging.test.ts`,
`t249-copilot-adapter.test.ts`, `t250-copilot-adapter-security.test.ts`, and
`t-copilot-directive-budget.test.ts`;
the live journey is `tests/e2e/t-exec-copilot-status.serial.test.ts`, gated
on `AIDLC_COPILOT_EXEC_LIVE=1`.
