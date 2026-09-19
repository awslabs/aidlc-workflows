---
target: aidlc-quality-agent
plugin: test-pro
fragments:
  - anchor: after-preflight
    order: 90
  - anchor: in:Collaboration
    order: 100
---

## fragment: after-preflight

**test-pro coverage read-out (mandatory):** before designing or reviewing tests, read the Coverage Targets recorded by the `nfr-requirements` contribution; every test plan states which target each suite serves.

## fragment: in:Collaboration

- **Works with (test-pro)**: test-pro-metrics-agent (hands over the branch-coverage, edge-case and API matrices for the Coverage Targets read-out; receives the coverage-threshold verdict before the Build & Test gate)
