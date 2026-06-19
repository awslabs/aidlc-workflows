---
description: >
  Start (or continue) an AI-DLC workflow with scope `infra`. Infrastructure changes
argument-hint: "[--depth <level>] [--test-strategy <level>] [--test-run]"
---

# AI-DLC — Scope: infra

## Step

```json
{
  "subcommand": "next",
  "args": ["--scope", "infra"],
  "tail": <$ARGUMENTS split by whitespace>
}
```

Print the resulting scope-resolution directive and continue the loop as the directive indicates.
