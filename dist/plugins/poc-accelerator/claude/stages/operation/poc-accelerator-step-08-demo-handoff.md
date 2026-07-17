---
slug: poc-accelerator-step-08-demo-handoff
number: 4.81
name: PoC Demo and Handoff
plugin: poc-accelerator
phase: operation
execution: ALWAYS
condition: Always executes last to obtain customer acceptance and document the production extension path.
lead_agent: aidlc-product-agent
support_agents:
  - aidlc-architect-agent
  - aidlc-pipeline-deploy-agent
mode: inline
produces:
  - poc-accelerator-demo-package
  - poc-accelerator-extension-recommendations
  - poc-accelerator-cost-projection
  - poc-accelerator-value-metrics-register
consumes:
  - artifact: poc-accelerator-step-07-deployment-log
    required: true
  - artifact: poc-accelerator-smoke-test-results
    required: true
  - artifact: poc-accelerator-architecture-diagram
    required: true
  - artifact: poc-accelerator-feature-review
    required: true
requires_stage:
  - poc-accelerator-step-07-deployment
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - poc-accelerator-cde
inputs: Deployed PoC evidence, architecture diagram, implementation review, and customer acceptance criteria
outputs: poc-accelerator-demo-package.md, poc-accelerator-extension-recommendations.md, poc-accelerator-cost-projection.md, poc-accelerator-value-metrics-register.md (under this stage's record dir, engine-resolved)
---

# PoC Demo and Handoff

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Assemble the Customer Demo

Load the product, architect, and deployment personas. Create
`poc-accelerator-demo-package.md` with the problem statement, launch steps,
safe sample input, expected result, architecture diagram reference, CDK stack
reference, test evidence, and cleanup contact.

### Step 2: Document the Production Extension Path

Create `poc-accelerator-extension-recommendations.md`. Separate achieved PoC
capabilities from production work such as authentication, resilience,
observability, data governance, cost controls, security review, and operational
ownership. Recommend a follow-on `feature` or `enterprise` workflow rather
than declaring the PoC production ready.

### Step 3: Project PoC and Production Costs

Create `poc-accelerator-cost-projection.md` with two estimates that close the
business case for the customer and the account team:

1. **PoC running cost** — enumerate the deployed CDK stack's resources (from
   the deployment log), state the pricing assumptions (region, instance sizes,
   storage volume, request rates observed during smoke testing), and estimate
   the monthly cost of keeping the PoC running as-is. Prefer the AWS pricing
   MCP server (`awslabs.aws-pricing-mcp-server`, configured per the regional
   MCP setup knowledge) for real-time Price List API quotes; fall back to AWS
   pricing pages. Cite the pricing source and the date of the quote.
2. **Production-scale projection** — state explicit scale assumptions agreed
   with the customer (users, throughput, data volume, availability target),
   list the production additions from the extension recommendations that carry
   cost (multi-AZ, monitoring, backup, security services), and project a
   monthly cost range for the production architecture. Include the main cost
   levers (savings plans, reserved capacity, serverless tiers, storage classes)
   and which assumption dominates the range.

Every figure must be labeled as an estimate with its assumptions inline. Do not
present estimates as quotes or commitments, and do not pull billing data from
customer accounts without the data owner's approval.

### Step 4: Record Value Signals Without Fabricating Business Data

Create `poc-accelerator-value-metrics-register.md` with the identifiers and
owners needed to later measure delivery duration, workshop-to-PoC conversion,
PoC-to-production conversion, deployed stack/resource inventory, estimated MRR,
and associated opportunity. It is a tracking register only: do not invent CFN,
MRR, or SFDC values, and do not integrate with customer or internal systems
without an approved connector and data owner. The estimated-MRR row may cite
the PoC running cost from `poc-accelerator-cost-projection.md` as its basis,
clearly labeled as an estimate.

### Step 5: Customer Acceptance Gate

Ask only:

- **Accept handoff** — record the demo result, extension path, cost projection, and owner.
- **Request changes** — return to the relevant approved PoC stage with a bounded request.

### Step 6: Update State

Mark `poc-accelerator-step-08-demo-handoff` complete in `<record>/aidlc-state.md`.

## Sensors

The Markdown sensors ensure handoff artifacts cite the deployed evidence,
architecture, and implementation review.

## Learn

Maintain timestamped interpretations, deviations, tradeoffs, and open questions
in `<record>/<phase>/<stage>/memory.md`. Customer-specific knowledge belongs in
project space memory only after approval.
