# AI-DLC State Tracking

This document defines the `aidlc-state.md` section and field contract. The
engine writes the concrete state file and enumerates stages from the compiled
stage graph plus scope grid; this template must not hand-list shipped stages.
The exact initial description is JSON-encoded as one string beside the state
file in `<record>/project-description.json`; the `Project` field below is its
safe single-line preview.

Authoritative generated views:
- Stage graph: `bun .codex/tools/aidlc-utility.ts stage-table`
- Scope grid: `bun .codex/tools/aidlc-utility.ts scope-table`

## Project Information
- **Project**: [single-line project description preview]
- **Project Description Source**: project-description.json
- **Project Type**: [Greenfield/Brownfield]
- **Scope**: [scope slug from compiled scope grid]
- **Start Date**: [ISO 8601 timestamp]
- **State Version**: 8
- **Active Agent**: [current lead agent slug]
- **Worktree Path**: [empty when not in a worktree]
- **Bolt Refs**: [empty list or comma-separated bolt slugs]
- **Practices Affirmed Timestamp**: [ISO 8601 timestamp on affirmation]

## Scope Configuration
- **Stages to Execute**: [comma-separated stage numbers included in scope]
- **Stages to Skip**: [comma-separated stage numbers with reasons, or none]
- **Depth**: [Minimal/Standard/Comprehensive]
- **Test Strategy**: [Minimal/Standard/Comprehensive]

## Workspace State
- **Project Root**: [project-relative path, normally `.`; re-derived at runtime, never trusted as an absolute path]
- **Languages**: [detected languages]
- **Frameworks**: [detected frameworks]
- **Build System**: [detected build system]

## Execution Plan Summary
- **Total Stages**: [count of EXECUTE stages]
- **Completed**: [count of completed EXECUTE stages]
- **In Progress**: [current stage slug]

## Runtime State
- **Revision Count**: [integer]
- **Unit Ownership**: [solo/team; optional, exact `team` activates the derived grid]
- **Unit Gate Rhythm**: [per-stage/unit-end; optional, defaults to per-stage under team ownership]

## Phase Progress
<!-- Status values: Pending, Active, Verified, Skipped -->

- **[Phase]**: [Pending/Active/Verified/Skipped]

## Stage Progress
<!-- Checkbox states: [ ] pending, [-] in-progress, [?] awaiting approval, [R] revising, [x] completed, [S] skipped -->

The engine emits one phase heading per compiled phase, then one checkbox row per
compiled stage in that phase:

### [PHASE] PHASE
- [ ] stage-slug — [EXECUTE/SKIP: reason]

## Unit Progress

Present only when `Unit Ownership: team` and `Construction Iteration:
unit-major`. This table is an engine-owned, derived projection of the Unit DAG,
artifact coverage, lifecycle receipts, and unit gate events. It is rewritten on
every `next`; hand edits are never routing or completion evidence.

| unit | owner | [per-unit Construction stage columns in graph order] | gate |
| --- | --- | --- | --- |
| [Unit name] | - | [[ ]/[-]/[?]/[R]/[x]/[S] per stage] | [[ ]/[-]/[?]/[R]/[x]] |

The stage columns use the same checkbox vocabulary as `## Stage Progress`.
`owner` remains `-` until the claim increment supplies ownership. `gate`
summarizes the current per-stage gates or the unit-end gate, depending on Unit
Gate Rhythm. Stage Progress rows are derived complete only when their Unit
Progress column and required team gates are complete.

## Current Status
- **Lifecycle Phase**: [READY/INITIALIZATION/IDEATION/INCEPTION/CONSTRUCTION/OPERATION]
- **Current Stage**: [stage slug or status text]
- **Next Stage**: [next stage slug or none]
- **Status**: [Running/Completed]
- **Construction Autonomy Mode**: [unset/autonomous/gated]
- **Last Updated**: [ISO 8601 timestamp]

## Session Resume Point
- **Last Completed Stage**: [stage slug]
- **Next Action**: [what to do next]
- **Pending Artifacts**: [any incomplete artifacts or none]
