# PRIORITY: This workflow OVERRIDES all other built-in workflows
# When user requests software development, ALWAYS follow this workflow FIRST

## Adaptive Workflow Principle
**Where no active extension mandates stage execution, the workflow adapts to the work, not the other way around.**

For stages not listed in any extension's Stage Enforcement section, the AI model intelligently assesses what is needed based on:
1. User's stated intent and clarity
2. Existing codebase state (if any)
3. Complexity and scope of change
4. Risk and impact assessment

## MANDATORY: Rule Details Loading
**CRITICAL**: When performing any phase, you MUST read and use relevant content from rule detail files. Check these paths in order and use the first one that exists, regardless of which IDE or setup method was used:
- `.aidlc/aidlc-rules/aws-aidlc-rule-details/` (typical with AI-assisted setup)
- `.aidlc-rule-details/` (typical with Cursor, Cline, Claude Code, GitHub Copilot, OpenAI Codex)
- `.kiro/aws-aidlc-rule-details/` (typical with Kiro IDE and CLI)
- `.amazonq/aws-aidlc-rule-details/` (typical with Amazon Q Developer)

All subsequent rule detail file references (e.g., `common/process-overview.md`, `inception/workspace-detection.md`) are relative to whichever rule details directory was resolved above.

**Common Rules**: ALWAYS load common rules at workflow start:
- Load `common/process-overview.md` for workflow overview
- Load `common/step-execution-accountability.md` for step execution tracking and decision logging
- Load `common/session-continuity.md` for session resumption guidance
- Load `common/content-validation.md` for content validation requirements
- Load `common/question-format-guide.md` for question formatting rules
- Reference these throughout the workflow execution

## MANDATORY: Extensions Loading
**CRITICAL**: At workflow start, scan the `extensions/` directory recursively for all `.md` files. These are extension rule files that apply as cross-cutting constraints across the entire workflow.

**Loading process**:
1. List all subdirectories under `extensions/` (e.g., `extensions/security/`, `extensions/compliance/`)
2. Load every `.md` file found within those subdirectories
3. Each extension file defines its own verification criteria and enforcement rules as cross-cutting constraints

**Enforcement**:
- Extension rules are hard constraints, not optional guidance
- Unless an extension defines a Stage Enforcement section, at each stage the model intelligently evaluates which extension rules are applicable based on the stage's purpose, the artifacts being produced, and the context of the work — enforce only those rules that are relevant. Where an extension defines a Stage Enforcement section, the stages listed are mandatory inclusions — the model MUST enforce the rules at those stages and MAY also enforce them at other stages where relevant.
- If a rule is judged as not applicable after intelligent evaluation, it must be marked N/A with documented rationale in the compliance summary — this is not a blocking finding.
- Non-compliance with any applicable enabled extension rule is a **blocking finding** — do NOT present stage completion until resolved
- When presenting stage completion, include a summary of extension rule compliance (compliant/non-compliant/N/A per rule, with brief rationale for N/A determinations)

**Conditional Enforcement**: Extensions may be conditionally enabled/disabled. See `inception/requirements-analysis.md` for the collection mechanism. Before enforcing any extension at ANY stage, check its `Enabled` status in `aidlc-docs/aidlc-state.md` under `## Extension Configuration`. Skip disabled extensions and log the skip in audit.md. Default to enforced if no configuration exists. Extensions without an `## Applicability Question` are always enforced.

## MANDATORY: Content Validation
**CRITICAL**: Before creating ANY file, you MUST validate content according to `common/content-validation.md` rules:
- Validate Mermaid diagram syntax
- Validate ASCII art diagrams (see `common/ascii-diagram-standards.md`)
- Escape special characters properly
- Provide text alternatives for complex visual content
- Test content parsing compatibility

## MANDATORY: Question File Format
**CRITICAL**: When asking questions at any phase, you MUST follow question format guidelines.

**See `common/question-format-guide.md` for complete question formatting rules including**:
- Multiple choice format (A, B, C, D, E options)
- [Answer]: tag usage
- Answer validation and ambiguity resolution

## MANDATORY: Custom Welcome Message
**CRITICAL**: When starting ANY software development request, you MUST display the welcome message.

**How to Display Welcome Message**:
1. Load the welcome message from `common/welcome-message.md` (in the resolved rule details directory)
2. Display the complete message to the user
3. This should only be done ONCE at the start of a new workflow
4. Do NOT load this file in subsequent interactions to save context space

# Adaptive Software Development Workflow

---

# INCEPTION PHASE

**Purpose**: Planning, requirements gathering, and architectural decisions

