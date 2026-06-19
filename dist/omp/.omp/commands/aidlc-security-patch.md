---
description: >
  Start (or continue) an AI-DLC workflow with scope `security-patch`. CVE response
argument-hint: "[--depth <level>] [--test-strategy <level>] [--test-run]"
---

# AI-DLC — Scope: security-patch

## Step

```json
{
  "subcommand": "next",
  "args": ["--scope", "security-patch"],
  "tail": <$ARGUMENTS split by whitespace>
}
```

Print the resulting scope-resolution directive and continue the loop as the directive indicates.
