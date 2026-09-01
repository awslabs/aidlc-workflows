# Closed-Loop Observability Rules

## Overview
These rules define how to build closed-loop observability — componentry that monitors production behaviour, learns baselines, and **triggers the AI-DLC workflow** to update observability artifacts. The closed-loop system MUST NOT modify thresholds, dashboards, or alarms directly. It produces structured change requests that are processed through the normal AI-DLC flywheel with human approval at each gate.

**Prefix**: `AIOBS-LOOP-`

**Status**: Future capability — rules are placeholders. The model MUST NOT implement AIOBS-LOOP rules at this time.

**Closed-loop flow**:
1. **Observe** — Collect production baselines for steady-state and peak traffic patterns
2. **Analyse** — Detect drift, identify threshold gaps, compare actuals against design-time assumptions
3. **Recommend** — Produce a structured change request formatted as AI-DLC requirements
4. **Trigger** — Feed the change request into the AI-DLC workflow as input
5. **AI-DLC processes** — Normal workflow (requirements → design → code generation) with human approval
6. **Deploy** — Updated observability artifacts deployed through the standard pipeline

The closed-loop is a trigger for the flywheel, not an actuator. It never touches production directly.

**Why not modify directly?** When AI-DLC produces Infrastructure-as-Code (CloudFormation, CDK, Terraform), the IaC is the single source of truth for alarm thresholds, dashboard configurations, and scaling parameters. Direct modification of these resources by a closed-loop agent would cause IaC drift — the deployed state would no longer match the code in version control. The next pipeline deployment would revert the changes, drift detection tools would flag noise, and there would be no audit trail in the codebase. Routing through the AI-DLC flywheel ensures changes result in IaC code changes, reviewed by a human, merged, and deployed through the standard pipeline.

---

## Planned Rules

### Rule AIOBS-LOOP-001: Build a Baselining Agent for Steady-State and Peak Traffic

**Rule**: TODO — Define how the AI builds componentry to collect steady-state and peak baselines from production metrics over a defined window. The agent observes and records, it does not act.

**Verification**:
- TODO

---

### Rule AIOBS-LOOP-002: Detect Baseline Drift and Threshold Gaps

**Rule**: TODO — Define how the system detects when production behaviour has shifted enough from established baselines to warrant observability updates. Includes: threshold gaps (alarm thresholds no longer aligned to actual behaviour), capacity trend changes, and new traffic patterns not covered by existing instrumentation.

**Verification**:
- TODO

---

### Rule AIOBS-LOOP-003: Produce Structured Change Requests for the AI-DLC Flywheel

**Rule**: TODO — Define the format of change requests produced by the closed-loop agent. Change requests MUST be structured as AI-DLC requirements input, including: what changed (baseline data), why it matters (drift magnitude, risk), and what should be updated (specific thresholds, descriptions, projections). The closed-loop agent MUST NOT modify any observability artifact directly.

**Verification**:
- TODO

---

### Rule AIOBS-LOOP-004: Trigger the AI-DLC Workflow for Observability Refinement

**Rule**: TODO — Define how change requests trigger the AI-DLC workflow. The workflow processes the change request through its normal phases with human approval at each gate. Updated observability artifacts (alarm thresholds, dashboard descriptions, capacity projections) are deployed through the standard pipeline.

**Verification**:
- TODO

---

### Rule AIOBS-LOOP-005: Track Closed-Loop Effectiveness Over Time

**Rule**: TODO — Define how the system measures whether closed-loop refinements are improving observability effectiveness. Metrics may include: false positive alarm rate before/after refinement, time-to-detect improvement, threshold accuracy vs actual incidents.

**Verification**:
- TODO
