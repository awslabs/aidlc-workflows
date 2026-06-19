---
description: >
  Start (or continue) an AI-DLC workflow with scope `feature`. Default for new features, practical depth
argument-hint: "[--depth <level>] [--test-strategy <level>] [--test-run]"
---

# AI-DLC — Scope: feature

## Step

```json
{
  "subcommand": "next",
  "args": ["--scope", "feature"],
  "tail": <$ARGUMENTS split by whitespace>
}
```

Print the resulting scope-resolution directive and continue the loop as the directive indicates.