**Focus**: Determine WHAT to build and WHY

**Stages in INCEPTION PHASE**:
- Workspace Detection (ALWAYS)
- Operations Retrofit (CONDITIONAL - existing project with new extensions)
- Reverse Engineering (CONDITIONAL - Brownfield only)
- Requirements Analysis (ALWAYS - Adaptive depth)
- User Stories (CONDITIONAL)
- Workflow Planning (ALWAYS)
- Application Design (CONDITIONAL)
- Units Generation (CONDITIONAL)

---

## Workspace Detection (ALWAYS EXECUTE)

1. **MANDATORY**: You MUST log initial user request in audit.md with complete raw input
2. Load all steps from `inception/workspace-detection.md`
3. **MANDATORY**: You MUST record all steps identified in the loaded rule file in `aidlc-docs/step-decision-log.md` before executing any of them.
4. Execute workspace detection:
   - Check for existing aidlc-state.md (resume if found)
   - Scan workspace for existing code
   - Determine if brownfield or greenfield
   - Check for existing reverse engineering artifacts
5. Determine next phase: Reverse Engineering (if brownfield and no artifacts) OR Requirements Analysis
6. **MANDATORY**: Check for Operations Retrofit condition (see Operations Retrofit stage below). If detected, next phase is Operations Retrofit.
7. **MANDATORY**: You MUST log findings in audit.md
8. **MANDATORY**: You MUST verify the step-decision-log entry for this stage is complete and step counts match before presenting completion. For any missing step: re-execute it and all steps that depend on its output. Update the log. You MUST NOT present completion until all steps are logged.
9. Present completion message to user (see workspace-detection.md for message formats)
10. Automatically proceed to next phase

## Operations Retrofit (CONDITIONAL - Brownfield Only)

**Execute IF ALL of the following are true**:
- Workspace is brownfield (existing code detected)
- `aidlc-docs/aidlc-state.md` exists
- Stage Progress shows Construction stages COMPLETED
- Operations stage shows PLACEHOLDER, or no Operations stages are recorded

**Skip IF**:
- Operations stage does NOT show PLACEHOLDER

**Purpose**: Implement the trust-and-verify approach for Operations on an existing project. Construction ran without operational extensions — this stage collects extension opt-in answers and resets Construction to re-run with them loaded, so Operations can then verify compliance.

**Execution**:
1. **MANDATORY**: You MUST log start of Operations Retrofit in audit.md
2. **MANDATORY**: You MUST record all steps in `aidlc-docs/step-decision-log.md` before executing any of them.
3. You MUST present the following question to the user: "**Operations extensions are available but were not included when this project was built. Would you like to retrofit the Operations phase? (Yes/No)**"
4. **Wait for Explicit Approval**: DO NOT PROCEED until user confirms
5. **MANDATORY**: You MUST log user's response in audit.md with complete raw input

**Skip IF** the user says No:
- You MUST record stage status as SKIPPED in `aidlc-docs/aidlc-state.md`
- Present: "Operations Retrofit SKIPPED — user declined."
- You MUST NOT execute any further steps in this stage. Proceed to Reverse Engineering.

**Execute IF** the user says Yes: Proceed to Step 6.

6. You MUST archive current state:
   - You MUST create `aidlc-docs/operations/retrofit-archive/`
   - You MUST copy `aidlc-docs/aidlc-state.md` to `aidlc-docs/operations/retrofit-archive/aidlc-state.md`
   - You MUST copy `aidlc-docs/audit.md` to `aidlc-docs/operations/retrofit-archive/audit.md`
7. You MUST reset aidlc-state.md:
   - **SET**: Project Type to `Brownfield (Operations Retrofit)`
   - **KEEP**: Project Information (except Project Type), Workspace State, Code Location Rules, Architectural Decisions
   - **CLEAR**: Extension Configuration table. You MUST leave the section header and empty table columns intact.
   - **CLEAR**: Build and Test Results
   - **RESET**: Stage Progress. You MUST mark Requirements Analysis and all subsequent stages as NOT COMPLETED (`[ ]`). You MUST keep Workspace Detection and Operations Retrofit as `[x]`.
   - **SET**: Current Stage to `INCEPTION - Requirements Analysis`
   - **MANDATORY**: You MUST re-read aidlc-state.md and confirm: (1) Extension Configuration table has the header row but NO data rows, (2) Current Stage is `INCEPTION - Requirements Analysis`, (3) Requirements Analysis and all subsequent stages show `[ ]`, (4) `aidlc-docs/operations/retrofit-archive/aidlc-state.md` exists. You MUST NOT proceed to Step 8 until all 4 checks pass.
