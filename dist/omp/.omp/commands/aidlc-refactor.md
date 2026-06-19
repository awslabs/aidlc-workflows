---
description: >
  Start (or continue) an AI-DLC workflow with scope `refactor`. Clean up existing code
argument-hint: "[--depth <level>] [--test-strategy <level>] [--test-run]"
---

# AI-DLC — Scope: refactor

## Step

```json
{
  "subcommand": "next",
  "args": ["--scope", "refactor"],
  "tail": <$ARGUMENTS split by whitespace>
}
```

Print the resulting scope-resolution directive and continue the loop as the directive indicates.
