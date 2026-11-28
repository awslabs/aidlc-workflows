---
slug: security-threat-model
name: Security Threat Model
plugin: security
phase: inception
execution: CONDITIONAL
condition: Execute when Inception approved a design to model, Domain Design's components or Contract Design's contracts. Skip when both design stages were skipped, or when the person chooses to go on without a threat model.
lead_agent: aidlc-devsecops-agent
support_agents: []
mode: inline
produces:
  - security-threat-model
consumes:
  - artifact: requirements
    required: true
  - artifact: components
    required: true
  - artifact: decisions
    required: false
  - artifact: contract-summary
    required: false
requires_stage:
  - requirements-analysis
  - domain-design
  - contract-design
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
  - classic
  - workshop
ars:
  targets: [r, ua]
  cost: 3
inputs: <record>/inception/requirements-analysis/requirements.md, <record>/inception/domain-design/components.md, <record>/inception/domain-design/decisions.md (if produced), <record>/inception/contract-design/contract-summary.md (if produced)
outputs: security-threat-model.md (under this stage's record dir, engine-resolved), the threat report with its machine-readable record in one json block
---

# Security Threat Model

Threat-model the design the person approved in Inception with AWS Security
Agent, before Construction builds it. The review runs in the person's AWS
account through the `security-agent` MCP server, and this stage turns its
threats into a report that Code Generation reads.

## Steps

### Step 1: Collect the approved design

These are the specs the review reads. Note the absolute path of each one that
exists:

- `<record>/inception/requirements-analysis/requirements.md`
- `<record>/inception/domain-design/components.md` (if produced)
- `<record>/inception/domain-design/decisions.md` (if produced)
- `<record>/inception/contract-design/contract-summary.md` (if produced)

When neither `components.md` nor `contract-summary.md` exists, there is no
design to model and this stage does not apply. Run
`{{INVOKE}} engine orchestrate report --stage security-threat-model --result skipped --reason 'Inception produced no design to threat model'`,
then run `next`.

### Step 2: Check the AWS Security Agent

Call the `security-agent` MCP server's `setup_check` tool.

- **No such server or tool.** The MCP server is not configured in this
  harness. Tell the person in one line that the threat model needs the AWS
  Security Agent MCP server, which the security plugin's README shows how to
  add. Offer two choices: add it and try again, or go on without a threat
  model.
- **`ready: false`, and `missing` names `aws_credentials`.** The AWS profile
  the server runs with did not work. Show the error in one line and offer the
  same two choices.
- **`ready: false` otherwise.** Stop and ask the person before anything is
  created. Never call `setup` without their yes. Tell them what `setup` and the
  first review create in their account: the IAM role `SecurityAgentScanRole`
  (unless they name an existing role) and an agent space (or one of the
  `existing_agent_spaces` it lists), then, on the first review, the S3 bucket
  `security-agent-threat-model-<account>-<region>`. Tell them that the review
  uploads the project's source (files `.gitignore` excludes are left out) and
  the spec files to that bucket, that threat modelling is a preview feature
  of AWS Security Agent, and that in ap-southeast-1 the service uses global
  cross-region inference, so the model that reads the uploads can run in
  another commercial region. Offer three choices: set it up now, I will set it
  up myself, or go on without a threat model. Call `setup` only on their yes,
  with the agent space and role they chose.
- **`ready: true`.** When `config` has no `threat_model_s3_bucket`, the first
  review creates that bucket: say so and ask before Step 3, the same way.

Ask each question as a structured question, recorded the way stage-protocol.md
section 3 says: `{{INVOKE}} engine log decision --stage security-threat-model`
before it and `{{INVOKE}} engine log answer --stage security-threat-model`
after it, with their exact choice. When they choose to go on without a threat
model, run
`{{INVOKE}} engine orchestrate report --stage security-threat-model --result skipped --reason '<their reason>'`
and run `next`. Their explicit choice wins at every step of this stage.

### Step 3: Start the review

Call `start_threat_model_review` with:

- `path`: the absolute path of the project root. Never `.`, which the server
  reads as its own folder.
- `specs`: the absolute paths from Step 1, only the files that exist.
- `title`: a title with no spaces, such as `<record folder name>-threat-model`.

When it answers with an `error`, tell the person and offer to try again after
the fix the error names, or to go on without a threat model.

### Step 4: Wait for the result

The review runs in the service, usually 5 to 30 minutes. Call
`get_scan_status` with the `scan_id` from Step 3 once a minute (wait between
calls with a `sleep 60` shell command) until `status` is `COMPLETED`, `FAILED`
or `STOPPED`. When 45 minutes pass without one of them, tell the person and
offer to keep waiting, to stop the review with `stop_scan`, or to go on
without a threat model.

When the status is `FAILED` or `STOPPED`, show the person why, from the
status's `steps`, and offer to start the review again or to go on without a
threat model.

### Step 5: Collect the threats

Call `get_scan_findings` with the `scan_id` and no `severity`, so every threat
comes back. Each threat has `threatId`, `statement`, `severity`, `status`,
`stride`, `threatImpact`, `recommendation` and `impactedAssets`.

### Step 6: Write the threat model

Write `security-threat-model.md` in this stage's record folder with these
sections:

- `## Scope`: the specs the review read, by their record paths
  (`inception/requirements-analysis/requirements.md` and so on), and the
  review's `scan_id`.
- `## Threats`: one entry per threat, highest severity first. Give its
  statement, severity, STRIDE categories, the components from `components.md`
  or the contracts from `contract-summary.md` it affects, and the service's
  recommendation. Name the component a threat touches by its name in
  `components.md`. When it touches none, say so.
- `## Mitigations for Construction`: for each CRITICAL or HIGH threat, the
  control the code must have, in one line each. Code Generation reads this
  section for every unit.
- `## Record`: exactly one fenced `json` block, the machine-readable record
  below. Keep it the only `json` block in the file.

```json
{
  "schema_version": 1,
  "scan": {
    "scan_id": "scan-1a2b3c4d",
    "threat_model_id": "<threat_model_id from start_threat_model_review>",
    "scan_type": "THREAT_MODEL",
    "status": "COMPLETED",
    "region": "ap-southeast-1",
    "mcp_server": "awslabs.security-agent-mcp-server@0.2.1",
    "completed_at": "2026-11-02T08:15:00Z",
    "specs": ["inception/requirements-analysis/requirements.md"]
  },
  "threats": [
    {
      "threat_id": "<threatId>",
      "statement": "<statement>",
      "severity": "HIGH",
      "status": "OPEN",
      "stride": ["SPOOFING"],
      "impact": "<threatImpact>",
      "impacted_assets": ["<impactedAssets>"],
      "recommendation": "<recommendation>",
      "components": ["<component name from components.md>"]
    }
  ]
}
```

`region` is the `AWS_REGION` the server runs with, `mcp_server` is the package
the server was started from, and `completed_at` is the UTC time you saw
`COMPLETED`. `severity` and `status` keep the service's values. Copy no
account ID, bucket name or role ARN into the file.

### Step 7: Completion handoff

Hand completion to `stage-protocol.md` via
`{{INVOKE}} engine orchestrate report --stage security-threat-model --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never
perform one in prose, and never narrate this bookkeeping to the person.

### Step 8: Present completion and request approval

Use the stage-protocol.md completion template:

- The number of threats by severity, and the CRITICAL and HIGH ones by name.
- The review path: `<record>/inception/security-threat-model/`.
- A structured approval question with options: Approve (continue to the next stage) / Request Changes (say what to change).

## Sensors

This stage's output is a markdown artefact under
`<record>/inception/security-threat-model/` (`security-threat-model.md`).

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `requirements`, `components`. The `## Scope` section's
record paths are the citations `upstream-coverage` looks for.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working, and take the learnings step before the approval gate; that module says
when it asks the person anything. When the module is absent, skip both the diary
and the step.
