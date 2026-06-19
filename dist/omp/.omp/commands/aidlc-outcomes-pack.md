---
description: >
  Pack the AI-DLC session outcomes into OUTCOMES.md.
  Classified `read-only` for workflow state (never advances stage pointer,
  never emits audit events) but does write the OUTCOMES.md output file.
argument-hint: ""
---

# AI-DLC — outcomes pack

Opt-in packaging over `/aidlc --outcomes-pack`; the same output is always reachable via that flag.

## Step

```json
{
  "subcommand": "summary",
  "mode": "aidlc-outcomes-pack"
}
```

Print the tool's stdout verbatim and stop.
