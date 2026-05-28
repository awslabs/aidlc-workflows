# AWS Service Naming Standards

**Last Updated**: 2026-03-19
**Version**: 1.0
**Status**: Active

---

## Purpose

This document establishes the official naming standards for AWS services in the AIDLC Design Reviewer codebase to support consistency, professionalism, and compliance with AWS branding guidelines.

---

## Core Principle

**Use the full AWS service name on first mention, then short form is acceptable for subsequent references in the same context.**

---

## AWS Service Names

### Amazon Bedrock

**Full Name**: Amazon Bedrock
**Short Form**: Bedrock (acceptable after first mention)

**First Mention Examples**:

- ✅ "This application uses Amazon Bedrock to access Claude models..."
- ✅ "Amazon Bedrock provides secure access to foundation models..."
- ✅ "Configure Amazon Bedrock Guardrails for content filtering..."

**Subsequent Reference Examples** (after first mention in same context):

- ✅ "The Bedrock API requires authentication..."
- ✅ "Bedrock model invocations are logged..."
- ✅ "Send the prompt to Bedrock for processing..."

**Code Comments**:

```python
# CORRECT: First mention in file/module
"""
Amazon Bedrock client factory for Unit 4: AI Review.

Creates configured boto3 Amazon Bedrock runtime clients with timeout and credential settings.
"""

# CORRECT: Subsequent mentions in same file
# Call Bedrock with retry logic
response = self._invoke_bedrock(prompt)

# Check Bedrock API response
if not response:
    raise BedrockAPIError("Bedrock API returned empty response")
```text
**User-Facing Messages**:

- First mention: "Connecting to Amazon Bedrock..."
- Error messages: "Amazon Bedrock API call failed"
- Documentation: Use full name in headings and first paragraph

### Other AWS Services

| Service      | Full Name                                  | Short Form   |
| -------------- | -------------------------------------------- | -------------- |
| IAM          | AWS Identity and Access Management (IAM)   | IAM          |
| CloudWatch   | Amazon CloudWatch                          | CloudWatch   |
| CloudTrail   | AWS CloudTrail                             | CloudTrail   |
| S3           | Amazon Simple Storage Service (S3)         | S3           |
| Lambda       | AWS Lambda                                 | Lambda       |
| VPC          | Amazon Virtual Private Cloud (VPC)         | VPC          |
| STS          | AWS Security Token Service (STS)           | STS          |
| SSO          | AWS Single Sign-On (SSO)                   | AWS SSO      |

---

## Application Guidelines

### Documentation Files

**Headings and Titles**:

- ✅ Use full service name in document titles
- ✅ Use full service name in section headings
- ✅ Use full service name on first mention in each major section

**Example**:

```markdown
# Amazon Bedrock Security Guidelines

## Overview
Amazon Bedrock is AWS's managed service for accessing foundation models...

## Authentication
When authenticating to Bedrock, use temporary credentials...
```text
### Code Comments and Docstrings

**Module Docstrings**:

- ✅ Use full service name at module level
- ✅ Short form acceptable within same module for implementation details

**Function/Class Docstrings**:

- ✅ Use full service name if it's the primary topic
- ✅ Short form acceptable if service already introduced in module docstring

**Example**:

```python
"""
Amazon Bedrock client factory.

Creates boto3 clients for Amazon Bedrock with proper configuration.
Handles authentication and timeout settings for Bedrock API calls.
"""

def create_bedrock_client():
    """Create a configured Bedrock runtime client."""
    # Implementation uses short form since service is established
```text
### User-Facing Messages

**CLI Output**:

- ✅ Use full service name in initial startup messages
- ✅ Short form acceptable in progress indicators

**Error Messages**:

- ✅ Use full service name for clarity and professionalism
- ✅ Example: "Amazon Bedrock API authentication failed"

**Log Messages**:

- ✅ INFO level: Can use short form for brevity
- ✅ ERROR level: Prefer full service name for clarity
- ✅ Example (INFO): `logger.info("Sending request to Bedrock...")`
- ✅ Example (ERROR): `logger.error("Amazon Bedrock API call failed: {error}")`

