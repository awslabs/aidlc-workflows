---
name: aidlc-replay
description: >
  Print a structured session narrative for stakeholders who weren't in
  the room. Numbers (stage counts, phase rollup, duration) come from
  `aidlc-runtime.ts summary`; prose comes from the audit trail and
  artefacts. Renders to the terminal only — writes no file, never
  mutates workflow state, never emits audit events.
argument-hint: ""
user-invocable: true
classification: read-only
---

# AI-DLC Session Replay

## Purpose

Turn a workflow's audit trail and artefacts into a readable story: what
was decided, in what order, and why. For async review, for stakeholders
who weren't present, or as a post-session record. Not a raw log dump.

## Classification

Read-only. This skill renders the narrative to the terminal and writes
**no file**. It never advances the workflow stage pointer and never
emits an audit event.

## The counting rule

All counts and aggregates — number of stages, per-phase breakdown,
duration, approved/failed/pending tallies, learnings captured — come
from the tool, not from eyeballing files:

```bash
bun .claude/tools/aidlc-runtime.ts summary --json
```

The narrative prose (what happened, key decisions, reasoning) is yours
to synthesise from the active record's audit shards and artefacts. The
skeleton numbers are the tool's. Never hand-count stages or artefacts
when the tool already reports the figure.

## Steps

### Step 1: Read the aggregates

Run `bun .claude/tools/aidlc-runtime.ts summary --json`.

If it exits non-zero (no `runtime-graph.json` yet), print:

```
No session data yet — start a workflow with /aidlc before running
/aidlc-replay.
```

and STOP. Otherwise keep the parsed JSON; you'll cite its fields for
every number in the report.

### Step 2: Read the narrative sources

Resolve `<active-space>` from `aidlc/active-space` (default `default`) and
`<active-intent>` from
`aidlc/spaces/<active-space>/intents/active-intent`. The active workflow
record is
`aidlc/spaces/<active-space>/intents/<active-intent>`.

- Every `.md` shard under `<record>/audit/` — the full event trail; order
  events by their `Timestamp` fields for the narrative.
- `<record>/aidlc-state.md` — the active-stage cursor.
- The artefacts recursively under `<record>/<phase>/` — what each stage
  produced, including per-unit Construction outputs.

These are your sources for *prose*. Do not derive counts from them when
Step 1's JSON already carries the count.

### Step 3: Render the replay

Print the narrative to the terminal in this shape (write no file):

```markdown
# Session Replay
**Workflow**: {summary.workflow_id}
**Scope**: {summary.scope}
**Duration**: {summary.duration_minutes} min   (or "in progress")
**Stages**: {summary.stages.approved} approved / {summary.stages.total} total

## Executive Summary
{3-5 sentences: what was built or decided, key choices, constraints, outcome}

## Timeline
{For each phase in summary.by_phase, in workflow order:}

### {Phase} Phase  —  {by_phase[phase].approved}/{by_phase[phase].total} stages approved

#### {Stage Name}
**What happened**: {1-2 sentences from the audit trail}
**Key decisions**: {bullets, with reasoning drawn from the audit shards}
**Artefacts produced**: {list with one-line descriptions}

{...repeat per stage that executed...}

## Decisions Register Summary
{Table: decision | alternatives considered | chosen option | rationale}

## Learnings Captured
From orchestrator: {summary.learnings.from_orchestrator}
From user additions: {summary.learnings.from_user_addition}
{Then narrate the notable ones from the stage memory.md diaries.}

## What's Next
{Outstanding open threads from the last audit entries / open questions}
```

### Step 4: Offer adjustments

You may offer: "Want a different tone (more technical / more executive)
or an added section?" — re-render to the terminal if asked. Do not loop
on it; one offer is enough. If the user wants the replay saved, point
them at `/aidlc-outcomes-pack` (the skill that writes a file) rather
than writing one here.
