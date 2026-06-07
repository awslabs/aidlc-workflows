# Infrastructure Specification

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## Service Mapping

| Logical Component | Service | Provider | Rationale | NFR Satisfied |
|---|---|---|---|---|
| [from nfr-specification patterns/tech-stack] | [actual service] | [AWS/Azure/GCP/other] | [why this service] | [NFR-n] |

## Compute

| Component | Compute type | Sizing | Scaling approach |
|---|---|---|---|
| [what runs] | [container/serverless/VM/etc.] | [size rationale] | [how it scales] |

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
