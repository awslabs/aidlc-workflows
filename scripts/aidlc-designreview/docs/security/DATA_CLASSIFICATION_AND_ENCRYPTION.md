<!-- markdownlint-disable MD041 MD060 -->

Copyright (c) 2026 AIDLC Design Reviewer Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
-->

# Data Classification and Encryption Strategy

**Last Updated**: 2026-03-19
**Version**: 1.0
**Status**: Production Guidelines

---

## Executive Summary

This document defines the data classification scheme and encryption strategy for the AIDLC Design Reviewer application, addressing sensitive data handling requirements.

**Key Findings**:

- Application performs **transient processing** only (no persistent sensitive data storage)
- Primary sensitive assets: AWS credentials, design documents, generated reports
- Encryption-in-transit: ✅ Enforced (TLS 1.2+)
- Encryption-at-rest: ⚠️ Relies on underlying infrastructure (disk encryption)

---

## AWS Shared Responsibility Model for Data Protection

**Reference**: [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/)

### Data Protection Responsibilities

Data protection is a **shared responsibility** between AWS and customers:

| Data Protection Area        | AWS Responsibility                                                                         | Customer Responsibility                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Encryption in Transit**   | ✅ Provide TLS 1.2+ for all AWS API endpoints<br/>✅ Enforce HTTPS for Amazon Bedrock      | ✅ Use AWS SDK (boto3) which enforces TLS<br/>✅ Validate certificate chains (SDK default)                                                                       |
| **Encryption at Rest**      | ✅ Encrypt Amazon Bedrock service data<br/>✅ Provide AWS KMS for customer data encryption | ⚠️ Enable disk encryption (BitLocker, FileVault, LUKS)<br/>❌ Encrypt design documents before processing (optional)<br/>❌ Encrypt generated reports (optional)  |
| **Key Management**          | ✅ Manage AWS-managed KMS keys<br/>✅ Provide KMS service                                  | ⚠️ Create and manage customer-managed KMS keys (if used)<br/>⚠️ Define key rotation policies<br/>⚠️ Control key access via IAM                                   |
| **Data Classification**     | ✅ Classify AWS service data                                                               | ❌ Classify design documents and reports<br/>❌ Determine data sensitivity<br/>❌ Define handling procedures                                                     |
| **Data Retention**          | ✅ Retain Amazon Bedrock logs per AWS policy                                               | ❌ Define retention policy for design documents<br/>❌ Define retention policy for generated reports<br/>⚠️ Configure CloudWatch log retention (if enabled)      |
| **Data Deletion**           | ✅ Securely delete Amazon Bedrock service data                                             | ❌ Securely delete local files (design docs, reports)<br/>❌ Overwrite or shred sensitive files                                                                  |
| **Credential Protection**   | ✅ Secure temporary credential issuance (STS)<br/>✅ Automatic credential expiration       | ✅ Scrub credentials from application logs<br/>⚠️ Secure ~/.aws/credentials file permissions<br/>⚠️ Rotate IAM role credentials                                  |

**Legend**:

- ✅ Implemented (AWS or AIDLC application)
- ⚠️ Requires customer configuration/action
- ❌ Customer responsibility (not implemented by application)

### Critical Distinction: Data Location Determines Responsibility

```text
┌─────────────────────────────────────────────────────────────┐
│  DATA IN AWS SERVICES                                        │
│  (Amazon Bedrock processed prompts/responses)                │
│                                                              │
│  AWS Responsibility:                                         │
│  • Encryption of data within Amazon Bedrock                  │
│  • Secure deletion after processing                          │
│  • Service-level access controls                             │
├─────────────────────────────────────────────────────────────┤
│  DATA ON CUSTOMER SYSTEMS                                    │
│  (Design documents, reports, logs, credentials)              │
│                                                              │
│  Customer Responsibility:                                    │
│  • Classify data sensitivity                                 │
│  • Enable disk encryption                                    │
│  • Secure file permissions                                   │
│  • Implement secure deletion                                 │
│  • Define retention and backup policies                      │
└─────────────────────────────────────────────────────────────┘
```text
**Key Principle**: AWS protects data **within** AWS services, but customers must protect data **on their workstations and in transit to AWS**.

