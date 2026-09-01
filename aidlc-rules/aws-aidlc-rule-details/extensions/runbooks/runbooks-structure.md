# Runbook Structure and Content Rules

## Overview
These rules define **how** runbooks are structured and what they must contain. Every rule traces back to one or more AIRUN-STRAT rules. Load this file during NFR Design, Code Generation, and Operations stages.

---

### Rule AIRUN-CONTENT-001: Include Required Sections in Every Runbook

**Rule**: Every runbook MUST include the following sections:

1. **Prerequisites** — Required permissions, tools, configurations, and network connectivity/access needed to execute the runbook.
2. **Constraints** — Maintenance windows, impacted resources, conflicts with other business or operations activities.
3. **Procedure Steps** — Numbered steps with expected outcomes for each step. Each step MUST be specific and actionable.
4. **Verification** — How to verify the runbook achieved its intended outcome. This may be internal (return codes from executed actions), manual (operator verification), or programmatic (system verification).
5. **Rollback** — How to revert the change or return the environment to the previous state. Every runbook MUST be reversible, either through reverting the change or through execution of another procedure.
6. **Escalation** — Who to escalate to if the active team member cannot complete the runbook successfully, after what time period, any third parties and their contact/support information, and any decision makers who should be contacted before execution.

**Verification**:
- Every runbook contains all six required sections
- Procedure steps are numbered with expected outcomes
- Rollback procedure is documented and tested
- Escalation paths include contacts, time thresholds, and third-party support information

---

### Rule AIRUN-CONTENT-002: Runbooks Must Be Minimal and Actionable

**Rule**: Runbooks MUST contain the minimum information necessary to successfully perform the procedure. They are not design documents or architecture overviews. Every sentence must contribute to the operator successfully completing the procedure.

**Verification**:
- No runbook contains background information that is not directly needed for execution
- Steps are concise and actionable
- No ambiguous language ("consider", "you might want to") — use imperative instructions

---

### Rule AIRUN-CONTENT-003: Identify Targets Explicitly

**Rule**: Runbooks MUST execute against explicitly defined targets. The runbook MUST verify through metadata (tags, environment identifiers, resource ARNs) that it is executing against the correct target. This prevents accidental execution against the wrong environment.

**Verification**:
- Runbooks identify target resources explicitly (by tag, ARN, or environment identifier)
- Automated runbooks include a target verification step before executing changes
- No runbook relies on implicit environment context (e.g., "the current account")
