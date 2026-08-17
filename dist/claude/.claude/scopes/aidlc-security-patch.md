---
name: security-patch
depth: Minimal
keywords:
  - security
  - CVE
  - vulnerability
  - patch
description: CVE response
skeleton: off
runner: true
---

# security-patch scope

Minimal depth for responding to a CVE or vulnerability fast. It threads a
narrow path: understand the code (reverse-engineering), state what the
patch must do (requirements-analysis), capture the security constraint
(nfr-requirements), fix and test (code-generation, build-and-test), then
ship through the deployment stages so the patch actually reaches
production.

## Why these stages, why skip those

A security patch is urgent, incremental, and must deploy. It skips the
whole design ceremony (ideation, domain-design, units-generation,
nfr-design, infrastructure-design) because the change is targeted, but
unlike `bugfix` it keeps deployment-pipeline and deployment-execution
EXECUTE — a patch that never deploys does not close the vulnerability.
requirements-analysis runs so there is an auditable statement of the
vulnerability and its remediation criteria (the `requirements` artifact
nfr-requirements and code-generation consume), and nfr-requirements runs
so the security constraint is recorded. One of the three incremental
scopes that skip the walking-skeleton ceremony.

## Membership

Keyword triggers: `security`, `CVE`, `vulnerability`, `patch`.
Initialization, reverse-engineering, requirements-analysis,
nfr-requirements, code-generation, build-and-test, deployment-pipeline,
and deployment-execution execute; the rest is SKIP.