**Compliance Disclaimer**: Customers are responsible for determining appropriate data classification and encryption controls based on their regulatory and compliance requirements. Using Amazon Bedrock does not automatically confer compliance with HIPAA, PCI DSS, or other data protection regulations.

**See Also**:

- [AWS_BEDROCK_SECURITY_GUIDELINES.md](./AWS_BEDROCK_SECURITY_GUIDELINES.md) for complete shared responsibility model
- [RISK_ASSESSMENT.md](./RISK_ASSESSMENT.md) for data protection risk analysis

---

## Data Classification

### Classification Levels

| Level              | Description                           | Examples                                  | Handling Requirements                      |
| -------------------- | --------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| **CRITICAL**       | Highly sensitive, regulatory impact   | AWS credentials, access keys              | Encrypt, scrub from logs, temporary only   |
| **CONFIDENTIAL**   | Proprietary business information      | Design documents, architecture diagrams   | Access control, optional encryption        |
| **INTERNAL**       | Internal use, not public              | Review reports, AI findings               | Basic access control                       |
| **PUBLIC**         | Can be freely shared                  | Documentation, open-source code           | No restrictions                            |

---

## Data Inventory

### 1. AWS Credentials (CRITICAL)

**Data Type**: Authentication credentials
**Sensitivity**: CRITICAL
**Storage Location**: AWS profile (~/.aws/credentials) - managed by AWS CLI
**Lifetime**: Temporary (STS tokens: 1-12 hours)
**Encryption**:

- ✅ In-transit: TLS 1.2+ (boto3 enforced)
- ⚠️ At-rest: Relies on OS disk encryption (BitLocker, FileVault, LUKS)
- ✅ In-logs: Scrubbed via regex patterns

**Handling Requirements**:

- MUST use temporary credentials only (IAM roles, STS, SSO)
- MUST NOT hardcode in application code
- MUST scrub from all logs
- MUST encrypt ~/.aws directory if disk encryption not enabled

**Compliance**: PCI DSS (credentials = cardholder data equivalent)

---

### 2. Design Documents (CONFIDENTIAL)

**Data Type**: Technical architecture documentation
**Sensitivity**: CONFIDENTIAL (proprietary business information)
**Storage Location**: User-provided directory (aidlc-docs/)
**Lifetime**: User-controlled (input files)
**Encryption**:

- ⚠️ At-rest: User responsibility (disk encryption recommended)
- ✅ In-transit: TLS 1.2+ when sent to Amazon Bedrock
- ⚠️ In-memory: Plaintext (transient processing)

**Handling Requirements**:

- SHOULD be stored on encrypted file systems
- MUST validate file types (.md only)
- MUST limit file sizes (prevent DoS)
- SHOULD use access controls (file permissions)

**Compliance**: Intellectual property protection, trade secret laws

---

### 3. AI Model Responses (CONFIDENTIAL)

**Data Type**: LLM-generated review findings
**Sensitivity**: CONFIDENTIAL (derived from design documents)
**Storage Location**: Memory only (transient)
**Lifetime**: Request duration (~30-120 seconds)
**Encryption**:

- ✅ In-transit: TLS 1.2+ (Bedrock API)
- ⚠️ In-memory: Plaintext
- ❌ At-rest: NOT stored permanently

**Handling Requirements**:

- MUST NOT store raw responses permanently
- MAY log to CloudWatch (with retention policy)
- MUST parse into structured data only
- SHOULD discard after processing

**Compliance**: Data minimization principle (GDPR)

---

### 4. Generated Reports (INTERNAL)

**Data Type**: HTML/Markdown review reports
**Sensitivity**: INTERNAL (business use)
**Storage Location**: User-specified output directory
**Lifetime**: User-controlled
**Encryption**:

