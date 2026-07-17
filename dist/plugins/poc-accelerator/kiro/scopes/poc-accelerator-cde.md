---
name: poc-accelerator-cde
plugin: poc-accelerator
depth: Minimal
keywords:
  - pocx
  - poc cde
  - cde poc
  - poc accelerator
  - customer poc
  - customer prototype
  - poc delivery
description: Deliver a customer-facing, CDK-deployed proof of concept in eight focused steps
skeleton: off
runner: true
---

# poc-accelerator-cde scope

A customer-delivery proof of concept for a 3–5 working-day engagement,
aligned with the CDE (Customer Development Engineering) working model. It is
intentionally distinct from core `poc`: core `poc` is a disposable feasibility
spike, whereas this scope produces a running demo, a TypeScript CDK deployment
package, an architecture decision record, and production-extension advice.

## Why these stages, why skip those

The eight dedicated stages mirror the CDE flow: agree scope, design a small
solution, prepare an AWS environment, demonstrate a walking skeleton, expand
only the validated core flow, test it, deploy it through CDK, and hand it over.
It deliberately omits the full production lifecycle, compliance assessment,
and enterprise operational design. Those are follow-on `feature` or
`enterprise` work, not shortcuts to production readiness.

## Membership

Use `/aidlc --scope poc-accelerator-cde <customer scenario>` after composing
and selecting the `poc-accelerator` plugin — or simply `/aidlc pocx <scenario>`
/ `/aidlc poc cde <scenario>`, which route here via keyword inference. The
eight `poc-accelerator-*` stages execute in order; framework Initialization
stages remain the engine preamble and are not part of the customer-facing
eight-step flow.
