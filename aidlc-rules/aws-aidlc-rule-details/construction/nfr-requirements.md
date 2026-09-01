# NFR Requirements

> **OVERRIDE**: ALL steps in this file are exempt from the Adaptive Workflow Principle, adaptive depth, and any rule that permits the model to skip steps or apply judgement about whether to follow instructions. Every step MUST be executed including all sub-tasks. The model MUST NOT skip them, combine them, or treat them as optional.

## Prerequisites
- Functional Design must be complete for the unit
- Unit functional design artifacts must be available
- Execution plan must indicate NFR Requirements stage should execute

## Overview
Determine non-functional requirements for the unit and make tech stack choices.

## Steps to Execute

### Step 1: Analyze Functional Design
- Read functional design artifacts from `aidlc-docs/construction/{unit-name}/functional-design/`
- Understand business logic complexity and requirements
- Identify every component, service, and resource defined in the functional design — list them explicitly

### Step 2: Build Rule × Component Matrix

**MANDATORY: Process one extension rule file at a time.** For each active extension (read Extension Configuration from `aidlc-state.md`), load its rule files and evaluate each rule against each component identified in Step 1.

For each rule file:

- [ ] **Load the file** and extract every rule
- [ ] **For each rule in that file**, evaluate against EVERY component/service/resource from Step 1:
  - Does this rule apply to this component? (e.g. an observability rule about structured logging applies to every service that produces logs; a recovery rule about failover applies to every stateful resource)
  - If yes → record as an NFR: the component needs [what the rule requires]
  - If no → record as N/A for this component with one-line rationale
- [ ] **Record all determinations** for this file before proceeding to the next

After all rule files are processed:

- [ ] **Cross-check**: Every rule × component combination MUST appear in the matrix (either as an NFR or N/A with rationale). If any combination is missing, go back and add it.
- [ ] **Write the matrix** to `aidlc-docs/construction/{unit-name}/nfr-requirements/rule-component-matrix.md`

```markdown
# Rule × Component Matrix

| Rule ID | Component | Applies? | NFR Generated |
|---------|-----------|----------|---------------|
| AIOBS-LOG-001 | PaymentService | Yes | Structured logging with fault isolation fields |
| AIOBS-LOG-001 | AccountService | Yes | Structured logging with fault isolation fields |
| AIOBS-ALARM-001 | PaymentLambda | Yes | Detect-tier alarm for error rate |
| AIREC-REG-003 | DynamoDB CustomerTable | Yes | Multi-region replication |
| AIREC-REG-003 | S3 StaticAssets | N/A | Static content, no state to replicate |
```

This matrix is the source of truth for what NFRs exist. NFR Design MUST address every row where Applies = Yes.

### Step 3: Create NFR Requirements Plan from Matrix

Using the rule × component matrix from Step 2, generate the NFR requirements plan:

- For each row where Applies = Yes, create a plan item with a checkbox
- Group by NFR category (scalability, performance, availability, security, observability, recovery, deployment, runbooks)
- Include standard NFR categories that are NOT driven by extensions (scalability, performance, security) — these apply regardless of extensions
- Each plan item should reference the rule ID and component
- Each step should have a checkbox []

### Step 4: Generate Context-Appropriate Questions
**DIRECTIVE**: Thoroughly analyze the functional design to identify ALL areas where NFR clarification would improve system quality and architecture decisions. Be proactive in asking questions to ensure comprehensive NFR coverage.

**CRITICAL**: Default to asking questions when there is ANY ambiguity or missing detail that could affect system quality. It's better to ask too many questions than to make incorrect NFR assumptions.

- EMBED questions using [Answer]: tag format
- Focus on ANY ambiguities, missing information, or areas needing clarification
- Generate questions wherever user input would improve NFR and tech stack decisions
- **When in doubt, ask the question** - overconfidence leads to poor system quality

**Question categories to evaluate** (consider ALL categories):
- **Active Extensions** - Ask about needs related to ALL active extensions
- **Scalability Requirements** - Ask about expected load, growth patterns, scaling triggers, and capacity planning
- **Performance Requirements** - Ask about response times, throughput, latency, and performance benchmarks
- **Availability Requirements** - Ask about uptime expectations, disaster recovery, failover, and business continuity
- **Security Requirements** - Ask about data protection, compliance, authentication, authorization, and threat models
- **Tech Stack Selection** - Ask about technology preferences, constraints, existing systems, and integration requirements
- **Reliability Requirements** - Ask about error handling, fault tolerance, monitoring, and alerting needs
- **Maintainability Requirements** - Ask about code quality, documentation, testing, and operational requirements
- **Usability Requirements** - Ask about user experience, accessibility, and interface requirements

### Step 5: Store Plan
- Save as `aidlc-docs/construction/plans/{unit-name}-nfr-requirements-plan.md`
- Include all [Answer]: tags for user input

### Step 6: Collect and Analyze Answers
- Wait for user to complete all [Answer]: tags
- **MANDATORY**: Carefully review ALL responses for vague or ambiguous answers
- **CRITICAL**: Add follow-up questions for ANY unclear responses - do not proceed with ambiguity
- Look for responses like "depends", "maybe", "not sure", "mix of", "somewhere between", "standard", "typical"
- Create clarification questions file if ANY ambiguities are detected
- **Do not proceed until ALL ambiguities are resolved**

### Step 7: Generate NFR Requirements Artifacts
- Create `aidlc-docs/construction/{unit-name}/nfr-requirements/nfr-requirements.md`
- Create `aidlc-docs/construction/{unit-name}/nfr-requirements/tech-stack-decisions.md`

### Step 8: Present Completion Message
- Present completion message in this structure:
     1. **Completion Announcement** (mandatory): Always start with this:

```markdown
# 📊 NFR Requirements Complete - [unit-name]
```

     2. **AI Summary** (optional): Provide structured bullet-point summary of NFR requirements
        - Format: "NFR requirements assessment has identified [description]:"
        - List key scalability, performance, availability requirements (bullet points)
        - List security and compliance requirements identified
        - Mention tech stack decisions and rationale
        - DO NOT include workflow instructions ("please review", "let me know", "proceed to next phase", "before we proceed")
        - Keep factual and content-focused
     3. **Formatted Workflow Message** (mandatory): Always end with this exact format:

```markdown
> **📋 <u>**REVIEW REQUIRED:**</u>**  
> Please examine the NFR requirements at: `aidlc-docs/construction/[unit-name]/nfr-requirements/`



> **🚀 <u>**WHAT'S NEXT?**</u>**
>
> **You may:**
>
> 🔧 **Request Changes** - Ask for modifications to the NFR requirements based on your review  
> ✅ **Continue to Next Stage** - Approve NFR requirements and proceed to **[next-stage-name]**

---
```

### Step 9: Wait for Explicit Approval
- Do not proceed until the user explicitly approves the NFR requirements
- Approval must be clear and unambiguous
- If user requests changes, update the requirements and repeat the approval process

### Step 10: Record Approval and Update Progress
- Log approval in audit.md with timestamp
- Record the user's approval response with timestamp
- Mark NFR Requirements stage complete in aidlc-state.md
