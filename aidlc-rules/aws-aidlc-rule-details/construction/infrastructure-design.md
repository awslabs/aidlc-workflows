# Infrastructure Design

> **OVERRIDE**: Steps 10–18 in this file are exempt from the Adaptive Workflow Principle, adaptive depth, and any rule that permits the model to skip steps or apply judgement about whether to follow instructions. When extensions are active, Steps 10–18 MUST be executed. The model MUST NOT skip them, combine them, or treat them as optional. These steps produce the extension plan rule mapping which is a required input to Code Generation.

## Prerequisites
- Functional Design must be complete for the unit
- NFR Design recommended (provides logical components to map)
- Execution plan must indicate Infrastructure Design stage should execute

## Overview
Map logical software components to actual infrastructure choices for deployment environments.

## Steps to Execute

### Step 1: Analyze Design Artifacts
- Read functional design from `aidlc-docs/construction/{unit-name}/functional-design/`
- Read NFR design from `aidlc-docs/construction/{unit-name}/nfr-design/` (if exists)
- Identify logical components needing infrastructure

### Step 2: Create Infrastructure Design Plan
- Generate plan with checkboxes [] for infrastructure design
- Focus on mapping to actual services (AWS, Azure, GCP, on-premise)
- Each step should have a checkbox []

### Step 3: Generate Context-Appropriate Questions
**DIRECTIVE**: Thoroughly analyze the functional and NFR design to identify ALL areas where clarification would improve infrastructure decisions. Be proactive in asking questions to ensure comprehensive infrastructure coverage.

**CRITICAL**: Default to asking questions when there is ANY ambiguity or missing detail that could affect infrastructure quality. It's better to ask too many questions than to make incorrect infrastructure assumptions.

**MANDATORY**: Evaluate ALL of the following categories by asking targeted questions about each. For each category, determine applicability based on evidence from the functional and NFR design artifacts -- do not skip categories without explicit justification:

- EMBED questions using [Answer]: tag format
- Focus on ANY ambiguities, missing information, or areas needing clarification
- Generate questions wherever user input would improve infrastructure decisions
- **When in doubt, ask the question** - overconfidence leads to poor infrastructure choices

**Question categories to evaluate** (consider ALL categories):
- **Deployment Environment** - Ask about cloud provider preferences, environment setup, and deployment targets
- **Compute Infrastructure** - Ask about compute service choices, sizing, and scaling requirements
- **Storage Infrastructure** - Ask about database selection, storage patterns, and data lifecycle needs
- **Messaging Infrastructure** - Ask about messaging/queuing services, event-driven patterns, and async processing
- **Networking Infrastructure** - Ask about load balancing, API gateway approach, and network topology
- **Monitoring Infrastructure** - Ask about observability tooling, alerting strategy, and logging requirements
- **Shared Infrastructure** - Ask about infrastructure sharing strategy, multi-tenancy, and resource isolation

### Step 4: Store Plan
- Save as `aidlc-docs/construction/plans/{unit-name}-infrastructure-design-plan.md`
- Include all [Answer]: tags for user input

### Step 5: Collect and Analyze Answers
- Wait for user to complete all [Answer]: tags
- Review for vague or ambiguous responses
- Add follow-up questions if needed

### Step 6: Generate Infrastructure Design Artifacts
- Create `aidlc-docs/construction/{unit-name}/infrastructure-design/infrastructure-design.md`
- Create `aidlc-docs/construction/{unit-name}/infrastructure-design/deployment-architecture.md`
- If shared infrastructure: Create `aidlc-docs/construction/shared-infrastructure.md`

### Step 7: Present Infrastructure Design Completion Message
- Present completion message in this structure:
     1. **Completion Announcement** (mandatory): Always start with this:

```markdown
# 🏢 Infrastructure Design Complete - [unit-name]
```

     2. **AI Summary** (optional): Provide structured bullet-point summary of infrastructure design
        - Format: "Infrastructure design has mapped [description]:"
        - List key infrastructure services and components (bullet points)
        - List deployment architecture decisions and rationale
        - Mention cloud provider choices and service mappings
        - DO NOT include workflow instructions ("please review", "let me know", "proceed to next phase", "before we proceed")
        - Keep factual and content-focused
     3. **Formatted Workflow Message** (mandatory): Always end with this exact format:

```markdown
> **📋 <u>**REVIEW REQUIRED:**</u>**  
> Please examine the infrastructure design at: `aidlc-docs/construction/[unit-name]/infrastructure-design/`



> **🚀 <u>**WHAT'S NEXT?**</u>**
>
> **You may:**
>
> 🔧 **Request Changes** - Ask for modifications to the infrastructure design based on your review  
> ✅ **Continue to Next Stage** - Approve infrastructure design

---
```

### Step 8: Wait for Explicit Approval
- Do not proceed until the user explicitly approves the infrastructure design
- Approval must be clear and unambiguous
- If user requests changes, update the design and repeat the approval process

### Step 9: Record Approval
- Log approval in audit.md with timestamp
- Record the user's approval response with timestamp

### Step 10: Check Extension Status
- Read Extension Configuration from aidlc-state.md
- If no extensions are active, present the following to the user and skip to Step 17:

```markdown
# 📋 Extension Rule Mapping - [unit-name]

No extensions are active. No rule mapping will be generated for [unit-name].

> **🚀 <u>**WHAT'S NEXT?**</u>**
>
> **You may:**
>
> 🔧 **Request Changes** - If extensions should be active, request corrections to the extension configuration  
> ✅ **Continue to Next Stage** - Confirm no extensions and proceed to **Code Generation**

---
```

