# Baseline Runbook Rules

## Overview
These rules ensure that every deployable service has documented, tested, and automated runbooks for operational procedures. Runbooks enable consistent and prompt responses to well-understood events by capturing the minimum information necessary to successfully perform a procedure.

**Custom Rules**: Organisation-specific runbook rules can be defined in `extensions/runbooks/runbooks-custom.md` using the `AIRUN-CUSTOM-` prefix. When present, custom rules are loaded and enforced alongside built-in rules.

**Implementation Rules**: The STRAT rules below define **what** runbooks to create and **why**. The **how** is defined in rule files in `extensions/runbooks/`. The model MUST scan that directory and load `.md` files when runbook rules are active during NFR Design, Code Generation, and Operations stages.

**Prerequisites**:
- Observability rules must be processed first — runbook identification depends on the alarm inventory (AIOBS-ALARM-004). The observability domain MUST be completed before the runbooks domain during both Construction and Operations.
- If the user opted out of observability (answer D), runbooks can still be created but will not have alarm-driven triggers or alarm-linked response actions.

**Loading based on user's runbook answer:**
- **Answer A (AWS best-practice)**: Load all `.md` files in `extensions/runbooks/` EXCEPT `runbooks-custom.md`
- **Answer B (AWS + custom)**: Load all `.md` files in `extensions/runbooks/` INCLUDING `runbooks-custom.md`
- **Answer C (custom only)**: Load ONLY `runbooks-custom.md` from `extensions/runbooks/`. Skip all other files. STRAT rules in this baseline file still apply as context.

**Enforcement**: At each applicable stage, the model MUST verify compliance with these rules before presenting the stage completion message.

### Blocking Runbook Finding Behavior
A **blocking runbook finding** means:
1. The finding MUST be listed in the stage completion message under a "Runbook Findings" section with the AIRUN rule ID
2. The stage MUST NOT present the "Continue to Next Stage" option until all blocking findings are resolved
3. The model MUST present only the "Request Changes" option with a clear explanation of what needs to change
4. The finding MUST be logged in `aidlc-docs/audit.md` with the AIRUN rule ID and stage context

### Default Enforcement
All rules in this document and in the loaded `extensions/runbooks/` files are **blocking** by default. If any rule's verification criteria are not met, it is a blocking runbook finding — follow the blocking finding behavior above. If a rule is not applicable to the current architecture, mark it as **N/A** with a documented rationale — this is not a blocking finding. Silent omission is not acceptable — if a rule cannot be satisfied, the model MUST investigate whether the chosen tools provide the capability, document the gap, and present it as a blocking finding. All gaps MUST be logged to audit.md with rule ID, rationale, and severity.

### Verification Criteria Format
Verification items in this document are plain bullet points describing compliance checks. Each item should be evaluated as compliant or non-compliant during review.

### Stage Enforcement

The following stages have mandatory enforcement of these rules. This is a minimum set — the model MUST enforce these rules at each stage listed below, and MAY also enforce them at other stages where relevant.

| Stage | Mandatory |
|-------|-----------|
| NFR Design | ✅ MUST enforce |
| Code Generation | ✅ MUST enforce |
| Operations | ✅ MUST enforce |

#### NFR Design

The model MUST produce design artifacts satisfying every loaded rule. The following are mandatory NFR Design outputs:

0. **Prerequisite check** (blocking): Before producing any runbook artifacts, verify that the observability domain's alarm inventory exists in the NFR design artifacts. If it does not exist, this is a blocking finding — the observability domain MUST complete NFR Design before the runbooks domain begins. Do NOT proceed with runbook NFR Design until this prerequisite is satisfied. If the user opted out of observability (answer D), skip this check and proceed without alarm-driven triggers.
1. **Runbook inventory from alarm inventory** (AIRUN-STRAT-001, AIOBS-ALARM-004): After the observability domain completes alarm design, enumerate every alarm with a documented response action. Each response action MUST map to a runbook. Produce a runbook inventory table in NFR design artifacts with columns: Runbook Name, Trigger (alarm or event), Fault Isolation Boundary, Automation Level (pending user answer). Include runbooks for non-alarm operational procedures (deployments, scaling, data recovery) identified from the architecture.
2. **Automation risk appetite question** (AIRUN-STRAT-003): After producing the runbook inventory, present the automation risk appetite question to the user using the format defined in AIRUN-STRAT-003. Only include fault isolation boundaries that exist in the architecture. Record the user's answer and update the runbook inventory table with the confirmed automation level per boundary.
3. **Runbook structure design** (AIRUN-CONTENT-001): Define the runbook template structure that all generated runbooks will follow — required sections per AIRUN-CONTENT-001 (prerequisites, constraints, procedure steps, verification, rollback, escalation). Include this template in NFR design artifacts.

