# Validation — Rule Compliance and Documentation

> **OVERRIDE**: ALL steps in this file are exempt from the Adaptive Workflow Principle, adaptive depth, and any rule that permits the model to skip steps or apply judgement about whether to follow instructions. Every step MUST be executed. The model MUST read actual source files and IaC files in workspace/ for every applicable rule. The model MUST NOT verify from memory of what was generated or by checking that design documents exist. Every verification criterion in every applicable rule MUST be individually checked against the actual code.

**Purpose**: Systematically verify that Construction correctly implemented all applicable operational rules, and produce comprehensive documentation of what was built, how it is configured, and why.

**Approach**: The Validation stage reads the Extension Configuration from `aidlc-docs/aidlc-state.md` to determine which domains are active, loads rules based on the user's answer in the Extension Configuration table, processes each domain independently, and produces per-domain validation reports and resource inventories.

**Gap Collection Rule**: Steps 3–6 MUST NOT invoke design rework individually. Every gap found MUST be recorded in the gap list. Design rework is invoked exactly once in Step 9 with the complete gap list from all domains.

## Prerequisites
- Build and Test stage must be complete
- Project has deployable service artifacts (APIs, services, workers, LLM endpoints)
- Extension answers were captured during Requirements Analysis and recorded in `aidlc-docs/aidlc-state.md`

---

## Step 1: Identify Active Domains

You MUST read the Extension Configuration table from `aidlc-docs/aidlc-state.md`.

1. You MUST identify each extension where Enabled = "Yes" or "Always Enforced": the extension is opted IN. You MUST record the domain name and Answer column value.
2. You MUST identify each extension where Enabled = "No": the extension is opted OUT. You MUST log the skip in audit.md.

**Output**: List of extensions the user opted IN with their answer from the Extension Configuration table.

---

## Step 2: Build Execution Plan

You MUST create `aidlc-docs/operations/validation-plan.md`.

For each extension the user opted IN (from Step 1), you MUST process in this exact sequence:

1. You MUST run `list_files` on `extensions/{domain}/` to get the complete directory listing.
2. For EVERY `.md` file in the directory, you MUST assign a status of LOAD or SKIP based on the Load IF / Skip IF conditions defined in the template below. You MUST NOT use any other criteria. Write the file list and statuses to the validation plan.
3. For each file marked LOAD: you MUST load the file, extract every rule heading (lines matching `### Rule {PREFIX}-`), and record the file name and rule count in the validation plan.
4. You MUST NOT assign SKIP to any file unless it matches a Skip IF condition below.

After all extensions are processed:

5. You MUST scan all loaded files for cross-domain rule references (rule IDs with prefixes belonging to other opted-in extensions).
6. You MUST build a domain dependency graph: if domain A references rules from domain B, domain B MUST be processed before domain A. Write the domain processing order to the validation plan.

```markdown
# Rules Validation Plan

## Execution Plan

### Domain Processing Order
| Order | Domain | Depends On | Files | Rules |
|-------|--------|-----------|-------|-------|
| 1 | {domain} | None | {count} | {count} |
| 2 | {domain} | {domain} | {count} | {count} |

### Domain: {domain-name}
**User answer**: [A/B/C]

- [ ] **{domain}-baseline.opt-in.md** — SKIP
  - Opt-in question file, not a rule file

- [ ] **{domain}-baseline.md** — [LOAD/SKIP]
  - **Load IF**: Answer is A, B, or C
  - **Skip IF**: Domain is inactive (should not reach here)

- [ ] **{domain}-{concern}.md** (one entry per file found in directory) — [LOAD/SKIP]
  - **Load IF**: Answer is A or B (load all rule files per Loading Instructions)
  - **Skip IF**: Answer is C (custom only — Loading Instructions say load ONLY baseline + custom)

- [ ] **{domain}-custom.md** — [LOAD/SKIP]
  - **Load IF**: Answer is B or C (Loading Instructions include custom)
  - **Skip IF**: Answer is A (Loading Instructions exclude custom)

**Rules** (from all LOAD files):
- [ ] {RULE-ID-001}: {rule title}
- [ ] {RULE-ID-002}: {rule title}
```