- ⚠️ At-rest: User responsibility (disk encryption recommended)
- ❌ In-transit: Not transmitted (local file)

**Handling Requirements**:

- SHOULD be stored on encrypted file systems
- MAY include confidential findings (treat as CONFIDENTIAL)
- SHOULD use access controls (file permissions)
- SHOULD be deleted after review completion (if not needed)

**Compliance**: Business records retention policies

---

### 5. Application Logs (INTERNAL)

**Data Type**: Structured application logs
**Sensitivity**: INTERNAL (may contain metadata)
**Storage Location**: logs/design-reviewer.log, CloudWatch Logs
**Lifetime**: 90 days (configurable)
**Encryption**:

- ✅ Credentials: Scrubbed
- ⚠️ At-rest: CloudWatch encryption (AWS KMS)
- ❌ Local logs: Plaintext (disk encryption recommended)

**Handling Requirements**:

- MUST scrub credentials before logging
- MUST NOT log sensitive document content
- SHOULD encrypt CloudWatch log groups (KMS)
- SHOULD rotate local logs (10 MB, 5 backups)

**Compliance**: Audit trail requirements (SOC 2, ISO 27001)

---

## Encryption Strategy

### Encryption in Transit

**Requirement**: ALL data transmitted to AWS MUST use TLS 1.2 or higher

**Implementation**:

```python
# boto3 enforces HTTPS by default
session = boto3.Session(profile_name='aidlc-app-role')
bedrock_client = session.client('bedrock-runtime', region_name='us-east-1')

# Verify TLS version
import ssl
assert ssl.OPENSSL_VERSION_INFO >= (1, 1, 1), "OpenSSL 1.1.1+ required for TLS 1.2+"
```text
**Covered Data**:

- ✅ AWS API calls (IAM, Bedrock, CloudWatch)
- ✅ Design documents sent to Amazon Bedrock
- ✅ AI model responses from Amazon Bedrock

**Status**: ✅ ENFORCED

---

### Encryption at Rest

#### Option 1: Operating System Disk Encryption (RECOMMENDED)

**Recommendation**: Enable full disk encryption on all systems running AIDLC Design Reviewer

**Platforms**:

- **Windows**: BitLocker
- **macOS**: FileVault
- **Linux**: LUKS (dm-crypt)

**Covered Data**:

- ✅ AWS credentials (~/.aws/)
- ✅ Design documents (aidlc-docs/)
- ✅ Generated reports
- ✅ Application logs

**Implementation**:

```bash
# Linux (LUKS) - Encrypt home directory
sudo apt install cryptsetup
cryptsetup luksFormat /dev/sdX
cryptsetup open /dev/sdX encrypted-home
mkfs.ext4 /dev/mapper/encrypted-home

# macOS (FileVault)
sudo fdesetup enable

# Windows (BitLocker)
# Enable via Control Panel > BitLocker Drive Encryption
```text
**Status**: ⚠️ USER RESPONSIBILITY (not enforced by application)

---

#### Option 2: File-Level Encryption (ADVANCED)

**Use Case**: Enhanced protection for design documents in shared environments

**Tools**:

- **GPG**: `gpg --encrypt --recipient user@example.com design-doc.md`
- **AWS KMS**: Encrypt/decrypt using AWS Key Management Service
- **age**: Modern file encryption tool

**Implementation**:

```bash
# Encrypt design documents before review
gpg --encrypt --recipient aidlc-reviewer design-doc.md

# Decrypt for review
gpg --decrypt design-doc.md.gpg | design-reviewer --stdin

# Encrypt generated reports
gpg --encrypt --recipient manager@example.com design-review-report.html
```text
**Status**: ⚠️ OPTIONAL (for high-sensitivity environments)

---

#### Option 3: AWS KMS Integration (FUTURE ENHANCEMENT)

**Concept**: Integrate AWS KMS for application-level encryption

**Potential Implementation**:

