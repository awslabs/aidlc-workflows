---
description: >
  Replay the AI-DLC workflow audit trail as a concise structured timeline.
  Classified `read-only`: never advances stage pointer, never emits audit events.
argument-hint: ""
---

# AI-DLC — replay audit trail

Opt-in packaging over `/aidlc --replay`; the same output is always reachable via that flag.

## Step

```json
{
  "subcommand": "summary",
  "mode": "aidlc-replay"
}
```

Print the tool's stdout verbatim and stop.
