---
description: >
  Print per-phase and total session token/cost summary. Classified `read-only`: pulls every count from the aidlc runtime tool
  (no LLM-side counting). Never advances the workflow stage pointer. Never emits audit events.
argument-hint: ""
---

# AI-DLC — session cost

Opt-in packaging over `/aidlc --session-cost`; the same output is always reachable via that flag without this command.

## Step

```json
{
  "subcommand": "summary",
  "mode": "aidlc-session-cost"
}
```

Print the tool's stdout verbatim and stop.
