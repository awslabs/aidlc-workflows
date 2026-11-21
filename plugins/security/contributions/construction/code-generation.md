---
target: code-generation
plugin: security
adds:
  produces:
    - security-scan-result
  consumes:
    - artifact: security-threat-model
      required: false
  requires_stage:
    - security-threat-model
  sensors:
    - security-findings-gate
fragments:
  - anchor: after-step:1
    order: 100
  - anchor: after-step:4
    order: 100
  - anchor: in:Sensors
    order: 100
---

## fragment: after-step:1

### Step 1b (security): Read the threat model

When `<record>/inception/security-threat-model/security-threat-model.md`
exists, read its `## Threats` and `## Mitigations for Construction` sections.
List the threats that touch the components this unit builds, each with its
recommendation, and put that list in the Step 4 delegation prompt beside the
unit's design artifacts. When the file does not exist, the plan skipped the
threat model: go on without it.

## fragment: after-step:4

### Step 4b (security): Scan this unit's changes with AWS Security Agent

After the developer agent finishes, and before Step 5, scan the code this unit
changed and write `<code-generation-record>/security-scan-result.md`. A unit
cannot complete without that file, and the `security-findings-gate` check holds
the gate until it shows a completed scan with no open finding at or above HIGH.

1. **Check the connection.** Call the `security-agent` MCP server's
   `setup_check`. When the server is missing, tell the person that this check
   needs the AWS Security Agent MCP server (the security plugin's README shows
   how to add it), and offer to add it and scan, or to go on without a scan.
   When `ready` is false, or `config` has no `s3_bucket`, stop and ask before
   anything is created in their account. Never call `setup` or start the first
   scan without their yes. Tell them that `setup` creates the IAM role
   `SecurityAgentScanRole` (unless they name an existing role) and an agent
   space, and that the first scan creates the S3 bucket
   `security-agent-scans-<account>-<region>`. Tell them that each scan uploads
   the code at the base ref and this unit's diff to that bucket, and that in
   ap-southeast-1 the service uses global cross-region inference, so the model
   that reads them can run in another commercial region. Record each question
   and the person's exact answer as stage-protocol.md section 3 says, with
   `{{INVOKE}} engine log decision --stage code-generation` before it and
   `{{INVOKE}} engine log answer --stage code-generation` after it (add
   `--unit "<directive.unit>"` for a unit).
2. **Choose what to scan.**
   - `path`: the absolute path of the git repository that holds this unit's
     code: the project root, or the Bolt worktree when the unit is built in
     one. Never `.`, which the server reads as its own folder.
   - `base_ref`: the commit this unit's work started from. When none of the
     unit's changes are committed yet, the usual case right after Step 4, that
     is `HEAD`. When some are committed, use the commit before the first of
     them, or the branch the work started from, such as `main`.
   - New files: the scan's diff is `git diff <base_ref>`, which leaves out
     files git does not track. Run `git add --intent-to-add <file>...` for each
     new file this unit created (`git status --porcelain` lists them as `??`).
     It stages no content.
   - `title`: no spaces, such as `<directive.unit>-code-generation`.
3. **Start the scan.** Call `start_diff_scan` with them. When it answers
   `No diff found`, the base ref is later than the unit's changes: pick the
   earlier commit and start again. Any other `error`: tell the person, and
   offer to fix what it names and scan again, or to go on without a scan.
4. **Wait.** A diff scan usually takes 10 to 15 minutes. Call
   `get_scan_status` with the `scan_id` once a minute (wait between calls with
   a `sleep 60` shell command) until `status` is `COMPLETED`, `FAILED` or
   `STOPPED`. After 30 minutes without one of them, tell the person and offer
   to keep waiting, to stop the scan with `stop_scan`, or to go on without a
   scan.
5. **Collect the findings.** Call `get_scan_findings` with the `scan_id` and no
   `severity`, so the record holds every finding.