8. **MANDATORY**: You MUST verify the step-decision-log entry for this stage is complete and step counts match before presenting completion. For any missing step: re-execute it and all steps that depend on its output. Update the log. You MUST NOT present completion until all steps are logged.
9. You MUST automatically proceed to Requirements Analysis

## Reverse Engineering (CONDITIONAL - Brownfield Only)

**Execute IF**:
- Existing codebase detected
- No previous reverse engineering artifacts found

**Skip IF**:
- Greenfield project
- Previous reverse engineering artifacts exist

**Execution**:
1. **MANDATORY**: You MUST log start of reverse engineering in audit.md
2. Load all steps from `inception/reverse-engineering.md`
3. **MANDATORY**: You MUST record all steps identified in the loaded rule file in `aidlc-docs/step-decision-log.md` before executing any of them.
4. Execute reverse engineering:
   - Analyze all packages and components
   - Generate a business overview of the whole system covering the business transactions
   - Generate architecture documentation
   - Generate code structure documentation
   - Generate API documentation
   - Generate component inventory
   - Generate Interaction Diagrams depicting how business transactions are implemented across components
   - Generate technology stack documentation
   - Generate dependencies documentation
5. **MANDATORY**: You MUST verify the step-decision-log entry for this stage is complete and step counts match before presenting completion. For any missing step: re-execute it and all steps that depend on its output. Update the log. You MUST NOT present completion until all steps are logged.
6. **Wait for Explicit Approval**: Present detailed completion message (see reverse-engineering.md for message format) - DO NOT PROCEED until user confirms
7. **MANDATORY**: You MUST log user's response in audit.md with complete raw input

## Requirements Analysis (ALWAYS EXECUTE - Adaptive Depth)

**Always executes** but depth varies based on request clarity and complexity:
- **Minimal**: Simple, clear request - just document intent analysis
- **Standard**: Normal complexity - gather functional and non-functional requirements
- **Comprehensive**: Complex, high-risk - detailed requirements with traceability

**Execution**:
1. **MANDATORY**: You MUST log any user input during this phase in audit.md
2. Load all steps from `inception/requirements-analysis.md`
3. **MANDATORY**: You MUST record all steps identified in the loaded rule file in `aidlc-docs/step-decision-log.md` before executing any of them.
4. Execute requirements analysis:
   - Load reverse engineering artifacts (if brownfield)
   - Analyze user request (intent analysis)
   - Determine requirements depth needed
   - Assess current requirements
   - Ask clarifying questions (if needed)
   - Generate requirements document
5. Execute at appropriate depth (minimal/standard/comprehensive)
6. **MANDATORY**: You MUST verify the step-decision-log entry for this stage is complete and step counts match before presenting completion. For any missing step: re-execute it and all steps that depend on its output. Update the log. You MUST NOT present completion until all steps are logged.
7. **Wait for Explicit Approval**: Follow approval format from requirements-analysis.md detailed steps - DO NOT PROCEED until user confirms
8. **MANDATORY**: You MUST log user's response in audit.md with complete raw input

## User Stories (CONDITIONAL)

**INTELLIGENT ASSESSMENT**: Use multi-factor analysis to determine if user stories add value:

**ALWAYS Execute IF** (High Priority Indicators):
- New user-facing features or functionality
- Changes affecting user workflows or interactions
- Multiple user types or personas involved
- Complex business requirements with acceptance criteria needs
- Cross-functional team collaboration required
- Customer-facing API or service changes
- New product capabilities or enhancements

**LIKELY Execute IF** (Medium Priority - Assess Complexity):
- Modifications to existing user-facing features
- Backend changes that indirectly affect user experience
- Integration work that impacts user workflows
- Performance improvements with user-visible benefits
- Security enhancements affecting user interactions
- Data model changes affecting user data or reports

**COMPLEXITY-BASED ASSESSMENT**: For medium priority cases, execute user stories if:
- Request involves multiple components or services
- Changes span multiple user touchpoints
- Business logic is complex or has multiple scenarios
- Requirements have ambiguity that stories could clarify
- Implementation affects multiple user journeys
- Change has significant business impact or risk

**SKIP ONLY IF** (Low Priority - Simple Cases):
- Pure internal refactoring with zero user impact
- Simple bug fixes with clear, isolated scope
- Infrastructure changes with no user-facing effects
- Technical debt cleanup with no functional changes
- Developer tooling or build process improvements
- Documentation-only updates

