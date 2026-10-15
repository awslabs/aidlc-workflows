# Getting Started

This page takes you from nothing to your first approved stage: install AI-DLC,
set up a project with `aidlc config`, check it with `aidlc doctor`, then run
`/aidlc` in Claude Code up to the first approval. Every screen below comes from
a real run in a fresh home folder, trimmed where it says so. In the
samples, `X.Y.Z` stands for the release you installed, `/home/you` for your home
folder, and Claude Code's drawing characters (boxes, arrows, ticks) are shown as
plain text or left out. The other tools differ in a few steps, listed in
[On the other tools](#on-the-other-tools).

## Before you start

- **A harness, installed and signed in.** This page uses Claude Code. For three
  tools AI-DLC checks the oldest version it works with, and `aidlc doctor` says
  when yours is older:

  | Tool | Oldest version |
  | --- | --- |
  | Codex CLI | 0.145.0 |
  | GitHub Copilot CLI | 1.0.74 (VS Code-only installs may omit the CLI) |
  | Kiro CLI | 2.6.0 for the `kiro` row; 2.24.1 for the `kiro-ide` row |

- **Git, for Codex CLI and Cursor.** Codex CLI finds a project's hooks only in
  a Git repository, and Cursor may skip them outside one, so run `git init` in
  a new folder before `aidlc config`.
- **Nothing else.** The native installer brings everything AI-DLC runs; you do
  not need Bun or Node.js.

## 1. Install AI-DLC

macOS, Linux, or WSL:

```bash
curl -fsSL https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.ps1 | iex
```

The installer sets up everything AI-DLC needs: the native `aidlc` command and
every harness runtime. You do not need to install Bun or Node.js; a native
install runs its hooks and commands through `aidlc` and does not call `bun`. On
Windows, it installs for the current account, registers the bin directory in
persistent User PATH, and updates the current PowerShell process. Run it from a
normal PowerShell window; one opened with "Run as administrator" gets a warning
and a prompt, since installing as administrator is less safe. A terminal app or IDE that was already open (Kiro, VS Code, Cursor) keeps the PATH it started with, so quit and reopen it before using `aidlc` there; a new tab inside it is not enough.
Use [`-NoModifyPath`](18-install-and-lifecycle.md#windows-powershell) to skip
both PATH changes and invoke the printed direct command instead. On macOS,
Linux, or WSL, apply the installer's PATH instruction if `aidlc` is not found.

On macOS and Linux it ends like this when `~/.local/bin` is already on your
PATH:

```text
PASS installed AI-DLC X.Y.Z with all harness runtimes
Next: aidlc config
```

and like this when it is not:

```text
PASS installed AI-DLC X.Y.Z with all harness runtimes
Add AI-DLC to PATH for this shell:
  export PATH="/home/you/.local/bin:$PATH"
Then run: aidlc config
```

Run the `export` line it printed (add it to your shell's startup file to keep
it), then check the command:

```text
$ aidlc version
aidlc X.Y.Z (runtime X.Y.Z)
```

Before those lines, a download prints one `Downloaded <file>` line per release
file, and a machine without a recent GitHub CLI also prints
`WARN GitHub CLI attestation verification is unavailable; continuing with SHA-256 release checksums.`
The SHA-256 checks always run; the GitHub CLI adds the signed-provenance check
([Release Authentication](18-install-and-lifecycle.md#release-authentication)).
On Windows the installer's own result starts with `Installed AI-DLC X.Y.Z`, and
the paths in later screens use Windows separators, such as `.claude\`.

Prefer to manage the project files yourself, or cannot install a native
executable? The manual-copy path is the one place Bun is needed: install
[Bun](https://bun.sh/), download `aidlc-copy-runtime-X.Y.Z.tar.gz` from the
[release](https://github.com/awslabs/aidlc-workflows/releases/latest), copy
the complete `runtime/<harness>/` directory into the project, and run its own
setup once, as [Copy Channel](18-install-and-lifecycle.md#copy-channel) shows.
A copy never replaces your `.gitignore` or `AGENTS.md`; AI-DLC adds its own
lines to them. The manual-copy path does not require the native `aidlc`
command.

## 2. Set up your project

Run `aidlc config` in the project folder. AI-DLC does not look upward for a git
root, so this folder is where `aidlc/` will live; with several repos, see
[Where `aidlc/` lives](03-spaces-and-intents.md#where-aidlc-lives). This run uses
a new, empty folder:

```text
$ mkdir inventory-api && cd inventory-api && git init -q
$ aidlc config

  AI-DLC setup - first run in this project.

  Checked your machine and this repo:

    Harness    Claude Code detected  (2.1.296 on your PATH)
    Project    git repo, no AI-DLC files yet
    AWS        credentials not found
    Runtime    aidlc on this shell's PATH only: start Claude Code from a terminal

  Set up AI-DLC for Claude Code with recommended defaults?

    1. Yes, use recommended defaults   MCP servers on, all plugins, current model provider
                                       preserved
                                       Records balanced (default): medium project agent effort for
                                       deciding, reviewing, and writing up; your session
                                       (conductor) effort stays unchanged.
    2. No, customize step by step      harness, provider, preset, plugins, MCP, record layer
    3. Exit, nothing written

  Choice [1]:
```

Nothing is written before you answer. What it checked:

- **Harness**: the tool it found on your PATH, which it sets up for. With
  several, it asks which one first; with none, see
  [Set up before you install a harness](#set-up-before-you-install-a-harness).
- **Project**: whether this is a Git repository and whether AI-DLC is already
  set up here. In a project that is set up, `aidlc config` checks what is in
  place instead of asking these questions
  ([Configure or Refresh a Project](18-install-and-lifecycle.md#configure-or-refresh-a-project)).
- **AWS**: whether it found AWS credentials, which matters only if you choose
  Amazon Bedrock as the model provider.
- **Runtime**: whether AI-DLC's hooks can find the `aidlc` command. Claude Code
  started from a terminal hands that terminal's PATH to the hooks, so `aidlc`
  on your shell's PATH is enough, and the line says to start it from a
  terminal; a PATH fix it counts here is shown at the end of setup. If you
  start Claude Code from a desktop icon instead, `aidlc doctor` says what to
  add, in step 4.

Press Enter for the recommended defaults. They record:

- **MCP servers on**: a `.mcp.json` with the five
  [shipped servers](#mcp-servers-optional).
- **All plugins**: every installed plugin is enabled.
- **Current model provider preserved**: AI-DLC writes no provider settings, so
  Claude Code keeps the provider and login you already use.
- **The balanced preset**: in `aidlc.settings.json`, the effort AI-DLC's own
  agents use; your own chat keeps its model and effort
  ([Choosing a Model and Effort](18-install-and-lifecycle.md#choosing-a-model-and-effort)).

Then it asks one more question, about Claude Code's status line:

```text
  Show AI-DLC's progress in your status line? It takes the place of your own while you work in this
  project.

    1. Yes  (recommended)
    2. No, keep mine

  Choice [1]:

  AI-DLC's status line shows in this project; /aidlc --statusline off turns it off.

  Writing project files ... done  (.claude/ and aidlc/, 316 files)
  Recording model preset ... done  (aidlc.settings.json in this project)
  Setup complete. Start your first workflow:

    claude                         open Claude Code in this repo
    /aidlc "what you want built"  describe your first intent
```

Your answer goes in `.claude/settings.local.json` and
`aidlc.settings.local.json`, which are yours alone (both are git-ignored).

### Customize instead

Choice 2 walks six steps; Enter takes the `[default]` each time. This run kept
every default except the provider, where it chose Amazon Bedrock:

```text
  Customize setup - 6 steps, Enter accepts the [default].

  Step 1 of 6 - Harness
  Detected on this machine: Claude Code.

    1. Claude Code     (detected, default)
    2. Codex CLI
    3. GitHub Copilot
    4. Cursor
    5. Kiro CLI (V2)
    6. Kiro            Kiro IDE and Kiro CLI on its v3 engine
    7. opencode
  Harness [1]:
  Using Claude Code.

  Step 2 of 6 - Model provider
  No AWS credentials were detected.
    1. keep current     inherit the provider already configured in the harness (default)
    2. amazon-bedrock   write the AWS region and profile to settings.json
  Provider [1]: 2
  AWS region [us-east-1]:
  AWS profile [default credential chain]:
  Using amazon-bedrock in us-east-1 with the default credential chain.

  Step 3 of 6 - Model effort preset
    1. balanced    medium effort for deciding, reviewing, and writing up (recommended, default)
    2. thorough    session effort for deciding and writing up, extra-high reviewing
    3. minimal     medium deciding and reviewing, low writing up
    4. unchanged   records no preset and keeps existing settings; new projects use shipped defaults
                   where agents inherit your session's model and effort
  Preset [1]:
  Using the balanced preset.

  Step 4 of 6 - Plugins
    1. all installed   (default)
    2. none optional   core AI-DLC only
    3. choose          comma-separated installed names
  Plugins [1]:
  Using all installed plugins.

  Step 5 of 6 - MCP servers
    1. on
    2. off
  MCP [1]:
  MCP servers on.

  Step 6 of 6 - Where to record the model preset
    1. this project, committed     aidlc.settings.json - shared with your team  (default)
    2. this project, just for you  aidlc.settings.local.json - gitignored
    3. this machine                every project you set up here
  Preset in [1]:
  Recording the model preset in this project, committed.

  Your choices - Enter to apply, or a number to change:
    1. Harness      Claude Code
    2. Provider     amazon-bedrock, us-east-1, default credential chain
    3. Preset       balanced
    4. Plugins      all installed
    5. MCP          on
    6. Preset in    this project, committed
  Apply? [Y/n]:
```

What each step writes:

| Step | Writes |
| --- | --- |
| 1. Harness | Which tool's files to set up (`.claude/` for Claude Code). |
| 2. Model provider | `keep current` writes nothing. `amazon-bedrock` adds `CLAUDE_CODE_USE_BEDROCK` and `AWS_REGION` (and the profile, when you name one) to the `env` block of `.claude/settings.json`. |
| 3. Model effort preset | The preset name in the file step 6 picks; `unchanged` records none. |
| 4. Plugins | Which installed plugins are on. |
| 5. MCP servers | `.mcp.json` with the shipped servers, or none. |
| 6. Where to record the preset | `aidlc.settings.json` (committed), `aidlc.settings.local.json` (git-ignored), or this machine's settings for every project. |

`Apply?` takes a step number to change that answer, `n` to stop with nothing
written. After the status line question, Bedrock leaves one step that only you
can do:

```text
  One thing needs you - it can't be done automatically:

    Verify Amazon Bedrock model access in the recorded region and confirm the AWS principal has
    bedrock:InvokeModel permission.
    fix: aidlc config providers --check
```

### Without questions

A script, CI, or a terminal without a prompt gets no wizard. Every harness
runtime is installed, so name yours. `--yes` confirms; it does not turn the MCP
servers on (add `--mcp defaults` for that):

```text
$ aidlc config --harness claude --mcp defaults --yes
configured /home/you/ci-demo for Claude Code X.Y.Z; next: open Claude Code in this project (if it is already open in this folder, exit it and start it again) and run `/aidlc --doctor`
```

On Kiro IDE, `--yes` also takes the recommended answer to the two questions
setup asks there about Kiro settings for all your projects: it turns Kiro's
Workflows feature off (while it is on, AI-DLC's reviews and helpers do not run)
and, when Command Prompt is Kiro's terminal on Windows, sets it to PowerShell.
To turn Workflows back on, run
`aidlc config trust --harness kiro-ide --kiro-workflows on --yes`.

Without `--harness`, it stops before writing anything:

```text
$ aidlc config < /dev/null
error: multiple harnesses are installed; pass --harness <claude|codex|copilot|cursor|kiro|kiro-ide|opencode>
fix: aidlc config --harness <name>
```

To see what config would do before it writes anything, preview it. At a
terminal it asks for the harness and the MCP choice; elsewhere name the harness:

```text
$ aidlc config --harness claude --dry-run
config plan for /home/you/ci-demo: create=330 update=0 merge=0 preserve=1 remove=0 conflict=0
```

A setup without questions records no model preset, so AI-DLC's agents use the
shipped defaults. Every question has a flag:
[Config Options](18-install-and-lifecycle.md#config-options) and `aidlc config <section> --help`.

### Set up before you install a harness

When no supported tool is on your PATH, the wizard first asks which one to set
up, with no default:

```text
  No supported harness CLI was detected. Choose one to configure:

    1. Claude Code
    2. Codex CLI
    3. GitHub Copilot
    4. Cursor
    5. Kiro CLI (V2)
    6. Kiro            Kiro IDE and Kiro CLI on its v3 engine
    7. opencode
  Harness [1-7]:

  That's not one of the choices - enter 1, 2, ... or 7.
  Harness [1-7]: 1
  Using Claude Code.
```

The rest is the same, with `Claude Code selected` in place of `detected`.

## 3. What config left in your project

```text
$ git status --short
?? .claude/
?? .gitignore
?? .mcp.json
?? aidlc.settings.json
?? aidlc/
```

| Path | What it is | Commit it? |
| --- | --- | --- |
| `.claude/` | Claude Code's AI-DLC files: the `/aidlc` skill, agents, stages, hooks, tools, and `settings.json` (hooks, permissions, the welcome message) | Yes |
| `aidlc/` | AI-DLC's records: `aidlc/spaces/default/memory/` holds the rules (the framework's defaults, and your team's and project's own), and each piece of work gets its record here | Yes |
| `.gitignore` | AI-DLC's own marked block, added to yours if you had one | Yes |
| `.mcp.json` | The MCP servers, when you chose them | Yes |
| `aidlc.settings.json` | The model preset | Yes |
| `aidlc.settings.local.json`, `.claude/settings.local.json` | Your own choices (here, the status line) | No, git-ignored |

Commit the first five so your team gets the same setup:
`git add .claude aidlc .gitignore .mcp.json aidlc.settings.json && git commit -m "Set up AI-DLC"`.
Run `aidlc config` again at any time to refresh the files from your installed
release; it keeps what you edited
([Configure or Refresh a Project](18-install-and-lifecycle.md#configure-or-refresh-a-project)).

## 4. Check it

One fix line is shortened here:

```text
$ aidlc doctor
AI-DLC doctor

Machine
  warn  Runtime hook PATH: aidlc is on this shell's PATH (/home/you/.local/bin/aidlc) but not on the system-wide PATH
        fix: Nothing needs changing when you start Claude Code from a terminal: it hands that terminal's PATH to AI-DLC's hooks. If you start it from a desktop icon, the dock, or a service and AI-DLC's hooks do not run, add /home/you/.local/bin to the PATH line in /etc/environment, ENV_PATH in /etc/login.defs, or a PATH= line in ~/.config/environment.d/*.conf, then restart Claude Code. Editing .bashrc or .zshrc does not change this check.
  ok    9 checks passed

Project (.claude, Claude Code)
  warn  AIDLC hooks have not run in this project yet
        fix: This is expected before your first Claude Code chat in this folder. ...
  warn  Workspace records: 8 uncommitted change(s) under aidlc/ (advisory - the shared records travel by git; commit & push so teammates get them: `git add aidlc/ && git commit && git push`)
        fix: add --verbose to see the details, correct the named condition, then run doctor again
  ok    49 checks passed

Framework integrity
  ok    all 12 checks passed

0 problems, 3 warnings.
Warnings are advisory - if everything works, ignore them.
Add --verbose to see every check.
```

On a new project these three warnings are expected: the first matters only if
you start Claude Code from a desktop icon, the second clears after your first
chat, and the third after you commit. A `fail` row is a real problem and comes
with its fix. Inside Claude Code, `/aidlc --doctor` runs the same check.

## 5. Your first run in Claude Code

Start Claude Code in the project:

```text
$ claude
```

The first time in a new folder, Claude Code asks whether you trust it, and
lists the commands AI-DLC's settings let run without asking:

```text
 Accessing workspace:

 /home/you/inventory-api

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a
 well-known open source project, or work from your team). If not, take a moment to review what's in
 this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 ! This folder pre-approves 45 tool permissions in .claude/settings.json:
   WebSearch, Edit(/**), Bash(aidlc engine *), Bash(aidlc doctor), Bash(aidlc doctor --verbose),
 Bash(aidlc version), Bash(aidlc --doctor), Bash(aidlc --doctor --verbose), and 37 more
 These will apply without asking. Only proceed if you trust this configuration.

 > No, exit
   Yes, I trust this folder
```

For your own project, choose **Yes, I trust this folder**. With MCP servers on,
Claude Code then asks which of the five servers in `.mcp.json` to enable; enable
the ones you have credentials for, or press Esc to skip them all. AI-DLC works
either way.

At start, Claude Code shows AI-DLC's welcome message. Under its AI-DLC heading
it says "Run `/aidlc` to start or resume a workflow. Describe what to build and
AI-DLC proposes a plan for you to confirm.", then lists the phases, the stages,
and the scopes (the ready-made plans) with the stages each one runs.
On the very first start Claude Code may show its own notice instead and say
`1 more notice hidden`; the welcome shows at a later start.

Now describe what you want built:

```text
> /aidlc Build a REST API for inventory management
```

The agent reads your words and proposes a plan, a ready-made set of stages for
this kind of work. Here it picked `mvp`; your words may get another:

```text
 Plan
 I'd run the "mvp" plan for: "Build a REST API for inventory management" - 19 stages, 19 approval
 gates, 5 stages repeat per unit of work in Construction. Do you want me to go ahead with it, use
 a different plan, or tailor one to this task?
 > 1. Go ahead with the "mvp" plan
      19 stages: skips operations and ships the core API.
   2. Use a different plan
      Pick another ready-made plan (e.g. classic, feature, express, poc).
   3. Tailor a plan to this task
      Have a plan composed specifically for this work.
   4. Type something.
   5. Chat about this
```

Go ahead starts the work. **Use a different plan** lists the others with their
length, and you pick one or type its name:

```text
 Plan
 Which plan would you like for the inventory REST API?
 > 1. classic (14 stages)
      V1-style ceremony through Inception and Construction - the implicit default.
   2. feature (29 stages)
      Full lifecycle for new features, practical depth.
   3. express (6 stages)
      Lightest run: requirements to deploy, no design pass, no reviewers.
   4. poc (4 stages)
      Prove feasibility fast.
   5. Type something.
   6. Chat about this
```

This run typed "mvp after all" there and went on with `mvp`.
[Workflow Profiles](workflow-profiles.md) describes each plan. **Tailor** has
the agent propose a plan of its own from your words.

Every question also offers **Type something** (your own answer) and **Chat
about this**; the screens below leave those two out, except on the stage's
first question.

AI-DLC then creates the record for this piece of work and starts the first
stage, Intent Capture. Its first question is how you want to answer the
stage's questions:

```text
 Answer mode
 I've created 8 questions at
 aidlc/spaces/default/intents/261013-inventory-rest-api/ideation/intent-capture/intent-capture-questions.md.
 How would you like to answer them?
 > 1. Guide me
      Walk through each question interactively here
   2. I'll edit the file
      Fill in the answers in the file directly
   3. Chat
      Discuss freely; I'll extract the decisions from the conversation
```

You choose once; later stages use the same answer and say so in one line
("Answering the way you chose earlier: Guide me. Say if you'd rather edit the
file or chat."). With **Guide me**, the questions come a few at a time, each
with its options. The top line lists them; after the last one, **Submit** shows
your answers for review and **Submit answers** sends them:

```text
 < [ ] Q1 Problem  [ ] Q2 Users  [ ] Q3 Success  [ ] Q4 Trigger  Submit >
 Q1. What business problem should the inventory API solve first? (If it's not defined yet, pick
 "Type something" and say so.)
 > 1. Stock counts drift
      A. We don't know accurately what stock we have (counts drift, spreadsheets go stale)
   2. Stock-outs / overstock
      B. Levels aren't visible in time to reorder
   3. Shared source of truth
      C. Other systems (shop, ordering, warehouse tools) need one reliable source of stock data
   4. Multi-location tracking
      D. Tracking stock across several locations is manual and error-prone
   5. Type something.
   6. Chat about this
```

Pick an option with the arrow keys and Enter, or choose **Type something** to
answer in your own words; a question that says "Select all that apply" takes
several. When every question is answered, the agent reads your answers back
for one confirmation before it writes anything:

```text
 Confirm
 - Problem: other systems need one shared, reliable source of stock data (Q1)
 - Callers: internal staff tools and an online store / ordering system (Q2)
 - Success: at least one real consumer system integrated and using the API in daily work (Q3)
 - Trigger: a new business or product line that needs inventory tracking from day one (Q4)
 - Stakeholders: just you; you decide scope and priority; no progress reporting needed (Q5-Q7)
 - Out of the first version: supplier purchasing / automatic reorder, and any user interface (API
 only) (Q8)

 Does this all look correct before I generate the artifact?
 > 1. Looks correct
      Generate the artifact from these answers
   2. Request changes
      Revise one or more answers before generation
```

Then it writes the stage's documents. When they rest on assumptions your
answers did not settle, it asks whether to keep them as assumptions or turn
them into questions. A reviewer agent reads the main document, and the last
question before the approval is whether anything from this stage is worth
remembering next time:

```text
 Notes
 Anything to add for next time?
 > 1. Nothing to add
      Move on to the approval for this step
   2. Add a note
      Record something AI-DLC should remember for future runs
```

Then the first approval (trimmed: the source-check lines, the review file's
path and two of the three findings are left out):

```text
Intent Capture & Framing is ready for your review. It produced intent-statement.md,
stakeholder-map.md and intent-capture-questions.md (8 questions, all answered), in
aidlc/spaces/default/intents/261013-inventory-rest-api/ideation/intent-capture/.

Stage: Intent Capture & Framing
Review outcome: Concerns remain for your decision.

| ID   | Severity | Where                                      | Status |
|------|----------|--------------------------------------------|--------|
| R-01 | Minor    | intent-statement.md > Initial Scope Signal | New    |
| R-02 | Minor    | intent-statement.md > Initiative Trigger   | New    |
| R-03 | Minor    | intent-statement.md > Success Metrics      | New    |

> R-03 Finding: The table carries a single, binary success metric ("at least one real consumer
  system integrated and uses the API in daily work") with no accuracy, timeliness, or
  adoption-breadth dimension, ...
> R-03 Required action: Human should confirm at the gate that a single integration-adoption
  metric is sufficient, or ask a follow-up to add a data-accuracy or reliability metric before
  inception begins.

Decision options:
- Approve - continue with the open findings accepted.
- Request Changes - return to the listed artifacts so the required actions can be addressed.

Review: aidlc/spaces/default/intents/261013-inventory-rest-api/ideation/intent-capture/

The two wording points (R-01, R-02) are things I added that you didn't confirm, and they're easy
to remove. R-03 is your call: one success measure is enough, or you may want to add one for stock
accuracy. After you approve, the next step is Feasibility & Constraints.

 Approval
 Intent Capture & Framing complete. How would you like to proceed?
 > 1. Approve
      Continue to Feasibility & Constraints
   2. Request Changes
      Provide revision feedback
```

The documents are in the folder it names; open them before you decide.
**Approve** moves on and accepts the open findings; **Request Changes** sends
the stage back to address them (say what to change, or that you want the
follow-up question). This run approved:

```text
Progress: 1 of 19 stages done. Next: Feasibility & Constraints.
Now working on Feasibility & Constraints, wearing the architect hat.
```

The record for this piece of work now holds (trimmed to the main files):

```text
aidlc/spaces/default/intents/261013-inventory-rest-api/
  aidlc-state.md                 where the work stands
  audit/                         every question, answer and approval, as it happened
  project-description.json       your request, word for word
  ideation/intent-capture/       intent-statement.md, stakeholder-map.md,
                                 intent-capture-questions.md, reviews/review-01.md
  ideation/feasibility/          the next stage, under way
```

From here each stage follows the same rhythm: questions, documents, a review,
your approval. [Your First Workflow](02-your-first-workflow.md) explains each
part of that rhythm; [Worked Examples](16-worked-examples.md) follows whole
runs.

## On the other tools

The steps are the same everywhere; these differ:

| Harness | Config value | Open | Invoke |
| --- | --- | --- | --- |
| Claude Code | `claude` | `claude` | `/aidlc` |
| Kiro (Kiro IDE, Kiro CLI on v3) | `kiro-ide` | Open the project, then choose **aidlc** in the chat panel's agent picker, or run `kiro-cli` in the project | `/aidlc` |
| Kiro CLI (V2) | `kiro` | `kiro-cli chat` | `/aidlc` |
| Codex CLI | `codex` | `codex` | `$aidlc` |
| Cursor | `cursor` | Open Cursor or run `agent` | `/aidlc` |
| opencode | `opencode` | `opencode` | `/aidlc` |
| GitHub Copilot CLI / VS Code | `copilot` | Copilot CLI or VS Code | `/aidlc` |

After config, complete the one step config names for your tool:

| Harness | Typical action |
| --- | --- |
| Claude Code | If Claude Code is already open in this folder, exit it and start it again |
| Kiro (Kiro IDE, Kiro CLI on v3) | Open the configured project, then choose **aidlc** in the chat panel's agent picker, or start `kiro-cli` in the project |
| Kiro CLI (V2) | Start `kiro-cli chat`; the project selects the AI-DLC agent |
| Codex CLI | Approve the hook trust prompt or apply the generated trust seed |
| Cursor | Open the configured project or run `agent` |
| opencode | Start `opencode` in the project |
| GitHub Copilot | Trust the project folder |

The welcome message is Claude Code's alone. AI-DLC draws its own status line
on Claude Code; on Codex, setup offers Codex's built-in status line, with the
task progress AI-DLC keeps current. For Kiro's v3 engine on Kiro CLI 2.24.1 or
later, use `kiro-ide`, which pins it; `kiro` is Kiro CLI (V2)
([Kiro CLI](harnesses/kiro-cli.md) says how an existing `kiro` project switches).

In Kiro IDE, the **aidlc** agent appears in the agent picker only after you
trust the folder and reload the window: if the Restricted Mode banner shows,
select **Manage** on it, then **Trust**, and run **Developer: Reload Window**
(see [First run](harnesses/kiro-ide.md#first-run)). If you use Kiro IDE's own
terminal in a folder you have not trusted yet, Kiro first asks whether you
trust it; choose **Trust Folder & Continue** only for your own project or one
you have checked, since trusting lets the folder's `.kiro` hooks run commands
on your machine.

Each tool's chapter under [Running on other harnesses](harnesses/README.md)
covers the rest.

## AWS Bedrock Setup

The Claude Code, Codex, and opencode distributions preserve the provider
already configured by the user. Amazon Bedrock is an explicit option.

### Provider-neutral default

AI-DLC does not select a model provider in the shipped Claude Code, Codex, or
opencode project configuration. The harness keeps the provider,
authentication, model, and context settings already configured by the user.
Balanced reviewer agents may cap reasoning effort, but they do not pin a
provider-specific model.

### Configure Bedrock (optional)

Choose `amazon-bedrock` at step 2 of the customized setup above, or later with
`aidlc config providers`. Then:

1. Enable access to the configured Anthropic models in the Amazon Bedrock model
   catalog.
2. Provide AWS credentials through the normal SDK credential chain, for example
   `aws configure` or `aws sso login --profile <profile>`.
3. Use a region where those models are available.
4. Run `aidlc config providers --check` to see what is still pending.

Keep credentials and personal overrides out of the shared
`.claude/settings.json`. Put them in `.claude/settings.local.json` or the
standard AWS credential files.

To keep the provider already selected in Claude Code, choose `keep current`
in `aidlc config providers` (or pass `--provider current`). To record a different
Claude Code-supported provider explicitly, run `aidlc config providers
--provider other --yes`. This removes old AI-DLC-owned Bedrock overrides from
the shared project settings and leaves the manual setup step pending. Complete
that provider's authentication flow, then run `aidlc config providers
--acknowledge --yes` to mark the step done. See the
[Claude Code authentication guide](https://code.claude.com/docs/en/authentication).

For IAM detail, model access, SSO, and regional troubleshooting, see
[Claude Code on Amazon Bedrock](https://community.aws/content/2tXkZKrZzlrlu0KfH8gST5Dkppq/claude-code-on-amazon-bedrock-quick-setup-guide)
and the [Amazon Bedrock documentation](https://docs.aws.amazon.com/bedrock/).

## MCP Servers (optional)

The recommended defaults turn the shipped MCP servers on for Claude Code
projects; a setup without questions adds them with `--mcp defaults`:

```bash
aidlc config --harness claude --mcp defaults
```

Use `--mcp none` to omit them. A copy-channel install starts without them; run
`bun .claude/tools/aidlc.ts config project --harness claude --mcp defaults --yes` to add them.
The default set is:

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

## Updating

`aidlc update` updates the machine runtime. It does not rewrite configured
projects. Refresh each project; open work carries on:

```bash
aidlc update
cd /path/to/your-project
aidlc doctor
aidlc config
```

Config preserves project-owned content, and a refresh while a workflow is open
is done and says whether that work carries on. Projects using plugins should run
`/aidlc plugin sync` after an engine refresh.

For version selection, project pins, offline installation, mirrors, custom CAs,
release authentication, automation, and uninstall, see
[Install and Lifecycle](18-install-and-lifecycle.md).

## Troubleshooting

Start with:

```bash
aidlc doctor
```

Then use [Troubleshooting](15-troubleshooting.md) for hooks, provider access,
approval gates, stale state, and diagnostics. Harness-specific setup problems
belong in the matching [harness guide](harnesses/README.md).

## Next Steps

- [Onboarding: A Guided First Week](onboarding.md) - the mental model and a guided five-run path for first-time teams
- [Workflow Profiles](workflow-profiles.md) - choose the right workflow
- [Your First Workflow](02-your-first-workflow.md) - what each part of a run means
- [Spaces and Intents](03-spaces-and-intents.md) - understand project state
- [Interaction Modes](07-interaction-modes.md) - work with questions and gates
- [Install and Lifecycle](18-install-and-lifecycle.md) - manage the native runtime
