# HCLS Data Handling Rules

## Overview
These healthcare data handling rules govern how Protected Health Information (PHI) and electronic PHI (ePHI) are encrypted, de-identified, stored, backed up, and logged. They apply across all AI-DLC phases when enabled and ensure that PHI is protected at every layer of the technology stack.

**Enforcement**: At each applicable stage, the model MUST verify compliance with these rules before presenting the stage completion message to the user.

**Relationship to Security Baseline**: These rules extend SECURITY-01 (Encryption at Rest and in Transit) with healthcare-specific encryption requirements. If both extensions are enabled, HCLS Data Handling rules take precedence for PHI data. Security Baseline rules still govern non-PHI data.

### Blocking Data Handling Finding Behavior
A **blocking data handling finding** means:
1. The finding MUST be listed in the stage completion message under a "HCLS Data Handling Findings" section with the rule ID and description
2. The stage MUST NOT present the "Continue to Next Stage" option until all blocking findings are resolved
3. The model MUST present only the "Request Changes" option with a clear explanation of what needs to change
4. The finding MUST be logged in `aidlc-docs/audit.md` with the HCLS-DATA rule ID, description, and stage context

If a rule is not applicable to the current project context (e.g., HCLS-DATA-02 when no analytics or ML pipelines exist), mark it as **N/A** in the compliance summary. This is not a blocking finding.

### Default Enforcement
All rules in this document are **blocking** by default. If any rule's verification criteria are not met, it is a blocking data handling finding. Follow the blocking finding behavior defined above.

### Partial Enablement
When the user selects **Partial** enablement during opt-in, only the following rules are enforced:
- HCLS-DATA-01 (PHI Encryption Standards)
- HCLS-DATA-05 (Log Sanitization)

All other rules are marked as N/A in compliance summaries.

---

## Rule HCLS-DATA-01: PHI Encryption Standards

**Rule**: All PHI data MUST be encrypted using healthcare-grade encryption standards that meet or exceed HIPAA Security Rule requirements (§164.312(a)(2)(iv) and §164.312(e)(1)).

**Requirements (Encryption at Rest)**:
- PHI at rest MUST be encrypted using AES-256 (or equivalent) via AWS KMS with Customer Managed Keys (CMKs)
- KMS key policies MUST restrict key usage to authorized services and principals only
- Key rotation MUST be enabled (annual automatic rotation for KMS CMKs, or more frequent per organizational policy)
- Envelope encryption MUST be used for large data objects (e.g., S3 objects, database fields): data encrypted with a data key, data key encrypted with the CMK
- Different PHI data categories SHOULD use separate CMKs to limit blast radius of a key compromise

**Requirements (Encryption in Transit)**:
- All PHI in transit MUST use TLS 1.2 or higher. TLS 1.0 and 1.1 MUST be explicitly disabled
- Internal service-to-service communication carrying PHI MUST also be encrypted (mTLS recommended for service mesh architectures)
- API Gateway and Load Balancer TLS policies MUST enforce minimum TLS 1.2 with strong cipher suites (no RC4, no 3DES, no export ciphers)
- Certificate management MUST use AWS Certificate Manager (ACM) or equivalent automated certificate lifecycle management

**Verification**:
- Every data store containing PHI uses AES-256 encryption with KMS CMKs
- KMS key policies are scoped to authorized principals
- Key rotation is enabled
- TLS 1.2+ is enforced on all endpoints handling PHI
- TLS 1.0/1.1 are explicitly disabled
- Internal service communication carrying PHI is encrypted
- No PHI is transmitted over unencrypted channels

**Applicable Stages**: Application Design, Infrastructure Design, NFR Design, Code Generation

---

## Rule HCLS-DATA-02: De-identification Methods

**Rule**: Any analytics, machine learning, research, or reporting pipeline that uses PHI MUST apply HIPAA-compliant de-identification before processing, unless a valid authorization or exception applies.

**Requirements**:
- De-identification MUST follow one of two HIPAA-approved methods:
  - **Safe Harbor** (§164.514(b)): Remove all 18 HIPAA identifiers (names, geographic data smaller than state, dates except year, phone/fax numbers, email addresses, SSN, MRN, health plan numbers, account numbers, certificate/license numbers, vehicle identifiers, device identifiers, URLs, IP addresses, biometric identifiers, full-face photos, any other unique identifier)
  - **Expert Determination** (§164.514(a)): A qualified statistical expert certifies that the risk of re-identification is very small
- The de-identification method used MUST be documented in the design artifacts
- De-identification MUST be applied as close to the data source as possible, preferably during data extraction, not downstream
- Re-identification risk MUST be assessed when combining de-identified datasets. Quasi-identifiers (age, zip code, gender) can enable re-identification when combined
- A re-identification key (if maintained) MUST be stored separately from the de-identified data, with access restricted to authorized personnel