Validation check:
- **MANDATORY**: Every `.md` file in each domain's directory listing MUST appear in the plan with a LOAD or SKIP status.
- **MANDATORY**: The Load IF / Skip IF conditions above are the ONLY valid conditions. They match the Loading Instructions defined in each domain's baseline.opt-in.md file. Architecture relevance is NOT a valid Skip IF condition.
- **MANDATORY**: Every rule heading (`### Rule {PREFIX}-`) found in every LOAD file MUST appear in the Rules checklist. If any rule is missing, add it before proceeding to Step 3.

---

## Step 3: Independently Assess Applicable Rules (Per-File)

For the current domain, you MUST analyse the workload independently — you MUST NOT rely on what Construction decided was applicable. You MUST re-evaluate from the architecture.

**MANDATORY: Process one rule file at a time.** You MUST iterate through each loaded rule file in the domain sequentially. For each file:

1. You MUST re-read the file to ensure all rule headings and criteria are in context.
2. You MUST read the rules checklist from `aidlc-docs/operations/validation-plan.md` for this domain. Each rule is a checkbox item (`- [ ] {RULE-ID}: {title}`). This is your task list.
3. You MUST evaluate applicability of each rule in that file against the architecture.
4. You MUST add each rule to the applicability matrix in `aidlc-docs/operations/{domain-name}/{domain-name}-validation.md` with status APPLICABLE or NOT APPLICABLE (with rationale).
5. You MUST mark the corresponding checkbox `[x]` in the validation plan after recording each rule.
6. You MUST proceed to the next file only after all rules in the current file are marked `[x]` in the plan.

After all files are processed, you MUST write the complete applicability matrix to `aidlc-docs/operations/{domain-name}/{domain-name}-validation.md`. The matrix MUST contain every rule ID found across all loaded files. If a rule file was loaded but no rules from it appear in the matrix, the assessment is incomplete and you MUST NOT proceed to Step 5.

Additional requirements:
- You MUST NOT mark a rule NOT APPLICABLE based on your own judgement — only based on the rule's stated "Applies to" condition not being met.
- Rules without an "Applies to" condition are APPLICABLE by default.
- You MUST report AWS best-practice rules and custom rules separately so the user can clearly distinguish gaps against AWS best practices from gaps against organisation-specific rules.

Validation checks:
- **MANDATORY**: You MUST read the rules checklist in the validation plan for this domain. Every checkbox MUST be marked `[x]`. If any remain `[ ]`, you MUST go back and process them.
- **MANDATORY**: The count of rules in the applicability matrix MUST equal the count of `[x]` items in the validation plan for this domain. If they do not match, you MUST identify the discrepancy and correct it.
- **MANDATORY**: You MUST NOT proceed to Step 4 until all checkboxes are `[x]` and the matrix is complete.

**Wait for Explicit Approval**: User must confirm the applicability assessment before proceeding with this domain.

---

## Step 4: Discover Resources from Code

You MUST enumerate every deployable resource that actually exists in `workspace/` by reading the IaC files. This inventory is built from the code — not from the design documents, not from the matrix, not from memory.

1. You MUST list all IaC files in `workspace/` (CDK stacks, CloudFormation templates, Terraform modules, SAM templates).
2. You MUST read each IaC file and record every resource construct found — the resource type, the logical name/ID, and the file it was found in.
3. You MUST group discovered resources by type (Lambda functions, DynamoDB tables, CloudWatch alarms, CloudWatch dashboards, Synthetics canaries, SNS topics, SSM documents, S3 buckets, API Gateway APIs, CloudFront distributions, Route53 health checks, IAM roles, CodePipeline pipelines, CodeDeploy applications, etc.).
4. You MUST write the resource inventory to `aidlc-docs/operations/resource-inventory.md`.

### Resource Inventory Format

```markdown
# Resource Inventory (from code)

## Lambda Functions
| Logical Name | File | Handler |
|-------------|------|---------|
| {name} | {file path} | {handler reference} |

## CloudWatch Alarms
| Logical Name | File | Metric | Threshold |
|-------------|------|--------|-----------|
| {name} | {file path} | {metric} | {threshold} |

## [repeat for each resource type discovered]
```

