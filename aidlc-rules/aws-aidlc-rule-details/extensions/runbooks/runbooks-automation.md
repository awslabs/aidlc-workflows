# Runbook Automation Rules

## Overview
These rules define **how** runbooks are automated and triggered. They implement AIRUN-STRAT-003. Load this file during NFR Design, Code Generation, and Operations stages.

---

### Rule AIRUN-AUTO-001: Implement Automated Runbooks as Code

**Rule**: Runbooks identified as fully or partially automatable (AIRUN-STRAT-003) MUST be implemented as runbook automations executable by the cloud provider's native automation service. The model MUST select the automation service appropriate to each runbook's requirements using the following preference hierarchy:

1. **Native automation service** — for multi-step operational procedures, especially those requiring approval gates, conditional branching, or rollback. Select the cloud provider's native automation service that best fits the runbook's operational requirements.
2. **Native remote execution service** — for single-command execution across multiple instances or targets.
3. **Serverless function** — for event-driven automation that requires custom logic not expressible in the native automation service.
4. **Scripted automation (shell/Python)** — fallback only when native services cannot satisfy the runbook's requirements. Document the rationale for falling back to scripts.

The model derives the specific service from the cloud provider and tech stack defined in tech-env.md. The rule defines the preference hierarchy — not the tool.

Automated runbooks MUST be stored in version control and deployed through the same pipeline as application code.

**Verification**:
- Each automatable runbook uses the highest-preference automation approach that satisfies its requirements
- Each automated runbook artifact MUST be an executable workflow implemented in an AWS automation service, together with all supporting code required to satisfy AIRUN-AUTO-002 and AIRUN-AUTO-003
- For runbook automation steps that require human approval, approval MUST be possible via the AWS Console or CLI interacting with the workflow
- Script-based runbooks document why a native service was insufficient
- Automated runbook definitions are stored in version control
- Automated runbooks are deployed through CI/CD pipelines
- Partially automated runbooks include human approval steps in the runbook automation where required

---

### Rule AIRUN-AUTO-002: Trigger Automated Runbooks from Monitoring Events

**Rule**: Automated runbooks MUST be triggered automatically by monitoring events. The model MUST identify which alarms or events (AIOBS-ALARM rules) should trigger automated runbook execution, and implement the event-to-runbook binding using the cloud provider's native event routing and alarm action capabilities.

If it is not technically possible to trigger a runbook automatically, this is a blocking finding. The model MUST present the limitation to the customer and the finding MUST be explicitly accepted by the customer with the decision logged to `aidlc-docs/audit.md` with the AIRUN rule ID and rationale.

**Verification**:
- Each automated runbook has a functioning trigger binding implemented in IaC
- Event-to-runbook bindings are implemented in IaC
- Triggered runbooks include verification of the triggering condition before executing changes (avoid acting on transient spikes)
- Any runbook that cannot be triggered automatically has documented customer acceptance in audit.md

---

### Rule AIRUN-AUTO-003: Automated Runbooks Must Verify Outcome

**Rule**: Every automated runbook MUST include a verification step that confirms the intended outcome was achieved. If verification fails, the runbook MUST either execute its rollback procedure or escalate to a human operator.

**Verification**:
- Every automated runbook includes a post-execution verification step
- Verification failure triggers rollback or escalation
- Verification results are logged and emitted as metrics
- Failed automated runbook executions generate alerts
