# Facilitator Guide

This page is for the person running an AI-DLC workshop or supporting a team
through its first workflows. It covers what to check before the day, how to
keep a run small, and what to do when a team gets stuck. Participants should
read [Onboarding](onboarding.md) instead.

---

## Before the workshop: the readiness pass mark

Asking a team to install AI-DLC and report any problems is not enough. A
machine whose hooks never run reports nothing, and on most harnesses
`aidlc doctor` on a fresh install passes before any hook has had a chance to
run. A machine is ready only when it has run one real workflow stage and the
doctor shows the hooks fired.

Run these steps on each participant machine, in the folder the team will work
in. Folder trust and hook settings are per folder, so a scratch folder proves
less.

1. **Set up the project.** In a terminal in the project folder, run
   `aidlc config --harness <name>` (for example `copilot`). It shows a
   `Setup check - N of M sections need you.` table and offers to walk you
   through what it flagged.
   - Pass: the `Runtime` row reads `[ok]` and `hook PATH ready`, and the
     `Trust` row reads `[ok]`. On Copilot the `Trust` row does not cover
     `trustedFolders`; see [GitHub Copilot on Windows](#github-copilot-on-windows).
   - `Models` or `Providers` showing `[needs]` does not stop the hooks. See
     the `Providers` row in
     [Troubleshooting](15-troubleshooting.md#native-install-channel) for what
     to answer.
2. **Check the install.** Run `aidlc doctor`.
   - Pass: the summary line reads `0 problems`.
   - Read every warning. A `Runtime hook PATH` warning means the host may
     start the hooks without finding `aidlc`: fix it first.
3. **Run one stage.** Open the harness in the same folder and start a
   throwaway workflow, for example:

   ```text
   /aidlc express Add a --version flag to the CLI
   ```

   (`$aidlc` on Codex CLI.) The initialization stages run on their own. When
   the first real stage asks you something (a question or an approval),
   answer it the way the harness shows it: pick an option where a picker
   appears (Claude Code, Codex CLI), or type the number or your answer in the
   chat where the options are numbered (GitHub Copilot and the others).
4. **Check the hooks fired.** Back in the terminal, run
   `aidlc doctor --verbose`.
   - Pass: a row `Hooks last fired:` lists hook names with current times,
     for example `plan-approval-guard` and `continue-workflow`.
   - Fail: `Hooks have never executed although this workflow has progressed`,
     or a `Hook heartbeat data` row saying no hook has ever fired, means the
     host is not running AI-DLC's hooks on this machine. Fix it before the
     workshop.
   - Not ready: a `Hook failures, the latest within the last day` warning
     means a hook ran into a failure it could not report at the time; the row
     names the reasons.
   - Not ready, although it is marked `ok`: a row reading
     `Human-turn receipts: 0 HUMAN_TURN rows ... (advisory)` means your
     answers are not being recorded, so approvals will be refused later.
     This row shows only with `--verbose`.
5. **Put the test away.** In the chat, run `/aidlc intent archive <name>`
   with the name of the test work (`/aidlc intent` lists the names). Nothing
   is deleted. The next `/aidlc` asks which work to continue, or, when none
   is left, asks you to describe new work. On a machine whose hooks only
   partly work the chat may refuse this; then run
   `aidlc engine intent archive <name>` in your own terminal instead.

Ask each team for the output of steps 1, 2 and 4 from a participant machine a
week before the workshop. That costs them minutes and shows whether the
hooks, the PATH and the folder trust are wired.

The `workshop` scope (`/aidlc workshop`) is for the facilitated group session
itself. It is a 26-stage run, not a readiness check.

---

## Keep side tasks small: name the scope

A plain `/aidlc <description>` suggests a scope from its words or offers to
compose a plan, and `classic`, the default, runs 18 of 33 stages. A
description longer than five words is offered `bugfix` only when it asks for
the fix ("Fix the export that drops rows", "please fix it"). Other bug reports
get the offer to compose a plan, which lists `bugfix` first; picking the
default there runs a much larger workflow. Name the scope as the first word:

| The side task is... | Type | Stages |
|---|---|---|
| A known bug with a known fix | `/aidlc bugfix <what is broken>` | 9 / 33 |
| A small change or a quick end-to-end try | `/aidlc express <the change>` | 10 / 33 |

`feature` runs every stage (33 / 33). It suits a production feature, not a
side task. See [Workflow Profiles](workflow-profiles.md) for every scope.

Start a side task in its own project folder, so it does not mix with the
team's main workflow.

Tell participants this at kickoff: side tasks outside the planned use case
take `bugfix` or `express`, not the default.

---

## Fewer questions: depth

Depth sets how many questions each stage asks and how long its documents
are. At `Standard` depth a stage aims for about 5 to 8 questions; at
`Minimal` it aims for about 2 to 4. These are targets, not caps: a vague
answer or a contradiction still gets a follow-up.

- Mid-workflow, type `/aidlc --depth minimal`. It changes the depth of the
  running workflow.
- At the start, add it after the scope, for example
  `/aidlc classic --depth minimal <the work>`.

`bugfix`, `express`, `poc`, `refactor`, and `security-patch` already default
to `Minimal`. `classic`, `feature`, and `workshop` default to `Standard`. See
[Scopes and Depth](05-scopes-and-depth.md#the-3-depth-levels).

---

## Construction: one Unit at a time

When Inception splits the work into several Units, Construction can run them
two ways:

- `unit-major`: one Unit goes through its design stages and Code Generation
  before the next Unit starts. Teams see working code sooner.
- `stage-major`: every Unit goes through one stage before any Unit moves to
  the next, so a team with six Units answers six sets of questions at each
  stage. When the scope builds a walking skeleton, that first Unit still goes
  all the way to code before the rest.

New solo workflows whose scope splits work into Units and writes code record
`Construction Iteration: unit-major` when they are created. Before
Construction starts, open the work's `aidlc-state.md` (under
`aidlc/spaces/<space>/intents/`) and check that line. If it says
`stage-major`, or the line is missing (which also means stage-major), switch
it during Inception. Ask the agent, or run this in the project folder:

```bash
aidlc engine state set-construction-iteration unit-major
```

If that is refused with `Select Construction Execution: serial`, the work is
set to build Units in parallel: run
`aidlc engine state set-construction-execution serial` first, then switch.

Once Construction has started, the change needs your explicit approval of
that exact change. See
[Construction order and execution](12-cli-commands.md#construction-order-and-execution).

---

## Recovery playbook

A team is stuck when the same refusal comes back after a retry, the agent
repeats a command and gets the same error, or every `aidlc` command the agent
runs is refused. Waiting does not clear a loop like that, and the agent
cannot think its way out.

### 1. Stop the loop

Stop the agent (the stop button in the chat, or Esc in a terminal harness).
Each retry costs minutes and credits.

### 2. Capture a diagnostic report from your own terminal

Open a terminal yourself (not through the agent), go to the project folder,
and run:

```bash
aidlc doctor --export
```

AI-DLC's checks act on what the agent does. A command you type in your own
terminal is not the agent's action, so this works even when every command the
agent tries is refused. The doctor writes a redacted report under
`aidlc/diagnostics/` and prints its path. It holds no source code and no
document bodies. Attach it when you report the problem. See
[Sharing a Diagnostic Report](15-troubleshooting.md#sharing-a-diagnostic-report).

### 3. Read the fix lines

`aidlc doctor` prints a `fix:` line under every problem and warning. Follow
it before anything else.

### 4. Match the symptom

| What the team sees | What to do |
|---|---|
| The workflow waits and does not move on | If it shows a question or an approval gate, it is waiting for you: answer what it shows, one of the options it lists, or **Approve** / **Request Changes** at a gate. If it shows neither and the agent says work is still running in the background, let that finish. `/aidlc --status` shows where it is. To leave a stage, jump with `/aidlc --stage <slug>`. |
| Answers or approvals are not recorded, or the doctor says hooks have never executed | The host is not running AI-DLC's hooks. Fix what the doctor names (PATH, folder trust, hook approval, the chosen agent), restart the harness, and run the readiness pass mark again. |
| The agent's `aidlc` commands are refused during Code Generation, and they start with `cd <path>;` | Ask the agent to run each `aidlc` command on its own, with nothing before it. The check refuses a `cd` in front of a command unless it can tell the `cd` stays in the current folder, and it cannot tell that for an unquoted Windows path such as `cd C:\path`. `aidlc --status`, `aidlc doctor`, and `aidlc engine orchestrate next` on their own are allowed. Older builds also refuse plain `aidlc --status` and `aidlc doctor` in this state; go to the next row. |
| Code Generation work is refused with `Plan Approval authority is ambiguous or stale` even after the plan was approved | First let the agent run the step the refusal names (for example a fresh `next`), on its own. If the same refusal comes back, use the last resort below. `/aidlc --plan-approval off` and Guard Policy `off` do not release this refusal. |
| The conversation is long or confused | Open a new chat and type `/aidlc --resume`. The workflow continues from the files on disk, not from the old conversation. |

### Last resort: switch the Plan Approval check off

`AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1` turns off the check that refuses work
during Code Generation, for every workflow in a harness started with it. Use
it only while a person is watching the session, and only to get past a
refusal that is wrong. The hooks read it from the environment the harness
starts with, so set it before you start the harness:

- Close every window of the harness first.
- On Windows PowerShell with VS Code:

  ```powershell
  $env:AIDLC_DISABLE_PLAN_APPROVAL_GUARD = "1"
  code C:\path\to\project
  ```

- On macOS or Linux: `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1 code /path/to/project`
  (or the harness's own command instead of `code`).

While it is set, the workflow's audit trail records that the check was off
(`GUARD_DISABLED`). Start the harness again without the variable as soon as
the team is past the problem.

Recording the switch with `aidlc config flags --bypass` does not help here:
`aidlc config flags` refuses to record it while a workflow is running.

### When to pivot

Debugging AI-DLC is not what the team came for. If a team hits the same
failure twice after working through this playbook, stop: keep the diagnostic
report, and move the team to its fallback plan, for example a harness that
passed the readiness pass mark on their machines. Agree the fallback before
the workshop so the switch takes minutes.

---

## How strongly each harness enforces the workflow

AI-DLC runs the same engine everywhere, but each host gives its hooks
different powers. A weaker row means the workflow relies more on the agent
following its instructions, and a failure is easier to miss.

| Harness | How questions appear | Can AI-DLC refuse an agent's action? | At the end of a turn | Hooks run only when | Gaps to know |
|---|---|---|---|---|---|
| Claude Code | Native picker; picker answers count as your turn | Yes, every check | Keeps the workflow going until the step is reported | Project hooks are approved with `/hooks` and Claude Code restarted; an organization policy can block them (the doctor checks) | None noted |
| Codex CLI | Picker, with numbered prose as the fallback; picker answers count | Yes, every check | Keeps the workflow going | The project's hooks are trusted (one interactive trust pass, or the shipped trust seed) | No custom status line |
| GitHub Copilot (CLI and VS Code) | Numbered prose; type your answer. Pickers are refused while a workflow runs, because their answers do not count | Yes, through Copilot's deny channel. Live-verified on the CLI; on VS Code documented but not yet verified live | Keeps the workflow going | For the Copilot CLI, the folder is in `trustedFolders`; headless `copilot -p` also needs `GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=1`. `aidlc` must be on the PATH the host starts with | No status line. The doctor cannot tell whether VS Code runs the hooks until a stage has run |
| Cursor | Numbered prose | Yes | Cannot hold the turn; the reminder arrives as a follow-up message | The project is in a git repository and the folder is trusted (the doctor checks the repository) | Headless `agent -p` runs cannot pass approval gates. No status line |
| Kiro CLI | Numbered prose | Yes | Keeps the workflow going in interactive sessions, not in `--no-interactive` runs | The `aidlc` agent is active | No status line; no session-end or pre-compaction hooks |
| Kiro IDE | Numbered prose | Partly: the approval floor, Plan Approval, and the terminal command check. No reviewer read-scope, state-transition, or review-freeze check | Cannot hold the turn; the agent's own instructions keep the workflow going | The folder is trusted, the window was reloaded, and the `aidlc` agent is chosen (the doctor warns until hooks have run) | No status line |
| opencode | Numbered prose | Yes | Cannot hold the turn; the reminder is sent as a new prompt | The AI-DLC plugin is installed (the doctor checks it) | No session-end event. No status line |

Where there is no status line, use `/aidlc --status` (`$aidlc --status` on
Codex CLI) and the progress line at each gate. Each harness chapter under
[Running on other harnesses](harnesses/README.md) has the details.

---

## GitHub Copilot on Windows

Many workshops run Copilot in VS Code on Windows. Check these before the
day:

- **Install from a normal PowerShell window**, not one opened with "Run as
  administrator", then close and reopen VS Code so its terminals and hooks see
  the new PATH. See [Install](18-install-and-lifecycle.md#install) and
  [Windows PowerShell](18-install-and-lifecycle.md#windows-powershell).
- **VS Code version.** Run `code --version`: AI-DLC needs 1.130 or later. The
  doctor checks only the optional Copilot CLI version, not VS Code.
- **Folder trust.** The Copilot CLI runs repository hooks only in a folder its
  `trustedFolders` list in `config.json` covers (the folder or one above it).
  Run `copilot` once in the project folder and choose "Yes, and remember this
  folder for future sessions", or add the folder's full path yourself. The
  doctor reads the file where the CLI does (`%USERPROFILE%\.copilot` on
  Windows, or `COPILOT_HOME`) and warns when it does not cover the folder.
  VS Code never reads that list: its hooks run only in a trusted workspace
  with the Chat: Use Hooks setting on, which an organization can switch off.
  The doctor cannot see either, so check both in VS Code.
- **Run `aidlc` commands on their own.** At the start of the session, tell
  the agent: "Run each aidlc command on its own, without cd in front." During
  Code Generation, a command such as `cd C:\path; aidlc --status` is refused,
  while `aidlc --status` alone is allowed.
- **Answer by typing.** Type the number or your answer in the chat. Picker
  answers are refused while a workflow runs.
- **Run the [readiness pass mark](#before-the-workshop-the-readiness-pass-mark)
  on each Windows machine.** It is the only check that proves VS Code runs
  the hooks there.

For the rest of the Copilot setup, see
[AI-DLC on GitHub Copilot](harnesses/copilot.md).

---

## Related reading

- [Onboarding](onboarding.md) - the participant's first week
- [Multi-Team Construction and Workshop Mode](workshop-mode.md) - several teams building Units of one intent
- [Workflow Profiles](workflow-profiles.md) - every scope and when to use it
- [Troubleshooting](15-troubleshooting.md) - symptoms and fixes
