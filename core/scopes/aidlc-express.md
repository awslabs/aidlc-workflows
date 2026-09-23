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
guard_policy: relaxed
sensors: off
learnings: off
summary_confirmation: off
---

# express scope

`express` answers the community request for a lightweight run. It follows a
straight line from requirements to code, test, and deploy without a design
pass or reviewer dispatch.

Guard Policy defaults to relaxed: changed inputs are recorded and announced rather than reopening approval; plan approval and review freeze are lowered for undirected work.

Sensors, learnings, and summary confirmation are off too; override them per intent
with `/aidlc --sensors on|off`, `/aidlc --learnings on|off`, or
`/aidlc --summary-confirmation on|off`.

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
