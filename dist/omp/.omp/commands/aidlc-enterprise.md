---
description: >
  Start (or continue) an AI-DLC workflow with scope `enterprise`. Regulated enterprise feature, full audit trail
argument-hint: "[--depth <level>] [--test-strategy <level>] [--test-run]"
---

# AI-DLC — Scope: enterprise

## Step

```json
{
  "subcommand": "next",
  "args": ["--scope", "enterprise"],
  "tail": <$ARGUMENTS split by whitespace>
}
```

Print the resulting scope-resolution directive and continue the loop as the directive indicates.
