# Deployment Architecture

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## Unit

[Unit name]

## Compute

| Component | Compute type | Sizing | Scaling trigger |
|---|---|---|---|
| [component] | [Lambda/ECS/EC2/Fargate/etc.] | [memory, CPU, concurrency] | [what triggers scale] |

## Networking

| Element | Configuration |
|---|---|
| VPC / Subnet | [placement] |
| Load balancer | [type, listeners] |
| Security groups | [inbound/outbound rules summary] |
| DNS | [routing] |

## Deployment

| Aspect | Choice |
|---|---|
| Strategy | [rolling / blue-green / canary] |
| IaC tool | [CDK / Terraform / CloudFormation / other] |
| Pipeline | [CI/CD approach] |
| Rollback | [how to recover from bad deploy] |
