# Infrastructure Specification

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## Service Mapping

| Blueprint ID | Logical Component | Service | Provider | Rationale | NFR Satisfied |
|---|---|---|---|---|---|
| CMP-001 | [from nfr-specification patterns/tech-stack] | [actual service] | [AWS/Azure/GCP/other] | [why this service] | [NFR-n] |

## Compute

| Blueprint ID | Component | Compute type | Sizing | Scaling approach |
|---|---|---|---|---|
| CMP-001 | [what runs] | [container/serverless/VM/etc.] | [size rationale] | [how it scales] |

## Network Topology

| Zone | Contains | Access |
|---|---|---|
| [public / private / isolated] | [what lives here] | [what can reach it] |

## Security Boundaries

| Boundary | Enforcement | Secrets approach |
|---|---|---|
| [what's protected] | [how access is controlled] | [how secrets are managed] |

## Observability

| Concern | Approach | Tooling |
|---|---|---|
| [logging / metrics / tracing / alerting] | [strategy] | [service/tool] |

## Deployment Strategy

| Aspect | Decision | Rationale |
|---|---|---|
| IaC tool | [CDK/Terraform/Pulumi/other] | [why] |
| Deploy method | [rolling/blue-green/canary] | [why] |
| Rollback | [how to recover] | [RTO expectation] |

## Copied Blueprint Expansions

| Blueprint ID | Expansion Target | Infrastructure Detail Added |
|---|---|---|
| CMP-001 | components.yaml | [compute/storage/network/IAM/observability mapping added] |
| UNIT-001 | unit.md | [deployment topology, runtime config, IaC references added] |
