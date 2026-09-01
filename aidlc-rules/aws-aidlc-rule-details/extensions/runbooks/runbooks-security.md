# Runbook Security and Controls Rules

## Overview
These rules define the security controls and access requirements for runbook execution. Load this file during NFR Design, Code Generation, and Operations stages.

---

### Rule AIRUN-SEC-001: Enforce Authentication and Authorisation for Runbook Execution

**Rule**: Runbooks MUST only be executable by authenticated and appropriately authorised personnel and resources. Automated runbooks MUST use IAM roles with least-privilege permissions scoped to the specific actions the runbook performs.

**Verification**:
- Manual runbooks document required IAM permissions
- Automated runbooks use dedicated IAM roles with least-privilege policies
- No runbook uses overly broad permissions (no wildcard actions or resources without documented exception)
- Execution is auditable (CloudTrail, SSM execution history)

---

### Rule AIRUN-SEC-002: Test Runbooks with the Same Rigour as Application Code

**Rule**: Runbooks MUST be tested with the same engineering discipline used for application code. This includes testing in pre-production environments that mirror production, validating rollback procedures, and verifying target identification logic.

**Verification**:
- Runbooks are tested in pre-production before being used in production
- Rollback procedures are tested independently
- Target verification logic is tested against correct and incorrect targets
- Automated runbooks are included in CI/CD pipelines
