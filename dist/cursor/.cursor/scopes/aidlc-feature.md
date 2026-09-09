---
name: feature
depth: Standard
keywords: []
description: Full lifecycle for new features, practical depth
skeleton: on
runner: true
change_control: relaxed
---

# feature scope

The full-lifecycle scope for new feature work at practical depth. Like
`enterprise`, it runs every stage in the graph, but the stage bodies apply
Standard rather than Comprehensive depth — lighter ceremony, the same
end-to-end coverage from ideation through operation.

Change Control defaults to relaxed: an input that changes after approval is recorded and announced in one line, and the run continues.

## Why every stage

A new feature still needs the full arc: understand the problem
(ideation), design it (inception), build and test it (construction), and
operate it (operation). `feature` keeps all of those so nothing silently
drops. The difference from `enterprise` is depth, expressed in the stage
bodies and the org/team rule layers, not in which stages run.

## Membership

`feature` marks all 33 stages EXECUTE. It remains the implicit freeform fallback
and is also available through `--scope feature` and the `/aidlc-feature` runner.
There are no keyword triggers of its own.
