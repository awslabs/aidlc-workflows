---
target: workspace-scaffold
plugin: pdlc
adds:
  scopes:
    - pdlc-discovery
---

Scope membership only — no produces, no sensors, no prose.

`pdlc-discovery` needs the record directory tree its discovery artifacts are
written into. See the sibling `workspace-detection` contribution for why plugin
scopes must claim the initialization spine explicitly.
