# Session Management

A workflow may span multiple harness sessions. AI-DLC persists all progress to disk so you can resume, redo, jump, or start fresh at any time.

> **Harness note.** Session resume works on every harness (the state lives in
> the intent's record dir, not the harness). Session *lifecycle events* differ: Claude Code
> emits `SESSION_STARTED/RESUMED/ENDED` and `SESSION_COMPACTED`; Kiro emits only
> `SESSION_STARTED`; Codex infers `SESSION_ENDED` and adds a post-compaction
> mission re-inject. See [Running on other harnesses](harnesses/README.md).

---

## Resume Flow

When you run `/aidlc` and the active intent's `aidlc-state.md` (under its record dir) exists from a previous session, AI-DLC presents a status summary and offers four resume options.

```mermaid
flowchart TD
    START(["/aidlc invoked"])
    STATE_EXISTS{"aidlc-state.md\nexists?"}
    RECOVERY_CHECK{".aidlc-recovery.md\nexists?"}
    CORRUPTION{"State matches\nrecovery file?"}
    WARN["Warn about possible\nstate corruption"]
    RESUME_MENU["Resume Options"]

    OPT_RESUME["Resume from\nlast checkpoint"]
    OPT_REDO["Redo\ncurrent stage"]
    OPT_JUMP["Jump to\nspecific stage"]
    OPT_FRESH["Start fresh\n(new intent alongside)"]

    SCOPE_DETECT["Detect scope,\nstart new workflow"]

    START --> STATE_EXISTS
    STATE_EXISTS -->|Yes| RECOVERY_CHECK
    STATE_EXISTS -->|No| SCOPE_DETECT

    RECOVERY_CHECK -->|Yes| CORRUPTION
    RECOVERY_CHECK -->|No| RESUME_MENU
    CORRUPTION -->|Mismatch| WARN --> RESUME_MENU
    CORRUPTION -->|Match| RESUME_MENU

    RESUME_MENU --> OPT_RESUME
    RESUME_MENU --> OPT_REDO
    RESUME_MENU --> OPT_JUMP
    RESUME_MENU --> OPT_FRESH

    style START fill:#e1bee7,stroke:#7b1fa2
    style RESUME_MENU fill:#bbdefb,stroke:#1565c0
    style WARN fill:#ffcdd2,stroke:#c62828
```

<!-- Text fallback: /aidlc invoked. If state file exists, check for recovery file. If recovery file exists and stage doesn't match state, warn about possible corruption. Then show four resume options. If no state file exists, start a new workflow with scope detection. -->

### Four resume options

| Option | What happens | What is preserved | What is lost |
|--------|-------------|-------------------|-------------|
| **Resume from last checkpoint** | Continue from the in-progress or next pending stage. Task sidebar is rebuilt from the state file. | All artifacts, state, audit trail | In-memory conversation context from the prior session |
| **Redo current stage** | Reset the current stage's checkbox (via `aidlc-jump.ts execute --direction redo`) and re-execute it from scratch. | All other artifacts and state | Current stage's completion status and partial work |
| **Jump to stage** | Skip to a specific stage (via `next --stage <slug>`). Warns about skipped stages and potential downstream artifact invalidation. | All existing artifacts | Stages between current and target are marked `[S]` (skipped) |
| **Start fresh** | Start a new intent alongside the existing one (via `next --new-intent`, after confirming scope and description). | The existing workflow's artifacts, state, and audit trail (it stays in place) | Nothing - the prior intent remains resumable |

Dispatched ensemble work resumes from evidence on disk. For Practices
Discovery, the conductor preserves the lead draft and every existing
contribution file, dispatches only the missing quality/developer/devsecops
spokes, then continues with the human interview and lead integration. It does
not repeat completed spokes.

---

## Recovery Breadcrumb

Before Claude Code compacts conversation context, the `validate-state.ts` hook writes a hidden recovery file at `.aidlc-recovery.md` in the active intent's record dir. This file contains:

- Timestamp of the last validation
- Current stage name (extracted from `aidlc-state.md`)
- State file validity status

On the next `/aidlc` invocation, AI-DLC compares `.aidlc-recovery.md` against `aidlc-state.md`. If the "Current stage" fields differ, it warns you about possible state corruption from context compaction.

---

## Context Compaction

Claude Code automatically summarizes earlier conversation context when the context window fills up. This is called **compaction**. This implementation has safeguards to preserve workflow state across compaction events.

### What is preserved vs. lost

| Preserved | Lost |
|-----------|------|
| All record-dir artifacts (files on disk) | In-memory conversation context (prior discussion) |
| `aidlc-state.md` (stage progress, scope, project info) | Partial in-progress work not yet written to files |
| `audit/` shards (full history of decisions and actions) | Task IDs (rebuilt from state file on resume) |
| `.aidlc-recovery.md` (stage checkpoint) | Agent persona context (reloaded from agent files) |

### How to recover after compaction

1. Run `/aidlc` — AI-DLC reads the state file and offers resume options
2. If the recovery breadcrumb warns about a mismatch, choose **Redo current stage** to re-execute the stage that was in progress during compaction
3. If no warning appears, choose **Resume from last checkpoint** to continue normally

Compaction is a normal part of long sessions. The state file and artifacts on disk ensure no completed work is lost.

---

## Stage Jumps

You can jump forward or backward in the workflow using utility commands.

### Jump to a specific stage

```
/aidlc --stage code-generation
/aidlc --stage 3.5
```

When jumping forward, stages between the current position and the target are marked `[S]` (skipped). The orchestrator warns you about:

- Stages that will be skipped
- Artifacts that downstream stages may expect but will not find
- Potential impact on traceability

When jumping backward, the target stage is reset to `[ ]` (not started) and re-executed. Previously completed downstream stages remain marked `[x]` but their artifacts may become stale.

### Jump to the start of a phase

```
/aidlc --phase construction
/aidlc --phase 3
```

This jumps to the first stage of the specified phase. The same warnings about skipped stages and artifact invalidation apply.

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

**Every number they report comes straight from the data plane.** Each skill reads its figures from `bun .claude/tools/aidlc-runtime.ts summary --json` — the materialised view over `runtime-graph.json`. The skills never estimate or recount; the prose around the numbers (the narrative, the decision rationale) is the only part synthesised from the audit trail and artefacts. There is deliberately no token estimate — the old file-size-to-token heuristic was guesswork and has been removed.

```
/aidlc-session-cost      # quick "where are we" snapshot, any time
/aidlc-replay            # narrate the session for async review
/aidlc-outcomes-pack     # at workflow close — write the handover doc
```

Each skill needs a compiled `runtime-graph.json` to read. If you run one before a workflow has started its first stage, it prints a short "no session data yet" note and stops.

---

## Next Steps

- [State Tracking and Audit Trail](10-state-and-audit.md) — State file structure and checkpoint notation
- [Skills and Runner Commands](17-skills.md) — The read-only session views (`/aidlc-session-cost`, `/aidlc-replay`, `/aidlc-outcomes-pack`) and the runner family
- [CLI Commands](12-cli-commands.md) — Full reference for `--stage`, `--phase`, and other flags
- [Troubleshooting](15-troubleshooting.md) — Compaction recovery and state corruption
- [Glossary](glossary.md) — Definitions for compaction, recovery breadcrumb, session
