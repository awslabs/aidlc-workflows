# Custom Runbook Rules

## Overview

This file is for your organisation's custom runbook rules. Rules defined here are loaded and enforced alongside the built-in AIRUN rules when this file is present.

**How it works**:
- Place this file in `extensions/runbooks/` alongside the built-in rule files
- The AI-DLC extension loader automatically discovers and loads all `.md` files in this directory
- Custom rules are enforced with the same blocking behavior as built-in rules
- Custom rules can reference built-in rules (e.g., "extends AIRUN-CONTENT-001")

**Rule ID convention**: Use the prefix `AIRUN-CUSTOM-` followed by the category:
- `AIRUN-CUSTOM-CONTENT-` — Custom runbook content rules
- `AIRUN-CUSTOM-SEC-` — Custom runbook security rules
- `AIRUN-CUSTOM-AUTO-` — Custom runbook automation rules

---

## Custom Content Rules

<!-- Place custom runbook content rules here. -->

<!-- EXAMPLE (remove this comment block and uncomment to use):

### Rule AIRUN-CUSTOM-CONTENT-001: Include Change Advisory Board Reference

**Rule**: All runbooks for production changes must include a Change Advisory Board (CAB)
reference number. The runbook must not be executed without an approved CAB ticket.

**Verification**:
- Every production runbook includes a CAB reference field
- Automated runbooks validate CAB approval status before execution

-->

---

## Custom Security Rules

<!-- Place custom runbook security rules here. -->

<!-- EXAMPLE (remove this comment block and uncomment to use):

### Rule AIRUN-CUSTOM-SEC-001: Require Two-Person Authorisation for Destructive Runbooks

**Rule**: Runbooks that perform destructive operations (data deletion, service termination,
DNS changes) must require two-person authorisation before execution.

**Verification**:
- Destructive runbooks are identified and tagged
- SSM Automation documents for destructive runbooks include an approval step requiring a second approver
- Approval is logged and auditable

-->

---

## Custom Automation Rules

<!-- Place custom runbook automation rules here. -->

<!-- EXAMPLE (remove this comment block and uncomment to use):

### Rule AIRUN-CUSTOM-AUTO-001: Notify Slack Channel on Automated Runbook Execution

**Rule**: All automated runbook executions must send a notification to the team's
Slack channel with the runbook name, trigger, target, and outcome.

**Verification**:
- Slack notification step is included in all automated runbooks
- Notification includes: runbook name, trigger event, target resource, execution outcome

-->
