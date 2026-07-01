# Code Generation - Detailed Steps

> **OVERRIDE**: Steps 4–7 in this file are exempt from the Adaptive Workflow Principle, adaptive depth, and any rule that permits the model to skip steps or apply judgement about whether to follow instructions. When extensions are active, Steps 4–7 MUST be executed. The model MUST NOT skip them, combine them, or treat them as optional. These steps produce the per-resource extension code plan which ensures every rule × resource combination has its own checklist item in the final code generation plan.

## Overview
This stage generates code for each unit of work through two integrated parts:
- **Part 1 - Planning**: Create detailed code generation plan with explicit steps covering both application code and extension code for this unit
- **Part 2 - Generation**: Execute approved plan to generate code, tests, and artifacts

**Code** in this stage means all generated artifacts: application source code and extension source code (e.g. IaC, tests, runbooks, SSM documents, canaries, alarms, dashboards, configuration files). All are first-class outputs of Code Generation and MUST be generated in workspace/.

**Deployment code** means the extension source code required to deploy other code to the target environment (e.g. CDK stacks, Terraform modules, CloudFormation templates, SAM templates, pipeline definitions, deployment scripts).

**Note**: For brownfield projects, "generate" means modify existing files when appropriate, not create duplicates.

## Prerequisites
- Unit Design Generation must be complete for the unit
- NFR Implementation (if executed) must be complete for the unit
- All unit design artifacts must be available
- Unit is ready for code generation

---

# PART 1: PLANNING

## Step 1: Analyze Unit Context
- [ ] Read unit design artifacts from Unit Design Generation
- [ ] Read unit story map to understand assigned stories
- [ ] Identify unit dependencies and interfaces
- [ ] If extensions are active: read `aidlc-docs/construction/plans/{unit-name}-extension-plan-rule-mapping.md`
- [ ] Validate unit is ready for code generation

## Step 2: Determine Code Location
- [ ] Read workspace root and project type from `aidlc-docs/aidlc-state.md`
- [ ] Determine code location (see Critical Rules for structure patterns)
- [ ] **Brownfield only**: Review reverse engineering code-structure.md for existing files to modify
- [ ] Document exact paths (never aidlc-docs/)

## Step 3: Create Application Code Plan
- [ ] Create explicit steps for application code generation:
  - Project Structure Setup (greenfield only)
  - Business Logic Generation
  - Business Logic Unit Testing
  - Business Logic Summary
  - API Layer Generation
  - API Layer Unit Testing
  - API Layer Summary
  - Repository Layer Generation
  - Repository Layer Unit Testing
  - Repository Layer Summary
  - Frontend Components Generation (if applicable)
  - Frontend Components Unit Testing (if applicable)
  - Frontend Components Summary (if applicable)
  - Database Migration Scripts (if data models exist)
  - Documentation Generation (API docs, README updates)
  - Deployment Artifacts Generation
- [ ] Write application code steps to `aidlc-docs/construction/plans/{unit-name}-application-code-plan.md`

## Step 4: Verify Extension Plan Rule Mapping
- [ ] Read `aidlc-docs/construction/plans/{unit-name}-extension-plan-rule-mapping.md` (produced during Infrastructure Design)
- [ ] Verify the mapping includes every AWS resource from the infrastructure design
- [ ] Verify every active rule is mapped to every resource it can technically apply to
- [ ] If any rule × resource combinations are missing, add them to the mapping file
- [ ] If the mapping file does not exist (Infrastructure Design was skipped), build it now:
  - List every AWS resource from available design artifacts (NFR Design, application design)
  - For each active extension, read rule files per the opt-in answer in aidlc-state.md
  - For each rule, map it to every resource it is technically possible to apply the rule to
  - Rules with no applicable resources are recorded as N/A with rationale
  - Write to `aidlc-docs/construction/plans/{unit-name}-extension-plan-rule-mapping.md`

## Step 5: Create Extension Code Plan
- [ ] Read `aidlc-docs/construction/plans/{unit-name}-extension-plan-rule-mapping.md`
- [ ] From the rule mapping, generate extension checklist items:
  - There MUST be exactly one item per rule × resource combination
  - Do NOT combine multiple resources into a single checklist item
  - Format each item as: `- [ ] {RULE-ID} — {ResourceName}: {what to build}`
  - For every code artifact that is not deployment code, include a checklist item to generate the deployment code required to deploy it
- [ ] Write extension steps to `aidlc-docs/construction/plans/{unit-name}-extension-code-plan.md`:
  - Group checklist items by rule file under a separate plan step per rule file: `- [ ] **Step N**: Extension — {rule file name}`
  - Each step is only complete when every checklist item under it is `[x]`