6. **Write the record.** Write `security-scan-result.md` with a
   `# Security scan` heading, a table of the findings at or above HIGH (id,
   risk, name, location, status, and the person's decision when there is one),
   and exactly one fenced `json` block, the record the gate reads:

   ```json
   {
     "schema_version": 1,
     "scan": {
       "scan_id": "scan-5e6f7a8b",
       "scan_type": "DIFF",
       "base_ref": "HEAD",
       "status": "COMPLETED",
       "region": "ap-southeast-1",
       "mcp_server": "awslabs.security-agent-mcp-server@0.2.1",
       "completed_at": "2026-11-02T09:40:00Z"
     },
     "findings": [
       {
         "finding_id": "<findingId>",
         "name": "<name>",
         "risk_level": "HIGH",
         "status": "ACTIVE",
         "confidence": "<confidence>",
         "code_locations": [{ "file_path": "<filePath>", "line_start": 12, "line_end": 14 }]
       }
     ]
   }
   ```

   `risk_level`, `status` and `confidence` keep the service's `riskLevel`,
   `status` and `confidence`. `code_locations` copies `codeLocations`
   (`filePath`, `lineStart`, `lineEnd`). `region` is the `AWS_REGION` the
   server runs with, `mcp_server` the package it was started from, and
   `completed_at` the UTC time you saw `COMPLETED`. Copy no account ID, bucket
   name or role ARN into the file.
7. **Clear what blocks.** A finding at or above HIGH that is not `RESOLVED`
   blocks the gate. First read the override mode, `override_mode` in
   `.aidlc-security.json` at the project root: `strict` or `lenient`. When the
   file or the key is missing, the mode is strict. When the file is there but
   does not hold one of the two, the gate fails until someone fixes the file,
   so tell the person. For each blocking finding:
   - **Fix it.** Hand it to the developer agent the way Step 4 delegates the
     build (the `brief` output first, then the finding's name, description,
     code locations and `remediationCode`), and ask it to fix the code without
     weakening a test or a quality target. Then scan again from item 2 and
     write the record again from the new scan.
   - **Accept it.** Only the person can. Ask about each finding as a structured
     question with the options `Fix it` and `Accept the risk`, and when they
     accept, ask for their reason. Record both with `engine log decision` and
     `engine log answer --details 'Accept the risk: <their reason>'`. In a run
     that no person answers (Construction autonomy), fix what you can and let
     the gate stop for the person.
     - **Strict mode.** Write no `override` into the record, because the gate
       ignores it. Tell the person that the gate stops on this finding, and
       that they accept it there by choosing Override blocking sensors. That
       choice opens the gate over every blocking check that still fails, so
       fix the findings they did not accept first.
     - **Lenient mode.** Add
       `"override": { "by": "<their name>", "reason": "<their words>", "at": "<the UTC time of their answer>" }`
       to that finding (for `by`, ask their name, or use the project's
       `git config user.name`). Never write an override the person did not
       give, and never in a run that no person answers. After a new scan, an
       override carries forward only to the finding with the same `name` and
       the same `file_path`, copied unchanged. Say in one line which ones
       carried forward.
8. **Going on without a scan.** When the person chooses that, write the record
   with `not_run` in place of `scan` and `findings`:
   `{ "schema_version": 1, "not_run": { "reason": "<their words>", "at": "<UTC time>" } }`.
   The gate then refuses, and the engine offers Fix findings or Override
   blocking sensors. The engine records their override on the gate.

## fragment: in:Sensors

The security plugin adds `security-findings-gate`, a blocking gate check. On
each unit's `security-scan-result.md` it holds the gate while the diff scan is
not `COMPLETED`, or while a finding at or above HIGH is not `RESOLVED`. An
override in the record clears a finding only in lenient mode, which
`.aidlc-security.json` at the project root sets. On `code-generation-plan.md`
it holds the gate when no scan record sits beside the plan. It reads only that
record and `.aidlc-security.json`.
