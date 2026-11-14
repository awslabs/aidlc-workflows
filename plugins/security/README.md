# security: AWS Security Agent for AI-DLC

This AI-DLC plugin brings AWS Security Agent into the workflow at two points:

- **Inception.** A new stage, Security Threat Model, submits the requirements and
  design the person approved to Security Agent's threat model review and turns
  the threats into `security-threat-model.md`.
- **Construction.** Code Generation gains a diff scan of each unit's changes and
  a blocking gate check, `security-findings-gate`, that holds the stage's gate
  while a finding at or above HIGH is open.

It also gives core's `aidlc-devsecops-agent` the SECURITY-01 to SECURITY-15
baseline and a briefing on the Security Agent tools.

The plugin talks to the service through the AWS Security Agent MCP server,
`awslabs.security-agent-mcp-server`, pinned to version 0.2.1, in the
ap-southeast-1 Region. Your AWS account does the work, so read
[Before the first run](#before-the-first-run) before you start.

## What the plugin adds

| Piece | File | What it does |
| --- | --- | --- |
| Stage | `stages/inception/security-threat-model.md` | Runs after Delivery Planning in the `enterprise`, `feature`, `mvp`, `classic` and `workshop` scopes, where Inception produces a design |
| Contribution | `contributions/construction/code-generation.md` | Adds Step 1b (hand the threat model to the developer agent) and Step 4b (diff scan, record, fix or accept) to Code Generation, and the `security-scan-result` artifact |
| Sensor | `sensors/aidlc-security-findings-gate.md`, `tools/aidlc-sensor-security-findings-gate.ts` | Blocking gate check over `security-scan-result.md` |
| Knowledge | `knowledge/aidlc-devsecops-agent/security-baseline.md` | SECURITY-01 to SECURITY-15, loaded whenever the DevSecOps agent works |
| Persona contribution | `contributions/agents/aidlc-devsecops-agent.md` | The AWS write rule and how the tools and the gate behave |

## Install

The security plugin is one of AI-DLC's own plugins, so it ships in the
`aidlc-plugins` catalogue they share. A native install keeps that catalogue at
`${XDG_DATA_HOME:-$HOME/.local/share}/aidlc/plugins/` on Linux and macOS, and
at `%LOCALAPPDATA%\aidlc\plugins\` on Windows. The installer prints the full
path, and `aidlc doctor --verbose` names it under Machine. The copy runtime
carries the same catalogue in its `plugins/` folder, and in a checkout of this
repository `bun scripts/package.ts` writes it to `dist/plugins/`
([Plugins](../../docs/guide/18-install-and-lifecycle.md#plugins)). In the
steps below, `<catalogue>` is that folder.

### Claude Code

Add the catalogue once, install the plugin, then start a new session in the
AI-DLC project:

```text
/plugin marketplace add <catalogue>
/plugin install aidlc-security@aidlc-plugins
```

The plugin's SessionStart hook composes it into the project's `.claude/`
folder (`aidlc engine plugin sync`).

### Kiro IDE and Kiro CLI v3

Kiro has no plugin store. Copy the `.kiro` folder of the plugin's Kiro IDE
projection into the project. The plugin lands in
`.kiro/aidlc-plugins/aidlc-security/`:

```bash
cp -r <catalogue>/security/kiro-ide/.kiro <project>/
AIDLC_PLUGIN_ROOT="<project>/.kiro/aidlc-plugins/aidlc-security" AIDLC_PROJECT_DIR="<project>" \
  AIDLC_HARNESS_DIR=.kiro aidlc engine plugin sync
```

When `aidlc` is not on your PATH, run the composer with Bun instead:

```bash
AIDLC_PLUGIN_ROOT="<project>/.kiro/aidlc-plugins/aidlc-security" AIDLC_PROJECT_DIR="<project>" \
  AIDLC_HARNESS_DIR=.kiro bun "<project>/.kiro/aidlc-plugins/aidlc-security/hooks/compose.ts"
```

The copied `.kiro/hooks/aidlc-security-compose.json` registers a SessionStart
hook, so Kiro IDE composes the plugin again at the start of each session.
Copying the folder runs no trust check, so review the plugin as you would any
code you run.

To turn the plugin off in a project, keep only core enabled with
`aidlc engine plugin select aidlc`. `aidlc engine plugin select aidlc,security`
turns it back on.

## Configure the MCP server

A plugin cannot ship MCP configuration yet
([#3211](https://github.com/awslabs/aidlc-workflows/issues/3211)),
so add the server to your harness yourself. The stage and the contribution
call the server `security-agent`, so keep that name.

| Setting | Value |
| --- | --- |
| Command | `uvx awslabs.security-agent-mcp-server@0.2.1` (needs `uv` on your PATH) |
| `AWS_REGION` | `ap-southeast-1`. Without it the server uses `us-east-1`. |
| `AWS_PROFILE` | The AWS CLI profile the server signs in with |
| `WORKSPACE_ROOT` (optional) | The folder the server may upload from. Without it, the server accepts only paths inside its own working folder. |

### Claude Code

Add it with the Claude CLI. `--scope local` keeps your profile name out of the
project's committed files:

```bash
claude mcp add security-agent --scope local \
  -e AWS_REGION=ap-southeast-1 -e AWS_PROFILE=<your-profile> \
  -- uvx awslabs.security-agent-mcp-server@0.2.1
```

To share the entry with the team instead, put it in the project's `.mcp.json`.
AI-DLC never records or removes a server you add there yourself:

```json
{
  "mcpServers": {
    "security-agent": {
      "command": "uvx",
      "args": ["awslabs.security-agent-mcp-server@0.2.1"],
      "env": {
        "AWS_REGION": "ap-southeast-1",
        "AWS_PROFILE": "<your-profile>"
      }
    }
  }
}
```

Claude Code asks before each Security Agent tool call until you allow it.

### Kiro IDE and Kiro CLI

Add the same server to a Kiro MCP file. For Kiro IDE, use the project's
`.kiro/settings/mcp.json`. For Kiro CLI, AI-DLC ships `.kiro/settings/mcp.json`
as its own file, so use your user file, `~/.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "security-agent": {
      "command": "uvx",
      "args": ["awslabs.security-agent-mcp-server@0.2.1"],
      "env": {
        "AWS_REGION": "ap-southeast-1",
        "AWS_PROFILE": "<your-profile>",
        "WORKSPACE_ROOT": "<absolute path of the folder that holds your projects>"
      },
      "disabled": false
    }
  }
}
```

Kiro asks before each MCP call.

## Before the first run

**What the server creates in your account.** The agent calls the server's
`setup_check` first. When the account is not set up, the agent stops and asks
you before anything is created. It explains these resources, and calls `setup`
only after you say yes:

- the IAM role `SecurityAgentScanRole`, unless you name an existing role;
- an agent space, unless you pick one of the existing ones `setup_check` lists;
- on the first threat model review, the S3 bucket
  `security-agent-threat-model-<account>-<region>`;
- on the first code scan, the S3 bucket `security-agent-scans-<account>-<region>`.

The buckets use SSE-S3 encryption, block public access, accept TLS only, and
expire objects after 30 days.

**What leaves your machine.** A threat model review uploads the project's
source (without the files `.gitignore` excludes) and the spec files. A diff
scan uploads the code at the scan's base ref and the diff. Both go to those
buckets in your account.

**Where the data is processed.** In ap-southeast-1, AWS Security Agent uses
global cross-region inference, so the model that reads the uploads can run in
any commercial Region. Choosing ap-southeast-1 therefore does not keep the
processing of your source code in Singapore.

**What it costs.** Threat modelling and code review are preview features of
AWS Security Agent, at no charge while in preview. The plugin uses no
penetration testing, which is billed. AWS Continuum for code vulnerabilities
(the `continuum` API, us-east-1 and us-west-2 only) is out of scope.

## What runs in a workflow

1. **Security Threat Model (Inception).** After Delivery Planning, the
   DevSecOps agent submits `requirements.md`, `components.md`, and, when they
   exist, `decisions.md` and `contract-summary.md` to
   `start_threat_model_review`. It polls `get_scan_status` once a minute (a
   review usually takes 5 to 30 minutes), reads `get_scan_findings`, and
   writes `security-threat-model.md`, which maps the threats to the design,
   lists mitigations for Construction, and holds a `json` record. You approve
   it at the stage's gate. When there is no design, or you choose to go on without a
   threat model, the stage is skipped and the reason is recorded.
2. **Code Generation, Step 1b.** The threats that touch a unit go to the
   developer agent with the unit's design.
3. **Code Generation, Step 4b.** After the code is generated, the agent runs
   `start_diff_scan` against the commit the unit started from, waits (usually
   10 to 15 minutes), and writes `security-scan-result.md`. It fixes each
   blocking finding and scans again, unless you accept the finding.
4. **The gate.** `security-findings-gate` checks the record before the Code
   Generation gate opens.

## Gate reference

### The record

`security-scan-result.md` sits in each unit's Code Generation folder,
`<record>/construction/<unit>/code-generation/`. It holds a findings table for
people and exactly one fenced `json` block, which is all the gate reads:

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
      "finding_id": "f-101",
      "name": "Hardcoded credential",
      "risk_level": "HIGH",
      "status": "ACTIVE",
      "confidence": "HIGH",
      "code_locations": [{ "file_path": "src/config.ts", "line_start": 12, "line_end": 12 }],
      "override": { "by": "Dana Lee", "reason": "A fake key in a test fixture", "at": "2026-11-02T09:55:00Z" }
    }
  ]
}
```