**Verification**: NFR Design stage MUST NOT complete until all 3 outputs above are present in the NFR design artifacts. Missing outputs are blocking findings.

#### Operations

The model MUST validate every loaded rule against the generated artifacts (runbook documents, automation code, IaC). For each rule:
- Compliant → mark as passed
- Non-compliant → blocking finding: list the rule ID, what was expected, and what was found
- Not applicable → mark N/A with rationale

The Operations phase MUST NOT complete until all blocking findings are resolved or explicitly accepted by the customer with the decision logged to audit.

---

## RUNBOOK STRATEGY

These rules define **what** runbooks to create and **why**.

### Rule AIRUN-STRAT-001: Identify Runbooks from Operational Procedures and Failure Modes

**Rule**: The model MUST identify all operational procedures and failure modes that require runbooks by analysing the architecture, observability design (alarms, detection rules), and deployment model. Every alarm with a documented response action (AIOBS-ALARM-004) MUST have a corresponding runbook.

Runbooks MUST be prioritised by:
1. Frequently executed procedures — reduce operational effort
2. Procedures with high error rates — reduce probability of negative impact
3. Procedures with significant potential harmful impact — manage risk

**Verification**:
- A documented list of required runbooks exists, derived from the architecture and alarm inventory
- Every alarm response action references a runbook
- Runbooks are prioritised by frequency, error rate, and impact potential

---

### Rule AIRUN-STRAT-002: Runbooks Must Enable Unfamiliar Team Members

**Rule**: Runbooks MUST provide adequately skilled team members, who are unfamiliar with the specific procedure or workload, the instructions necessary to successfully complete the activity. Runbooks preserve institutional knowledge and reduce dependency on key personnel.

**Verification**:
- Runbooks contain sufficient detail for a team member unfamiliar with the procedure to execute it
- No runbook assumes prior knowledge of the specific workload implementation
- Runbooks are written during development, not after incidents

---

### Rule AIRUN-STRAT-003: Automate Runbooks

**Rule**: The model MUST evaluate each runbook for automation potential. Start with a valid manual process, then implement it as a runbook automation executable by the cloud provider's native automation service, and trigger automated execution where technically possible. Automation ensures consistency, speeds responses, and reduces errors caused by manual processes. All runbooks — regardless of automation level — are implemented as runbook automations executable by the cloud provider's native automation service. The user's decision is only about the trigger and approval model, not whether the runbook automation is created.

During NFR Design, after identifying the fault isolation boundaries from the architecture, the model MUST present the following question to capture the user's automation risk appetite per boundary. The user owns this decision — the model implements it fully.

**Automation Risk Appetite Format**: The model MUST present identified boundaries using this format (only include boundaries that exist in the architecture):

```markdown
## Question: Automation Risk Appetite

For each fault isolation boundary, what level of automation is appropriate for mitigation runbooks? All runbooks will be implemented as runbook automations executable by the cloud provider's native automation service regardless of your choice — this decision controls whether execution is fully automatic or requires a human approval step in the automation.

| Boundary | Blast Radius | Automation Level |
|----------|-------------|-----------------|
| Instance replacement | Single instance | A) Fully automatic  B) Human approval |
| AZ evacuation | Single AZ | A) Fully automatic  B) Human approval |
| Region failover | Entire region | A) Fully automatic  B) Human approval |

A) Fully automatic — runbook is triggered and executed without human intervention
B) Human approval — runbook automation is triggered automatically but includes a human approval step that pauses execution until approved

[Answer]:
```

The model MUST use the user's answers to determine the automation model for each runbook:
- **Fully automatic**: Alarm/event triggers automation, executes without approval gates
- **Human approval**: Alarm/event triggers automation, pauses at an approval step before executing

**Verification**:
- Each runbook has a documented automation assessment
- Automation level per fault isolation boundary is captured and approved by the user
- All runbooks are implemented as runbook automations executable by the cloud provider's native automation service regardless of automation level
- Fully automatic runbooks are triggered by monitoring events
- Human approval runbooks MUST include an approval gate in the runbook automation that pauses execution until a human approves via the console or CLI
- Manual runbooks that are not implemented as runbook automations document why automation is not feasible

---

### Rule AIRUN-STRAT-004: Every Runbook Must Document Manual Trigger

**Rule**: Regardless of automation level (fully automatic or human approval), every runbook MUST include documentation on how an operator can manually trigger the same automation. If the automatic trigger fails, or the operator needs to execute the runbook outside the normal event-driven flow, they must have a single command or console action to initiate it.

**Verification**:
- Every runbook documents how to manually trigger the automation in the event that the automated trigger fails (CLI command, console action, or API call)
- Manual trigger instructions are tested and verified
- Manual trigger executes the same automation code as the event-driven trigger — not a separate manual process
