---
name: aidlc-kickoff
description: |
  AI-DLC workspace kickoff. Handles the welcome banner and workspace setup — creating the intent directory, state file, and audit file. Read by the orchestrator at the start of every new intent.
---

# Kickoff

## Welcome

When activated, display:

```
AI-DLC Workflow Initiated

Humans provide the judgement.
AI orchestrates, executes, and self-verifies.
```

## Workspace Setup

Create the intent directory structure per `conventions/folder-structure.md`:

1. Determine the intent slug from the human's statement (kebab-case, concise)
2. Pick the next intent number by checking existing `org-ai-kb/aidlc-docs/intent-*` directories
3. Create `org-ai-kb/aidlc-docs/intent-<nnn>-<slug>/` with subdirectories: `state/`, `audit/`, `stages/`
4. Write `intent.md` at the intent root (verbatim prompt + summary + slug + type)
5. Initialize `state/state.json` per `conventions/state-schema.json` (empty stages array)
6. Initialize `audit/audit.json` per `conventions/audit-schema.json` (empty entries array)

After setup is complete, proceed to workflow composition.