### Step 11: Present Customer Journey Classification Question
- If no extensions are active (skipped from Step 10), this step does not apply
- Identify all customer journeys from the requirements and user stories
- Append the following question to `aidlc-docs/construction/plans/{unit-name}-infrastructure-design-plan.md` using the [Answer]: tag format:

```markdown
### Customer Journey Classification

The following customer journeys have been identified from the requirements:

| # | Customer Journey |
|---|-----------------|
| 1 | [journey from requirements] |
| 2 | [journey from requirements] |
| ... | ... |

The journeys you confirm below will receive the following additional observability capabilities:

- **Synthetic canary monitoring** — automated scripts that continuously execute the journey from outside the service boundary, detecting outages before customers report them
- **Per-journey dashboards** — side-by-side views of client-side and server-side metrics for each journey, enabling operators to compare what customers experience with what the service reports
- **Customer Experience metrics** — business-level success rate and latency metrics per journey, used to detect customer impact and trigger alarms

All other observability capabilities (structured logging, infrastructure alarms, distributed tracing, per-resource metrics) apply to every resource regardless of this answer.

Which customer journeys require these additional capabilities?
A) All of the above
B) Select specific journeys: [list numbers]

[Answer]:
```

### Step 12: Collect and Record Customer Journey Classification
- Wait for user to complete [Answer]: tag
- Record answer in `aidlc-docs/construction/plans/{unit-name}-infrastructure-design-plan.md` ([Answer]: tag)
- Record answer in `aidlc-state.md` under a new `## Customer Journey Configuration` section:
```markdown
## Customer Journey Configuration
| # | Customer Journey | In Scope |
|---|-----------------|----------|
| 1 | [journey] | Yes/No |
```
- Log answer in `audit.md` with timestamp

### Step 13: Generate Extension Plan Rule Mapping
- Read `aidlc-docs/construction/{unit-name}/infrastructure-design/infrastructure-design.md` to build the resource inventory
- Build `aidlc-docs/construction/plans/{unit-name}-extension-plan-rule-mapping.md`:
  - List every named AWS resource defined in this unit's infrastructure design — every Lambda function, every DynamoDB table, every API Gateway, etc.
  - For each active extension, read rule files per the opt-in answer in aidlc-state.md
  - For each rule, map it to every resource it is technically possible to apply the rule to
  - For each rule × resource combination, determine the specific implementation (metric names, alarm methods, thresholds) from the rule definitions, requirements, and AWS service characteristics. Values that cannot be determined are presented as questions in Step 14.
  - Rules with no applicable resources are recorded as N/A with rationale
  - Structure the file with one section per rule file, each containing a table of Rule, Resource, and What to build

### Step 14: Generate Rule Mapping Questions
**DIRECTIVE**: Analyze the rule mapping to generate ONLY questions for operational configuration values that cannot be determined from existing design artifacts, requirements, or rule definitions. Use the categories below as inspiration, NOT as a mandatory checklist. Skip entire categories if not applicable.

- EMBED questions using [Answer]: tag format
- Focus on values the model cannot determine from the rules, infrastructure design, NFR design, requirements, or AWS documentation
- Generate questions only where user input is needed for operational configuration

**Example question categories** (adapt as needed):
- **Alarm Notification** - Only if subscription type and subscribers cannot be determined from requirements
- **Log Retention** - Only if log retention period (e.g. 30, 90, 365 days) cannot be determined from requirements
- **Alarm Strategy** - Only if alarm thresholds for business KPIs, or whether to use anomaly detection instead of static thresholds, cannot be determined from requirements

- If questions are needed, append them to `aidlc-docs/construction/plans/{unit-name}-infrastructure-design-plan.md` using the same [Answer]: tag format as the existing questions in the plan
- If no questions are needed, skip to Step 16

### Step 15: Collect and Analyze Answers
- Wait for user to complete all [Answer]: tags
- Review for vague or ambiguous responses
- Add follow-up questions if needed
- Update the rule mapping file with answers received

### Step 16: Present Rule Mapping Completion Message
- Present completion message in this structure:
     1. **Completion Announcement** (mandatory): Always start with this:

```markdown
# 📋 Extension Rule Mapping Complete - [unit-name]
```

     2. **AI Summary** (mandatory): Present the AWS resource inventory as a table:
        - Format: "Extension rules have been mapped to the following AWS resources:"
        - Present a table with columns: Service, Resources (listing every named resource per service)
        - State the total number of rule × resource items and number of active domains
        - Reference the full mapping file path
        - DO NOT include workflow instructions ("please review", "let me know", "proceed to next phase", "before we proceed")
        - Keep factual and content-focused
     3. **Formatted Workflow Message** (mandatory): Always end with this exact format:

```markdown
> **📋 <u>**REVIEW REQUIRED:**</u>**  
> Please verify the resource inventory is complete — every AWS resource in your infrastructure should appear above.
> Full rule mapping: `aidlc-docs/construction/plans/[unit-name]-extension-plan-rule-mapping.md`



> **🚀 <u>**WHAT'S NEXT?**</u>**
>
> **You may:**
>
> 🔧 **Request Changes** - Request additions or corrections to the resource inventory or rule mapping  
> ✅ **Continue to Next Stage** - Approve rule mapping and proceed to **Code Generation**

---
```

### Step 17: Wait for Explicit Approval
- Do not proceed until the user explicitly approves the rule mapping, or has been skipped to from Step 10 and confirms no extensions are active
- Approval must be clear and unambiguous
- If user requests changes, update the mapping and repeat the approval process

### Step 18: Record Approval and Update Progress
- Log approval in audit.md with timestamp
- Record the user's approval response with timestamp
- Mark Infrastructure Design stage complete in aidlc-state.md