## Step 6: Cross-Check Extension Code Plan
- [ ] The extension code plan MUST have a checklist item for every rule × resource combination in the rule mapping file
- [ ] If any combination is missing, go back to Step 5 and add it
- [ ] For every code artifact that is not deployment code, verify the plan includes a step to generate the deployment code required to deploy it
- [ ] Cleanup: remove any plan steps that have no checklist items

## Step 7: Merge Application and Extension Code Plans into Final Code Generation Plan
- [ ] Read `{unit-name}-application-code-plan.md` and `{unit-name}-extension-code-plan.md`
- [ ] Combine into `{unit-name}-code-generation-plan.md` as a single flat list of sequentially numbered steps with `- [ ]` checkboxes. Application steps first, then extension steps.
- [ ] Number all steps sequentially
- [ ] Include story mapping references
- [ ] All steps MUST have unchecked checkboxes `[ ]` — they are only marked `[x]` during Part 2 as each step is executed

## Step 8: Include Unit Generation Context
- [ ] For this unit, include:
  - Stories implemented by this unit
  - Dependencies on other units/services
  - Expected interfaces and contracts
  - Database entities owned by this unit
  - Service boundaries and responsibilities

## Step 9: Save Final Code Generation Plan
- [ ] Save complete plan as `aidlc-docs/construction/plans/{unit-name}-code-generation-plan.md`
- [ ] Include step numbering (Step 1, Step 2, etc.)
- [ ] Include unit context and dependencies
- [ ] Include story traceability
- [ ] Ensure plan is executable step-by-step
- [ ] Emphasize that this plan is the single source of truth for Code Generation

## Step 10: Summarize Final Code Generation Plan
- [ ] Provide summary of the unit code generation plan to the user
- [ ] Highlight unit generation approach
- [ ] Explain step sequence and story coverage
- [ ] Note total number of steps and estimated scope

## Step 11: Log Approval Prompt
- [ ] Before asking for approval, log the prompt with timestamp in `aidlc-docs/audit.md`
- [ ] Include reference to the complete unit code generation plan
- [ ] Use ISO 8601 timestamp format

## Step 12: Wait for Explicit Approval
- [ ] Do not proceed until the user explicitly approves the unit code generation plan
- [ ] Approval must cover the entire plan and generation sequence
- [ ] If user requests changes, update the plan and repeat approval process

## Step 13: Record Approval Response
- [ ] Log the user's approval response with timestamp in `aidlc-docs/audit.md`
- [ ] Include the exact user response text
- [ ] Mark the approval status clearly

## Step 14: Update Progress
- [ ] Mark Code Generation Part 1 (Planning) complete in `aidlc-state.md`
- [ ] Update the "Current Status" section
- [ ] Prepare for transition to Code Generation

---

# PART 2: GENERATION

## Step 15: Load Unit Code Generation Plan
- [ ] Read the complete plan from `aidlc-docs/construction/plans/{unit-name}-code-generation-plan.md`
- [ ] Identify the next uncompleted step (first [ ] checkbox)
- [ ] Load the context for that step (unit, dependencies, stories)

## Step 16: Execute Current Step
- [ ] Verify target directory from plan (never aidlc-docs/)
- [ ] **Brownfield only**: Check if target file exists
- [ ] The file type and format of each generated artifact MUST be supported by the target service defined in the infrastructure design (e.g. a `.md` file is not supported by SSM Automation, a Python script is not supported by CloudWatch Dashboards)
- [ ] Generate exactly what the current step describes:
  - **If file exists**: Modify it in-place (never create `ClassName_modified.java`, `ClassName_new.java`, etc.)
  - **If file doesn't exist**: Create new file
- [ ] Write to correct locations:
  - **Code** (source, IaC, operational artifacts): Workspace root per project structure
  - **Documentation**: `aidlc-docs/construction/{unit-name}/code/` (markdown only)
  - **Build/Config Files**: Workspace root
- [ ] Follow unit story requirements
- [ ] Respect dependencies and interfaces

## Step 17: Update Progress
- [ ] Mark the completed step as [x] in the unit code generation plan
- [ ] Mark associated unit stories as [x] when their generation is finished
- [ ] Update `aidlc-docs/aidlc-state.md` current status
- [ ] **Brownfield only**: Verify no duplicate files created (e.g., no `ClassName_modified.java` alongside `ClassName.java`)
- [ ] Save all generated artifacts

