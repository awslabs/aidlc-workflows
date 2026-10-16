---
target: requirements-analysis
plugin: ddd
adds:
  scopes:
    - ddd-modeling
---

<!-- Frontmatter-only contribution: no prose fragments.

Puts core requirements-analysis under the ddd-modeling scope so the scope is a
runnable standalone path: init -> requirements-analysis -> ddd-domain-modeling.
requirements-analysis has no required consumes (every input is optional), so it
anchors the modeling-only engagement without pulling in the rest of Inception.
ddd-domain-modeling's required `requirements` consume is produced on-path. -->
