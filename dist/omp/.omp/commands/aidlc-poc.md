---
description: >
  Start (or continue) an AI-DLC workflow with scope `poc`. Prove feasibility fast
argument-hint: "[--depth <level>] [--test-strategy <level>] [--test-run]"
---

# AI-DLC — Scope: poc

## Step

```json
{
  "subcommand": "next",
  "args": ["--scope", "poc"],
  "tail": <$ARGUMENTS split by whitespace>
}
```

Print the resulting scope-resolution directive and continue the loop as the directive indicates.
