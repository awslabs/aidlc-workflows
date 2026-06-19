---
description: >
  Start (or continue) an AI-DLC workflow with scope `workshop`. Facilitated group session with mandatory gates
argument-hint: "[--depth <level>] [--test-strategy <level>] [--test-run]"
---

# AI-DLC — Scope: workshop

## Step

```json
{
  "subcommand": "next",
  "args": ["--scope", "workshop"],
  "tail": <$ARGUMENTS split by whitespace>
}
```

Print the resulting scope-resolution directive and continue the loop as the directive indicates.
