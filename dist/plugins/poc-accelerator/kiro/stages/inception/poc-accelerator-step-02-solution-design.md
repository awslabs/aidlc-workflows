---
slug: poc-accelerator-step-02-solution-design
number: 2.81
name: PoC Solution Design
plugin: poc-accelerator
phase: inception
execution: ALWAYS
condition: Always executes after the customer approves the delivery boundary.
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-product-agent
  - aidlc-pipeline-deploy-agent
mode: inline
produces:
  - poc-accelerator-solution-design
  - poc-accelerator-cdk-stack-plan
  - poc-accelerator-architecture-diagram
consumes:
  - artifact: poc-accelerator-requirements-brief
    required: true
  - artifact: poc-accelerator-acceptance-criteria
    required: true
  - artifact: poc-accelerator-domain-knowledge-capture
    required: false
requires_stage:
  - poc-accelerator-step-01-requirements-capture
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - poc-accelerator-cde
inputs: Approved delivery brief, acceptance criteria, and validated domain knowledge
outputs: poc-accelerator-solution-design.md, poc-accelerator-cdk-stack-plan.md, poc-accelerator-architecture-diagram.md (under this stage's record dir, engine-resolved)
---

# PoC Solution Design

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Inputs and Methodology

Load `aidlc-architect-agent`, the CDK patterns, and the approved requirements
artifacts. Trace every design choice to an acceptance criterion; do not invent a
production-grade capability outside the agreed PoC boundary. Ground service
selection in tool evidence, not memory: confirm regional/partition availability
with the AWS documentation MCP server and pull reference architectures and code
examples from the AWS knowledge MCP server (regional mapping per the MCP setup
knowledge).

### Step 2: Design the Smallest Demonstrable Architecture

Create `poc-accelerator-solution-design.md` with the end-to-end request flow,
trust boundaries, data classification, component responsibilities, and explicit
non-goals. Prefer managed AWS services that make the walkthrough observable and
removable after the engagement.

### Step 3: Define the CDK Stack Plan

Create `poc-accelerator-cdk-stack-plan.md` listing every planned TypeScript CDK
stack/resource, environment assumptions, outputs, deployment command, cost
watchpoints, and cleanup command. Quantify the cost watchpoints with the AWS
pricing MCP server (real-time Price List quotes for the target region and
partition) so the customer sees an order-of-magnitude PoC cost before building.
All infrastructure must be represented in CDK; no manual console-only resource
is an accepted path.

### Step 4: Render the Architecture Diagram

Create `poc-accelerator-architecture-diagram.md` using Mermaid or a clear text
diagram. Include the customer-facing flow and the CDK-managed AWS boundary.

### Step 5: SA Design Gate

Ask only:

- **Approve design** — proceed with the agreed stack plan.
- **Request changes** — revise architecture, service selection, or deployment boundary.

### Step 6: Update State

Mark `poc-accelerator-step-02-solution-design` complete in `<record>/aidlc-state.md`.

## Sensors

The upstream-coverage sensor verifies the design cites the approved requirements
and acceptance criteria. The required-sections sensor keeps each design
artifact scannable.

## Learn

Record timestamped design interpretations, deviations, tradeoffs, and open
questions in `<record>/<phase>/<stage>/memory.md`. Promote reusable CDK lessons
only when they contain no customer confidential information.
