---
id: html-shape
kind: deterministic
command: bun .claude/tools/aidlc-sensor.ts fire html-shape
default_severity: advisory
description: HTML-shape sensor for fixture compile testing
---

# required-sections (unknown-id fixture)

This fixture intentionally ships only one sensor. Real stages that
import linter / type-check / upstream-coverage will throw on compile.
