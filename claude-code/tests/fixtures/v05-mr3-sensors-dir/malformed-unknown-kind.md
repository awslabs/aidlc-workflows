---
id: malformed-unknown-kind
kind: arbitrary-bogus
command: bun .claude/tools/aidlc-sensor.ts fire malformed-unknown-kind
applies_to:
  all_stages: true
default_severity: advisory
description: Negative-case fixture — kind value is not in the v0.5.0 enum
category: document-shape
icon: ❌
timeout_seconds: 5
---

# malformed-unknown-kind sensor

Negative-case fixture for `tests/unit/t86-sensor-manifest-schema.sh`.
Carries `kind: arbitrary-bogus` — schema rejects.

Deliberately NOT `kind: llm` — `llm` is reserved for v0.11.0; using it
here would bake a forward-incompatibility into the test, blocking the
v0.11.0 LLM-dispatch PR from being added without test-spec churn.
