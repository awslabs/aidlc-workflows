# Session Management

A workflow may span multiple harness sessions. AI-DLC persists all progress to disk so you can resume, redo, jump, or start fresh at any time.

> **Harness note.** Session resume works on every harness (the state lives in
> the intent's record dir, not the harness). Session *lifecycle events* differ: Claude Code
> emits `SESSION_STARTED/RESUMED/ENDED` and `SESSION_COMPACTED`; Kiro CLI emits
> only `SESSION_STARTED`; Kiro IDE emits `SESSION_STARTED`, and `SESSION_RESUMED`
> when a prompt returns to an earlier chat; Codex infers `SESSION_ENDED`, then
> re-injects the mission through compact-source `SessionStart`. See [Running on other harnesses](harnesses/README.md).

---

## Resume Flow

When you run bare `/aidlc` in a new session and the active intent's `aidlc-state.md` exists, AI-DLC carries on where the work stopped, the same as `/aidlc --resume`, and says where it picked up. To do something else, say so: redo the current stage, jump to a stage, or start fresh.

```mermaid
flowchart TD
    START(["/aidlc invoked"])
    MODE{"Invocation"}
    STATE_EXISTS{"aidlc-state.md\nexists?"}
    RECOVERY_CHECK{".aidlc-engine/recovery.md\nexists?"}
    CORRUPTION{"State matches\nrecovery file?"}
    WARN["Warn about possible\nstate corruption"]
    RESUME_STATE{"aidlc-state.md\nexists?"}
    PARKED{"Workflow parked?"}
    UNPARK["Clear park marker"]
    CONTINUE["Continue current stage"]
    OTHER["You ask to redo, jump,\nor start fresh"]
    JUMP["Jump to named stage"]
    NO_STATE["Error: no workflow state"]
    SCOPE_DETECT["Detect scope,\nstart new workflow"]

    START --> MODE
    MODE -->|"bare /aidlc"| STATE_EXISTS
    MODE -->|"/aidlc --resume"| RESUME_STATE
    MODE -->|"/aidlc --resume --stage"| JUMP
    STATE_EXISTS -->|Yes| RECOVERY_CHECK
    STATE_EXISTS -->|No| SCOPE_DETECT

    RECOVERY_CHECK -->|Yes| CORRUPTION
    RECOVERY_CHECK -->|No| RESUME_STATE
    CORRUPTION -->|Mismatch| WARN --> RESUME_STATE
    CORRUPTION -->|Match| RESUME_STATE

    RESUME_STATE -->|No| NO_STATE
    RESUME_STATE -->|Yes| PARKED
    PARKED -->|Yes| UNPARK --> CONTINUE
    PARKED -->|No| CONTINUE
    CONTINUE -.->|"any time"| OTHER

    style START fill:#e1bee7,stroke:#7b1fa2,color:#000
    style OTHER fill:#bbdefb,stroke:#1565c0,color:#000
    style CONTINUE fill:#c8e6c9,stroke:#388e3c,color:#000
    style WARN fill:#ffcdd2,stroke:#c62828,color:#000
    style NO_STATE fill:#ffcdd2,stroke:#c62828,color:#000
```

<!-- Text fallback: bare /aidlc with state checks the recovery breadcrumb and carries on like /aidlc --resume; you can ask to redo, jump, or start fresh at any time; without state it starts scope detection. /aidlc --resume with state clears a park marker if needed and continues directly; without state it errors. /aidlc --resume --stage jumps to the named stage. -->

Park from the command surface with `/aidlc park`; the engine names the park command and the conductor reports where it stopped. `/aidlc --resume` brings it back.

### Redo, jump, or start fresh

Bare `/aidlc` resumes from the last checkpoint. Ask for one of the others in your own words at any time.

| Option | What happens | What is preserved | What is lost |
|--------|-------------|-------------------|-------------|
| **Resume from last checkpoint** | Continue from the in-progress or next pending stage. Task sidebar is rebuilt from the state file when the session has task tools. | All artifacts, state, audit trail | In-memory conversation context from the prior session |
| **Redo current stage** | Reset the current stage's checkbox (via `aidlc-jump.ts execute --direction redo`) and re-execute it from scratch. When Construction runs one Unit at a time and a Unit has finished work, Redo instead redoes only the active Unit's step from the start, also when that Unit is paused or waiting for its summary confirmation or checkpoint approval. For Code Generation that includes the plan, so the new plan comes back to you for approval (unless plan approval is off). | All other artifacts and state (and, one Unit at a time, the other Units' finished work) | Current stage's completion status and partial work (one Unit at a time: that Unit's step) |
| **Jump to stage** | Skip to a specific stage (via `next --stage <slug>`). After a forward jump, AI-DLC tells you in one line which stages it skipped and how to go back. | All existing artifacts | Stages between current and target are marked `[S]` (skipped) |
| **Start fresh** | Start a new intent alongside the existing one (via `next --new-intent`, after confirming scope and description). | The existing workflow's artifacts, state, and audit trail (it stays in place) | Nothing - the prior intent remains resumable |

`/aidlc --resume --stage <slug>` treats the explicit stage as the target and takes the normal jump path.

Dispatched ensemble work resumes from evidence on disk. For Practices
Discovery, the conductor preserves the lead draft and every existing
contribution file, dispatches only the missing quality/developer/devsecops
spokes, then continues with the human interview and lead integration. It does
not repeat completed spokes.

Code Generation resumes from the plan's ticks. The developer agent ticks each
step in `code-generation-plan.md` as it finishes it. If the build stops part
way (a model or provider error, the editor closed), the next run of the same
approved plan picks up at the first unticked step, and you see one line such as
"Picking up unit-2's code at step 5 of 9 (1-4 done)." When nothing is ticked but
the files the first steps name were written, it picks up after them instead
("(1-4 wrote their files)"). The developer checks the files each done step
names and redoes a step only when a file it should have made is not there.
Redo, Request Changes, and approving the plan again start its steps fresh: the
plan's ticks are cleared when the new build starts, and only the ticks it makes
count if it is cut off in turn. Editing the plan after approval also starts
fresh.

---

## Recovery Breadcrumb

Before Claude Code compacts conversation context, the `validate-state.ts` hook writes a hidden recovery file at `.aidlc-engine/recovery.md` in the active intent's record dir. This file contains:

- Timestamp of the last validation
- Current stage name (extracted from `aidlc-state.md`)
- State file validity status

On the next `/aidlc` invocation, AI-DLC compares `.aidlc-engine/recovery.md` against `aidlc-state.md`. If the "Current stage" fields differ, it warns you about possible state corruption from context compaction.

---

## Context Compaction

Claude Code automatically summarizes earlier conversation context when the context window fills up. This is called **compaction**. This implementation has safeguards to preserve workflow state across compaction events.

### What is preserved vs. lost

| Preserved | Lost |
|-----------|------|
| All record-dir artifacts (files on disk) | In-memory conversation context (prior discussion) |
| `aidlc-state.md` (stage progress, scope, project info) | Partial in-progress work not yet written to files |
| `audit/` shards (full history of decisions and actions) | Task IDs (rebuilt from state file on resume) |
| `.aidlc-engine/recovery.md` (stage checkpoint) | Agent persona context (reloaded from agent files) |

### How to recover after compaction

1. Run `/aidlc`. AI-DLC reads the state file and carries on where the work stopped
2. If the recovery breadcrumb warns about a mismatch, ask to redo the current stage to re-execute the stage that was in progress during compaction. When Construction runs one Unit at a time, the resume context names the step the active Unit is on (for example `Current Step: code-generation for unit beta`), and Redo redoes only that Unit's step; the other Units' finished work stays approved
3. If no warning appears, there is nothing else to do: the work continues normally

Compaction is a normal part of long sessions. The state file and artifacts on disk ensure no completed work is lost.

---

## Changing Model Mid-Workflow

Switching to another model inside a running chat is slow and uses many tokens:
the new model reads the whole conversation again before it answers. On Claude
models the provider's cache of the conversation belongs to one model, so none
of it carries over, and changing the effort level in the same chat usually
discards it too.

AI-DLC keeps everything it needs on disk, so a new chat is the cheaper switch:

1. Stop at a stage boundary: approve the stage and ask to stop in the same
   reply, for example `Approved. Stop here for today.` The workflow parks
   before the next stage starts (see
   [Interaction Modes](07-interaction-modes.md)). `/aidlc park` also parks it
   where it is.
2. Open a new chat or session and choose the new model and effort there. On
   Kiro IDE, also choose the **aidlc** agent in the chat panel's agent picker,
   because a new chat starts on Kiro's Default agent (see
   [Start AI-DLC in a Kiro IDE chat](harnesses/kiro-ide.md#start-ai-dlc-in-a-kiro-ide-chat)).
3. Run `/aidlc --resume`. The new chat reads the saved state, artifacts, and
   audit trail from disk instead of the old conversation, and continues where
   the workflow stopped.

Anything the old chat discussed but did not write to a file does not carry
over, which is why the end of a stage is the best moment. On Codex CLI, type
`$aidlc` instead of `/aidlc`. For which model and effort to choose, see
[Choosing a Model and Effort](18-install-and-lifecycle.md#choosing-a-model-and-effort).

---

## Stage Jumps

You can jump forward or backward in the workflow using utility commands.

### Jump to a specific stage

```
/aidlc --stage code-generation
/aidlc --stage 3.5
```

When jumping forward, stages between the current position and the target are marked `[S]` (skipped), and AI-DLC tells you in one line which stages it skipped and how to go back, for example "Moved to Code Generation; skipped User Stories. To go back, type `/aidlc --stage requirements-analysis`." Later stages may expect files that the skipped stages would have written.

When Construction runs one Unit at a time (unit-major, the default for new work), a jump goes through when you ask for it. Jumping to the step the active Unit is on simply continues it. Jumping back to a step the active Unit already finished, for example `/aidlc --stage nfr-design` while unit beta is on Code Generation, reopens it and the steps after it for that Unit only (each reopened step that finds its earlier files offers Keep, Modify, or Redo), and the assistant says so in one line: "Reopened NFR Design for unit beta. alpha keeps its finished work. Say 'for every unit' to redo it for alpha too." Saying "for every unit", or naming a Unit, reopens it for those Units instead, also after the stage approvals have moved on to a later per-unit step. Naming another Unit while beta is in the middle of a step pauses beta's step first, and the assistant says: "Paused unit beta at Code Generation and reopened NFR Design for unit alpha. Say 'back to beta' to pick beta up again." Nothing is lost: alpha redoes its steps, then beta picks up where it stopped, or earlier when you say 'back to beta'. Naming a Unit where that cannot apply (a step that is not done per Unit, or, with Construction checkpoints off, a step already approved for every Unit) is said plainly and nothing changes; saying "for every unit" then reopens it for every Unit. Once a Unit has finished work, jumping ahead to a later step, for example `/aidlc --stage code-generation` while unit beta is on NFR Requirements ("stop the design, build it"), moves only beta on: beta's steps up to Code Generation are skipped for beta (their files stay), every other Unit keeps its finished work and approvals, and a Unit that has not started does its own steps when it gets there. `/aidlc --stage <skipped step> --unit beta` reopens what was skipped for beta. Before any Unit has finished work, a jump ahead skips those steps for every Unit. Jumping further, for example `/aidlc --phase operation` to leave Construction early, skips the steps Units have not finished (their files stay). Either way the assistant tells you in one line what was skipped and that `/aidlc --stage <earliest skipped step>` reopens it.

When jumping backward, the target stage and every later stage in your plan are reset to `[ ]` (not started) and come up again in order, and AI-DLC tells you in one line how to return, for example "Moved back to Requirements Analysis. To return to Code Generation, type `/aidlc --stage code-generation`." A jump resets progress marks, not files: the artifacts stay on disk, and each reopened stage that finds its earlier files asks whether to keep, modify, or redo them.

### Jump to the start of a phase

```
/aidlc --phase construction
/aidlc --phase 3
```

This jumps to the first stage of the specified phase. As with a stage jump, AI-DLC tells you which stages it skipped and how to go back.

### Combining jumps with scope

For projects without a state file, you can combine `--stage` or `--phase` with `--scope`:

```
/aidlc --stage code-generation --scope bugfix
```

This creates a new workflow with the specified scope and jumps directly to the target stage.

---

## Session Skills

Three read-only skills report on the current workflow without changing it. Each is typed like a command and appears in the `/` skill picker:

| Skill | What it does | Output |
|-------|--------------|--------|
| `/aidlc-session-cost` | Prints a deterministic cost view — duration, stage outcomes, memory entries, sensor firings, learnings captured | Terminal only |
| `/aidlc-replay` | Renders a readable session narrative for stakeholders who weren't in the room — what was decided and why | Terminal only |
| `/aidlc-outcomes-pack` | Generates a handover document so the team can own and continue the system without re-running the workflow | Writes `OUTCOMES.md` |

**They are read-only.** None advances the workflow stage pointer, and none emits an audit event, so they are safe to run at any point — including mid-stage. `/aidlc-session-cost` and `/aidlc-replay` print to the terminal and write nothing; `/aidlc-outcomes-pack` is the only one that writes a file (`OUTCOMES.md` at the workspace root).

**Every number they report comes straight from the data plane.** Each skill reads its figures from `aidlc engine runtime summary --json` — the materialised view over `runtime-graph.json`. The skills never estimate or recount; the prose around the numbers (the narrative, the decision rationale) is the only part synthesised from the audit trail and artefacts. There is deliberately no token estimate — the old file-size-to-token heuristic was guesswork and has been removed.

```
/aidlc-session-cost      # quick "where are we" snapshot, any time
/aidlc-replay            # narrate the session for async review
/aidlc-outcomes-pack     # at workflow close — write the handover doc
```

Each skill needs a compiled `runtime-graph.json` to read. If you run one before a workflow has started its first stage, it prints a short "no session data yet" note and stops.

**If your harness doesn't expose the slash command.** `/aidlc-session-cost`, `/aidlc-replay`, and `/aidlc-outcomes-pack` are skills — they only appear as typeable commands in harnesses that surface skills in the `/` picker (Claude Code, Kiro, Cursor, and the like). On a harness that doesn't, typing `/aidlc-session-cost` is reported as an invalid command. The cost view still works: run the underlying command directly, which is exactly what the skill runs and what every number comes from:

```bash
aidlc engine runtime summary          # human-readable cost view
aidlc engine runtime summary --json   # machine-readable, same numbers
```

This is read-only and safe to run at any point in a workflow. Like the skills, it needs a compiled `runtime-graph.json`; before the first stage transition it exits non-zero with a "run a workflow first" note.

---

## Next Steps

- [State Tracking and Audit Trail](10-state-and-audit.md) — State file structure and checkpoint notation
- [Skills and Runner Commands](17-skills.md) — The read-only session views (`/aidlc-session-cost`, `/aidlc-replay`, `/aidlc-outcomes-pack`) and the runner family
- [CLI Commands](12-cli-commands.md) — Full reference for `--stage`, `--phase`, and other flags
- [Troubleshooting](15-troubleshooting.md) — Compaction recovery and state corruption
- [Glossary](glossary.md) — Definitions for compaction, recovery breadcrumb, session
