---
name: mabl-verification-validation
plugin: mabl-verification
display_name: mabl Verification Validation
description: >
  A focused scope that activates all mabl-verification plugin stages for validating
  the plugin itself or running a mabl-centric verification workflow. Includes the
  core construction and operation stages plus all three mabl-verification stages.
  Use this scope when the primary goal is exercising the mabl verification loop
  end-to-end (pre-PR matching, coverage gap analysis, and ship gating) without
  the full enterprise/feature lifecycle overhead.
phases:
  initialization:
    - project-bootstrap
    - workspace-scan
    - workflow-planning
  ideation:
    - SKIP
  inception:
    - SKIP
  construction:
    - code-implementation
    - build-and-test
    - mabl-verification-pre-pr
    - mabl-verification-coverage-gap
  operation:
    - mabl-verification-ship-gate
depth: Standard
test_strategy: Standard
---

# mabl Verification Validation Scope

A lightweight scope designed for two use cases:

1. **Plugin validation** — verifying the mabl-verification plugin itself works
   correctly after installation or upgrade. Exercises all three plugin stages
   against a real codebase with real mabl tests.

2. **mabl-centric workflows** — when the primary goal is test verification (not
   full feature ideation/design). Skips Ideation and Inception entirely, runs a
   minimal Construction (implement + build + mabl verify), and gates ship.

## When to use

- After installing/upgrading the mabl-verification plugin: `/aidlc --scope mabl-verification-validation`
- For hotfixes or small changes where the only validation needed is "do the mabl tests still pass?"
- When testing the plugin's integration with a new mabl workspace

## Stage flow

```
project-bootstrap → workspace-scan → workflow-planning
  → code-implementation → build-and-test → mabl-verification-pre-pr
  → mabl-verification-coverage-gap (conditional)
  → mabl-verification-ship-gate
```

## Prerequisites

- mabl CLI installed and authenticated
- mabl MCP server connected
- At least one mabl test in the workspace covering the application under development
- A running local dev server for test execution
