---
name: aidlc-kickoff
description: |
  AI-DLC workspace kickoff. Handles the welcome banner and workspace setup — initialising the intent and its state and audit artifacts through the repository. Read by the orchestrator at the start of every new intent.
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

Initialise the intent through the repository. The repository operations named here are responsibilities you carry out via the mechanism the active backend's adapter specifies — that may be your ordinary read/write/shell tools (markdown-fs backend) or specific tools / an MCP server (e.g. a graph backend). First read `conventions/repository-interface.md` (what each operation must achieve) and `conventions/artifact-repository.md` (how to achieve it, and which mechanism to use, on the active backend); then do the following:

1. Determine the intent slug from the human's statement (kebab-case, concise)
2. Perform `initIntent` for this intent: create the intent's home and initialise the `state` artifact (empty stages array, per `conventions/state-schema.json`) and the `audit` artifact (empty entries array, per `conventions/audit-schema.json`), as the adapter describes. The adapter's rules cover numbering and placement.
3. Perform `saveArtifact` for the `intent` artifact (verbatim prompt + summary + slug + type).

After setup is complete, proceed to workflow composition.
