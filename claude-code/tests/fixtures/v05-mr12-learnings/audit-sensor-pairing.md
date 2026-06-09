# AI-DLC Audit Log

## Workflow Started
**Timestamp**: 2026-05-28T08:00:00Z
**Event**: WORKFLOW_STARTED
**Workflow ID**: t98-sensor-pairing
**Scope**: feature
**Intent**: t98 fixture: single-stage code-generation with mixed sensor pairings

---

## Stage Started
**Timestamp**: 2026-05-28T08:01:00Z
**Event**: STAGE_STARTED
**Stage**: code-generation
**Agent**: aidlc-developer-agent

---

## Sensor Fired
**Timestamp**: 2026-05-28T08:02:00Z
**Event**: SENSOR_FIRED
**Fire id**: aaaa0001
**Sensor ID**: required-sections
**Stage slug**: code-generation
**Output path**: aidlc-docs/construction/code-generation/output.md

---

## Sensor Passed
**Timestamp**: 2026-05-28T08:02:02Z
**Event**: SENSOR_PASSED
**Fire id**: aaaa0001
**Sensor ID**: required-sections
**Stage slug**: code-generation
**Output path**: aidlc-docs/construction/code-generation/output.md
**Duration ms**: 120

---

## Sensor Fired
**Timestamp**: 2026-05-28T08:03:00Z
**Event**: SENSOR_FIRED
**Fire id**: bbbb0002
**Sensor ID**: linter
**Stage slug**: code-generation
**Output path**: aidlc-docs/construction/code-generation/output.md

---

## Sensor Failed
**Timestamp**: 2026-05-28T08:03:04Z
**Event**: SENSOR_FAILED
**Fire id**: bbbb0002
**Sensor ID**: linter
**Stage slug**: code-generation
**Output path**: aidlc-docs/construction/code-generation/output.md
**Detail path**: aidlc-docs/.aidlc-sensors/code-generation/linter-bbbb0002.md
**Findings count**: 3

---

## Sensor Fired
**Timestamp**: 2026-05-28T08:04:00Z
**Event**: SENSOR_FIRED
**Fire id**: cccc0003
**Sensor ID**: type-check
**Stage slug**: code-generation
**Output path**: aidlc-docs/construction/code-generation/output.md

---

## Sensor Budget Override
**Timestamp**: 2026-05-28T08:04:08Z
**Event**: SENSOR_BUDGET_OVERRIDE
**Fire id**: cccc0003
**Sensor ID**: type-check
**Stage slug**: code-generation
**Output path**: aidlc-docs/construction/code-generation/output.md
**Cap layer**: binding
**Cap value**: 5
**Observed value**: 7

---

## Sensor Fired
**Timestamp**: 2026-05-28T08:05:00Z
**Event**: SENSOR_FIRED
**Fire id**: dddd0004
**Sensor ID**: upstream-coverage
**Stage slug**: code-generation
**Output path**: aidlc-docs/construction/code-generation/output.md

---

## Stage Completed
**Timestamp**: 2026-05-28T08:10:00Z
**Event**: STAGE_COMPLETED
**Stage**: code-generation
