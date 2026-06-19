# AIDLC Rules for oh-my-pi

This directory maps onto omp's `rules/` discovery surface. At the omp layer, rules
are TTSR-style regex triggers — frontmatter `condition:` + body + `scope:`.

The shipped framework keeps this directory as a placeholder. Project-specific rules
the team wants enforced on every turn go here. The layered rule system (org/team/
project/phase/stage) lives under `aidlc-common/rules/` and is exported by the engine
into `RULES.md` (always-apply prose on every turn).

Rule shape:

```
---
description: One-line summary shown in /extensions
condition: regex-trigger-on-the-model-stream
scope: text | tool:edit(*.ts) | tool:bash | ...
---

Body injected as a system reminder when the condition fires.
```

See https://omp.sh/docs/ttsr for the full schema and worked example, and
`docs/harness/02-rules.md` for the merge order and conflict-resolution rules.
