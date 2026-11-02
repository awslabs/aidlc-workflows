---
target: aidlc-devsecops-agent
plugin: security
fragments:
  - anchor: after-preflight
    order: 100
  - anchor: end-of-body
    order: 100
---

## fragment: after-preflight

**AWS writes need the person's yes (security plugin).** Never call the
`security-agent` MCP server's `setup`, and never start a review or scan that
would create its first S3 bucket, without the person's explicit yes in this
conversation: both change resources in the person's AWS account.

## fragment: end-of-body

## AWS Security Agent (security plugin)

The security plugin runs AWS Security Agent through the `security-agent` MCP
server (`awslabs.security-agent-mcp-server`), which the person configures in
their harness.

- **The tools.** `setup_check` says whether the account is ready (`ready`,
  `missing`, `config`). `start_threat_model_review` and `start_diff_scan`
  start a job in the service and return a `scan_id` at once. Poll
  `get_scan_status` with it about once a minute until `COMPLETED`, `FAILED` or
  `STOPPED`, then read `get_scan_findings` without `severity`, so nothing is
  filtered out. `stop_scan` cancels a job.
- **Paths and titles.** Pass absolute paths, never `.`: the server resolves
  `.` against its own folder and refuses paths outside its `WORKSPACE_ROOT`.
  Titles take no spaces.
- **What leaves the machine.** A threat model review uploads the project
  source (without the files `.gitignore` excludes) and the spec files. A diff
  scan uploads the code at its `base_ref` and the diff. Both go to S3 buckets
  in the person's account. In ap-southeast-1 the service uses global
  cross-region inference, so the model that reads the uploads can run in
  another commercial region: say so when the person's data has to stay in one
  region.
- **What it creates.** `setup` creates the IAM role `SecurityAgentScanRole`
  (unless the person names an existing role) and an agent space. The first
  threat model creates the bucket `security-agent-threat-model-<account>-<region>`,
  and the first code scan `security-agent-scans-<account>-<region>`. Threat
  modelling and code review are preview features of the service.
- **The Code Generation gate.** The `security-findings-gate` check holds the
  gate while a unit's diff scan is not `COMPLETED`, or while a finding at or
  above HIGH is neither `RESOLVED` nor accepted by the person. A finding the
  service rated `UNKNOWN` always holds it. The threshold lives in the plugin,
  never in the scan record. The person accepts a finding with the engine's
  `Override blocking sensors` choice at the gate, which the engine records.
  Only when the project's `.aidlc-security.json` sets `override_mode` to
  `lenient` does an `override` in the record count too, written after the
  person's answer is recorded with `engine log decision` and
  `engine log answer`. Never write one on your own, and never change
  `.aidlc-security.json` unless the person asks.
