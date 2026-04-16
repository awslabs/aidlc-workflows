# HCLS Compliance Rules

## Overview
These healthcare compliance rules are cross-cutting constraints that apply across all AI-DLC phases when enabled. They enforce regulatory requirements from HIPAA (Health Insurance Portability and Accountability Act), HITRUST CSF, GxP (Good Practice regulations), and FDA 21 CFR Part 11 where applicable.

**Enforcement**: At each applicable stage, the model MUST verify compliance with these rules before presenting the stage completion message to the user.

**Relationship to Security Baseline**: These rules extend and specialize the Security Baseline extension. If both HCLS Compliance and Security Baseline are enabled, HCLS rules take precedence where they impose stricter requirements. Security Baseline rules still apply for areas not covered by HCLS-specific rules.

### Blocking Compliance Finding Behavior
A **blocking compliance finding** means:
1. The finding MUST be listed in the stage completion message under a "HCLS Compliance Findings" section with the rule ID and description
2. The stage MUST NOT present the "Continue to Next Stage" option until all blocking findings are resolved
3. The model MUST present only the "Request Changes" option with a clear explanation of what needs to change
4. The finding MUST be logged in `aidlc-docs/audit.md` with the HCLS rule ID, description, and stage context

If a rule is not applicable to the current project context (e.g., HCLS-COMP-07 when no patient-facing data sharing exists), mark it as **N/A** in the compliance summary. This is not a blocking finding.

### Default Enforcement
All rules in this document are **blocking** by default. If any rule's verification criteria are not met, it is a blocking compliance finding. Follow the blocking finding behavior defined above.

### Partial Enablement
When the user selects **Partial** enablement during opt-in, only the following rules are enforced:
- HCLS-COMP-01 (PHI/PII Data Classification)
- HCLS-COMP-02 (Audit Trail for PHI Access)

All other rules are marked as N/A in compliance summaries.

---

## Rule HCLS-COMP-01: PHI/PII Data Classification

**Rule**: Every data model, schema, or data store definition MUST classify each field/attribute into one of three sensitivity categories:
- **PHI** (Protected Health Information): Any individually identifiable health information as defined by HIPAA §160.103, including medical records, diagnoses, treatment information, lab results, and insurance information when linked to an individual identifier
- **PII** (Personally Identifiable Information): Information that can identify an individual but is not health-related: names, addresses, dates of birth, Social Security numbers, contact information
- **Non-sensitive**: Data that cannot identify an individual and is not health-related

**Requirements**:
- Data classification MUST be documented in the requirements or design artifacts before any implementation begins
- PHI fields MUST be tagged/annotated in code (via decorators, annotations, schema metadata, or equivalent mechanism) so that downstream processes (encryption, access control, audit logging) can identify them programmatically
- Classification decisions MUST be reviewed and approved as part of the Requirements Analysis or Application Design stage
- When uncertain whether a field constitutes PHI, default to classifying it as PHI

**Verification**:
- Every data model has a documented classification for each field
- No data store schema exists without PHI/PII/Non-sensitive annotations
- Classification is traceable from requirements through to implementation
- Combined data that could re-identify individuals is classified as PHI even if individual fields are non-sensitive

**Applicable Stages**: Requirements Analysis, Application Design, Functional Design, Code Generation

---

## Rule HCLS-COMP-02: Audit Trail for PHI Access

**Rule**: Every system operation that reads, writes, updates, or deletes PHI MUST generate an immutable audit log entry containing:
- **Who**: The authenticated user or service principal performing the action
- **What**: The specific PHI resource accessed (resource type + ID, NOT the PHI data itself)
- **When**: Timestamp in ISO 8601 format (UTC)
- **Why**: The purpose/context of the access (API endpoint, business operation, or consent reference)
- **How**: The access method (API call, direct DB query, batch job, etc.)

**Requirements**:
- Audit logs MUST be stored in a tamper-evident or append-only store (e.g., AWS CloudTrail with log file integrity validation, Amazon QLDB, S3 with Object Lock)
- Audit logs MUST be retained for a minimum of 6 years (HIPAA §164.530(j))
- Audit logs MUST NOT contain the PHI data itself, only references (resource type + ID)
- Audit log access MUST be restricted to authorized compliance/security personnel
- Audit logging MUST NOT be bypassable. It must be enforced at the infrastructure or middleware layer, not left to application code to implement per-endpoint

**Verification**:
- Every API endpoint or data access layer that touches PHI has audit logging
- Audit log storage is append-only or tamper-evident
- Audit log entries contain all five required fields (who, what, when, why, how)
- Audit logs do not contain PHI data values
- Retention policy is configured for minimum 6 years
- No code path exists that accesses PHI without generating an audit entry

**Applicable Stages**: Application Design, Infrastructure Design, Functional Design, Code Generation, Build and Test

---

## Rule HCLS-COMP-03: BAA-Eligible Services Only

**Rule**: All AWS services used to store, process, or transmit PHI MUST be covered by the AWS Business Associate Agreement (BAA). This is a non-negotiable HIPAA requirement.