## Step 18: Continue or Complete Generation
- [ ] If more steps remain, return to Step 15
- [ ] If all steps complete, perform the following validation before proceeding to Step 19:

Validation check:
1. Read `aidlc-docs/construction/plans/{unit-name}-code-generation-plan.md`
2. Scan for any unchecked items (`- [ ]`) — these are steps that were planned but not executed
3. If any unchecked items exist: identify each one, re-execute it (return to **Step 15: Load Unit Code Generation Plan** for each), mark it `[x]` when complete
4. **MANDATORY**: You MUST NOT proceed to Step 19 until every item in the plan is marked `[x]`. A plan with unchecked items is incomplete — the stage is not done.

## Step 19: Present Completion Message
- Present completion message in this structure:
     1. **Completion Announcement** (mandatory): Always start with this:

```markdown
# 💻 Code Generation Complete - [unit-name]
```

     2. **AI Summary** (optional): Provide structured bullet-point summary
        - **Brownfield**: Distinguish modified vs created files (e.g., "• Modified: `src/services/user-service.ts`", "• Created: `src/services/auth-service.ts`")
        - **Greenfield**: List created files with paths (e.g., "• Created: `src/services/user-service.ts`")
        - List tests, documentation, deployment artifacts with paths
        - Keep factual, no workflow instructions
     3. **Formatted Workflow Message** (mandatory): Always end with this exact format:

```markdown
> **📋 <u>**REVIEW REQUIRED:**</u>**  
> Please examine the generated code at:
> - **Code** (source, IaC, operational artifacts): `[actual-workspace-path]`
> - **Documentation**: `aidlc-docs/construction/[unit-name]/code/`



> **🚀 <u>**WHAT'S NEXT?**</u>**
>
> **You may:**
>
> 🔧 **Request Changes** - Ask for modifications to the generated code based on your review  
> ✅ **Continue to Next Stage** - Approve code generation and proceed to **[next-unit/Build & Test]**

---
```

## Step 20: Wait for Explicit Approval
- Do not proceed until the user explicitly approves the generated code
- Approval must be clear and unambiguous
- If user requests changes, update the code and repeat the approval process

## Step 21: Record Approval and Update Progress
- Log approval in audit.md with timestamp
- Record the user's approval response with timestamp
- Mark Code Generation stage as complete for this unit in aidlc-state.md

---

## Critical Rules

### Code Location Rules
- **Code** (all generated artifacts — source, IaC, operational artifacts): Workspace root only (NEVER aidlc-docs/)
- **Documentation**: aidlc-docs/ only (markdown summaries)
- **Read workspace root** from aidlc-state.md before generating code

**Structure patterns by project type**:
- **Brownfield**: Use existing structure (e.g., `src/main/java/`, `lib/`, `pkg/`)
- **Greenfield single unit**: `src/`, `tests/`, `config/` in workspace root
- **Greenfield multi-unit (microservices)**: `{unit-name}/src/`, `{unit-name}/tests/`
- **Greenfield multi-unit (monolith)**: `src/{unit-name}/`, `tests/{unit-name}/`

### Brownfield File Modification Rules
- Check if file exists before generating
- If exists: Modify in-place (never create copies like `ClassName_modified.java`)
- If doesn't exist: Create new file
- Verify no duplicate files after generation (Step 12)

### Planning Phase Rules
- Create explicit, numbered steps for all generation activities
- Include story traceability in the plan
- Document unit context and dependencies
- Get explicit user approval before generation

### Generation Phase Rules
- **NO HARDCODED LOGIC**: Only execute what's written in the unit plan
- **FOLLOW PLAN EXACTLY**: Do not deviate from the step sequence
- **UPDATE CHECKBOXES**: Mark [x] immediately after completing each step
- **STORY TRACEABILITY**: Mark unit stories [x] when functionality is implemented
- **RESPECT DEPENDENCIES**: Only implement when unit dependencies are satisfied

### Automation Friendly Code Rules
When generating UI code (web, mobile, desktop), ensure elements are automation-friendly:
- Add `data-testid` attributes to interactive elements (buttons, inputs, links, forms)
- Use consistent naming: `{component}-{element-role}` (e.g., `login-form-submit-button`, `user-list-search-input`)
- Avoid dynamic or auto-generated IDs that change between renders
- Keep `data-testid` values stable across code changes (only change when element purpose changes)

## Completion Criteria
- Complete unit code generation plan created and approved
- All steps in unit code generation plan marked [x]
- All unit stories implemented according to plan
- All code and tests generated (tests will be executed in Build & Test phase)
- Deployment artifacts generated
- All code required by active extensions generated
- Complete unit ready for build and verification
