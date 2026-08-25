---
name: aidlc-session-cost
description: >
  Read-only session cost view. Prints deterministic aggregates for the
  current workflow — duration, stage outcomes, memory entries, sensor
  firings, learnings captured — sourced entirely from
  `aidlc-runtime.ts summary`. Never mutates workflow state, never emits
  audit events, never writes files.
argument-hint: ""
user-invocable: true
classification: read-only
---

# AI-DLC Session Cost

## Purpose

Give the team a transparent, deterministic view of what the current
workflow has consumed: how long it has run, how many stages have
cleared their gates, how much the orchestrator wrote to its observation
diaries, how often sensors fired, and how many learnings were captured.

Every number this skill prints comes from
`bun .aidlc/tools/aidlc-runtime.ts summary --json` — the materialised,
event-sourced view over `runtime-graph.json`. This skill does **no
counting of its own**. It does not estimate tokens, does not walk the
artefact tree, and does not read `audit.md`. If a number isn't in the
tool's output, this skill does not invent it.

## Classification

Read-only. This skill never advances the workflow stage pointer, never
emits an audit event, and never writes a file. It is safe to run at any
point in a workflow, including mid-stage.

## Steps

### Step 1: Read the aggregates

Run:

```bash
bun .aidlc/tools/aidlc-runtime.ts summary --json
```

If the command exits non-zero (no `runtime-graph.json` yet — the
workflow hasn't compiled a graph), print:

```
No session data yet.

Session cost becomes available once a workflow has started and its
first stage transition has compiled runtime-graph.json. Run /aidlc to
begin, then re-run /aidlc-session-cost.
```

and STOP.

Otherwise parse the JSON. The shape is:

```jsonc
{
  "workflow_id": "...",          // ISO timestamp of the live workflow
  "scope": "...",
  "started_at": "...",
  "duration_minutes": 40,         // null when nothing has completed yet
  "stages":   { "total": N, "approved": N, "failed": N, "pending": N },
  "by_phase": { "<phase>": { "total": N, "approved": N, "failed": N, "pending": N }, ... },
  "memory":   { "total": N, "interpretations": N, "deviations": N, "tradeoffs": N, "open_questions": N },
  "sensors":  { "total": N, "passed": N, "failed": N, "budget_override": N, "incomplete": N },
  "learnings":{ "from_orchestrator": N, "from_user_addition": N }
}
```

### Step 2: Render the report

Print the fields verbatim — do not recompute, round, or re-estimate any
value. Use `in progress` when `duration_minutes` is `null`.

```
Session Cost
============

Workflow:   {workflow_id}
Scope:      {scope}
Duration:   {duration_minutes} min   (or "in progress")

Stages
  Total:      {stages.total}
  Approved:   {stages.approved}
  Failed:     {stages.failed}
  Pending:    {stages.pending}

By phase
  {phase}    {approved}/{total} approved[, {failed} failed][, {pending} pending]
  ...

Memory entries
  Total:            {memory.total}
  Interpretations:  {memory.interpretations}
  Deviations:       {memory.deviations}
  Trade-offs:       {memory.tradeoffs}
  Open questions:   {memory.open_questions}

Sensors
  Fired:            {sensors.total}
  Passed:           {sensors.passed}
  Failed:           {sensors.failed}
  Budget-override:  {sensors.budget_override}
  Incomplete:       {sensors.incomplete}

Learnings captured
  From orchestrator:    {learnings.from_orchestrator}
  From user additions:  {learnings.from_user_addition}
```

### Step 3: Surface advisory notes (optional, narrative only)

You may add a short narrative note after the table — for example,
flagging that many stages are still pending, or that sensors are firing
`incomplete` often. Keep it to one or two sentences and base it only on
the numbers above. Do not invent metrics the tool did not report.

> Note on tokens: this skill deliberately does **not** print a token
> estimate. The retired file-size-to-token heuristic was guesswork
> dressed as data. If you need real token accounting, read it from your
> Claude Code session, not from a file-size approximation.
