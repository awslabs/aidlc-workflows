---
id: required-sections
kind: deterministic
command: bun .claude/tools/aidlc-sensor.ts fire required-sections
default_severity: advisory
description: Only one sensor present; stages importing the others will throw
---

# required-sections (unknown-id fixture)

This fixture intentionally ships only one sensor. Real stages that
import linter / type-check / upstream-coverage will throw on compile.
