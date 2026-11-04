# AI-DLC on Google Antigravity

The Antigravity runtime is one of the framework's harness distributions, for
[Google Antigravity](https://antigravity.google). One tree serves every surface
that runs the Antigravity agent: the **Antigravity IDE** and the **Antigravity
CLI** (`agy`): they share the same workspace-local
customization root, `.agents/`. One deterministic core, many harnesses: the
engine, state machine, audit log, graph, swarm referee, and learnings gate are
byte-identical across every distribution - only the shell differs. The
source/development tree is **generated** into ignored local `dist/antigravity/`
from `core/` + `harness/antigravity/` by `bun scripts/package.ts antigravity`;
never hand-edit it.

Harness-specific onboarding lives in `.agents/rules/aidlc-onboarding.md`,
loaded automatically through `trigger: always_on`. The root `AGENTS.md` block
is harness-neutral and shared with other installed harnesses whose engine
directories differ.

## Layout

Antigravity consumes the standard core projection directly (no `emit.ts`, no
split dot-dir), the way Cursor does. The distribution is:

- **`.agents/`** - the framework tree. Antigravity reads only a few subdirs as
  native meaning: `rules/` (the always-on onboarding and standing method
  pointer, four model-decided phase pointers), `agents/` (the 14 personas as
  native subagents), `skills/` (the orchestrator, utility shortcuts, and
  generated stage runners), `hooks.json` + `hooks/` (the hook wiring and
  adapter), and `plugins/` (if you add one). The engine dirs beside them
  (`tools/`, `aidlc-common/`, `knowledge/`, `sensors/`, `scopes/`) are inert
  data to Antigravity and safely share the directory.
- **`aidlc/`** - the workspace shell (the pre-built
  `aidlc/spaces/default/memory/` method tree the engine reads), a sibling of
  `.agents/`.
- **`AGENTS.md`** - project-root ambient instructions Antigravity auto-reads.

## Prerequisites

- **Antigravity** - the IDE or the CLI (`agy`). Both read
  this install's `.agents/` surfaces. Verified against agy cli-2026.10; hooks
  (`.agents/hooks.json`), skills (`.agents/skills/`) and Markdown agents
  (`.agents/agents/`) are current-line features.
- **A trusted folder** - Antigravity loads a workspace's `.agents/hooks.json`
  once the folder is trusted, and without the hooks your approvals are never
  recorded. Trust the folder when Antigravity asks (or add it to
  `trustedWorkspaces` in your Antigravity settings), then send your next
  message in the same chat.
- **bun** only for source development or a copy-channel install. Once
  installed, native and versioned release runtimes invoke `aidlc`.
- **Model access comes with your Antigravity session.** The tiered persona
  surfaces ship with **no model pins** (all tiers project to null on
  Antigravity), so every agent inherits the model you chose in the model
  picker; AI-DLC configures no model provider for this harness.
- **Not beside Codex CLI.** Codex discovers its skills in the same
  `.agents/skills/` tree, so the two harnesses cannot be installed in the
  same project; `aidlc config` and `/aidlc --doctor` say so.

## Install

### Native channel (recommended)

Install the native command as described in
[Install and Lifecycle](../18-install-and-lifecycle.md), then:

```bash
cd your-project
aidlc config --harness antigravity
aidlc doctor
```

### Versioned manual-copy alternative

Download and extract a specific release's `aidlc-copy-runtime-X.Y.Z.tar.gz` as
described in
[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel),
then copy `runtime/antigravity/.agents/` and `runtime/antigravity/aidlc/` into
your project and add the shipped `.gitignore` and `AGENTS.md` blocks (their
text is under `.agents/tools/data/root-blocks/`). The `aidlc/` shell ships the
pre-built `aidlc/spaces/default/memory/` method tree the engine reads;
`/aidlc --doctor` fails its "workspace shell ready" check without it.

Open the project in Antigravity (or start `agy` in it) and run
`/aidlc --doctor`, then `/aidlc` followed by what you want to build. Native
utility shortcuts are `/aidlc-status`, `/aidlc-jump --stage <slug>` (or
`--phase <name>`), and `/aidlc-scope <name>`.

## What's different on this harness

- **Questions render through the native `ask_question` modal.** The
  orchestrator folds each spec's header into the question text and each
  option's description into its option string (`<label> - <description>`);
  the modal supplies the write-in row itself, and summaries plus clickable
  `[basename](file:///absolute/path)` artifact links go inside the question text
  so they stay visible above Antigravity's `"Agent work"` accordion. The
  questions FILE with `[Answer]:` tags remains the source of truth, and the
  recorded answer is the label alone.
- **Hooks ride `.agents/hooks.json`** through the AIDLC adapter
  (`.agents/hooks/aidlc-antigravity-adapter.ts`), which maps Antigravity's
  named hooks (`SessionStart`, `PreInvocation`, `PreToolUse`, `PostToolUse`,
  `Stop`) onto the byte-shared core hook bodies (run as bun subprocesses): the
  state-transition, reviewer read-scope, review-freeze, and plan-approval
  guards before a tool runs, audit + sensors on write/edit, stage-graph
  rebuilds after shell commands, and the forwarding-loop check at a stop. The
  **PreToolUse guards** answer on Antigravity's `{"decision":"allow"|"deny"}`
  stdout channel (`deny` adds `reason`); an empty answer is a deny on this
  host, so every allow path says so. Malformed hook input denies the call, exit
  `2` from a guard denies with its message, and an unexpected guard failure
  lets the call through while recording a hook drop for `/aidlc --doctor`. A
  hook runs with `.agents/` as
  its working directory, so each wired command steps up to the project root
  first. Antigravity names its tools by step type (`run_command`,
  `view_file`, `write_to_file`, `replace_file_content`, `invoke_subagent`,
  ...); the adapter maps them, and their `TargetFile` / `CommandLine` / `Cwd`
  arguments, onto the core hooks' Claude-shaped contract.
- **Your turn is read from the transcript.** Antigravity has no
  prompt-submit event. The adapter reads the conversation transcript the host
  names on every `PreInvocation` (and again before a guarded tool call) and
  records a human turn for each new `USER_INPUT` step the person typed
  themselves and each completed `ask_question` modal answer (`ASK_QUESTION` or
  `GENERIC` transcript step). A parent woken by its delegate's report, and a
  delegate's own first step, are system messages, so they never count as a
  human turn.
- **Forwarding-loop enforcement is live.** Antigravity's `Stop` hook can
  refuse a stop (`{"decision":"continue","reason"}`), so a turn that ends with
  a directive pending is sent back into the loop, under the core's own
  no-progress cap. A stop while a delegate the conductor dispatched is still
  working (`fullyIdle: false`) is a legitimate wait and is let through.
- **No session-end and no pre-compaction moment.** Antigravity fires neither
  event, so `SESSION_ENDED` audit events are not emitted and state validation
  runs through the engine's own checks instead of before compaction.
- **Personas are native subagents.** The 14 persona `.md` files in
  `.agents/agents/` are discovered by frontmatter `name`; the conductor adopts
  them inline for most stages and delegates via the `invoke_subagent` tool
  (the persona's name is its `TypeName`) for the two subagent stages (2.1
  reverse-engineering, 3.5 code-generation). The manifest injects each
  persona's tool allowlist (an Antigravity agent with no `tools:` line gets
  only the read-only default set) and keeps every delegation tool out of it,
  so a delegate cannot delegate again; `mainAgent: false` keeps the personas
  out of the main-agent picker.
