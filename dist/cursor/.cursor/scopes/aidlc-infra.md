---
name: infra
depth: Standard
keywords:
  - infrastructure
  - deploy
  - infra
description: Infrastructure changes
skeleton: on
---

# infra scope

Standard depth for infrastructure changes. It is the one scope whose path
leans on the back half of the graph: it skips ideation and the
application-code construction stages, and instead runs practices-discovery,
the NFR design pass, infrastructure-design, the CI pipeline, and the full
deployment + observability set in operation.

## Why these stages, why skip those

Infrastructure work is not about product features, so ideation,
user-stories, domain-design, units-generation, and code-generation
are skipped. It is about how the system is provisioned and run, so the
operation stages (deployment-pipeline, environment-provisioning,
deployment-execution, observability-setup) plus the NFR and
infrastructure design that feed them are EXECUTE. This is the only scope
where `reverse-engineering` is SKIP — infra changes start from the
deployment topology, not the application source — and the only non-
enterprise/feature scope that runs the operation phase.

## Membership

Keyword triggers: `infrastructure`, `deploy`, `infra`. Initialization,
practices-discovery, requirements-analysis, the NFR + infrastructure
design stages, ci-pipeline, and the deployment/provisioning/observability
operation stages execute.
