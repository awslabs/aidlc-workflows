---
slug: poc-accelerator-step-04-walking-skeleton
number: 3.81
name: PoC Walking Skeleton
plugin: poc-accelerator
phase: construction
execution: ALWAYS
condition: Always executes after environment readiness to demonstrate one complete end-to-end slice.
lead_agent: aidlc-developer-agent
support_agents:
  - aidlc-architect-agent
  - aidlc-quality-agent
mode: inline
workspace_requires: true
produces:
  - poc-accelerator-skeleton-demo
  - poc-accelerator-skeleton-review
consumes:
  - artifact: poc-accelerator-solution-design
    required: true
  - artifact: poc-accelerator-environment-readiness
    required: true
  - artifact: poc-accelerator-acceptance-criteria
    required: true
requires_stage:
  - poc-accelerator-step-03-environment-readiness
sensors:
  - linter
  - type-check
  - required-sections
  - upstream-coverage
scopes:
  - poc-accelerator-cde
inputs: Approved design, ready environment, and acceptance criteria
outputs: Working end-to-end source code plus poc-accelerator-skeleton-demo.md and poc-accelerator-skeleton-review.md (under this stage's record dir, engine-resolved)
---

# PoC Walking Skeleton

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Select One Vertical Slice

Load the developer, architecture, and quality personas. Choose the smallest
customer-visible path that crosses the planned application and CDK-managed AWS
boundary: one input, one business decision, one visible outcome. It must be a
real runnable slice, not a mock-only slide deck.

### Step 2: Implement and Deploy the Slice

Implement the code and infrastructure in the workspace. Use the AWS IaC MCP
server to generate and validate the CDK/CloudFormation definitions (cfn-lint
and compliance checks before deploying), and the AWS knowledge MCP server for
working code examples when a construct is unfamiliar. Add a focused automated
test, run lint/type checks and the test command, deploy through CDK, and prove
the path in the approved non-production environment — confirm the deployed
resources through the AWS API MCP server. Keep sample payloads synthetic or
masked.

### Step 3: Capture Demo Evidence

Create `poc-accelerator-skeleton-demo.md` with launch command/URL, safe sample
input, expected output, deployment reference, and test result. Create
`poc-accelerator-skeleton-review.md` with what was demonstrated, customer
feedback, and the decision to continue, change direction, or stop.

### Step 4: SA and Customer Demo Gate

Ask only:

- **Approve skeleton** — use the demonstrated path as the base for expansion.
- **Request changes** — revise the slice or solution design before expanding.

### Step 5: Update State

Mark `poc-accelerator-step-04-walking-skeleton` complete in `<record>/aidlc-state.md`.

## Sensors

Linter and type-check sensors validate workspace code. Markdown sensors validate
the demo evidence and its traceability to the design and acceptance criteria.

## Learn

Record timestamped interpretations, deviations, tradeoffs, and open questions
in `<record>/<phase>/<stage>/memory.md`. Record only generalizable lessons and
customer-approved feedback.
