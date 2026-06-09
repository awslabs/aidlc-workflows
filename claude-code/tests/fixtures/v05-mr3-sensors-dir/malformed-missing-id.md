---
kind: deterministic
command: bun .claude/tools/aidlc-sensor.ts fire malformed-missing-id
applies_to:
  all_stages: true
default_severity: advisory
description: Negative-case fixture — id field is missing
category: document-shape
icon: ❌
timeout_seconds: 5
---

# malformed-missing-id sensor

Negative-case fixture for `tests/unit/t86-sensor-manifest-schema.sh`.
Frontmatter omits the required `id:` field — schema rejects.