| Field | Values |
| --- | --- |
| `scan.status` | `IN_PROGRESS`, `STOPPING`, `STOPPED`, `FAILED`, `COMPLETED` |
| `findings[].risk_level` | `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `INFORMATIONAL`, `UNKNOWN` |
| `findings[].status` | `ACTIVE`, `RESOLVED`, `ACCEPTED`, `FALSE_POSITIVE` |
| `findings[].override` | Present only on a finding you accepted in lenient mode |

When you go on without a scan, the record holds `not_run` in place of `scan`
and `findings`:

```json
{ "schema_version": 1, "not_run": { "reason": "<your words>", "at": "2026-11-02T09:45:00Z" } }
```

### When the gate holds

The check fails, and the gate stays closed, when any of these is true:

- The record is missing, has no `json` block or more than one, or does not
  match the schema.
- The record says no scan ran, or `scan.status` is not `COMPLETED`.
- A finding at or above HIGH is not `RESOLVED`, unless the override mode is
  lenient and the finding has a valid override. A service status of
  `ACCEPTED` or `FALSE_POSITIVE` is not your decision, so those findings hold
  the gate too.
- A finding has `risk_level` `UNKNOWN`. It holds the gate at every threshold.
- `.aidlc-security.json` exists but does not set a mode the check reads (see
  [Override modes](#override-modes)).

The check also fires on each unit's `code-generation-plan.md`, and fails there
when no record sits beside the plan, so a unit that skipped the scan cannot
pass the gate.

### Override modes

The override mode decides whether an `override` in the record can pass a
finding. Set it in `.aidlc-security.json` at the project root, and commit the
file so that a change to it shows in review:

```json
{ "override_mode": "lenient" }
```

| Mode | What accepts a blocking finding |
| --- | --- |
| `strict`, the default | Only your **Override blocking sensors** choice at the gate. The check ignores every `override` in the record. |
| `lenient` | A valid `override` in the record, or your **Override blocking sensors** choice at the gate. |

Without the file, or without `override_mode`, the mode is strict. When the
file exists but cannot be read, is not valid JSON, holds another key, or sets
another mode, the check fails and names the file.

The two modes trade unattended runs against proof that a person decided:

- **Lenient.** The gate cannot tell an override you gave from one the agent
  wrote. Code Generation's Step 4b tells the agent to write one only after
  your answer. Under Construction autonomy no one answers, so an agent that
  writes one anyway passes its own findings.
- **Strict.** Every accepted risk needs you at the gate, where the engine
  records your choice. The engine never offers **Override blocking sensors**
  under Construction autonomy, so an autonomous run stops on any blocking
  finding until you come back.

### Accepting a finding

Only you can accept a finding. The agent asks about each blocking finding
(**Fix it** or **Accept the risk**) and asks for your reason. It records your
answer with `aidlc engine log decision` and `aidlc engine log answer`. Under
Construction autonomy no one answers, so the agent fixes what it can and the
gate stops the run for you. What happens after your answer depends on the
mode:

- **Strict.** The agent adds nothing to the record. The gate stops on the
  finding, and you accept it there by choosing **Override blocking sensors**.
  That choice opens the gate over every blocking check that still fails, so
  the agent fixes the findings you did not accept first.
- **Lenient.** The agent adds `override` to the finding: `by` (your name),
  `reason` (your words) and `at` (when you answered). An override with an
  empty `by` or `reason`, or an `at` that is not an ISO-8601 time, does not
  count.

In lenient mode the check lists every accepted finding in its output, under
`overrides`. The dispatcher keeps that output only for a failed check, in the
detail file the gate names. On a passing check the audit row records the pass
alone, so the record of an accepted finding is its `override` in
`security-scan-result.md` and your answer in the audit log. In either mode,
**Override blocking sensors** opens the gate over every remaining finding at
once, and the engine records that choice on the gate.

### Threshold

The gate blocks at HIGH. The AI-DLC dispatcher runs the check with `--stage`
and `--output-path` only, and it drops any other argument in the manifest's
`command`, so the installed gate always uses HIGH. To use another level in a
fork, change `DEFAULT_THRESHOLD` in the worker. To try another level by hand,
run the worker yourself from the project root, so it reads the same
`.aidlc-security.json` (on Kiro the worker is in `.kiro/tools/`):

```bash
bun .claude/tools/aidlc-sensor-security-findings-gate.ts \
  --output-path <record>/construction/<unit>/code-generation/security-scan-result.md \
  --threshold CRITICAL
```

To fire it the way the gate does, with an audit row:

```bash
aidlc engine sensor fire security-findings-gate --stage code-generation \
  --output-path <record>/construction/<unit>/code-generation/security-scan-result.md
```

## Limits

- One scan record covers one repository. The plugin does not yet handle a
  unit that changes several repositories.
- A diff scan reports at most 30 findings, highest risk first, and covers at
  most 3,000 changed files or a 5 MB diff (AWS Security Agent limits).
- `git diff` leaves out files git does not track. The agent marks the unit's
  new files with `git add --intent-to-add` before the scan, which stages no
  content.
- This README shows the install and the MCP setup for Claude Code and Kiro.
  AI-DLC builds the plugin for its other harnesses too. On those, add the same
  `security-agent` server through the harness's own MCP settings.
