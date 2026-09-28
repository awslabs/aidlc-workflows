# AI-DLC State Tracking

This document defines the `aidlc-state.md` section and field contract. The
engine writes the concrete state file and enumerates stages from the compiled
stage graph plus scope grid; this template must not hand-list shipped stages.
The exact initial description is JSON-encoded as one string beside the state
file in `<record>/project-description.json`; the `Project` field below is its
safe single-line preview.

Authoritative generated views:
- Stage graph: `{{INVOKE}} engine gen stage-table`
- Scope grid: `{{INVOKE}} engine gen scope-table`

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
- **Guard Policy**: [strict/relaxed/off, then its source in parentheses: `(from scope <name>)`, `(from <layer>.md)`, or `(set by you)`; written at intent creation with the resolved value, rewritten by `/aidlc --guard-policy` or the plain-chat request, read by value only. When a record carries only the retired `**Change Control**` line, every `/aidlc` run announces that a carried-over relaxed or off value now also lowers fences for work nobody directed and every pass is recorded in the audit trail, and asks the person to keep it or raise the fences again; the notice repeats until the person chooses a Guard Policy setting; a retired strict line alone gets no notice. If both lines carry different policy words, strict applies with source `conflicting state lines` unless memory holds strict, and `next` repeats a notice containing both raw values until the person chooses; if both agree, `Guard Policy` is used. Any policy write removes the retired line and retains only `Guard Policy`; `next` writes nothing]
- **Guards Off**: [only present once a fence was switched off for this piece of work: a comma list of `plan-approval`, `review-freeze`, `state-transition`, `reviewer-scope` followed by `(set by you)`, or `none`; written by `/aidlc config set guard.<fence> off|on`; a persisted human-presence entry is ignored because human presence has no per-work switch]
- **Guards On**: [only present once a fence was forced on above the policy word for this piece of work: a comma list of `plan-approval`, `review-freeze`, `state-transition`, `reviewer-scope` followed by `(set by you)`, or `none`; written by `/aidlc config set guard.<fence> on|off`; a persisted human-presence entry is ignored; precedence is environment kill switch, Guards Off, Guards On, Guard Policy, then on by default]
- **Sensors**: [on/off, then its source in parentheses: `(from scope <name>)` or `(set by you)`; written at intent creation with the scope default, rewritten by `/aidlc --sensors`, read by value only]
- **Learnings**: [on/off, then its source in parentheses: `(from scope <name>)` or `(set by you)`; written at intent creation with the scope default, rewritten by `/aidlc --learnings`, read by value only]
- **Summary Confirmation**: [on/off, then its source in parentheses: `(from scope <name>)` or `(set by you)`; written at intent creation with the scope default, rewritten by `/aidlc --summary-confirmation`, read by value only]

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
- **Construction Checkpoints**: [enabled for new workflows; absent on legacy workflows]
- **Construction Iteration**: [unit-major/stage-major; new workflows default to unit-major, preserve an explicit choice]
- **Construction Execution**: [serial/swarm; new workflows default to serial, swarm requires stage-major]
- **Construction Verification Command**: [human-approved project check command; unset until a matching verification-command receipt is recorded]
- **Unit Ownership**: [solo/team; optional, exact `team` activates the derived grid]
- **Unit Gate Rhythm**: [per-stage/unit-end; optional, defaults to per-stage under team ownership]

Checkpoint policy applies only to solo work with an actual non-empty Unit DAG.
Existing workflows without the checkpoint field retain their legacy first-stage
and late per-stage approvals. An absent execution field preserves legacy
autonomy-based swarm routing. Execution selection is independent of approval;
team ownership retains its `unit_gate` policy.

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
- **Status**: [Running/Completed/Archived]
- **Construction Autonomy Mode**: [unset/autonomous/gated]
- **Last Updated**: [ISO 8601 timestamp]

## Session Resume Point
- **Last Completed Stage**: [stage slug]
- **Next Action**: [what to do next]
- **Pending Artifacts**: [any incomplete artifacts or none]
