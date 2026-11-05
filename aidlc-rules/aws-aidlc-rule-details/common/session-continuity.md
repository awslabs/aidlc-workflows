# Session Continuity Templates

## Welcome Back Prompt Template
When a user returns to continue work on an existing AI-DLC project, present this prompt:

```markdown
**Welcome back! I can see you have an existing AI-DLC project in progress.**

Based on your aidlc-state.md, here's your current status:
- **Project**: [project-name]
- **Current Phase**: [INCEPTION/CONSTRUCTION/OPERATIONS]
- **Current Stage**: [Stage Name]
- **Last Completed**: [Last completed step]
- **Next Step**: [Next step to work on]

**What would you like to work on today?**

A) Continue where you left off ([Next step description])

B) Review a previous stage ([Show available stages])

[Answer]: 
```

## MANDATORY: Approval Gate Status Interpretation

**CRITICAL**: `COMPLETED` in `aidlc-state.md` means the artifact was *generated*, not necessarily that the user *approved* it. A fresh session reading the state file cannot distinguish between these two states from `COMPLETED` alone.

When resuming a session, apply the following rules before proceeding past any stage:

| State file entry | Interpretation | Correct action |
|---|---|---|
| `[ ] Stage Name` | Not started | Begin stage from scratch |
| `[x] Stage Name (Approved)` | Generated AND approved | Proceed to next stage |
| `[x] Stage Name` (no `(Approved)` annotation) | Generated, approval status unknown | **Halt. Present the artifact and request explicit approval before continuing** |

**On resumption, for every stage marked `[x]` without `(Approved)`, you MUST**:
1. Load the stage artifact from the project docs directory
2. Present it to the user with: *"I can see [Stage Name] was completed in a previous session but I cannot confirm it was approved. Please review the artifact below and confirm: **Approve and continue** or **Request changes**."*
3. Do NOT proceed to the next stage until the user explicitly approves

**Audit trail cross-check**: When in doubt, read `aidlc-docs/audit.md`. If the audit trail shows "awaiting user approval" for a stage that `aidlc-state.md` marks as `COMPLETED`, treat it as unapproved and halt at the gate.

## MANDATORY: Session Continuity Instructions
1. **Always read aidlc-state.md first** when detecting existing project
2. **Parse current status** from the workflow file to populate the prompt — and apply the approval gate interpretation rules above before advancing past any stage
3. **MANDATORY: Load Previous Stage Artifacts** - Before resuming any stage, automatically read all relevant artifacts from previous stages:
   - **Reverse Engineering**: Read architecture.md, code-structure.md, api-documentation.md
   - **Requirements Analysis**: Read requirements.md, requirement-verification-questions.md
   - **User Stories**: Read stories.md, personas.md, story-generation-plan.md
   - **Application Design**: Read application-design artifacts (components.md, component-methods.md, services.md)
   - **Design (Units)**: Read unit-of-work.md, unit-of-work-dependency.md, unit-of-work-story-map.md
   - **Per-Unit Design**: Per-unit artifacts live under `aidlc-docs/construction/{unit-name}/` in
     `functional-design/`, `nfr-requirements/`, `nfr-design/`, and `infrastructure-design/`
     subdirectories. On resume, determine the in-progress unit from `aidlc-state.md` and load that
     unit's design artifacts, plus the design artifacts of any units it depends on (per
     `unit-of-work-dependency.md`). The exact files in each subdirectory are enumerated by the
     corresponding construction stage rules.
   - **Code Stages**: Read all code files, plans, AND all previous artifacts
4. **Smart Context Loading by Stage**:
   - **Early Stages (Workspace Detection, Reverse Engineering)**: Load workspace analysis
   - **Requirements/Stories**: Load reverse engineering + requirements artifacts
   - **Design Stages**: Load requirements + stories + architecture + design artifacts
   - **Code Stages**: Load ALL artifacts + existing code files
5. **Adapt options** based on architectural choice and current phase
6. **Show specific next steps** rather than generic descriptions
7. **Log the continuity prompt** in audit.md with timestamp
8. **Context Summary**: After loading artifacts, provide brief summary of what was loaded for user awareness
9. **Asking questions**: ALWAYS ask clarification or user feedback questions by placing them in .md files. DO NOT place the multiple-choice questions in-line in the chat session.

## Error Handling
If artifacts are missing or corrupted during session resumption, see [error-handling.md](error-handling.md) for guidance on recovery procedures. 