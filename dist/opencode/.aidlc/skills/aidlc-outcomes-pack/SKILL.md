---
name: aidlc-outcomes-pack
description: >
  Generate a comprehensive handover document at workflow close so the
  team can own, operate, and continue the system without re-running the
  workflow. Stage/phase/learning counts come from
  `aidlc-runtime.ts summary`; prose comes from the artefacts. Writes
  OUTCOMES.md but never mutates workflow state or emits audit events.
argument-hint: ""
user-invocable: true
classification: read-only
---

# AI-DLC Outcomes Pack

## Purpose

Produce a single handover document at the close of a workflow that gives
the team everything they need to own, operate, and keep building the
delivered system — without re-running the workflow to recover context.

## Classification

Read-only with respect to workflow state. This skill never advances the
stage pointer and never emits an audit event. It **does** write one
report artefact (`OUTCOMES.md` at the workspace root) — that is its
output. It writes nothing else.

## The counting rule

Stage tallies, per-phase rollup, memory-entry counts, and learnings
captured come from the tool, not from eyeballing the artefact tree:

```bash
bun .aidlc/tools/aidlc-runtime.ts summary --json
```

Section *content* (what was built, setup steps, decisions) is yours to
synthesise from the artefacts and the delivered code. Any *count* that
appears in the pack must trace to the tool's output.

## Steps

### Step 1: Read the aggregates

Run `bun .aidlc/tools/aidlc-runtime.ts summary --json`.

If it exits non-zero (no `runtime-graph.json` yet), print:

```
No session data yet — an outcomes pack is generated at the close of a
workflow. Run /aidlc to completion first.
```

and STOP. Otherwise keep the parsed JSON for the count fields below.

### Step 2: Read the content sources

- All artefacts under `aidlc-docs/<phase>/<stage>/` — requirements,
  design decisions, NFRs, infrastructure.
- The delivered application and infrastructure code at the workspace
  root.

### Step 3: Write OUTCOMES.md

Write `OUTCOMES.md` at the workspace root (not inside `aidlc-docs/`):

```markdown
# Outcomes Pack
**Scope**: {summary.scope}
**Stages delivered**: {summary.stages.approved} approved / {summary.stages.total} total
**Duration**: {summary.duration_minutes} min

## 1. What Was Built
- Project name and description (from requirements)
- Scope the workflow ran at
- Units of work delivered and what each contains
- Key architectural decisions and why (from design artefacts)
- Tech stack with version pins

## 2. Repository Structure
- Annotated directory tree of the delivered code
- What lives where and why

## 3. Setup Guide
- Prerequisites (runtimes, tools, cloud CLI versions)
- Local development setup, step by step
- Required environment variables
- How to run tests

## 4. Build and Deploy
- Build steps
- Full test-suite run
- Infrastructure deployment (from Build and Test artefacts)
- IaC deployment commands with expected outputs, if generated

## 5. Architecture Decisions
- Every significant decision made during the workflow
- Alternatives considered and why rejected
- Constraints that shaped the design (from rules and practices)

## 6. What to Commit vs Archive
| Artifact | Action | Destination |
|----------|--------|-------------|
| `decisions.md` (per stage) | Commit | `docs/decisions/` |
| Architecture summary (1 page) | Write + commit | `docs/architecture.md` |
| NFR summary table | Write + commit | `docs/nfr-summary.md` |
| `audit.md` | Archive — do NOT commit to app repo | Compliance archive |
| Stage question files | Discard | — |
| `aidlc-state.md` | Discard | — |
| Application / infrastructure code | Already committed | — |

## 7. Workflow Footprint
- Stages: {summary.stages.approved} approved, {summary.stages.failed} failed, {summary.stages.pending} pending
- Memory entries captured: {summary.memory.total}
  ({summary.memory.interpretations} interpretations, {summary.memory.deviations} deviations, {summary.memory.tradeoffs} trade-offs, {summary.memory.open_questions} open questions)
- Learnings captured: {summary.learnings.from_orchestrator} from orchestrator, {summary.learnings.from_user_addition} from user additions

## 8. Known Limitations and What to Tackle Next
- Scope items explicitly deferred during the workflow
  (cross-reference the {summary.memory.open_questions} open questions above)
- Technical debt identified but not resolved
- Recommended next steps
```

### Step 4: Confirm

Print a short summary: sections written, any sections skipped for
missing source material, and recommended additions. You may offer one
round of "want to add or adjust a section?" — do not loop on it.