**ASSESSMENT CRITERIA**: When in doubt, favor inclusion of user stories for:
- Requests with business stakeholder involvement
- Changes requiring user acceptance testing
- Features with multiple implementation approaches
- Work that benefits from shared team understanding
- Projects where requirements clarity is valuable

**ASSESSMENT PROCESS**: 
1. Analyze request complexity and scope
2. Identify user impact (direct or indirect)
3. Evaluate business context and stakeholder needs
4. Consider team collaboration benefits
5. Default to inclusion for borderline cases

**Note**: If Requirements Analysis executed, Stories can reference and build upon those requirements.

**User Stories has two parts within one stage**:
1. **Part 1 - Planning**: Create story plan with questions, collect answers, analyze for ambiguities, get approval
2. **Part 2 - Generation**: Execute approved plan to generate stories and personas

**Execution**:
1. **MANDATORY**: You MUST log any user input during this phase in audit.md
2. Load all steps from `inception/user-stories.md`
3. **MANDATORY**: You MUST record all steps identified in the loaded rule file in `aidlc-docs/step-decision-log.md` before executing any of them.
4. **MANDATORY**: Perform intelligent assessment (Step 1 in user-stories.md) to validate user stories are needed
5. Load reverse engineering artifacts (if brownfield)
6. If Requirements exist, reference them when creating stories
7. Execute at appropriate depth (minimal/standard/comprehensive)
8. **PART 1 - Planning**: Create story plan with questions, wait for user answers, analyze for ambiguities, get approval
9. **PART 2 - Generation**: Execute approved plan to generate stories and personas
10. **MANDATORY**: You MUST verify the step-decision-log entry for this stage is complete and step counts match before presenting completion. For any missing step: re-execute it and all steps that depend on its output. Update the log. You MUST NOT present completion until all steps are logged.
11. **Wait for Explicit Approval**: Follow approval format from user-stories.md detailed steps - DO NOT PROCEED until user confirms
12. **MANDATORY**: You MUST log user's response in audit.md with complete raw input

## Workflow Planning (ALWAYS EXECUTE)

1. **MANDATORY**: You MUST log any user input during this phase in audit.md
2. Load all steps from `inception/workflow-planning.md`
3. **MANDATORY**: You MUST record all steps identified in the loaded rule file in `aidlc-docs/step-decision-log.md` before executing any of them.
4. **MANDATORY**: Load content validation rules from `common/content-validation.md`
5. Load all prior context:
   - Reverse engineering artifacts (if brownfield)
   - Intent analysis
   - Requirements (if executed)
   - User stories (if executed)
6. Execute workflow planning:
   - Determine which phases to execute (Inception, Construction, AND Operations — see workflow-planning.md Step 3.5 for Operations determination)
   - Determine depth level for each phase
   - Create multi-package change sequence (if brownfield)
   - Generate workflow visualization (VALIDATE Mermaid syntax before writing)
7. **MANDATORY**: Validate all content before file creation per content-validation.md rules
8. **MANDATORY**: You MUST verify the step-decision-log entry for this stage is complete and step counts match before presenting completion. For any missing step: re-execute it and all steps that depend on its output. Update the log. You MUST NOT present completion until all steps are logged.
9. **Wait for Explicit Approval**: Present recommendations using language from workflow-planning.md Step 9, emphasizing user control to override recommendations - DO NOT PROCEED until user confirms
10. **MANDATORY**: You MUST log user's response in audit.md with complete raw input

## Application Design (CONDITIONAL)

**Execute IF**:
- New components or services needed
- Component methods and business rules need definition
- Service layer design required
- Component dependencies need clarification

**Skip IF**:
- Changes within existing component boundaries
- No new components or methods
- Pure implementation changes

**Execution**:
1. **MANDATORY**: You MUST log any user input during this phase in audit.md
2. Load all steps from `inception/application-design.md`
3. **MANDATORY**: You MUST record all steps identified in the loaded rule file in `aidlc-docs/step-decision-log.md` before executing any of them.
4. Load reverse engineering artifacts (if brownfield)
5. Execute at appropriate depth (minimal/standard/comprehensive)
6. **MANDATORY**: You MUST verify the step-decision-log entry for this stage is complete and step counts match before presenting completion. For any missing step: re-execute it and all steps that depend on its output. Update the log. You MUST NOT present completion until all steps are logged.
7. **Wait for Explicit Approval**: Present detailed completion message (see application-design.md for message format) - DO NOT PROCEED until user confirms
8. **MANDATORY**: You MUST log user's response in audit.md with complete raw input

## Units Generation (CONDITIONAL)

**Execute IF**:
- System needs decomposition into multiple units of work
- Multiple services or modules required
- Complex system requiring structured breakdown

