---
target: workspace-detection
plugin: pdlc
adds:
  scopes:
    - pdlc-discovery
---

Scope membership only — no produces, no sensors, no prose.

Core's initialization stages enumerate the core scopes explicitly, so a
plugin-shipped scope has no initialization spine until its stages are
set-unioned in. Without this, `/aidlc pdlc-discovery` resolves to a plan with
no workspace detection, no state file, and no scaffold — the discovery stages
would run with nowhere to write.

`adds.scopes` merges `pdlc-discovery` into this stage's membership list. Core's
own nine scopes are untouched; set-union is additive and commutative, so this
stays correct however many other plugins do the same thing.