**Requirements**:
- Infrastructure design MUST reference the current [AWS HIPAA Eligible Services List](https://aws.amazon.com/compliance/hipaa-eligible-services-reference/)
- Any service selection that involves PHI MUST be validated against the BAA-eligible list
- If a non-BAA-eligible service is required for a non-PHI function, it MUST be architecturally isolated from PHI data flows. No PHI may transit through or be accessible to the non-BAA service
- The design document MUST include a "BAA Service Mapping" section that lists each AWS service used, whether it handles PHI, and its BAA eligibility status

**Verification**:
- Every AWS service in the architecture that handles PHI is on the BAA-eligible list
- No PHI data flows through non-BAA-eligible services
- A BAA Service Mapping table exists in the design documentation
- Non-BAA services used for non-PHI functions are architecturally isolated from PHI

**Applicable Stages**: Application Design, Infrastructure Design, NFR Design

---

## Rule HCLS-COMP-04: Minimum Necessary Access

**Rule**: All access control designs MUST enforce the HIPAA Minimum Necessary Rule (§164.502(b)). Users, roles, and service principals MUST only have access to the minimum PHI necessary to perform their specific function.

**Requirements**:
- Role definitions MUST specify which PHI data categories each role can access and why
- No role MUST have blanket "read all patient records" access unless explicitly justified and documented (e.g., system backup role with compensating controls)
- API endpoints MUST support field-level filtering so that responses only include the PHI fields the requesting role is authorized to see
- Break-glass procedures MUST be defined for emergency access scenarios, with mandatory post-access review
- Access reviews MUST be designed into the system, with periodic recertification of role assignments

**Verification**:
- Role-to-PHI-category mapping is documented
- No role has unrestricted PHI access without documented justification and compensating controls
- API design includes field-level access control or response filtering
- Break-glass procedure is defined with audit logging and post-access review
- Access review/recertification mechanism is included in the design

**Applicable Stages**: Requirements Analysis, Application Design, Functional Design, Code Generation

---

## Rule HCLS-COMP-05: Data Retention and Disposal

**Rule**: The system design MUST define data lifecycle policies for all PHI data categories, including retention periods and secure disposal procedures.

**Requirements**:
- Retention periods MUST comply with applicable regulations: HIPAA (6 years for administrative records), state laws (which may require longer retention for medical records, up to 10+ years in some jurisdictions), and any customer-specific requirements
- Automated retention enforcement MUST be designed. Data that reaches its retention limit must be flagged or queued for secure disposal
- Secure disposal MUST use cryptographic erasure (delete encryption keys) or NIST SP 800-88 compliant methods
- Disposal events MUST be logged in the audit trail with: data category, volume, disposal method, timestamp, and authorizing principal
- Data in backups MUST be covered by the same retention and disposal policies

**Verification**:
- Retention policies are documented per data category
- Automated retention enforcement mechanism is included in the design
- Disposal method is specified (cryptographic erasure or NIST 800-88)
- Disposal audit logging is included
- Backup retention aligns with primary data retention policies

**Applicable Stages**: Requirements Analysis, Application Design, Infrastructure Design

---

## Rule HCLS-COMP-06: Breach Notification Design

**Rule**: The system MUST include a breach detection and notification mechanism to support HIPAA Breach Notification Rule (§164.400-414) requirements.

**Requirements**:
- Anomaly detection MUST be designed for PHI access patterns (unusual volume, unusual hours, unusual roles, geographic anomalies)
- Automated alerting MUST trigger when potential breach indicators are detected
- The system MUST support generating a breach impact assessment: which patients were affected, what PHI was exposed, the timeframe of the breach
- Notification workflow MUST be designed to support the 60-day notification window (HIPAA §164.404), including affected individuals, HHS, and media (if >500 individuals in a state)
- Incident response integration MUST be included. The system should provide forensic data to support breach investigation

**Verification**:
- Anomaly detection for PHI access is included in the design
- Alerting mechanism is defined for breach indicators
- Breach impact assessment capability is designed (affected patients, PHI types, timeframe)
- Notification workflow supports regulatory timelines
- Forensic data availability is designed (logs, access records, data lineage)

**Applicable Stages**: Application Design, Infrastructure Design, NFR Design

---

## Rule HCLS-COMP-07: Consent Management

**Rule**: The system MUST capture, store, and enforce patient consent preferences before any PHI sharing, disclosure, or secondary use.

**Requirements**:
- Consent records MUST capture: patient identifier, consent scope (what data, for what purpose, to whom), grant/revoke timestamps, consent method (electronic, paper, verbal with witness), and expiration (if applicable)
- Consent enforcement MUST be evaluated at the point of data access, before PHI is disclosed to any external party, shared across organizational boundaries, or used for secondary purposes (research, analytics, marketing)
- Consent revocation MUST be supported and take effect within a defined SLA (document the SLA in requirements)
- Consent records MUST be included in the audit trail
- The system MUST support HIPAA minimum consent categories: Treatment, Payment, Healthcare Operations (TPO) and any additional consent categories required by the use case

**Verification**:
- Consent data model captures all required fields
- Consent enforcement is evaluated at data access points before disclosure
- Consent revocation mechanism is designed with a defined SLA
- Consent events are logged in the audit trail
- TPO consent categories are supported at minimum

**Applicable Stages**: Requirements Analysis, Application Design, Functional Design, Code Generation