```python
import boto3

kms_client = boto3.client('kms')

def encrypt_design_document(content: str, key_id: str) -> bytes:
    """Encrypt design document using AWS KMS."""
    response = kms_client.encrypt(
        KeyId=key_id,
        Plaintext=content.encode('utf-8')
    )
    return response['CiphertextBlob']

def decrypt_design_document(ciphertext: bytes, key_id: str) -> str:
    """Decrypt design document using AWS KMS."""
    response = kms_client.decrypt(
        CiphertextBlob=ciphertext
    )
    return response['Plaintext'].decode('utf-8')
```text
**Benefits**:

- Centralized key management
- Audit trail (CloudTrail logs all KMS operations)
- Fine-grained access control (IAM policies)
- Automatic key rotation

**Status**: 📋 PLANNED (Q3 2026)

---

### Encryption in Memory

**Current State**: Data is in plaintext in application memory during processing

**Rationale**:

- Transient processing (30-120 seconds)
- No persistent storage
- Python runtime limitations (no practical memory encryption)

**Mitigations**:

- Short-lived processes (exit after review completion)
- No core dumps (disable via `ulimit -c 0`)
- Process isolation (containerization recommended)
- Secure system hardening (ASLR, DEP)

**Status**: ℹ️ NOT IMPLEMENTED (low risk for transient processing)

---

## Key Management

### Current Approach

**AWS Credentials**:

- Managed by AWS STS (temporary credentials auto-rotate)
- IAM roles use AWS-managed keys
- No application-managed keys

**Disk Encryption**:

- OS-managed keys (BitLocker, FileVault, LUKS)
- User-controlled master password/recovery key

**Status**: ✅ ADEQUATE (no application key management required)

---

### Future AWS KMS Integration

**Key Hierarchy**:

```text
AWS KMS Customer Master Key (CMK)
    ├── Data Encryption Key (DEK) #1 → Encrypt design-doc-1.md
    ├── Data Encryption Key (DEK) #2 → Encrypt design-doc-2.md
    └── Data Encryption Key (DEK) #3 → Encrypt report-1.html
```text
**Key Policy** (attached to KMS key):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Enable IAM User Permissions",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::ACCOUNT-ID:root"
      },
      "Action": [
        "kms:Create*",
        "kms:Describe*",
        "kms:Enable*",
        "kms:List*",
        "kms:Put*",
        "kms:Update*",
        "kms:Revoke*",
        "kms:Disable*",
        "kms:Get*",
        "kms:Delete*",
        "kms:TagResource",
        "kms:UntagResource",
        "kms:ScheduleKeyDeletion",
        "kms:CancelKeyDeletion"
      ],
      "Resource": "arn:aws:kms:REGION:ACCOUNT-ID:key/*",
      "Condition": {
        "StringEquals": {
          "kms:KeySpec": "SYMMETRIC_DEFAULT"
        }
      }
    },
    {
      "Sid": "Allow AIDLC application to use key",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::ACCOUNT-ID:role/aidlc-app-role"
      },
      "Action": [
        "kms:Decrypt",
        "kms:DescribeKey"
      ],
      "Resource": "arn:aws:kms:REGION:ACCOUNT-ID:key/SPECIFIC-KEY-ID",
      "Condition": {
        "StringEquals": {
          "kms:ViaService": "bedrock.REGION.amazonaws.com"
        }
      }
    }
  ]
}
```text
**⚠️ IMPORTANT - Replace Placeholders Before Use**:

- `ACCOUNT-ID`: Your AWS account ID (e.g., `123456789012`)
- `REGION`: Your AWS region (e.g., `us-east-1`)
- `SPECIFIC-KEY-ID`: Your KMS key ID (e.g., `1234abcd-12ab-34cd-56ef-1234567890ab`)

**Least Privilege**: This policy grants only the minimum permissions required for AIDLC Design Reviewer. The application role only needs `kms:Decrypt` and `kms:DescribeKey` for read-only operations. The `kms:ViaService` condition ensures KMS access is only granted when called through Amazon Bedrock. Do NOT use `kms:*` or wildcard resources in production.

**Notes**:

- This is a KMS key policy (attached to the CMK), not an IAM policy
- The key ARN format is: `arn:aws:kms:REGION:ACCOUNT-ID:key/KEY-ID`
- Root account statement enables IAM policies to grant additional permissions
- `kms:KeySpec` condition restricts to symmetric keys only

**See Also**: [AWS IAM Best Practices - Grant Least Privilege](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html#grant-least-privilege)

**Key Rotation**: Automatic (AWS-managed, annually)

**Status**: 📋 PLANNED (Q3 2026)

---

## Data Retention and Deletion

### Retention Policies

| Data Type               | Retention Period            | Deletion Method        |
| ------------------------- | ----------------------------- | ------------------------ |
| **AWS Credentials**     | Auto-expire (1-12 hours)    | STS automatic          |
| **Design Documents**    | User-controlled             | User responsibility    |
| **AI Responses**        | Transient (seconds)         | Garbage collection     |
| **Generated Reports**   | User-controlled             | User responsibility    |
| **Application Logs**    | 90 days                     | Automatic rotation     |
| **CloudWatch Logs**     | 90 days                     | AWS retention policy   |
| **CloudTrail Logs**     | 90 days (archive 7 years)   | S3 lifecycle policy    |

---

### Secure Deletion

**Requirements**:

- MUST securely delete temporary files
- SHOULD overwrite sensitive files before deletion
- MAY use secure deletion tools for high-sensitivity data

**Implementation**:

```bash
# Secure file deletion (Linux)
shred -vfz -n 3 sensitive-file.md