5. You MUST cross-reference the resource inventory against `aidlc-docs/construction/{unit-name}/nfr-requirements/rule-component-matrix.md`. For every resource in the matrix that does NOT appear in the code, you MUST record it as a gap — the resource was planned but never implemented.

Validation check:
- **MANDATORY**: `aidlc-docs/operations/resource-inventory.md` MUST exist before proceeding to Step 5.
- **MANDATORY**: Every resource type present in the rule-component-matrix MUST have a corresponding section in the resource inventory. If a resource type from the matrix has zero entries in the inventory, you MUST record this as a gap.

---

## Step 5: Validate Construction Output Against Rules (Per-File)

**MANDATORY: Process one rule file at a time.** You MUST iterate through each loaded rule file that contains APPLICABLE rules. For each file:

1. You MUST re-read the rule file to ensure all verification criteria are in context.
2. You MUST read `aidlc-docs/operations/{domain-name}/{domain-name}-validation.md` to identify which rules in this file are APPLICABLE.
3. You MUST read `aidlc-docs/operations/resource-inventory.md` to identify which resources exist in code.
4. You MUST read `aidlc-docs/construction/{unit-name}/nfr-requirements/rule-component-matrix.md` to identify which resources each rule was mapped to during Construction.
5. For each APPLICABLE rule in this file, you MUST identify resources from the UNION of: resources mapped to this rule in the matrix, and resources in the inventory that this rule could apply to. These are the rule × resource combinations you MUST verify.
6. For EACH rule × resource combination, you MUST open and read the relevant source file in `workspace/`. You MUST NOT verify from memory of what was generated. You MUST NOT verify by checking that design documents exist. You MUST NOT verify by checking that a file with a relevant name exists.
7. In the source file, you MUST locate the specific deployable construct that satisfies the rule's verification criteria for that resource.
8. You MUST record one evidence row in `aidlc-docs/operations/{domain-name}/{domain-name}-validation.md` for this rule × resource combination using the format below.
9. You MUST assign a verdict of PASS only if the cited construct would result in the rule's requirements being satisfied for that specific resource as part of the Deployment stage. If it would not, the verdict MUST be GAP.
10. You MUST complete all rule × resource combinations for the current file before proceeding to the next.

### Evidence Table Format

