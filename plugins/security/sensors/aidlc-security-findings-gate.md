---
id: security-findings-gate
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-security-findings-gate.ts
default_severity: blocking
description: Holds the Code Generation gate while a unit's AWS Security Agent diff scan record has an open finding at or above HIGH (security plugin)
category: security
fire_on: gate
matches: "**/code-generation/{code-generation-plan,security-scan-result}.md"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  findings: string[]
  findings_count: integer
  threshold: string
  override_mode: string
  overrides: string[]
timeout_seconds: 60
---

# security-findings-gate sensor (security plugin)

BLOCKING, at the Code Generation gate. The gate fires it on each unit's
`security-scan-result.md` and `code-generation-plan.md`. It reads only the scan
record that Code Generation's Step 4b writes and the project's
`.aidlc-security.json`, never the network.

Fired on `security-scan-result.md`, it reads the file's one `json` block and
fails when:

- the block is missing, appears twice, is not JSON, or does not match the
  record's schema (`schema_version` 1);
- the record says no scan ran (`not_run`), or the scan's `status` is not
  `COMPLETED`;
- a finding whose `risk_level` is HIGH or CRITICAL is not `RESOLVED`, unless
  the override mode is lenient and the finding carries a valid `override` (a
  non-empty `by` and `reason`, and an ISO-8601 `at`). A finding the service
  rated `UNKNOWN` blocks the same way at every threshold.

Fired on `code-generation-plan.md`, it fails when no `security-scan-result.md`
sits beside the plan, so a unit that skipped the scan still stops the gate.

The override mode comes from `.aidlc-security.json` at the project root, which
is the working directory the dispatcher gives the worker. The file holds
`{"override_mode": "strict"}` or `{"override_mode": "lenient"}`. Without the
file or the key, the mode is strict. In strict mode the gate ignores every
`override` in the record. A person accepts a blocking finding only through the
engine's **Override blocking sensors** choice at the gate, which the engine
never offers under Construction autonomy. In lenient mode a valid `override`
accepts its finding. Both fires fail when the file exists but cannot be read,
is not valid JSON, holds a key other than `override_mode`, or sets another
mode.

Every verdict is one JSON line with `pass`, `findings` (one sentence per
problem), `findings_count`, `threshold`, `override_mode` (`strict` or
`lenient`, or `null` when `.aidlc-security.json` cannot be read) and
`overrides`, the findings a valid override accepted in lenient mode, each with
who, when and why. The dispatcher keeps that line in the detail file of a
failed fire only. The override decisions themselves are recorded through
`engine log decision` and `engine log answer` when the person makes them.

The threshold is HIGH. The dispatcher passes the worker `--stage` and
`--output-path` only, so `--threshold <CRITICAL|HIGH|MEDIUM|LOW|INFORMATIONAL>`
applies when you run the worker yourself, from the project root so it reads the
same `.aidlc-security.json`:

```bash
bun {{HARNESS_DIR}}/tools/aidlc-sensor-security-findings-gate.ts --output-path <record>/construction/<unit>/code-generation/security-scan-result.md --threshold CRITICAL
```