**Skip IF**:
- Single simple unit
- No decomposition needed
- Straightforward single-component implementation

**Execution**:
1. **MANDATORY**: You MUST log any user input during this phase in audit.md
2. Load all steps from `inception/units-generation.md`
3. **MANDATORY**: You MUST record all steps identified in the loaded rule file in `aidlc-docs/step-decision-log.md` before executing any of them.
4. Load reverse engineering artifacts (if brownfield)
5. Execute at appropriate depth (minimal/standard/comprehensive)
6. **MANDATORY**: You MUST verify the step-decision-log entry for this stage is complete and step counts match before presenting completion. For any missing step: re-execute it and all steps that depend on its output. Update the log. You MUST NOT present completion until all steps are logged.
7. **Wait for Explicit Approval**: Present detailed completion message (see units-generation.md for message format) - DO NOT PROCEED until user confirms
8. **MANDATORY**: You MUST log user's response in audit.md with complete raw input

---

# 🟢 CONSTRUCTION PHASE

**Purpose**: Detailed design, NFR implementation, and code generation

**Focus**: Determine HOW to build it

**Stages in CONSTRUCTION PHASE**:
- Per-Unit Loop (executes for each unit):
  - Functional Design (CONDITIONAL, per-unit)
  - NFR Requirements (CONDITIONAL, per-unit)
  - NFR Design (CONDITIONAL, per-unit)
  - Infrastructure Design (CONDITIONAL, per-unit)
  - Code Generation (ALWAYS, per-unit)
- Build and Test (ALWAYS - after all units complete)

**Note**: Each unit is completed fully (design + code) before moving to the next unit.

---

## Per-Unit Loop (Executes for Each Unit)

**For each unit of work, execute the following stages in sequence:**

### Functional Design (CONDITIONAL, per-unit)

**Execute IF**:
- New data models or schemas
- Complex business logic
- Business rules need detailed design

**Skip IF**:
- Simple logic changes
- No new business logic

**Execution**:
1. **MANDATORY**: You MUST log any user input during this stage in audit.md
2. Load all steps from `construction/functional-design.md`
3. **MANDATORY**: You MUST record all steps identified in the loaded rule file in `aidlc-docs/step-decision-log.md` before executing any of them.
4. Execute functional design for this unit
5. **MANDATORY**: You MUST verify the step-decision-log entry for this stage is complete and step counts match before presenting completion. For any missing step: re-execute it and all steps that depend on its output. Update the log. You MUST NOT present completion until all steps are logged.
6. **MANDATORY**: You MUST present standardized 2-option completion message as defined in functional-design.md - DO NOT use emergent 3-option behavior
7. **Wait for Explicit Approval**: User must choose between "Request Changes" or "Continue to Next Stage" - DO NOT PROCEED until user confirms
8. **MANDATORY**: You MUST log user's response in audit.md with complete raw input

### NFR Requirements (CONDITIONAL, per-unit)

**Execute IF**:
- Performance requirements exist
- Security considerations needed
- Scalability concerns present
- Tech stack selection required

**Skip IF**:
- No NFR requirements
- Tech stack already determined

**Execution**:
1. **MANDATORY**: You MUST log any user input during this stage in audit.md
2. Load all steps from `construction/nfr-requirements.md`
3. **MANDATORY**: You MUST record all steps identified in the loaded rule file in `aidlc-docs/step-decision-log.md` before executing any of them.
4. Execute NFR assessment for this unit
5. **MANDATORY**: You MUST verify the step-decision-log entry for this stage is complete and step counts match before presenting completion. For any missing step: re-execute it and all steps that depend on its output. Update the log. You MUST NOT present completion until all steps are logged.
6. **MANDATORY**: You MUST present standardized 2-option completion message as defined in nfr-requirements.md - DO NOT use emergent behavior
7. **Wait for Explicit Approval**: User must choose between "Request Changes" or "Continue to Next Stage" - DO NOT PROCEED until user confirms
8. **MANDATORY**: You MUST log user's response in audit.md with complete raw input

### NFR Design (CONDITIONAL, per-unit)

**Execute IF**:
- NFR Requirements was executed
- NFR patterns need to be incorporated

**Skip IF**:
- No NFR requirements
- NFR Requirements was skipped

