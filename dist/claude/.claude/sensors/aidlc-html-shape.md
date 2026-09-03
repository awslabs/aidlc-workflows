---
id: html-shape
kind: deterministic
command: bun .claude/tools/aidlc-sensor-html-shape.ts
default_severity: advisory
fire_on: gate
description: Checks HTML stage outputs follow the offline artifact authoring contract
category: document-shape
matches: "**/{aidlc-docs,intents}/**"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  findings: string[]
  scanned_files: string[]
  findings_count: integer
  reason: string
timeout_seconds: 5
---

# html-shape sensor

Checks every `.html` output beside the fired stage artifact against the HTML
artifact authoring contract. It passes when the stage has no HTML outputs, so
Markdown-only intents keep their existing behavior.

The check requires the doctype, document language, title and AIDLC identity
metadata, and a leading summary section. It rejects external or parent-path
resources, forms with actions, embedded browsing contexts, and a review section
that is not the final body element.

## Failure mode

Findings are advisory and identify both the artifact filename and the violated
contract rule. The sensor dispatcher records failures under the active intent's
`.aidlc-sensors/<stage-slug>/` directory.
