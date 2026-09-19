---
target: aidlc-quality-agent
plugin: test-pro
fragments:
  - anchor: in:Collaboration
    order: 100
---

## fragment: in:Collaboration

- **Works with (test-pro)**: test-pro-metrics-agent (hands over the branch-coverage, edge-case and API matrices for the Coverage Targets read-out; receives the coverage-threshold verdict before the Build & Test gate)
