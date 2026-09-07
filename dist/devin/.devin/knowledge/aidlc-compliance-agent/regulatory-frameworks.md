# Regulatory Frameworks

Overview of major compliance frameworks, their requirements, and practical implementation guidance for cloud-native applications on AWS.

## PCI-DSS (Payment Card Industry Data Security Standard)

**Applies to**: Any system that stores, processes, or transmits cardholder data.

**Key Requirements** (organized by the 12 requirements):
1. **Network security**: Use security groups and NACLs to segment the cardholder data environment (CDE). No public internet access to CDE resources.
2. **Default credentials**: Change all vendor-supplied defaults. Automate with hardened AMIs and container images.
3. **Protect stored data**: Encrypt cardholder data at rest with KMS (AES-256). Implement data retention and disposal policies.
4. **Encrypt transmission**: TLS 1.2+ for all data in transit. Enforce HTTPS at ALB/API Gateway.
5. **Anti-malware**: Use Amazon Inspector for vulnerability scanning. GuardDuty for threat detection.
6. **Secure systems**: Patch management via SSM Patch Manager. IaC security scanning in CI.
7. **Access control**: Least-privilege IAM policies. No shared credentials. Role-based access.
8. **Authentication**: MFA for all administrative access. Cognito or IAM Identity Center for user management.
9. **Physical security**: Inherited from AWS for cloud infrastructure. Document shared responsibility model.
10. **Logging and monitoring**: CloudTrail for API activity. CloudWatch Logs for application logs. Retain for 1 year minimum.
11. **Testing**: Quarterly vulnerability scans. Annual penetration testing. IaC scanning in CI.
12. **Security policy**: Document and maintain an information security policy. Review annually.

**Scope reduction**: Use tokenization (via a PCI-compliant payment processor like Stripe) to minimize the CDE footprint. If you never touch raw card numbers, most PCI requirements do not apply.

## HIPAA (Health Insurance Portability and Accountability Act)

**Applies to**: Organizations handling Protected Health Information (PHI) in the US healthcare context.

**Key Requirements**:
- **BAA (Business Associate Agreement)**: Required with AWS before storing PHI. AWS offers BAAs for eligible services.
- **HIPAA-eligible services only**: Not all AWS services are HIPAA-eligible. Verify each service on the AWS HIPAA page.
- **Encryption**: PHI must be encrypted at rest (KMS) and in transit (TLS). This satisfies the Safe Harbor provision.
- **Access controls**: Role-based access to PHI. Audit all access with CloudTrail.
- **Audit trail**: Log all access to, creation of, and modification of PHI. Retain logs for 6 years.
- **Minimum necessary**: Only access and expose the minimum PHI required for the specific purpose.
- **Breach notification**: Notify affected individuals within 60 days of discovering a breach. Report to HHS.

**Architecture considerations**: Isolate PHI in dedicated accounts or VPCs. Use AWS PrivateLink to avoid PHI traversing the public internet. Tag all resources containing PHI for governance.

## SOC 2 (Service Organization Control 2)

**Applies to**: Service providers that store or process customer data. Increasingly expected by enterprise customers.

**Type I vs Type II**:
- **Type I**: Point-in-time assessment. "Controls are properly designed as of a specific date." Faster to achieve.
- **Type II**: Assessment over a period (usually 6-12 months). "Controls operated effectively during the review period." More rigorous and more valued.

**Trust Service Criteria**:
1. **Security** (required): Protection against unauthorized access. Covers firewalls, access controls, encryption, monitoring.
2. **Availability**: System is operational and accessible per SLA commitments.
3. **Processing Integrity**: System processing is complete, valid, accurate, and timely.
4. **Confidentiality**: Information designated as confidential is protected.
5. **Privacy**: Personal information is collected, used, retained, and disposed of per the privacy notice.

**Practical implementation**: Use AWS Config rules to continuously evaluate compliance. Automate evidence collection with Config conformance packs. Use Security Hub for centralized findings.

## GDPR (General Data Protection Regulation)

**Applies to**: Any organization processing personal data of EU/EEA residents, regardless of where the organization is located.

**Core Principles**:
- **Lawfulness**: Process data only with a legal basis (consent, contract, legitimate interest, legal obligation).
- **Purpose limitation**: Collect data only for specified, explicit purposes.
- **Data minimization**: Process only the data necessary for the stated purpose.
- **Accuracy**: Keep personal data accurate and up to date.
- **Storage limitation**: Retain data only as long as necessary. Define and enforce retention policies.
- **Integrity and confidentiality**: Protect data with appropriate security measures.

**Data Subject Rights**:
- Right of access (provide a copy of their data)
- Right to rectification (correct inaccurate data)
- Right to erasure ("right to be forgotten")
- Right to data portability (export in machine-readable format)
- Right to object to processing

**Technical implementation**: Build data subject access request (DSAR) automation. Implement soft-delete with configurable retention. Use DynamoDB TTL or S3 lifecycle policies for automatic data expiry. Tag PII data stores for governance.

## Data Residency and Sovereignty

- **Data residency**: Data must be stored within a specific geographic region. Choose AWS regions accordingly (eu-west-1 for EU, ap-southeast-2 for Australia).
- **Data sovereignty**: Data is subject to the laws of the country where it is stored.
- Use AWS Organizations SCPs to restrict resource creation to approved regions.
- Configure S3 bucket policies and DynamoDB table locations to enforce residency.
- Cross-region replication must respect residency requirements; do not replicate to unapproved regions.
- Document data flows across regions for compliance audits.

## Privacy Impact Assessment (PIA)

Conduct a PIA when introducing a new system or significantly changing data processing:

1. **Describe the processing**: What data, from whom, for what purpose, how long retained.
2. **Assess necessity**: Is the processing proportionate to the goal? Could the same outcome be achieved with less data?
3. **Identify risks**: Unauthorized access, accidental disclosure, data loss, function creep.
4. **Define mitigations**: Encryption, access controls, anonymization, pseudonymization, retention limits.
5. **Document and review**: Record the assessment. Review when processing changes or annually.

## Compliance-as-Code Patterns

Automate compliance verification rather than relying on manual audits:

- **AWS Config Rules**: Continuously evaluate resource configurations against compliance requirements (encrypted-volumes, restricted-ssh, mfa-enabled-for-iam).
- **Config Conformance Packs**: Pre-built rule sets for PCI-DSS, HIPAA, SOC2. Deploy via CloudFormation.
- **Security Hub**: Aggregate findings from Config, GuardDuty, Inspector, and third-party tools. Score against compliance frameworks.
- **cdk-nag**: Enforce compliance rules at synthesis time in CDK. Use AwsSolutionsChecks, NIST80053R5Checks, HIPAASecurityChecks, or PCIDSS321Checks.
- **Custom Config Rules**: Write Lambda-backed rules for organization-specific requirements.

## Audit Trail Requirements

Across all frameworks, a robust audit trail is a common requirement:

- **CloudTrail**: Enable in all regions, all accounts. Send to a centralized, immutable S3 bucket with Object Lock.
- **Application-level audit logs**: Log who did what, when, to which resource. Include the authentication context (user ID, role, IP).
- **Integrity protection**: Use CloudTrail log file integrity validation. S3 Object Lock for immutability.
- **Retention**: PCI-DSS: 1 year. HIPAA: 6 years. SOC2: per policy (typically 1-3 years). GDPR: as long as necessary for the purpose.
- **Access to logs**: Restrict log access to security and compliance roles. Log access to logs (meta-auditing) for sensitive environments.
