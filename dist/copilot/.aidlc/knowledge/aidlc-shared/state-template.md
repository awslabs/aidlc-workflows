# AI-DLC State Tracking

This document defines the `aidlc-state.md` section and field contract. The
engine writes the concrete state file and enumerates stages from the compiled
stage graph plus scope grid; this template must not hand-list shipped stages.

Authoritative generated views:
- Stage graph: `bun .aidlc/tools/aidlc-utility.ts stage-table`
- Scope grid: `bun .aidlc/tools/aidlc-utility.ts scope-table`

## Project Information
- **Project**: [project description]
- **Project Type**: [Greenfield/Brownfield]
- **Scope**: [scope slug from compiled scope grid]
- **Start Date**: [ISO 8601 timestamp]
- **State Version**: 7
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
- **Project Root**: [absolute workspace path]
- **Languages**: [detected languages]
- **Frameworks**: [detected frameworks]
- **Build System**: [detected build system]

## Execution Plan Summary
- **Total Stages**: [count of EXECUTE stages]
- **Completed**: [count of completed EXECUTE stages]
- **In Progress**: [current stage slug]

## Runtime State
- **Revision Count**: [integer]

## Phase Progress
<!-- Status values: Pending, Active, Verified, Skipped -->

- **[Phase]**: [Pending/Active/Verified/Skipped]

## Stage Progress
<!-- Checkbox states: [ ] pending, [-] in-progress, [?] awaiting approval, [R] revising, [x] completed, [S] skipped -->

The engine emits one phase heading per compiled phase, then one checkbox row per
compiled stage in that phase:

### [PHASE] PHASE
- [ ] stage-slug — [EXECUTE/SKIP: reason]

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
