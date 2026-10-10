---
name: retrospective-ceremony
plugin: retrospective
depth: Standard
keywords:
  - retrospective
  - retrospective ceremony
  - code documentation
  - lessons learned
description: Turn on the optional end-of-delivery retrospective ceremony
skeleton: off
runner: true
---

# retrospective-ceremony scope

Opt in to the retrospective ceremony. A team that wants an end-of-delivery
retrospective selects the `retrospective` plugin and runs under this scope; the
`retrospective` stage is then on the plan near the end of Operation. Every other
install is byte-identical to bare core and meets no new gate — selecting the
plugin without this scope composes the stage but leaves it SKIP.

This scope is the opt-in switch itself: there is no separate "ceremony on/off"
flag to set. Not selecting it is "off".