**Verification**:
- De-identification method is documented (Safe Harbor or Expert Determination)
- All 18 HIPAA identifiers are addressed in the de-identification pipeline (for Safe Harbor)
- De-identification is applied at or near the data source
- Re-identification risk assessment is documented for combined datasets
- Re-identification keys (if any) are stored separately with restricted access

**Applicable Stages**: Requirements Analysis, Application Design, Functional Design, Code Generation

---

## Rule HCLS-DATA-03: Cross-Region Data Residency

**Rule**: PHI MUST NOT leave the designated AWS region unless explicitly approved and documented, with appropriate safeguards.

**Requirements**:
- The primary AWS region for PHI storage MUST be documented in the requirements
- Cross-region replication of PHI (for DR or availability) MUST be explicitly approved and limited to approved regions
- PHI MUST NOT be replicated to or processed in regions outside the jurisdiction specified by the customer or applicable regulations (e.g., US PHI should generally stay within US regions unless approved)
- AWS service configurations MUST enforce region-locking:
  - S3 bucket policies MUST deny cross-region replication unless explicitly configured for approved DR regions
  - DynamoDB global tables MUST only include approved regions
  - Lambda@Edge and CloudFront MUST NOT cache or process PHI at edge locations outside approved regions
- SCP (Service Control Policies) or IAM policies SHOULD restrict resource creation to approved regions

**Verification**:
- Primary PHI region is documented
- Cross-region replication (if any) is limited to approved regions and documented
- No PHI data flows to unapproved regions
- Region-locking is enforced at the infrastructure level (SCPs, bucket policies, service configurations)
- Edge computing configurations do not expose PHI outside approved regions

**Applicable Stages**: Requirements Analysis, Infrastructure Design, NFR Design

---

## Rule HCLS-DATA-04: Backup and Recovery for PHI

**Rule**: All PHI data stores MUST have automated, encrypted backup procedures with tested recovery capabilities.

**Requirements**:
- Backups MUST be encrypted using the same (or equivalent) encryption standards as the primary data (AES-256 with KMS CMKs)
- Backup frequency MUST meet the Recovery Point Objective (RPO) defined in requirements. Document the RPO explicitly
- Recovery procedures MUST meet the Recovery Time Objective (RTO) defined in requirements. Document the RTO explicitly
- Backup restoration MUST be tested at least annually (design for automated restoration testing where possible)
- Backups MUST be stored in a separate AWS account or with cross-account access controls to protect against ransomware or account compromise
- Backup retention MUST align with data retention policies defined in HCLS-COMP-05 (if HCLS Compliance is also enabled) or customer-specified retention periods
- Point-in-time recovery (PITR) MUST be enabled for databases containing PHI where the service supports it (e.g., RDS, DynamoDB)
- Backup access MUST be audited. Any backup restoration event must be logged

**Verification**:
- RPO and RTO are documented in requirements
- Automated backup is configured for all PHI data stores
- Backups are encrypted with KMS CMKs
- Backup storage is isolated (separate account or cross-account controls)
- PITR is enabled where supported
- Backup restoration testing is included in operational design
- Backup retention aligns with data retention policies
- Backup access is audited

**Applicable Stages**: Requirements Analysis, Infrastructure Design, NFR Design, Build and Test

---

## Rule HCLS-DATA-05: Log Sanitization

**Rule**: Application logs, debug output, error messages, and monitoring data MUST NOT contain PHI. Logging infrastructure MUST enforce sanitization before write.

**Requirements**:
- A PHI sanitization layer MUST be implemented in the logging pipeline. This may be a logging middleware, a custom log formatter, or a structured logging configuration that explicitly excludes PHI fields
- PHI fields identified in HCLS-COMP-01 (data classification) MUST be filtered, masked, or replaced with opaque references (e.g., patient ID → hash or token) before log output
- Error messages and exception stack traces MUST be reviewed for PHI leakage. Caught exceptions involving PHI must sanitize the error context before logging
- Log aggregation services (CloudWatch Logs, OpenSearch, third-party SIEM) MUST NOT receive raw PHI
- Developers MUST NOT use `console.log`, `print`, or equivalent statements that output PHI during debugging. Enforce via linting rules or code review checklists
- Monitoring dashboards and alerting systems MUST NOT display PHI in alert messages, metric labels, or dashboard widgets

**Verification**:
- A PHI sanitization mechanism exists in the logging pipeline
- PHI fields from the data classification are explicitly filtered/masked in log output
- Error handling code sanitizes PHI before logging exceptions
- Log aggregation destinations do not receive raw PHI
- Linting rules or code review checklists address PHI in debug statements
- Monitoring and alerting configurations do not expose PHI

**Applicable Stages**: Application Design, Functional Design, Code Generation, Build and Test
