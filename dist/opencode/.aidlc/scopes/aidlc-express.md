---
name: express
depth: Minimal
keywords:
  - express
  - lightweight
description: "Lightest run: requirements to deploy, no design pass, no reviewers"
skeleton: off
runner: true
review_cap: none
---

# express scope

`express` answers the community request for a lightweight run. It follows a
straight line from requirements to code, test, and deploy without a design
pass or reviewer dispatch.

## Why these stages, why skip those

Requirements Analysis establishes the contract, Code Generation implements
it, Build and Test verifies it, and the Operation tail can deploy and observe
the result. Reviewers are disabled by `review_cap: none`. Minimal testing still
requires requirement-driven unit tests with a happy-path floor per component.

The swarm path is structurally unreachable because `express` skips Units
Generation, so no Unit DAG can exist. Reverse Engineering remains CONDITIONAL
to provide brownfield understanding when existing code is present. The deploy
tail is also CONDITIONAL and self-skips when there is nothing to deploy. Its
stages use the approved requirements, workspace deployment configuration, build
results, and prior tail artifacts when full design producers are intentionally
absent.

## Membership

The grid contains the three Initialization stages, Reverse Engineering,
Requirements Analysis, Code Generation, Build and Test, Deployment Pipeline,
Deployment Execution, and Observability Setup. Every other stage is SKIP.
