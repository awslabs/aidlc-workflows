# Phase 6: Audit (AUDIT)

## Objective

Record what was done and why. Create an audit trail for future reference, compliance, and future AI sessions.

## Instructions

### Step 1: Summarize the Task

Write or append to `.aidlc/audit.md` using the XML-structured format:

```markdown
<audit_entry>
  <task_name>task-name</task_name>
  <date>YYYY-MM-DD</date>
  <phases_completed>detect, requirements, plan, implement, verify</phases_completed>
  <outcome>success</outcome>
</audit_entry>

<summary>
## Summary
...
</summary>

<key_decisions>
## Key Decisions

<decision id="D1">
  <what>What was decided</what>
  <why>Rationale</why>
  <alternatives>
    <alt>Alternative considered and why rejected</alt>
  </alternatives>
</decision>
</key_decisions>

<files_changed>
## Files Changed
| File | Action | Purpose |
...
</files_changed>

<known_limitations>
## Known Limitations
...
</known_limitations>

<follow_up_items>
## Follow-up Items
...
</follow_up_items>
---
```

### Step 2: Update State File

Update `.aidlc/state.md`:
```yaml
phase: complete
outcome: success | partial | failed
```

### Step 3: Final Summary

Present to user:
```
## Task Complete: <task-name>

**What was built:** <1 sentence>
**Files changed:** N total
**Decisions logged:** N

### Follow-up (if any):
- ...
```

### Step 4: Checkpoint

Ask: "Task is complete and documented. Anything else?"

The task is officially done when the user confirms. The `.aidlc/state.md` will guide the next session.