**Execution**:
1. **MANDATORY**: You MUST log any user input during this stage in audit.md
2. Load all steps from `construction/nfr-design.md`
3. **MANDATORY**: You MUST record all steps identified in the loaded rule file in `aidlc-docs/step-decision-log.md` before executing any of them.
4. Execute NFR design for this unit
5. **MANDATORY**: You MUST verify the step-decision-log entry for this stage is complete and step counts match before presenting completion. For any missing step: re-execute it and all steps that depend on its output. Update the log. You MUST NOT present completion until all steps are logged.
6. **MANDATORY**: You MUST present standardized 2-option completion message as defined in nfr-design.md - DO NOT use emergent behavior
7. **Wait for Explicit Approval**: User must choose between "Request Changes" or "Continue to Next Stage" - DO NOT PROCEED until user confirms
8. **MANDATORY**: You MUST log user's response in audit.md with complete raw input

### Infrastructure Design (CONDITIONAL, per-unit)

**Execute IF**:
- Infrastructure services need mapping
- Deployment architecture required
- Cloud resources need specification

**Skip IF**:
- No infrastructure changes
- Infrastructure already defined

**Execution**:
1. **MANDATORY**: You MUST log any user input during this stage in audit.md
2. Load all steps from `construction/infrastructure-design.md`
3. **MANDATORY**: You MUST record all steps identified in the loaded rule file in `aidlc-docs/step-decision-log.md` before executing any of them.
4. Execute infrastructure design for this unit
5. **MANDATORY**: You MUST verify the step-decision-log entry for this stage is complete and step counts match before presenting completion. For any missing step: re-execute it and all steps that depend on its output. Update the log. You MUST NOT present completion until all steps are logged.
6. **MANDATORY**: You MUST present standardized 2-option completion message as defined in infrastructure-design.md - DO NOT use emergent behavior
7. **Wait for Explicit Approval**: User must choose between "Request Changes" or "Continue to Next Stage" - DO NOT PROCEED until user confirms
8. **MANDATORY**: You MUST log user's response in audit.md with complete raw input
9. **If any extensions are active**: Produce extension plan rule mapping for this unit's resources and present rule mapping completion message as defined in infrastructure-design.md - DO NOT use emergent behavior
10. **Wait for Explicit Approval**: User must approve the rule mapping before proceeding - DO NOT PROCEED until user confirms
11. **MANDATORY**: You MUST log user's response in audit.md with complete raw input

### Code Generation (ALWAYS EXECUTE, per-unit)

**Always executes for each unit**

**Code Generation has two parts within one stage**:
1. **Part 1 - Planning**: Create detailed code generation plan with explicit steps
2. **Part 2 - Generation**: Execute approved plan to generate code, tests, and artifacts

**Execution**:
1. **MANDATORY**: You MUST log any user input during this stage in audit.md
2. Load all steps from `construction/code-generation.md`
3. **MANDATORY**: You MUST record all steps identified in the loaded rule file in `aidlc-docs/step-decision-log.md` before executing any of them.
4. **PART 1 - Planning**: Create code generation plan with checkboxes, get user approval
5. **PART 2 - Generation**: Execute approved plan to generate code for this unit
6. **MANDATORY**: You MUST verify the step-decision-log entry for this stage is complete and step counts match before presenting completion. For any missing step: re-execute it and all steps that depend on its output. Update the log. You MUST NOT present completion until all steps are logged.
7. **MANDATORY**: You MUST present standardized 2-option completion message as defined in code-generation.md - DO NOT use emergent behavior
8. **Wait for Explicit Approval**: User must choose between "Request Changes" or "Continue to Next Stage" - DO NOT PROCEED until user confirms
9. **MANDATORY**: You MUST log user's response in audit.md with complete raw input

---

## Build and Test (ALWAYS EXECUTE)

1. **MANDATORY**: You MUST log any user input during this phase in audit.md
2. Load all steps from `construction/build-and-test.md`
3. **MANDATORY**: You MUST record all steps identified in the loaded rule file in `aidlc-docs/step-decision-log.md` before executing any of them.
4. Generate comprehensive build and test instructions:
   - Build instructions for all units
   - Unit test execution instructions
   - Integration test instructions (test interactions between units)
   - Performance test instructions (if applicable)
   - Additional test instructions as needed (contract tests, security tests, e2e tests)
5. Create instruction files in build-and-test/ subdirectory: build-instructions.md, unit-test-instructions.md, integration-test-instructions.md, performance-test-instructions.md, build-and-test-summary.md
6. **MANDATORY**: You MUST verify the step-decision-log entry for this stage is complete and step counts match before presenting completion. For any missing step: re-execute it and all steps that depend on its output. Update the log. You MUST NOT present completion until all steps are logged.
7. **Wait for Explicit Approval**: Ask: "**Build and test instructions complete. Ready to proceed to Operations stage?**" - DO NOT PROCEED until user confirms
8. **MANDATORY**: You MUST log user's response in audit.md with complete raw input

