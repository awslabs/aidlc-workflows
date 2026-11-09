---
name: infra
depth: Standard
keywords:
  - infrastructure
  - deploy
  - infra
description: Infrastructure changes
skeleton: on
guard_policy: off
sensors: on
learnings: on
summary_confirmation: on
plan_approval: on
collaborators: off
---

# infra scope

Standard depth for infrastructure changes. It is the one scope whose path
leans on the back half of the graph: it skips ideation and the
product-design inception and construction stages, and instead runs
practices-discovery, the NFR design pass, infrastructure-design,
code-generation and build-and-test for the IaC, the CI pipeline, and the full
deployment + observability set in operation.

Guard Policy defaults to off: provisioning and deployment inputs that move after approval are recorded and announced rather than reopening approval; plan approval, review freeze, state transition, and reviewer read scope are lowered for undirected work. Human presence stays up.

## Why these stages, why skip those

Infrastructure work is not about product features, so ideation,
user-stories, domain-design, units-generation, and functional-design
are skipped. It is about how the system is provisioned and run, so the
operation stages (deployment-pipeline, environment-provisioning,
deployment-execution, observability-setup) plus the NFR and
infrastructure design that feed them are EXECUTE.

The IaC itself (CDK, Terraform, CloudFormation) is code, so code-generation
writes it, under the person's Plan Approval, from the infrastructure design.
It runs as one zero-Unit pass because units-generation is skipped.
build-and-test then runs the IaC's static checks and tests. Infrastructure
Design only describes the infrastructure, and Environment Provisioning only
applies the IaC that code-generation wrote; neither authors it.

This is the only scope where `reverse-engineering` is SKIP — infra changes start from the
deployment topology, not the application source — and the only non-
enterprise/feature scope that runs the operation phase.

## Membership

Keyword triggers: `infrastructure`, `deploy`, `infra`. Initialization,
practices-discovery, requirements-analysis, the NFR + infrastructure
design stages, code-generation, build-and-test, ci-pipeline, and the
deployment/provisioning/observability operation stages execute.
