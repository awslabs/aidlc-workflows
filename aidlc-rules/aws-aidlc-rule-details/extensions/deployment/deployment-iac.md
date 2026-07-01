# Deployment — Infrastructure as Code Rules

## Overview
These rules define **how** to implement Infrastructure as Code for deployable services. They implement DEPLOY-STRAT-001 from `extensions/deployment/deployment-baseline.md`.

**Applies when**: Deployment extension is active (Answer A or B).

**Prefix**: `DEPLOY-IAC-`

---

### Rule DEPLOY-IAC-001: IaC Must Be Generated as Part of Code Generation

**Rule**: The code generation plan MUST include an explicit IaC generation step. IaC is not a post-construction activity — it is generated alongside application code as part of the same workflow.

The model MUST determine the appropriate IaC tool from the tech stack (specified in tech-env.md or chosen during NFR Design). The IaC tool is not prescribed — it is derived:
- If tech-env.md specifies a tool (e.g. AWS CDK), use it
- If not specified, evaluate the architecture and choose the tool that best fits (CDK for AWS-native, Terraform for multi-cloud, CloudFormation for simple stacks)
- Document the choice and rationale in the NFR design artifacts

**Verification**:
- IaC generation is a named step in the code generation plan
- IaC files exist in the workspace in a dedicated directory (e.g. `infra/`, `cdk/`, `terraform/`)
- The IaC tool choice is documented with rationale

**Customer Validation** (only when IaC tool is not specified in tech-env.md): The model MUST present the derived IaC tool choice for customer approval.

```markdown
## Question: IaC Tool Selection

No IaC tool was specified in tech-env.md. Based on the architecture, the
following IaC tool has been selected:

**Proposed tool**: [tool]
**Rationale**: [why this tool best fits the architecture]

A) Approve — proceed with this IaC tool
B) Modify — I want a different tool (describe after [Answer]: tag)
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

---

### Rule DEPLOY-IAC-002: IaC Must Cover All Deployable Resources

**Rule**: IaC MUST define all AWS resources required by the service. No resource should exist only in the AWS console — every resource must be reproducible from IaC.

**IaC MUST include at minimum**:
- Compute resources (Lambda functions, ECS services, EC2 ASGs, EKS node groups)
- Data resources (DynamoDB tables, RDS instances, S3 buckets, ElastiCache clusters)
- API and networking layer (API Gateway, ALB/NLB, VPC, subnets, security groups)
- IAM roles and policies with least-privilege permissions per service
- CloudWatch alarms (aligned to NFR design — the same alarms used for observability and deployment gates)
- CloudWatch log groups with retention policies
- SNS topics for alarm notifications
- Deployment configuration (CodeDeploy deployment groups, ECS service deployment settings, Lambda aliases)

**For multi-region deployments**: Separate IaC stacks MUST be created per region. Globally-scoped resources (CloudFront, Route 53) MUST be in a dedicated global stack.

**Verification**:
- All AWS resources from the infrastructure design are represented in IaC
- IAM roles are defined with least-privilege permissions
- CloudWatch alarms from NFR design are implemented in IaC
- Deployment configuration is in IaC (not manual console configuration)

---

### Rule DEPLOY-IAC-003: IaC Must Be Parameterised for Environment Parity

**Rule**: IaC MUST use parameters or environment-specific configuration for values that differ between environments (table names, alarm thresholds, concurrency limits, instance sizes). Values MUST NOT be hardcoded for a specific environment.

**Why**: Hardcoded environment-specific values prevent the same IaC from being used across environments, breaking DEPLOY-STRAT-005 (pipeline parity).

**Verification**:
- IaC accepts environment parameters (not hardcoded environment-specific values)
- The same IaC definition can be deployed to multiple environments with different parameter values

---

### Rule DEPLOY-IAC-004: Runtime Dependencies Must Be Expressed in IaC

**Rule**: Every runtime dependency that a deployed resource requires to function MUST be expressed within IaC. The IaC tool MUST resolve dependency ordering automatically through its dependency graph — no external ordering mechanism should be required.

- **Express in IaC IF**: The dependency can be created, configured, or populated using the IaC tool's native constructs or custom resource mechanisms (e.g. CDK custom resources, Terraform provisioners, CloudFormation custom resources). This includes: secret creation, parameter writes, test identity provisioning, seed data population, schema creation.
- **Script fallback IF**: The dependency is technically impossible to express in IaC — e.g. requires multi-step interactive logic, depends on runtime output that cannot be predicted at synthesis time, or requires tooling not available in the IaC execution context. This MUST be documented with a justification explaining why IaC cannot express it.

**Dependency management across stacks/templates**: When multiple IaC stacks/modules exist, the model MUST express cross-stack dependencies explicitly so the IaC tool deploys them in the correct order. A resource in Stack B that depends on an output from Stack A MUST declare that dependency. Silent ordering assumptions are not acceptable.

**When scripts are used (fallback)**:
- The script MUST be generated by Construction and committed to the workspace
- The justification for why IaC cannot express this dependency MUST be documented in the NFR design artifacts
- The pipeline MUST include a Provisioning step that executes the script after IaC deployment and before the Test stage (DEPLOY-PIPE-008)
- The pipeline Test stage (DEPLOY-PIPE-012) MUST NOT execute until all provisioning scripts complete

**Verification**:
- Every runtime dependency identified in DEPLOY-COMP-001 is expressed in IaC OR has a documented justification for script fallback
- Cross-stack dependencies are explicitly declared (not implicit ordering)
- No deployed resource fails on first execution due to a missing dependency that should have been provisioned by IaC
- If provisioning scripts exist, they have documented justification and the pipeline includes a Provisioning step

**Cross-references**:
- DEPLOY-COMP-001 (every runtime dependency identified and provisioned)
- DEPLOY-COMP-002 (everything DLC builds gets deployed)
- DEPLOY-PIPE-008 (pipeline stage ordering includes Provisioning step if scripts exist)
- DEPLOY-PIPE-012 (Test stage validates dependencies are satisfied)