---

# 🟡 OPERATIONS PHASE

**Purpose**: Validate that Construction correctly implemented all applicable operational rules, deploy the workload to a real environment, and execute post-deployment testing to prove operational readiness.

**Focus**: Verify WHAT was built meets the rules, deploy it, and prove it works

**Stages in OPERATIONS PHASE**:
- Rules Validation (CONDITIONAL)
- Deployment (CONDITIONAL)
- Post-Deployment Testing (CONDITIONAL)

---

## Rules Validation (CONDITIONAL)

**Execute IF**:
- At least one extension is active (answer other than D/No)

**Skip IF**:
- No operational extensions were opted into (all answered D/No)

**Prerequisites** (evaluated at execution time, not at planning time):
- Build and Test stage must be complete before this stage executes

**Execution**:
1. **MANDATORY**: You MUST log any user input during this phase in audit.md
2. Load all steps from `operations/rules-validation.md`
3. **MANDATORY**: You MUST record all steps identified in the loaded rule file in `aidlc-docs/step-decision-log.md` before executing any of them.
4. Execute rules validation:
   - Read Extension Configuration from `aidlc-docs/aidlc-state.md`
   - For each opted-in extension with an `extensions/{domain}/` directory, load rules and validate Construction output
   - Process domains in dependency order (observability → recovery → runbooks → deployment)
   - Generate per-domain validation reports and documentation
   - Generate operations summary
5. **MANDATORY**: You MUST verify the step-decision-log entry for this stage is complete and step counts match before presenting completion. For any missing step: re-execute it and all steps that depend on its output. Update the log. You MUST NOT present completion until all steps are logged.
6. **Wait for Explicit Approval**: Present standardized 2-option completion message - DO NOT PROCEED until user confirms
7. **MANDATORY**: You MUST log user's response in audit.md with complete raw input

---

## Deployment (CONDITIONAL)

**Always Execute**: The execution plan always marks this stage EXECUTE. The opt-in check is performed internally by `operations/deployment.md` at runtime — if the deployment extension is not active, the stage asks the customer whether to proceed and may mark itself SKIPPED.

**Prerequisites** (evaluated at execution time, not at planning time):
- Rules Validation stage must be complete before this stage executes

**Execution**:
1. **MANDATORY**: You MUST log any user input during this phase in audit.md
2. Load all steps from `operations/deployment.md`
3. **MANDATORY**: You MUST record all steps identified in the loaded rule file in `aidlc-docs/step-decision-log.md` before executing any of them.
4. Execute deployment:
   - Check upstream artifact prerequisites (infra design, extension plan rule mapping, build summary)
   - Verify environment prerequisites (IaC tool, CLI, credentials, bootstrapping)
   - Verify deployment automation covers all components (infrastructure, application artifacts, assets/data)
   - Deploy infrastructure (IaC stacks)
   - Deploy application artifacts (Lambda code, container images, frontend bundles)
   - Deploy assets/data if applicable (migrations, seed data, config)
   - Verify every deployed component is present and observable in the environment
   - Record deployment outputs
5. **MANDATORY**: You MUST verify the step-decision-log entry for this stage is complete and step counts match before presenting completion. For any missing step: re-execute it and all steps that depend on its output. Update the log. You MUST NOT present completion until all steps are logged.
6. **Wait for Explicit Approval**: Present standardized 2-option completion message - DO NOT PROCEED until user confirms
7. **MANDATORY**: You MUST log user's response in audit.md with complete raw input

---

## Post-Deployment Testing (CONDITIONAL)

**Always Execute**: The execution plan always marks this stage EXECUTE. The opt-in check is performed internally by `operations/post-deployment-testing.md` at runtime — if deployment was skipped or blocked, the stage marks itself SKIPPED.

**Prerequisites** (evaluated at execution time, not at planning time):
- Deployment stage must have completed or been explicitly skipped

**Execution**:
1. **MANDATORY**: You MUST log any user input during this phase in audit.md
2. Load all steps from `operations/post-deployment-testing.md`
3. **MANDATORY**: You MUST record all steps identified in the loaded rule file in `aidlc-docs/step-decision-log.md` before executing any of them.
4. Execute post-deployment testing:
   - Discover test assets from Build and Test and active extensions
   - Build test plan using the testing framework phases (per-rule, per-resource)
   - Execute automatable tests against the deployed environment
   - Document customer-staged tests for later execution
   - Generate test report with evidence