| Rule | Resource | In Matrix | In Inventory | File | Evidence | Verdict |
|------|----------|-----------|-------------|------|----------|---------|
| {RULE-ID} | {resource name} | Yes/No | Yes/No | {file path in workspace/} | {construct name + key configuration that satisfies the rule's criteria} | PASS/GAP |

### Evidence test

For EACH row in the evidence table, you MUST apply this test:

1. You MUST confirm the evidence cites a specific construct (class instantiation, resource definition) in a stack file that is part of the deployment.
2. You MUST confirm the construct would create the AWS resource satisfying the rule when the stack is deployed.
3. You MUST confirm the construct's configuration satisfies the rule's specific verification criteria for that resource. If the rule specifies a configuration value (e.g. "treat_missing_data = BREACHING"), the evidence MUST cite that value.

- **PASS IF**: ALL three conditions are met.
- **GAP IF**: ANY condition is not met.

Examples of evidence where the verdict MUST be GAP:

- Comments or TODO annotations
- Import statements
- Variable declarations or type definitions
- Design documents or markdown files
- Test assertions or mock configurations
- Placeholder stubs with no functional content
- The existence of a file with a relevant name (without a construct inside it)
- Resources deferred to post-deployment creation
- A generic reference (e.g. "alarm exists") without citing the specific configuration the rule requires

### Validation checks

**Coverage check** (did Step 5 complete all work?):
- **MANDATORY**: You MUST cross-reference the Applicability Matrix, the resource inventory, and the rule-component-matrix. For each APPLICABLE rule, every resource from the UNION of the matrix and inventory that the rule applies to MUST have an evidence row. If any rule × resource combination is missing, you MUST return to Step 5 task 5 and complete the missing rows.

**Evidence check** (are the verdicts correct?):
- **MANDATORY**: You MUST apply the Evidence Test to every PASS verdict. If any PASS row does not satisfy all three conditions, you MUST reclassify it as GAP.
- **MANDATORY**: For each APPLICABLE rule, EVERY verification criterion listed in the rule MUST be individually checked. A rule is PASS ONLY when ALL its verification criteria are satisfied for ALL applicable resources.

**Gap recording**:
- **MANDATORY**: Every GAP verdict MUST be added to the domain's gap list with: the rule ID, the resource name, the file that was checked, and what is missing.

You MUST NOT invoke design rework at this point. Record gaps only.

Validation check:
- **MANDATORY**: The ONLY valid findings are PASS or GAP. There is no "MINOR GAP", "PARTIAL", "NON-BLOCKING", or any other category. A rule either meets ALL its verification criteria (PASS) or it does not (GAP). Every GAP is collected for rework in Step 9. There are no non-blocking gaps — every gap blocks.
- **MANDATORY**: If any finding in the domain validation report is not exactly PASS or GAP, you MUST rewrite it as GAP before proceeding.

**Wait for Explicit Approval**: User must confirm verification results for this domain before proceeding.

---

## Step 6: Consolidate Gap List

You MUST read the Evidence Table in `aidlc-docs/operations/{domain-name}/{domain-name}-validation.md` and produce a `## Gap List` section in the same file.

1. You MUST identify every row with a GAP verdict in the Evidence Table.
2. You MUST classify each GAP into one of two categories:
   - **Not Implemented** — no deployable construct was found for this rule × resource. The Evidence column says "Not found" or equivalent.
   - **Incorrectly Implemented** — a construct exists but does not satisfy the rule's criteria. The Evidence column cites a construct that is wrong or incomplete.
3. You MUST write the Gap List section with both categories:

```markdown
## Gap List

### Not Implemented (no deployable construct found)
| Rule | Resource | Expected | Searched Files |
|------|----------|----------|---------------|
| {RULE-ID} | {resource} | {what the rule requires} | {files checked} |

### Incorrectly Implemented (construct exists but does not satisfy criteria)
| Rule | Resource | File | What's Wrong | Required |
|------|----------|------|-------------|----------|
| {RULE-ID} | {resource} | {file path} | {what it has} | {what the rule requires} |
```

4. If there are no GAP verdicts, you MUST write: `## Gap List\n\nNo gaps identified. All applicable rules PASS.`

Validation check:
- **MANDATORY**: Every GAP row in the Evidence Table MUST appear in exactly one Gap List category. If any GAP is missing from the Gap List, you MUST add it.
- **MANDATORY**: The count of rows in the Gap List (both categories combined) MUST equal the count of GAP verdicts in the Evidence Table.

---

## Step 7: Continue or Complete Domain Processing

- If more opted-in extensions remain, you MUST return to Step 3 for the next domain in dependency order.
- If all opted-in extensions are processed, you MUST proceed to Step 8.

You MUST NOT skip any opted-in extension. All extensions the user opted IN (from Step 1) MUST be processed through Steps 3–6.

---

## Step 8: Validate Plan Completeness

1. You MUST read `aidlc-docs/operations/validation-plan.md`.
2. You MUST read each per-domain validation report (`aidlc-docs/operations/{domain-name}/{domain-name}-validation.md`).
3. You MUST confirm every rule in the plan has a validation finding (PASS or GAP) in the domain validation reports.
4. If any rule from the plan is missing a finding, you MUST return to Step 3 for the domain containing the missing rule.
5. You MUST scan every domain validation report for findings that are not exactly PASS or GAP. If ANY other value exists (including "MINOR GAP", "PARTIAL", "NON-BLOCKING", "FAIL", "PASS WITH EXCEPTIONS"), you MUST rewrite that finding as GAP. Partial compliance is a gap. Non-blocking is a gap. Every non-PASS finding is a gap.
6. You MUST NOT proceed to Step 9 until every rule in the plan has a corresponding finding AND all findings are exactly PASS or GAP.

Validation check:
- **MANDATORY**: You MUST count the rules in the plan. You MUST count the rules with findings across all domain validation reports. The counts MUST match. If they do not match, you MUST identify the missing rules and return to Step 3 for those domains.
- **MANDATORY**: Every finding in every domain report MUST be exactly PASS or GAP. No other value is valid.

---

## Step 9: Resolve Gaps

You MUST review the complete gap list collected across all domains during Step 5.

**If the gap list is empty**: You MUST proceed to Step 10.

**If the gap list contains entries**: You MUST load `common/design-rework.md` and you MUST follow its steps exactly. You MUST invoke the design rework mechanism exactly once, passing the complete list of gaps as blocking requirements. All gaps from all domains MUST be submitted together — you MUST NOT invoke rework per domain or per gap.

---

## Step 10: Complete Rules Validation Report

After all domains are processed and gaps resolved, you MUST create `aidlc-docs/operations/rules-validation-report.md` with the final status.

Validation check:
- **MANDATORY**: For every extension the user opted IN (from Step 1), the file `aidlc-docs/operations/{domain-name}/{domain-name}-validation.md` MUST exist. If any domain report is missing, you MUST return to Step 6 for that domain and produce it before proceeding.

**Run history**: This file accumulates results across validation/rework iterations. Each run appends a new section. Previous run sections MUST NOT be modified.

```markdown
# Rules Validation Report

## Workload Context
- **Service name**: [from application design]
- **Deployment model**: [single-instance / multi-instance / multi-AZ / multi-region]
- **Service type**: [API / worker / streaming / LLM inference]
- **Externally facing**: [yes / no]
- **Multi-tenant**: [yes / no]

## N/A Determinations
| Domain | Rule | Rationale |
|--------|------|-----------|
| [domain] | [rule ID] | [why not applicable] |

## Validation Results
**Timestamp**: [ISO 8601]
**Run**: [run number]

| Domain | Rule | Result | Finding |
|--------|------|--------|---------|
| [domain] | [rule ID] | PASS / GAP | [what was missing, or —] |

**Summary**: [X] applicable rules, [Y] compliant, [Z] gaps
**Gaps submitted to design rework**: [list of rule IDs, or "none"]

## Documentation Artifacts
[List of all generated documentation files per domain]
```

---

## Step 11: Stage Completion

**MANDATORY**: You MUST present the standardized completion message using EXACTLY this format. You MUST NOT add columns, invent categories, or use any verdict other than PASS or GAP.

```markdown
# Rules Validation Complete

## Results

| Domain | Rules Assessed | PASS | GAP |
|--------|---------------|------|------|
| [domain] | [count] | [count] | [count] |
| **Total** | **[count]** | **[count]** | **[count]** |

## Gaps Submitted to Rework
[List of GAP rule IDs submitted to design rework, or "None — all rules compliant"]

## Known Exceptions
[List of GAP rules accepted as exceptions by the user with justification, or "None"]

## Options
A) Request Changes — specify what needs adjustment
B) Complete — finalise Validation stage
```

**MANDATORY**: The ONLY valid values in the Result column are PASS or GAP. There is no "MINOR GAP", "PARTIAL", "NON-BLOCKING", "N/A", or any other category. A rule either meets ALL its verification criteria (PASS) or it does not (GAP). Rules that do not apply to the architecture are excluded during the applicability assessment (Step 3) and do not appear in this table.

Validation check:
- **MANDATORY**: Before presenting the completion message, you MUST scan `aidlc-docs/operations/rules-validation-report.md` for any Result value that is not exactly "PASS" or "GAP". If ANY other value exists (including but not limited to: "MINOR GAP", "PARTIAL", "NON-BLOCKING", "ARCHITECTURE-N/A", "KNOWN EXCEPTION"), you MUST rewrite the report replacing every non-PASS value with GAP. Partial compliance is failure. A rule that is not fully met is GAP.

**Wait for Explicit Approval**: You MUST NOT finalise until the user confirms.

**MANDATORY**: You MUST log the user's response in audit.md with complete raw input.
