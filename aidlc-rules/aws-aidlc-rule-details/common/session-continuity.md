# Session Continuity Templates

## Feature Detection on Resume
When a user returns, scan `aidlc-docs/` for existing feature folders (subdirectories containing `aidlc-state.md`):

**Single feature found**: Auto-select and present the Welcome Back prompt below.

**Multiple features found**: Present a feature selection prompt first:
```markdown
**Welcome back! I found multiple AI-DLC features in progress.**

Available features:
1. **{feature-name-1}** - [Current Stage from aidlc-state.md]
2. **{feature-name-2}** - [Current Stage from aidlc-state.md]
...

A) Continue feature 1: {feature-name-1}
B) Continue feature 2: {feature-name-2}
...
N) Start a new feature

[Answer]: 
```

**Legacy flat structure found** (aidlc-state.md directly in aidlc-docs/ with no feature subfolder):
```markdown
**Welcome back! I found an existing AI-DLC project using the legacy flat structure.**

To support concurrent feature development, I need to migrate your existing docs into a feature folder.

What name should I use for this feature? (e.g., "User Authentication", "Payment Processing")
```
After receiving the name, move all artifacts from `aidlc-docs/` into `aidlc-docs/{feature-name}/`.

## Welcome Back Prompt Template
After feature selection, present this prompt:

```markdown
**Welcome back! Resuming feature: {feature-name}**

Based on your aidlc-state.md, here's your current status:
- **Feature**: {feature-name}
- **Current Phase**: [INCEPTION/CONSTRUCTION/OPERATIONS]
- **Current Stage**: [Stage Name]
- **Last Completed**: [Last completed step]
- **Next Step**: [Next step to work on]

**What would you like to work on today?**

A) Continue where you left off ([Next step description])
B) Review a previous stage ([Show available stages])

[Answer]: 
```

## MANDATORY: Session Continuity Instructions
1. **Always scan aidlc-docs/ for feature folders first** when detecting existing projects
2. **Resolve feature selection** before loading any state (single feature auto-selects, multiple features prompt user)
3. **Read aidlc-docs/{feature-name}/aidlc-state.md** after feature is selected
4. **Parse current status** from the workflow file to populate the prompt
5. **MANDATORY: Load Previous Stage Artifacts** - Before resuming any stage, automatically read all relevant artifacts from previous stages (all paths resolve under `aidlc-docs/{feature-name}/`):
   - **Reverse Engineering**: Read architecture.md, code-structure.md, api-documentation.md
   - **Requirements Analysis**: Read requirements.md, requirement-verification-questions.md
   - **User Stories**: Read stories.md, personas.md, story-generation-plan.md
   - **Application Design**: Read application-design artifacts (components.md, component-methods.md, services.md)
   - **Design (Units)**: Read unit-of-work.md, unit-of-work-dependency.md, unit-of-work-story-map.md
   - **Per-Unit Design**: Read functional-design.md, nfr-requirements.md, nfr-design.md, infrastructure-design.md
   - **Code Stages**: Read all code files, plans, AND all previous artifacts
6. **Smart Context Loading by Stage**:
   - **Early Stages (Workspace Detection, Reverse Engineering)**: Load workspace analysis
   - **Requirements/Stories**: Load reverse engineering + requirements artifacts
   - **Design Stages**: Load requirements + stories + architecture + design artifacts
   - **Code Stages**: Load ALL artifacts + existing code files
7. **Adapt options** based on architectural choice and current phase
8. **Show specific next steps** rather than generic descriptions
9. **Log the continuity prompt** in audit.md with timestamp
10. **Context Summary**: After loading artifacts, provide brief summary of what was loaded for user awareness
11. **Asking questions**: ALWAYS ask clarification or user feedback questions by placing them in .md files. DO NOT place the multiple-choice questions in-line in the chat session.

## Error Handling
If artifacts are missing or corrupted during session resumption, see [error-handling.md](error-handling.md) for guidance on recovery procedures. 