# Secure directory deletion
find aidlc-docs/ -type f -exec shred -vfz -n 3 {} \;
rm -rf aidlc-docs/

# macOS secure delete
srm -v sensitive-file.md
```text
**Automated Cleanup**:

```python
import os
import tempfile

# Use temporary directories for transient data
with tempfile.TemporaryDirectory() as tmpdir:
    # Process files in tmpdir
    # Automatically deleted on exit
    pass
```text
---

## Access Control

### File System Permissions

**Requirements**:

```bash
# AWS credentials directory (CRITICAL)
chmod 700 ~/.aws
chmod 600 ~/.aws/credentials
chmod 600 ~/.aws/config

# Design documents (CONFIDENTIAL)
chmod 750 aidlc-docs/
chmod 640 aidlc-docs/**/*.md

# Generated reports (INTERNAL)
chmod 640 design-review-report.html

# Application logs (INTERNAL)
chmod 640 logs/design-reviewer.log
```text
**Rationale**:

- Owner: Read/write access
- Group: Read-only access (for team collaboration)
- Others: No access

---

### AWS IAM Policies

**Principle**: Least-privilege access to AWS resources

**Data Access Control**:

```json
{
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-6-v1:0",
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6-v1:0",
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-v1:0"
      ],
      "Condition": {
        "StringEquals": {
          "aws:PrincipalArn": "arn:aws:iam::ACCOUNT-ID:role/aidlc-app-role",
          "aws:RequestedRegion": "us-east-1"
        }
      }
    }
  ]
}

**⚠️ IMPORTANT - Amazon Bedrock Model Access**:
- **Specific Models**: This policy grants access only to Claude 4.5 and 4.6 models in `us-east-1`
- **Region Scoping**: The `aws:RequestedRegion` condition restricts access to a single region
- **Model Versions**: Update model ARNs when new model versions are released
- **Least Privilege**: Do NOT use wildcard ARNs like `arn:aws:bedrock:*:*:foundation-model/*` in production

