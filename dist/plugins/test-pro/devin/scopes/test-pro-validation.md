---
name: test-pro-validation
plugin: test-pro
depth: Comprehensive
keywords:
  - validation
  - test validation
  - regression validation
description: Run the test-pro validation stages
skeleton: off
runner: true
---

# test-pro-validation scope

Comprehensive depth for exercising the test-pro plugin's validation path. It
runs the cross-unit integration stage during construction and the full deployed
suite during operation, so a project can prove both assembled-unit behavior and
post-deploy regression coverage.

## Why these stages, why skip those

This scope is focused on validation evidence rather than product discovery or
implementation. The two test-pro stages complement the core path: integration
testing checks cross-unit seams after build-and-test, and full-suite execution
checks deployed behavior after deployment.

## Membership

Keyword triggers: `validation`, `test validation`, `regression validation`.
`test-pro-integration` and `test-pro-full-suite` execute when their plugin stage
membership includes this scope; unrelated stages remain governed by their own
scope lists.
