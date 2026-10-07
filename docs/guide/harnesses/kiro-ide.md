# Running AI-DLC on Kiro IDE and Kiro CLI

One of the framework's harnesses: this Kiro runtime runs the same AI-DLC
methodology inside [Kiro](https://kiro.dev/) — Kiro IDE 1.x and Kiro CLI v3
run one agent harness and read the same `.kiro/` tree. One deterministic core —
the tools, 33 stage files, protocols, knowledge, sensors, scopes, and rules —
is byte-shared across every harness; only the shell (skills, agent surfaces,
hook wiring, activation) differs.

Harness-specific onboarding lives in `.kiro/steering/aidlc-onboarding.md`,
whose `inclusion: always` frontmatter loads it automatically. The root
`AGENTS.md` block is harness-neutral and shared with other installed harnesses;
engine directories must still differ (the `kiro` and `kiro-ide` distributions cannot share `.kiro/`; in a project with
`kiro`, `aidlc config --harness kiro-ide` switches `.kiro/` to this distribution in place).

> [!IMPORTANT]
> **Run AI-DLC on Kiro with Claude Opus 4.8.** The conductor drives a
> multi-step ritual per stage — clarifying questions, artifact generation, a
> reviewer pass, the learnings ritual, then the approval gate. Opus 4.8
> follows the full ritual and pauses correctly at every gate. Weaker models
> skip optional steps (the reviewer pass and the learnings ritual) and may
> rush gates. Set the chat model to **Claude Opus 4.8** before starting a
> workflow.

## Prerequisites

- **Kiro IDE 1.1.70 or later**, signed in, or **Kiro CLI 2.24.1 or later**
  (`kiro-cli --version`), signed in. These are the oldest builds this
  distribution has been checked on. `/aidlc --doctor` warns when the
  `kiro-cli` on the PATH is older; it cannot read the Kiro IDE version.
- **Claude Opus 4.8** selected as the chat model (see the note above)
- **bun** only when generating or running the source/development `dist/`
  projection. Native installs and versioned release runtimes are
  self-contained.

> [!TIP]
> For a source-generated `dist/` install, bun must be on the PATH the IDE
> hands its hooks and tools. Opened from a terminal, the IDE hands them that
> terminal's PATH, so `bun --version` working there is enough. Opened from the
> dock or a desktop icon, it may not: if hooks can't find bun, run
> `bun .kiro/tools/aidlc.ts doctor` in such a terminal. Its `Runtime hook PATH`
> row names the directory to add and where; restart the IDE afterwards. Until
> then, open the IDE from that terminal.

## Install

### Native channel (recommended)

If you run these commands in Kiro IDE's own terminal in a project folder you
have not trusted yet, Kiro first asks whether you trust it. Choose **Trust
Folder & Continue** only for your own project or one you have checked;
otherwise choose **Cancel** (see [First run](#first-run)).

```bash
tmp="$(mktemp -d)"
curl -fsSL \
  https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh \
  -o "$tmp/install.sh"
sh "$tmp/install.sh"
rm -rf "$tmp"
cd your-project
aidlc config --harness kiro-ide
aidlc doctor
```

The installer verifies the release metadata, executable, and all-harness runtime archive against the published SHA-256 checksums. The installed runtime does not require Bun, Node.js, or Git. Harness selection happens in `aidlc config`.

On Windows, download `install.ps1` and run
`& $installer`. See [Windows installation](../18-install-and-lifecycle.md#windows-powershell)
for account scope, automatic User PATH registration, and `-NoModifyPath`.
For an air-gapped package, use
`install.sh --from <release-directory> --offline` on Unix or
`& $installer -From <release-directory> -Offline` on Windows.

`aidlc config` projects the Kiro shell before the project is opened. The native
`aidlc engine *` trust grant, and the exact read-only and turn-back-on commands
listed for a copied project below, ship inside the permissions of the conductor
(`.kiro/agents/aidlc.md`); every agent it hands work to is denied those
commands. Some commands are
held back from it: `aidlc engine config set *` changes a setting of your piece
of work, `aidlc engine adapter *` is the entry the IDE's own hooks run, and a
command holding `$`, a backtick, `>`, `<`, `&`, `@(`, `@{`, or a line break can
run, expand, or redirect more than the one command. When an agent runs one of these, Kiro IDE
asks you first. Earlier releases also merged it into
`.vscode/settings.json` `kiroAgent.trustedCommands`; Kiro IDE 1.x no longer
reads that key, so the entry can be removed. Before the first workflow, follow
[First run](#first-run): open `your-project/` in Kiro IDE, trust the folder and
reload the window, choose **aidlc** in the chat panel's agent picker, and run
`/aidlc --doctor`. In Kiro CLI, run `kiro-cli` in the project instead; it opens
on the `aidlc` agent.

### Versioned manual-copy alternative

Download and extract a specific release's `aidlc-copy-runtime-X.Y.Z.tar.gz` as described in
[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel),
then set `RUNTIME_ROOT` to the extracted `runtime/` directory.

```bash
mkdir -p your-project/.kiro your-project/aidlc
# Safe on fresh installs; required when upgrading from v2.5.56 or earlier.
for retired_hook in \
  audit-logger block mint runtime-compile stop sync-statusline \
  enforce-approval-gate plan-approval-guard review-freeze state-transition-guard \
  terminal-command-guard rebuild-stage-graph sync-workflow-state
do
  rm -f \
    "your-project/.kiro/hooks/aidlc-${retired_hook}.json" \
    "your-project/.kiro/hooks/aidlc-${retired_hook}.kiro.hook"
done
rm -f \
  your-project/.kiro/agents/aidlc.json \
  your-project/.kiro/agents/aidlc-*-agent.json \
  your-project/.kiro/hooks/aidlc-*.kiro.hook
# The copy replaces .kiro/settings/cli.json; keep the project's own first.
if [ -f your-project/.kiro/settings/cli.json ]; then
  cp your-project/.kiro/settings/cli.json your-project/cli.json.before-aidlc
fi
cp -R "$RUNTIME_ROOT/kiro-ide/.kiro/." your-project/.kiro/
cp -R "$RUNTIME_ROOT/kiro-ide/aidlc/." your-project/aidlc/     # the workspace shell (spaces/default/memory) — a sibling of .kiro/, not inside it
cd your-project && bun .kiro/tools/aidlc.ts config --from "$RUNTIME_ROOT" --harness kiro-ide
```

The first removal loop is the v2.5.57 hook-name migration. The second removes
Kiro CLI-format agent JSON shipped by older distributions and the IDE 0.x
`.kiro.hook` registrations, which Kiro IDE 1.x never executes. An overlay copy
cannot delete retired files. The copy also replaces `.kiro/settings/cli.json`,
which pins Kiro CLI to its v3 engine and the `aidlc` agent. That file is managed
by AI-DLC like the rest of `.kiro/`: `aidlc config` stops with a conflict rather
than overwrite a copy that differs from the shipped one, and `--force` replaces
it. Keep your own Kiro CLI settings in the user-level `~/.kiro/settings/cli.json`
instead: Kiro CLI reads that file too, and the project file wins only for the
keys it sets.
If the project kept settings in `.kiro/settings/cli.json`, the block above saves
them as `cli.json.before-aidlc` so you can move them there. Both removals are
no-ops on a fresh install. After that cleanup, the
`cp -R <src>/. <dst>/` form copies the tree **contents** whether
`your-project/.kiro` already exists or not. A plain
`cp -r "$RUNTIME_ROOT/kiro-ide/.kiro" your-project/.kiro` nests a second `.kiro` inside an
existing `.kiro/` and the IDE never sees the new files.

The `aidlc/` directory is the workspace shell — it ships the pre-built
`aidlc/spaces/default/memory/` method tree the engine reads. It is a **sibling**
of `.kiro/`, so copy it separately (or copy the whole
`$RUNTIME_ROOT/kiro-ide/` tree at once). `/aidlc --doctor` fails its
"workspace shell ready" check if it is missing.

In a copied project, the `aidlc` agent runs AI-DLC's engine commands
(`bun .kiro/tools/aidlc.ts engine ...`), its tool scripts, its read-only
commands (`doctor` and `--doctor`, with or without `--verbose`, `version`,
`--version`, `status`, `--status`, `config --help`, `config --show` and
`config <section> --show` with or without `--json`, and
`config <section> --help`) and turning a check back on
(`config flags --clear-bypass <switch> --yes`) with no card. A native install
runs the same commands, as `aidlc ...`, with no card too. Any other
`config` change (bare `config`, the guided setup, included), the commands that change the machine's AI-DLC install (`use`,
`update`, `rollback`, `uninstall`, `system`), and a command holding `$`, a
backtick, `>`, `<`, `&`, `@(`, `@{`, or a line break show Kiro's card first.

The versioned runtime uses the native `aidlc` command. Framework developers who
need the Bun-shaped source projection can clone the repository, run
`bun install --frozen-lockfile` and `bun scripts/package.ts`, then use the
ignored local `dist/kiro-ide/` output instead.

The shipped `.gitignore` carries the workspace's commit/ignore split: the
per-user cursors (`aidlc/active-space`, `aidlc/spaces/*/intents/active-intent`)
and machine-local runtime (`aidlc/.aidlc-clone-id`, `runtime-graph.json`, sensor
caches, `spaces/*/knowledge/.sources.local.json`) stay untracked, while the
shared records — method memory, state, audit shards, artifacts — travel with
git. The last line, the copy's own setup, adds those lines and AI-DLC's part of
`AGENTS.md` after everything already in your files, or creates the files when
the project has none, so the AI-DLC rules are in place before your first
workflow.

The install ships:

- `.kiro/skills/aidlc/SKILL.md` — the conductor loaded when you invoke
  `/aidlc`.
- `.kiro/agents/aidlc.md` — the same conductor exposed in the workspace agent
  selector. It delegates through `invoke_sub_agent` (Kiro IDE) or
  `orchestrate_subagent` (Kiro CLI), the dispatch tools that run each persona
  under its own tools and deny rules.
- `.kiro/agents/aidlc-*-agent.md` — all 14 delegation personas, carrying
  `tools:` grants and `permissions.rules`. On a delegated call Kiro enforces a
  persona's deny rules but runs its commands under the conductor's allow, so
  each persona denies that allow except the AI-DLC commands a delegate may run.
  A delegate cannot move the workflow, change stage state, or switch or create
  an intent or space, however it quotes or spaces the command. Only the
  pipeline-deploy persona creates, merges, discards, and restores Bolt
  worktrees.
  No agent-v1 JSON ships. Their shell
  rules run AI-DLC's own commands and `bun --version` without
  asking; the project's own test and build commands still ask.
- `.kiro/settings/cli.json` — pins Kiro CLI to its v3 engine and the `aidlc`
  agent. Kiro CLI's default v2 engine runs none of the `.kiro/hooks/`
  registrations, and a hook cannot detect that from inside. Kiro IDE does not
  read this file. `kiro-cli acp` reads its `chat.defaultAgent` but not its
  engine pin, so an ACP client has to start `kiro-cli acp --agent-engine v3`
  and declare
  `clientCapabilities._meta.kiro.hooks` as `{ enabled: true, v2: true }` in its
  `initialize` request, or the session runs no hooks (see
  [Kiro CLI hooks not running](../15-troubleshooting.md#kiro-cli-hooks-not-running)).
- `.kiro/steering/aidlc-active-memory.md`: always-included steering that carries
  the active space's memory text for the conductor and delegated agents. AI-DLC
  writes it from `aidlc/spaces/<active-space>/memory/` for each chat and keeps it
  out of git; edit the memory files, never this one. A chat keeps the copy it
  started with, so after a memory edit the stage rules arrive with each step
  until a new chat starts.
- `.kiro/steering/aidlc-onboarding.md` — always-included harness setup and commands.
- `.kiro/hooks/aidlc-*.json` — the framework hooks in Kiro's v2 hook format.
  Both surfaces register them when a session starts; in Kiro IDE they appear
  in the Agent Hooks panel. The IDE 0.x `.kiro.hook` format is no longer
  shipped: Kiro IDE 1.x never executes it.

## First run

Kiro IDE runs a folder's hooks and loads its `aidlc` agent only after you trust
the folder and reload the window. An untrusted folder opens in Restricted Mode:
a banner at the top of the window, and "Restricted Mode" in the status bar.
Until then the AI-DLC hooks do not run, the `aidlc` agent is missing from the
agent picker, and the first approval question cannot see your reply.

Trust only a folder whose contents you know: your own project, or one you have
checked. Trusting lets the folder's `.kiro` hooks run commands on your machine,
so leave a project from someone else in Restricted Mode until you have reviewed
it.

Kiro can ask for this trust earlier. If you open Kiro IDE's terminal in the
folder before trusting it, for example to run `aidlc config` there, Kiro first
asks "Do you trust the authors of the files in this folder?". For a folder you
know, choose **Trust Folder & Continue**, which trusts it the same way step 1
does, and when `aidlc config` finishes, continue at step 2 to reload the
window. Otherwise choose **Cancel**.

1. Open `your-project/` in Kiro IDE. If the Restricted Mode banner shows at the
   top of the window and you know what is in the folder, select **Manage** on
   it, then **Trust** on the Workspace Trust page that opens.
2. Open the Command Palette (Ctrl+Shift+P, or Cmd+Shift+P on macOS) and run
   **Developer: Reload Window**.
3. Choose the **aidlc** agent in the chat panel's agent picker (see
   [Start AI-DLC in a Kiro IDE chat](#start-ai-dlc-in-a-kiro-ide-chat)).
4. In chat, run `/aidlc --doctor` to verify the setup, then
   `/aidlc <description>` to start a workflow.

On Kiro CLI, start `kiro-cli` in `your-project/`, then go to step 4.

If doctor reports "AIDLC hooks have not run in this project yet" after you have
sent a chat message, repeat steps 1 to 3. See
[Troubleshooting: Kiro IDE hooks not running](../15-troubleshooting.md#kiro-ide-hooks-not-running).

## Usage

Identical to the Claude Code harness: `/aidlc <description>` starts a
workflow, `/aidlc --status` reports position, `/aidlc --doctor`, `--stage`,
`--phase`, `--depth`, `--test-strategy`, and `--config [section]` all work, and the
per-stage (`/aidlc-domain-design`) and per-scope (`/aidlc-feature`) runner
skills are installed. There is no init command; the shipped shell scaffolds
the workspace, and AI-DLC automatically creates the first intent on your first `/aidlc`.

### Start AI-DLC in a Kiro IDE chat

Kiro IDE starts every new chat on its own **Default** agent, not on `aidlc`.
The `"chat.defaultAgent": "aidlc"` line in `.kiro/settings/cli.json` is a Kiro
CLI setting: it makes `aidlc` the default agent for `kiro-cli` sessions only,
and Kiro IDE does not read that file. So in each new Kiro IDE chat:

1. Open the agent picker in the chat panel and choose **aidlc** (its
   description starts "AI-DLC. Choose this agent in the agent picker"). This
   agent lets AI-DLC's commands run without asking you, and lets AI-DLC bring
   in its specialist agents. When AI-DLC
   starts, Kiro asks you to allow **Load skill: aidlc**. Choose **Always
   allow** and keep **Apply to: This workspace**, and Kiro stops asking in
   new chats for this project. **Allow** covers only the current chat.
2. Type the whole request, then press Enter: for example `/aidlc --doctor` or
   `/aidlc build a to-do app`. A bare `/aidlc` works too. While the `/` menu
   is open, Enter puts its first entry in the chat, a specialist such as
   `aidlc-architect-agent`, and the next Enter sends it. AI-DLC reads that as
   `/aidlc` and carries on.
3. Picking `aidlc` from the `/` menu does not change which agent the chat
   uses. If the chat is still on **Default**, Kiro asks you to approve
   loading AI-DLC and then each command it runs. To avoid that, choose
   **aidlc** in the agent picker first (step 1). The `aidlc-...-agent`
   entries in the `/` menu are the specialists AI-DLC brings in during a
   workflow; you do not start them yourself.

With the `aidlc` agent selected you can also ask in plain words, for example
"start an AI-DLC workflow for a to-do app" or "continue my AI-DLC workflow".
Kiro's welcome panel (Spec, Plan, Bug Fix, Quick Spec) lists Kiro's own
workflows; AI-DLC does not appear there, so start it from the chat as above.

### Supervised or Autopilot

The **Autopilot** switch at the bottom right of the chat box (also under
**Settings > Agent > Agent Autonomy**) sets how often Kiro itself asks you to
approve what the agent does. You can change it at any time, even in the middle
of a workflow. It does not change which AI-DLC checkpoints stop for you.

- **Supervised** (switch off): after each turn that changes files, Kiro shows a
  **Review changes** card and waits until you choose **Accept** or **Reject**.
  AI-DLC keeps its questions, stage documents, and plans in files, so a
  workflow shows many of these cards on top of AI-DLC's own questions.
- **Autopilot** (switch on): file changes go through without the card. Select
  **View changes** in the chat to see what changed.
- In both modes, Kiro asks you to **Allow** any command that the `aidlc` agent
  does not already allow, such as your project's test command. It also asks
  before the two AI-DLC commands held back on purpose (see
  [Native channel](#native-channel-recommended)).

In both modes, AI-DLC still stops and waits for your typed reply at each of its
questions, at every approval gate, and at Code Generation's **Approve Plan**
when plan approval is on (the default in every shipped scope except express
and poc, and yours to switch; see
[Plan approval](../13-customization.md#plan-approval)). Kiro's switch cannot
skip these. AI-DLC's hooks run in either mode: one refuses the agent's tool
calls while an approval gate waits for you, and another refuses code changes
until the plan is approved or, with plan approval off, until AI-DLC has
recorded that it builds the plan without asking. AI-DLC also accepts an answer
or an approval only after you have typed a reply to the question. The AI-DLC
setting that skips routine approvals is its own Construction choice
**Continue automatically** (see
[Your First Workflow](../02-your-first-workflow.md#construction-phase)), not
Kiro's Autopilot.

Use Supervised when you want to read every file change as it happens, for
example on your first workflow or in code where every change matters. Use
Autopilot when you want far fewer clicks: you still answer every AI-DLC
checkpoint in chat, and can look over the changes afterwards.

## How hooks work on Kiro

Kiro IDE and Kiro CLI v3 register hooks through v2 hook JSON files
(`{"version":"v1","hooks":[{name,trigger,matcher,action}]}`, PascalCase
triggers) under `.kiro/hooks/` (a different mechanism from the `kiro` CLI
distribution, which carries a `hooks` block inside the agent JSON). Native hook commands route through
`aidlc engine adapter kiro-ide`; source/development copies route through the projected
`aidlc-kiro-adapter.ts` shim. Both normalize the IDE event into the shape the
shared core hooks expect. Which Kiro tools are writes, shells, delegations, and
reads is set in one table, `aidlc-kiro-tool-names.ts` beside the adapter. The
adapter reads it; the hook registrations are hand-written JSON whose matchers
list the same shell, delegation, and audited write names.

Kiro IDE 1.x and Kiro CLI v3 deliver hook context as **JSON on stdin** (snake_case:
`{ session_id, tool_name, tool_input, tool_response }`; the older 0.12 builds instead set
the `USER_PROMPT` environment variable with a camelCase equivalent, and the
adapter accepts both). Earlier builds left PostToolUse write/shell tool inputs
empty, so the adapter recovers the written path from the result text when the
input carries none, and audit-tail hooks (`rebuild-stage-graph`, `sync-workflow-state`) run
from the audit trail. The graph-rebuild route also retains the shell result and session
identity so a successful `intent-create` binds to the invoking session: modern
events carry the exact `session_id`, while the legacy channel derives a stable
host-instance identity from the measured `VSCODE_IPC_HOOK`/`VSCODE_PID`
environment and retains it at SessionStart. Modern Stop likewise prefers its
event-local `session_id`, preventing one concurrent chat from consuming
another chat's handoff after an intent is created or selected; legacy agentStop falls back to the retained
identity. Later 1.x builds populate some PreToolUse and delegation inputs; the
adapter preserves those fields. On Windows, deterministic utilities use those
seams to avoid the IDE shell-result transport: builds that expose the submitted
prompt run the utility at UserPromptSubmit, while builds such as 1.0.242 (whose
prompt field is empty) fall back to the exact `execute_pwsh` PreToolUse command.
The utility runs once per turn, its UTF-8 text is relayed without terminal
protocol/control bytes, and the duplicate shell call is refused. Modern chats
store turn and output state per `session_id`; context without a session identity
uses one legacy compatibility bucket. Pre-1.0 camelCase payloads take the same
fallback through `toolArgs.command`; raw prompt text is only a newer-generation
compatibility shape.

The payload acquisition is **gated to payload-dependent targets**
(`audit-and-sensors`, `enforce-approval-gate`, `log-subagent`,
`plan-approval-guard`, `rebuild-stage-graph`, `review-freeze`,
`state-transition-guard`, and the `guard-tool-call` and `after-shell` cards
that run them), the terminal-command seams, plus
`session-start` and `continue-workflow` for their modern `session_id`, and
`record-human-turn` for the exact approval response. A non-empty `USER_PROMPT`
is consumed immediately on 0.12 builds (which open stdin without ever writing);
otherwise the adapter reads the 1.x stdin channel with a 2s broken-channel
ceiling. Every other target touches neither channel and keeps its zero-latency
path. The approval floor (`enforce-approval-gate`) runs on every `PreToolUse` but a read.
On 1.x it reads the invoking chat's `session_id`, so concurrent chats are held
by their own gates; the payload arrives and the channel closes with the call,
so it does not wait on the normal path, and only a channel that never closes
holds it until the 2s ceiling. A 0.12 payload carries no `session_id`, so the
floor uses the identity derived from the IDE host instance: every chat in that
host shares it and is judged by the gates of the workflow it is bound to.

| Hook | Trigger (matcher) | Purpose |
|------|-------------------|---------|
| `aidlc-session-start` | `SessionStart` | Injects workflow resume context when a new session takes its first prompt (both surfaces; resuming an existing session does not fire it). Kiro IDE 1.1.14 runs no SessionStart hook in a new chat, so `aidlc-record-human-turn` does this work instead |
| `aidlc-record-human-turn` | `UserPromptSubmit` | Records a human-turn event on every prompt (human-presence gate). A prompt from a chat other than the last one seen, or from a chat not yet started, first starts that chat's session, as `aidlc-session-start` would, so the chat gets its `AIDLC Runtime Session:` line or resume context |
| `aidlc-terminal-command` | `UserPromptSubmit` | Runs status, doctor, help, navigation, and other terminal utilities before the model when prompt text is available, for the chat that typed the command |
| `aidlc-continue-workflow` | `Stop` | Forwarding-loop audit (advisory-only; the Stop trigger cannot block on the IDE - enforcement relies on the conductor's own Stop protocol) |
| `aidlc-guard-tool-call` | `PreToolUse` (every tool but a read) | One card for the five checks below, run in this order on the same call. Each check runs only for the tools beside it; every check runs even after one refuses, and the call is refused when any check refuses, with each reason once. A read (`read_file`, `list_directory`, a search) runs with no card: it cannot answer an approval or change the workspace |
| `enforce-approval-gate` | in `aidlc-guard-tool-call` (every tool but a read) | Hard-blocks tool calls while an approval gate the person must answer is open and no human has acted since (human-presence floor); the read-only Review brief still prints. A gate AI-DLC approves itself, such as a Construction stage gate once every Unit's checkpoint is approved, does not hold it, and neither does the one Construction setting the person just chose |
| `plan-approval-guard` | in `aidlc-guard-tool-call` (every tool but a read) | Enforces Code Generation Plan Approval with exact target classification when arguments are present. The shell tool is recognised under all three IDE names, `execute_bash`, `execute_pwsh` (Windows), and `shell`: each is forwarded to the shared guard as `Bash` and routed to legacy recovery identically, and with no active workflow no shell call is denied. `execute_pwsh` is marked as PowerShell, so while a plan waits for approval read-only cmdlets (`Get-Content`, `Select-Object`, `ConvertFrom-Json`, ...), `2>$null`, and `aidlc.cmd` or the full path of the installed engine still run; `Out-File`, `Set-Content`, `Add-Content`, `Tee-Object`, and `>` into a file do not. Legacy argument-less payloads permit only measured `fs_write`/`str_replace` plan-question writes as far as this hook goes; `review-freeze` and `state-transition-guard` refuse such a write, so it does not run. PostToolUse stays silent because 0.12 discards that output; the invoking Code Generation `next`/final `continue` directive carries one protected choice capability. Recovery first requires an exact human `Recover Plan Approval` response; another live window cannot initiate it, while a replacement window can recover after the owner PID exits or an IPC-only endpoint disappears. Takeover clears old response evidence before rotating the challenge. An interrupted pre-write window remains a recovery latch even when PostToolUse never runs; definitive `toolSuccess:false` or recognized failure prose clears it because no mutation occurred, while unknown outcomes remain latched. Adapter-owned recovery preserves the human ask while clearing only violation/window state after successful reissue. `UserPromptSubmit` can submit exact recovery/approval labels but cannot reveal or transfer them. Unknown mutators fail closed and shared files/audit retain no plaintext secret. |
| `review-freeze` | in `aidlc-guard-tool-call` (writes and shells) | Refuses a write or shell mutation of a stage's reviewed output while a fresh terminal review receipt covers it, before the gate. Write tools reach the shared hook as Write/Edit with their target path and shell tools as Bash, with the chat's session; a delegated agent's own writes are judged the same way. An `execute_pwsh` command is read as PowerShell (backslash paths, `Set-Location`), here and in `state-transition-guard`. A call whose input cannot be read (a build older than Kiro IDE 1.1.70 or Kiro CLI 2.24.1 can send one with no arguments) is refused before the hook runs, inside or outside a workflow and with `AIDLC_DISABLE_REVIEW_FREEZE_HOOK=1`, with a line naming the supported builds. |
| `state-transition-guard` | in `aidlc-guard-tool-call` (writes and shells) | Refuses tool-call writes to AIDLC hooks, session controls, runtime records, and the audit trail, and direct `aidlc-state.ts` lifecycle verbs, pointing to `aidlc-orchestrate.ts report`. Kiro IDE names no delegated agent on its calls, so a delegate's calls get the conductor's rules. A call whose input cannot be read is refused the same way as for `review-freeze`. |
| `terminal-command-guard` | in `aidlc-guard-tool-call` (`execute_bash\|execute_pwsh\|shell`) | Fallback for empty-prompt IDE versions: runs the classified utility once and refuses the duplicate Windows shell call. On Windows it also refuses an `aidlc` command with a value that cmd.exe would split (see the Windows quotes row below) |
| `aidlc-write-audit-log` | `PostToolUse` (`fs_write\|str_replace\|fs_append`) | Logs artifact create/update, then fires applicable sensors (path from the tool result) |
| `aidlc-log-subagent` | `PostToolUse` (`^(subagent_.+\|invoke_sub_agent\|orchestrate_subagent)$`) | Records `SUBAGENT_COMPLETED` with the delegate's identity — one row per stage of an `orchestrate_subagent` pipeline. The matcher is broad so any delegate name reaches the adapter; the adapter drops the auxiliary `subagent_response` shell |
| `aidlc-after-shell` | `PostToolUse` (`execute_bash\|execute_pwsh\|shell`) | One card for the two hooks below, in this order |
| `rebuild-stage-graph` | in `aidlc-after-shell` | Recompiles the runtime graph (gated on the audit tail) |
| `sync-workflow-state` | in `aidlc-after-shell` | Forward-only sync of `Current Stage` from the latest `STAGE_STARTED` in the audit (the IDE surfaces no task payload to parse) |

`aidlc-session-end` has **no registration**: Kiro's `Stop` trigger fires at the
end of every assistant turn, not at conversation close, on both surfaces, so
registering it would append a spurious `SESSION_ENDED` between prompts in the
same session. No `SESSION_ENDED` is recorded until Kiro exposes a genuine
session-end event.

Kiro shows a "Run Command Hook" card each time one of these registrations runs: one before a file change, a command or a hand-off to another agent, one after a write or a command, none for a read, two for each message you send and one at the end of each turn.

### Debugging hooks

If a hook isn't behaving as expected, turn on debug logging and each hook
appends its decision path (which gate it took, the resolved paths, why it
exited) to `<record>/.aidlc-engine/hooks-health/hook-debug.log`. It is **off by
default** — no log is written and there is no overhead on a normal run. Two
ways to enable it, either works:

- **Filesystem marker (easiest on Kiro IDE):** `touch aidlc/.aidlc-hook-debug`
  (in PowerShell, `New-Item -ItemType File aidlc/.aidlc-hook-debug`)
  in your project. It takes effect on the very next hook fire — no IDE restart —
  and `rm aidlc/.aidlc-hook-debug` turns it back off.
- **Environment variable:** `export AIDLC_HOOK_DEBUG=1`. Hooks see the
  environment the IDE started with, so quit the IDE, then open it from a
  terminal where the variable is exported.
  On Windows, set it as a user variable in PowerShell instead,
  `[Environment]::SetEnvironmentVariable("AIDLC_HOOK_DEBUG", "1", "User")`,
  then quit and reopen the IDE (run it again with `$null` in place of `"1"` to
  turn it off).

## What's different on Kiro

| Area | Claude Code | Kiro IDE and Kiro CLI |
|------|-------------|----------|
| Hook registration | `settings.json` `hooks` block | `.kiro/hooks/aidlc-*.json` v2 hook files (Kiro IDE 1.x, Kiro CLI v3 engine) |
| Gates & questions | `AskUserQuestion` widget | Numbered prose options (reply with a number); the questions FILE with `[Answer]:` tags stays the source of truth |
| Statusline | Current stage + model + context % | Not available — use `/aidlc --status` and the progress line at each gate |
| Dispatched stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent) | `Task` tool | `invoke_sub_agent` (Kiro IDE) or `orchestrate_subagent` (Kiro CLI) → all 14 Markdown personas, each running under the `tools:` and deny rules in its own frontmatter and the conductor's command allow |
| Construction swarm | Parallel `Task` floor, optional ultracode Workflow | Subagent fan-out only; `AIDLC_USE_SWARM=1` is announced as a no-op |
| Session audit events | `SESSION_STARTED/RESUMED/ENDED`, `SESSION_COMPACTED` | `SESSION_STARTED` when a new session takes its first prompt, and on Kiro IDE `SESSION_RESUMED` when a prompt returns to an earlier chat (no genuine session-end trigger, so no `SESSION_ENDED`; no pre-compaction event) |
| MCP servers | Ships 5 (`.mcp.json`: `context7` + four AWS servers) | None shipped |
| Quotes in recorded text on Windows | Recorded as typed | Kiro IDE runs the agent's commands in Windows PowerShell 5.1, which drops empty arguments and removes a double quote inside a value unless it is written as `\"`. The agent writes quotes that way, so answers and feedback are recorded with their quotes. A value that also holds `&`, `<`, `>`, `^`, or a pipe sign is written with single inner quotes instead, because the `aidlc` command runs through cmd.exe, which would act on those characters; the hook refuses a command where one would reach cmd.exe outside its quotes. If a question or answer still arrives split in two, AI-DLC refuses to record it and says how to pass it, so the audit trail never keeps only part of it |
| Turning a guard, summary confirmation, or plan approval off mid-workflow | Ask in your own words and the agent runs the setter, or type the switch in chat, for example `/aidlc config set summary-confirmation off` | The same, except on Kiro IDE builds that give hooks an empty message (such as 1.0.242), which refuse the setter too. There, for summary confirmation or plan approval, run the terminal command the refusal names to turn it off now for all work, including the work running now (on a native install, `aidlc config flags --bypass AIDLC_DISABLE_SUMMARY_CONFIRMATION --local --yes` or `--bypass AIDLC_DISABLE_PLAN_APPROVAL_GUARD`; `--clear-bypass` turns it back on); for another guard, update Kiro IDE and type the switch |

Everything else — state machine, audit trail, artifacts under the per-intent
record dir (`aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`), the learnings
ritual, sensors, scopes, depth/test-strategy — behaves identically, because it
IS identical: native installs dispatch through `aidlc`, while source copies run
the corresponding tools from `.kiro/tools/`.

A project's `aidlc/` workspace is harness-neutral. Moving a project between
harnesses (or running both side by side) is supported-but-untested; `/aidlc
--doctor` will warn if it detects a conflicting harness setup with an active
workflow.

### Command cards end with "dministrator: ...powershell.exe" on Windows

On Windows, a Kiro IDE command card can end with a line such as
`dministrator: C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
once or twice. That is the terminal window's title, cut short by Kiro when it
shows the output. It does not change what the command did or what AI-DLC
records.

If you added `"terminal.integrated.windowsUseConptyDll": false` to Kiro's
settings, remove it and restart Kiro: it makes Kiro wrap command output, which
can stop Code Generation.

### Kiro memories carry old AI-DLC advice

Kiro IDE keeps memories outside your project, in `.kiro/memories/memories.db`
under your home folder (`%USERPROFILE%\.kiro\memories\memories.db` on Windows),
and can load them into every workspace you open. A memory an agent saved during
an earlier AI-DLC run can hold a diagnosis or workaround that only fit that
project and version, and is wrong or unsafe anywhere else: running a hook
command such as `record-human-turn` by hand, setting
`AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1`, turning summary confirmation off, or
calling Kiro IDE a "sessionless" harness. AI-DLC tells the agent never to save
such advice and never to act on it, but memories saved before that still load.

If the agent says "per my memory" and suggests one of these, or tells you to
resume "from Kiro IDE" while you are already in it:

1. Tell it to ignore that memory and follow what `/aidlc` says now. Guards and
   checkpoints are yours to switch: the agent names the command, you type it.
2. Delete only the memories that give that kind of advice: running an AI-DLC
   hook command by hand, setting a variable that skips a guard, turning a
   checkpoint off, calling Kiro IDE "sessionless", or telling you to resume
   from Kiro IDE while you are already in it. Keep the rest, including accurate
   Kiro IDE notes (for example that it has no status line), other AI-DLC notes,
   and debug tips such as `AIDLC_HOOK_DEBUG` (check Kiro's documentation for
   managing memories).
3. Keep a copy of `memories.db` before you delete anything, and close Kiro IDE
   first if you edit the file directly: it holds all of Kiro's memories, not
   only the AI-DLC ones.

## For framework developers

`dist/kiro-ide` is **generated** from `core/` + `harness/kiro-ide/` by
`bun scripts/package.ts kiro-ide` (core copy with the `{{HARNESS_DIR}}` token
substituted to `.kiro` and the `rules/` → `steering/` rename). The output is
ignored and local. `bun scripts/package.ts --check` builds twice in independent
temporary roots and byte-compares the results as the CI determinism guard. The
authored
Kiro IDE surfaces live in `harness/kiro-ide/`: the orchestrator skill
(`skills/aidlc/`), always-included active-memory steering (`steering/`),
the conductor Markdown (`agents/aidlc.md`), the hook adapter and v2 hook JSON
files (`hooks/`), the personas' delegate shell deny (`delegate-shell-deny.ts`),
and onboarding fills — edit those
(or `core/`), never hand-edit the generated `dist/kiro-ide`.

This harness differs from the `kiro` CLI harness (`harness/kiro/`) in four ways:
the `/aidlc` skill and the Markdown `agents/aidlc.md` are its conductor surfaces
(`settings/cli.json` also makes that agent Kiro CLI's default); it ships v2 hook
JSON files (the `kiro` harness relies on the agent-JSON `hooks` block); it preloads standing rules through
always-included steering rather than CLI agent resources; the shared Kiro
projection removes the core persona's Claude-only `disallowedTools` key; and
its manifest adds `tools:` and `permissions.rules` frontmatter to every persona.
It does not ship the `kiro` harness's agent-v1 JSON.
See [Porting to a New Harness](../../harness-engineering/09-porting-to-a-new-harness.md).

## Next steps

Installed and activated? The methodology is the same on every harness — keep
going with the neutral chapters:

- [Your First Workflow](../02-your-first-workflow.md) — an annotated end-to-end run.
- [Phases and Stages](../04-phases-and-stages.md) — the 5 phases and 33 stages.
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) — right-sizing a run.
- [Glossary](../glossary.md) — every term defined.

Other harnesses: [AI-DLC on Codex CLI](codex-cli.md) · [AI-DLC on Cursor](cursor.md) · [the harness family index](README.md).
