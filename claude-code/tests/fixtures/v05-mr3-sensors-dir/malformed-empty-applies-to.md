---
id: malformed-empty-applies-to
kind: deterministic
command: bun .claude/tools/aidlc-sensor.ts fire malformed-empty-applies-to
applies_to: {}
default_severity: advisory
description: Negative-case fixture — applies_to has no base shape
category: document-shape
icon: ❌
timeout_seconds: 5
---

# malformed-empty-applies-to sensor

Negative-case fixture for `tests/unit/t86-sensor-manifest-schema.sh`.
Carries `applies_to: {}` — schema rejects (no base shape; manifest
matches no stages and is unrunnable).
