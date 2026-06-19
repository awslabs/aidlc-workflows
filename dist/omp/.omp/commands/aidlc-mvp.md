---
description: >
  Start (or continue) an AI-DLC workflow with scope `mvp`. Skip operations, ship the core
argument-hint: "[--depth <level>] [--test-strategy <level>] [--test-run]"
---

# AI-DLC — Scope: mvp

## Step

```json
{
  "subcommand": "next",
  "args": ["--scope", "mvp"],
  "tail": <$ARGUMENTS split by whitespace>
}
```

Print the resulting scope-resolution directive and continue the loop as the directive indicates.
