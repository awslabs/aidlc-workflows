---
name: workshop
depth: Standard
testStrategy: Minimal
keywords:
  - workshop
  - lab
  - training
description: Facilitated group session with mandatory gates
skeleton: on
---

# workshop scope

Standard depth for a facilitated group session with mandatory gates, but
with a Minimal test strategy — the `testStrategy` override that keeps the
test floor light for a teaching context. It runs the inception,
construction, and operation arc end to end (so participants see the whole
lifecycle) while skipping the ideation discovery stages that a facilitator
front-loads by hand.

## Why these stages, why skip those

A workshop walks a group through the methodology, so it keeps the
substantive build and operate stages visible: reverse-engineering,
practices-discovery, the full inception design pass, construction, and the
operation phase all run. It skips the early ideation ceremony
(market-research, feasibility, scope-definition, team-formation,
rough-mockups, approval-handoff) because the facilitator scopes the
exercise up front rather than running those stages live. The
`testStrategy: Minimal` override means tests are demonstrated, not held to
the production floor.

## Membership

Keyword triggers: `workshop`, `lab`, `training`. Initialization, the
inception set, all of construction, and all of operation execute; the
ideation discovery stages are SKIP.