5. **MANDATORY**: You MUST verify the step-decision-log entry for this stage is complete and step counts match before presenting completion. For any missing step: re-execute it and all steps that depend on its output. Update the log. You MUST NOT present completion until all steps are logged.
6. **Wait for Explicit Approval**: Present standardized 2-option completion message - DO NOT PROCEED until user confirms
7. **MANDATORY**: You MUST log user's response in audit.md with complete raw input

## Key Principles

- **Adaptive Execution**: For stages not listed in any extension's Stage Enforcement section the model only executes stages that add value.
- **Transparent Planning**: Always show execution plan before starting
- **User Control**: User can request stage inclusion/exclusion
- **Progress Tracking**: Update aidlc-state.md with executed and skipped stages
- **Complete Audit Trail**: Log ALL user inputs and AI responses in audit.md with timestamps
  - **CRITICAL**: Capture user's COMPLETE RAW INPUT exactly as provided
  - **CRITICAL**: Never summarize or paraphrase user input in audit log
  - **CRITICAL**: Log every interaction, not just approvals
- **Quality Focus**: Complex changes get full treatment, simple changes stay efficient
- **Content Validation**: Always validate content before file creation per content-validation.md rules
- **NO EMERGENT BEHAVIOR**: Construction phases MUST use standardized 2-option completion messages as defined in their respective rule files. DO NOT create 3-option menus or other emergent navigation patterns.

## MANDATORY: Plan-Level Checkbox Enforcement

### MANDATORY RULES FOR PLAN EXECUTION
1. **NEVER complete any work without updating plan checkboxes**
2. **IMMEDIATELY after completing ANY step described in a plan file, mark that step [x]**
3. **This must happen in the SAME interaction where the work is completed**
4. **NO EXCEPTIONS**: Every plan step completion MUST be tracked with checkbox updates

### Two-Level Checkbox Tracking System
- **Plan-Level**: Track detailed execution progress within each stage
- **Stage-Level**: Track overall workflow progress in aidlc-state.md
- **Update immediately**: All progress updates in SAME interaction where work is completed

## Prompts Logging Requirements
- **MANDATORY**: You MUST log EVERY user input (prompts, questions, responses) with timestamp in audit.md
- **MANDATORY**: Capture user's COMPLETE RAW INPUT exactly as provided (never summarize)
- **MANDATORY**: You MUST log every approval prompt with timestamp before asking the user
- **MANDATORY**: Record every user response with timestamp after receiving it
- **CRITICAL**: ALWAYS append changes to EDIT audit.md file, NEVER use tools and commands that completely overwrite its contents
- **CRITICAL**: NEVER use file writing tools and commands that overwrite the entire contents of audit.md, as this causes duplication
- Use ISO 8601 format for timestamps (YYYY-MM-DDTHH:MM:SSZ)
- Include stage context for each entry

### Audit Log Format:
```markdown
## [Stage Name or Interaction Type]
**Timestamp**: [ISO timestamp]
**User Input**: "[Complete raw user input - never summarized]"
**AI Response**: "[AI's response or action taken]"
**Context**: [Stage, action, or decision made]

---
```

### Correct Tool Usage for audit.md

✅ CORRECT:

1. Read the audit.md file
2. Append/Edit the file to make changes

❌ WRONG:

1. Read the audit.md file
2. Completely overwrite the audit.md with the contents of what you read, plus the new changes you want to add to it

## Directory Structure

```text
<WORKSPACE-ROOT>/                   # ⚠️ APPLICATION CODE HERE
├── [project-specific structure]    # Varies by project (see code-generation.md)
│
├── aidlc-docs/                     # 📄 DOCUMENTATION ONLY
│   ├── inception/                  # 🔵 INCEPTION PHASE
│   │   ├── plans/
│   │   ├── reverse-engineering/    # Brownfield only
│   │   ├── requirements/
│   │   ├── user-stories/
│   │   └── application-design/
│   ├── construction/               # 🟢 CONSTRUCTION PHASE
│   │   ├── plans/
│   │   ├── {unit-name}/
│   │   │   ├── functional-design/
│   │   │   ├── nfr-requirements/
│   │   │   ├── nfr-design/
│   │   │   ├── infrastructure-design/
│   │   │   └── code/               # Markdown summaries only
│   │   └── build-and-test/
│   ├── operations/                 # 🟡 OPERATIONS PHASE
│   ├── aidlc-state.md
│   └── audit.md
```

**CRITICAL RULE**:
- Application code: Workspace root (NEVER in aidlc-docs/)
- Documentation: aidlc-docs/ only
- Project structure: See code-generation.md for patterns by project type
