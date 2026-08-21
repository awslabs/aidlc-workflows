---
target: state-init
plugin: pdlc
adds:
  scopes:
    - pdlc-discovery
---

Scope membership only — no produces, no sensors, no prose.

`pdlc-discovery` needs the state file every other stage reads and reports
against. See the sibling `workspace-detection` contribution for why plugin
scopes must claim the initialization spine explicitly.
