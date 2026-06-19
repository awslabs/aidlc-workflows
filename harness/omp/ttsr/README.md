# OMP TTSR Rules for AI-DLC

This directory holds **time-traveling stream rules** for oh-my-pi — regex triggers that
watch the model's live output and abort/abort-and-inject when a rule fires.

The shipped framework ships blank. Future project-specific rules (e.g. "refuse to add
`eval()` to production paths") belong here. Rule shape:

```
---
description: One-line description shown in /extensions
condition: regex-trigger-on-the-model-stream
scope: text | tool:edit(*.ts) | tool:bash | ...
---

Body injected as a system reminder when the condition fires.
```

See https://omp.sh/docs/ttsr for the full schema and worked example.
