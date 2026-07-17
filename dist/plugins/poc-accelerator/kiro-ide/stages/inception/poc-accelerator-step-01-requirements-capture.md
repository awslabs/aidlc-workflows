---
slug: poc-accelerator-step-01-requirements-capture
number: 2.80
name: PoC Requirements Capture
plugin: poc-accelerator
phase: inception
execution: ALWAYS
condition: Always executes first to establish a customer-confirmed delivery boundary.
lead_agent: aidlc-product-agent
support_agents:
  - aidlc-architect-agent
mode: inline
produces:
  - poc-accelerator-requirements-brief
  - poc-accelerator-acceptance-criteria
  - poc-accelerator-domain-knowledge-capture
consumes: []
requires_stage: []
sensors:
  - required-sections
scopes:
  - poc-accelerator-cde
inputs: Confirmed intent, customer discussion, and any approved non-production sample material
outputs: poc-accelerator-requirements-brief.md, poc-accelerator-acceptance-criteria.md, poc-accelerator-domain-knowledge-capture.md (under this stage's record dir, engine-resolved)
---

# PoC Requirements Capture

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load PoC Context

Load `aidlc-product-agent` and the PoC playbook. Read the confirmed intent,
customer-provided context, and existing project rules. Treat customer data as
restricted by default: do not request, copy, or process real production data
unless the customer and the GenAIIC (Generative AI Innovation Center)
co-creation process have explicitly approved it.

### Step 2: Capture a One-Page Delivery Brief

Create `poc-accelerator-requirements-brief.md` with the customer problem,
primary user, narrow business outcome, in-scope flow, explicit exclusions,
3–5-day time box, AWS account/region owner, and assumptions. Keep the brief
small enough to review in one customer session. Before promising a capability,
sanity-check that the candidate AWS services exist in the target region and
partition via the AWS documentation MCP server (or the AWS MCP Remote endpoint
in Global regions, per the regional MCP setup knowledge) — especially for
aws-cn, where service availability differs.

### Step 3: Define Observable Acceptance

Create `poc-accelerator-acceptance-criteria.md` with measurable demo outcomes:
inputs, expected behavior, visible result, test evidence, and the named
customer approver. Separate a PoC success signal from a production requirement.

### Step 4: Capture and Validate Domain Knowledge

Create `poc-accelerator-domain-knowledge-capture.md`. Record the source of each
rule (domain expert, approved document, or customer calibration), unresolved
terms, and any sample-data masking requirement. Write stable customer-specific
rules to the project memory only after the customer confirms them.

### Step 5: Customer Scope Gate

Present the brief and acceptance criteria. Ask only:

- **Approve scope** — lock the PoC boundary and continue to solution design.
- **Request changes** — revise the boundary, success criteria, or data posture.

### Step 6: Update State

Mark `poc-accelerator-step-01-requirements-capture` complete in `<record>/aidlc-state.md`.

## Sensors

The required-sections sensor validates that written Markdown deliverables are
reviewable. The customer approval is the authoritative acceptance of scope.

## Learn

Maintain `<record>/<phase>/<stage>/memory.md` with timestamped interpretations,
deviations, tradeoffs, and open questions. Promote only customer-confirmed,
durable rules; never place customer-sensitive material in framework knowledge.