- **Subagent identity is reconstructed.** A delegate runs in its own
  conversation, whose hooks fire like a main chat's, with no identity on the
  payload. The adapter keeps a protected project-local ledger under
  `aidlc/.aidlc-antigravity-subagents/`: each `invoke_subagent` dispatch
  records its persona and prompt, each conversation is classified from its
  own transcript (a delegate's opens with the dispatch, never with a message
  the person typed) and attributed to the dispatch whose prompt it carries,
  and reviewer read-scope enforcement keys on that attribution. Genuine
  ambiguity while a dispatch is live stays conservative, so it cannot disable
  reviewer-scope enforcement; when the reviewer read-scope and
  state-transition checks both stand aside for the piece of work (Guard
  Policy off does that), delegates run as the main conversation does. A
  delegate's stop retires its record and logs the subagent's completion.
- **Utility shortcuts are native skills.** `/aidlc-status`, `/aidlc-jump`, and
  `/aidlc-scope` improve slash-menu discovery without creating a second engine
  path.
- **Method rules are read instructions, not imports.** Antigravity rules do
  not expand `@`-import lines. `.agents/rules/aidlc.md` is always on and
  points at `aidlc/active-memory/{org,team,project}.md`; four
  `.agents/rules/aidlc-phase-*.md` files carry `trigger: model_decision` so
  phase guidance loads only when relevant. `aidlc/active-memory/` is the
  engine's git-ignored copy of the active space's method, refreshed at
  session start, on `/aidlc space <name>`, and with each step whose rules it
  sends. Each Antigravity rule file is capped at 24,000 bytes by the host;
  the onboarding rule ships well under it.
- **There is no statusline and no welcome message**; use `/aidlc-status`
  (or `/aidlc --status`) and the progress lines at gates.
- **Headless `agy -p` runs** cannot answer a permission prompt and run their
  shell commands in a sandbox, so they suit the read-only utilities
  (`--status`, `--doctor`, `--version`) only; gated workflows need an
  interactive session regardless.
- **Construction swarm** runs as `invoke_subagent` fan-out only
  (`AIDLC_USE_SWARM=1` is a loud no-op).
- **Plugins** project as Antigravity plugins: a `.antigravity-plugin/plugin.json`
  manifest and a `hooks.json` at the plugin root whose `SessionStart` hook
  composes the plugin into the install.

## Verification

- `/aidlc --doctor` (or `aidlc doctor` in a terminal) checks the hook wiring,
  the rule pointers, the persona files, and that no Codex install sits beside
  this one.
- `bun scripts/package.ts --check` (source tree) proves the generated
  `.agents/` tree is byte-identical across two clean builds.
- The adapter contract test (`tests/unit/t-antigravity-adapter.test.ts`) pipes
  live-captured Antigravity payloads through the adapter and asserts the
  observable core-hook effect.