**See Also**: [AWS IAM Best Practices - Grant Least Privilege](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html#grant-least-privilege)
```text
---

## Compliance Guidance

**IMPORTANT DISCLAIMER**: The information in this section is provided as technical guidance only. **Customers are solely responsible for determining the applicability of compliance frameworks to their specific use case and for performing their own compliance assessments.**

**Using AIDLC Design Reviewer and Amazon Bedrock does NOT automatically make your application compliant with GDPR, PCI DSS, SOC 2, or any other regulatory framework.**

---

### GDPR (General Data Protection Regulation)

**Customer Responsibility**: Customers must determine if GDPR applies to their use of AIDLC Design Reviewer based on whether design documents contain personal data of EU residents.

| Requirement                                    | Technical Implementation                       | Customer Must Also                                                                                                |
| ------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| **Data Minimization**                          | Transient processing only                      | ✅ Classify data and avoid sending personal data to Amazon Bedrock                                                |
| **Encryption**                                 | TLS in transit, disk at rest                   | ⚠️ Enable full disk encryption on workstations<br/>❌ Perform Data Protection Impact Assessment (DPIA)            |
| **Right to Erasure**                           | No persistent storage in application           | ❌ Define and implement data deletion procedures<br/>❌ Document data retention policies                          |
| **Data Protection Impact Assessment (DPIA)**   | Threat model provided as input                 | ❌ Perform formal DPIA for customer organization<br/>❌ Document lawful basis for processing                      |
| **Processor Agreement**                        | AWS DPA covers Amazon Bedrock infrastructure   | ❌ Review AWS DPA terms<br/>❌ Document processor relationship<br/>❌ Ensure compliance with AWS DPA requirements |

**Customer Responsibility**: If processing personal data of EU residents, customers must perform a DPIA, establish a lawful basis for processing, and implement all GDPR requirements beyond technical controls.

---

### PCI DSS (Payment Card Industry Data Security Standard)

**Customer Responsibility**: Customers must determine if PCI DSS applies based on whether cardholder data is processed.

| Requirement                                        | Technical Implementation              | Customer Must Also                                                                                                     |
| ---------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **3.4**: Encrypt transmission of cardholder data   | TLS 1.2+ enforced                     | ❌ Ensure design documents do not contain cardholder data<br/>❌ Implement additional network segmentation if required |
| **3.5**: Protect keys used for encryption          | AWS-managed keys for Amazon Bedrock   | ⚠️ Implement key management for customer-side encryption<br/>❌ Document key management procedures                     |
| **8.2**: No default credentials                    | Temporary credentials only            | ⚠️ Enforce MFA for AWS console access<br/>❌ Implement password policies<br/>❌ Perform quarterly access reviews       |

**Customer Responsibility**: If processing cardholder data, customers must implement the full PCI DSS framework, not just the technical controls listed above. **AWS credentials are sensitive authentication data and must be protected accordingly.**

---

### SOC 2 (Service Organization Control)

**Customer Responsibility**: Customers must determine if SOC 2 compliance is required for their organization.

| Control                              | Technical Implementation                      | Customer Must Also                                                                                                                           |
| -------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **CC6.1**: Logical access controls   | IAM policies provided as examples             | ❌ Define and implement access control policies<br/>❌ Perform access reviews<br/>❌ Document access provisioning/deprovisioning             |
| **CC6.6**: Encryption in transit     | TLS 1.2+ enforced                             | ❌ Document encryption standards<br/>❌ Verify compliance annually                                                                           |
| **CC6.7**: Encryption at rest        | Disk encryption (customer responsibility)     | ❌ Enable and verify disk encryption<br/>❌ Document encryption implementation<br/>❌ Test encryption regularly                              |
| **CC7.2**: Monitoring                | CloudWatch (optional, customer must enable)   | ❌ Enable CloudWatch and CloudTrail<br/>❌ Define monitoring procedures<br/>❌ Implement alerting and response<br/>❌ Retain logs per policy |

**Customer Responsibility**: AWS infrastructure has SOC 2 certification, but **customers must implement their own SOC 2 controls** for the application layer, access management, change management, incident response, and all other SOC 2 trust service criteria. AWS certification does not transfer to customer applications.

---

### Compliance Disclaimer

**CRITICAL**: This application provides technical security controls that may support compliance efforts, but **customers are solely responsible for**:

1. ❌ Determining which compliance frameworks apply to their use case
2. ❌ Performing formal compliance assessments and audits
3. ❌ Implementing all required compliance controls beyond technical security
4. ❌ Obtaining compliance certifications or attestations
5. ❌ Maintaining ongoing compliance through monitoring and reviews
6. ❌ Documenting compliance evidence and audit trails

**Consult with legal and compliance professionals** before using AIDLC Design Reviewer for regulated workloads.

**See Also**: [RISK_ASSESSMENT.md](./RISK_ASSESSMENT.md) for customer risk acceptance requirements.

---

## Security Recommendations

### Immediate (Implement Now)

1. **Enable Disk Encryption** on all systems running AIDLC
   - Priority: HIGH
   - Effort: LOW
   - Impact: Protects all data at rest

2. **Restrict File Permissions** (chmod 700 ~/.aws, chmod 640 reports)
   - Priority: HIGH
   - Effort: LOW
   - Impact: Prevents unauthorized local access

3. **Enable CloudWatch Log Encryption** (KMS)
   - Priority: MEDIUM
   - Effort: LOW
   - Impact: Protects audit logs

### Short-Term (Q2 2026)

1. **Implement AWS KMS Integration**
   - Priority: MEDIUM
   - Effort: MEDIUM
   - Impact: Centralized key management, audit trail

2. **Add File Integrity Monitoring**
   - Priority: MEDIUM
   - Effort: MEDIUM
   - Impact: Detect unauthorized modifications

### Long-Term (Q3-Q4 2026)

1. **Implement Report Encryption** (optional, user-controlled)
   - Priority: LOW
   - Effort: HIGH
   - Impact: Enhanced protection for reports

2. **Add S3 Integration** with SSE-KMS
   - Priority: LOW
   - Effort: HIGH
   - Impact: Persistent encrypted storage option

---

## Data Flow Diagram

```text
┌─────────────────────────────────────────────────────────────┐
│  INPUT: Design Documents (CONFIDENTIAL)                     │
│  Encryption: ⚠️ User disk encryption                        │
└────────────────────┬────────────────────────────────────────┘
                     │ Plaintext (in-memory)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  APPLICATION PROCESSING (Transient)                          │
│  • Configuration loaded (AWS credentials)                    │
│  • Documents parsed                                          │
│  • Prompts constructed                                       │
│  Encryption: ⚠️ Memory (plaintext)                          │
└────────────────────┬────────────────────────────────────────┘
                     │ TLS 1.2+ (encrypted)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  AMAZON BEDROCK API (AWS Infrastructure)                    │
│  • Model inference                                           │
│  • Guardrails enforcement                                    │
│  Encryption: ✅ AWS-managed (at rest)                       │
│             ✅ TLS 1.2+ (in transit)                        │
└────────────────────┬────────────────────────────────────────┘
                     │ TLS 1.2+ (encrypted)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  APPLICATION PROCESSING (Transient)                          │
│  • AI responses parsed                                       │
│  • Reports generated                                         │
│  Encryption: ⚠️ Memory (plaintext)                          │
└────────────────────┬────────────────────────────────────────┘
                     │ Plaintext (file write)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  OUTPUT: Generated Reports (INTERNAL)                        │
│  Encryption: ⚠️ User disk encryption                        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  LOGS: Application Logs (INTERNAL)                           │
│  Encryption: ✅ Credentials scrubbed                        │
│             ⚠️ Local: disk encryption                       │
│             ✅ CloudWatch: KMS (optional)                   │
└─────────────────────────────────────────────────────────────┘
```text
---

## References

- [AWS Key Management Service (KMS)](https://docs.aws.amazon.com/kms/latest/developerguide/overview.html)
- [AWS Encryption SDK](https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/introduction.html)
- [NIST SP 800-111: Guide to Storage Encryption](https://csrc.nist.gov/publications/detail/sp/800-111/final)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)

---

## Change Log

| Date         | Version   | Changes                                               |
| -------------- | ----------- | ------------------------------------------------------- |
| 2026-03-19   | 1.0       | Initial data classification and encryption strategy   |