### Configuration Files

**YAML/JSON Configuration**:

- ✅ Use descriptive field names with full service name in comments
- ✅ Short form acceptable in field names if clear from context

**Example**:

```yaml
aws:
  region: us-east-1              # AWS region for Amazon Bedrock
  profile_name: default          # AWS profile with Bedrock permissions

  # Amazon Bedrock Guardrails configuration
  guardrail_id: abc123           # Bedrock Guardrail ID
  guardrail_version: "1"         # Guardrail version
```text
### Exception Messages

**Exception Strings**:

- ✅ Use full service name for clarity in error reporting
- ✅ Users may not be familiar with short forms

**Example**:

```python
raise BedrockAPIError(
    "Amazon Bedrock API authentication failed",
    context={"hint": "Check Amazon Bedrock permissions in IAM"}
)
```text
---

## Rationale

### Why This Standard?

1. **AWS Branding Guidelines**: AWS documentation consistently uses full service names on first mention
2. **Professional Communication**: Full service names convey professionalism and authority
3. **User Clarity**: Not all users are familiar with AWS service abbreviations
4. **Legal Compliance**: Proper service naming aligns with AWS trademark guidelines
5. **Documentation Quality**: Improves searchability and reduces ambiguity

### Balancing Clarity and Brevity

- **First mention = Full name**: Establishes context clearly
- **Subsequent mentions = Short form**: Maintains readability and reduces verbosity
- **User-facing messages = Full name preferred**: Prioritizes clarity for users
- **Internal code = Short form acceptable**: Developers understand context

---

## Implementation Checklist

### For New Code

- [ ] Use full service name in module docstring
- [ ] Use full service name in class/function docstrings where applicable
- [ ] Use full service name in user-facing messages
- [ ] Use full service name in exception messages
- [ ] Short form acceptable in implementation details after first mention

### For Code Reviews

- [ ] Check that full service name appears on first mention
- [ ] Verify user-facing messages use full service name
- [ ] Confirm documentation uses full service name in headings
- [ ] Verify error messages are clear with full service name

### For Documentation

- [ ] Full service name in document title
- [ ] Full service name in first paragraph
- [ ] Full service name in section headings
- [ ] First mention in each major section uses full name
- [ ] Short form acceptable after establishment in section

---

## Examples from Codebase

### Before (Non-Compliant)

```python
"""
Bedrock client factory for Unit 4: AI Review.

Creates configured boto3 Bedrock runtime clients.
"""

def create_bedrock_client():
    """Create a configured Bedrock runtime client."""
    # Connect to Bedrock
    pass
```text
### After (Compliant)

```python
"""
Amazon Bedrock client factory for Unit 4: AI Review.

Creates configured boto3 Amazon Bedrock runtime clients with timeout and credential settings.
Handles authentication for Bedrock API calls.
"""

def create_bedrock_client():
    """Create a configured Amazon Bedrock runtime client."""
    # Connect to Bedrock (short form acceptable after first mention)
    pass
```text
---

## Exceptions

### When Short Form on First Mention is Acceptable

1. **Well-established acronyms**: IAM, S3, VPC (always defined once in document)
2. **Variable/function names**: `bedrock_client`, `create_bedrock_client()` (technical necessity)
3. **URLs and identifiers**: Service endpoints, model IDs (technical identifiers)
4. **After explicit definition**: When full name is provided with "(Bedrock)" notation

**Example of explicit definition**:

```text
Amazon Bedrock (Bedrock) is AWS's managed service... When calling Bedrock APIs...
```text
---

## Related Standards

- [AWS Branding Guidelines](https://aws.amazon.com/trademark-guidelines/)
- [AWS Documentation Style Guide](https://docs.aws.amazon.com/style-guide/)
- [AIDLC Code Style Guide](../../README.md)

---

## Change Log

| Date         | Version   | Changes                                         |
| -------------- | ----------- | ------------------------------------------------- |
| 2026-03-19   | 1.0       | Initial AWS service naming standards document   |

---

**Copyright 2026 AIDLC Design Reviewer Contributors**
Licensed under the Apache License, Version 2.0
