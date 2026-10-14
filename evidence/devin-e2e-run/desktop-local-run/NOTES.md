# desktop-local-run — caveats and deviations

## Surface notes

- The session ran in **Devin Local** (the CLI-derived agent harness inside
  Devin Desktop), confirmed via the agent selector — not Cascade.
- **`/hooks` is not implemented in Desktop's Devin Local UI**: the command
  returned "Unknown command: /hooks". The Desktop-native equivalent is the
  **Open customizations** surface (new-tab menu or session context menu),
  which lists loaded rules/skills/hooks/MCP/plugins. That surface was not
  captured; hook loading is instead proven by the SessionStart marker
  (12:14:00.925Z) and the doctor "Hooks last fired" rows (9 distinct hooks
  during the run).
- Host permission mode was **Bypass Permissions**. AI-DLC approval gates are
  question cards, not host permission prompts, and fired independently.
- The account's weekly usage quota was exhausted mid-run; the session
  consumed extra-usage allowance.

## Gate/capture caveats

- No separate scope-confirmation card appeared: `express` was declared in the
  intent command itself.
- The **plan-approval gate was presented and approved** (audit:
  `PLAN_APPROVAL_RECORDED` 12:47:38Z, checkpoint "Code Generation Plan
  Approval", approval fingerprint + questions SHA-256 + directive epoch) but
  no screenshot was filed for that card. The audit receipt is the evidence.
- The verification-command authorization folded into the flow; the approved
  `python -m unittest -v` output is visible in the completion summary and
  `04-tests.txt`.

## Enforcement events worth noting (all in `08-audit-shard.md`)

- `PLAN_APPROVAL_BLOCKED` ×3 — the guard intercepted a `python -m unittest
  --help` probe (12:44:33Z), an `aidlc-log` call (12:47:08Z), and an
  `aidlc-developer-agent` Task dispatch (12:48:13Z).
- Three refused malformed `aidlc-log answer` attempts (missing `--details`;
  descriptive text instead of the literal `Approve Plan`; wrong
  questions-file path) before the valid record was accepted at 12:47:38Z.
- `REVIEW_BUDGET_EXHAUSTED` refusal (12:52:18Z): a review pass was refused for
  `code-generation` (0 budget) with a structured guard-recovery remedy.
- `SENSOR_FAILED`: `traceability`, 1 finding — cosmetic schema nit: the
  stage-level manifest writes `"unit": null`, which the sensor requires to be
  a string. Coverage was 9/9 upstream IDs OK. Candidate upstream fix.
- 1 `continue-workflow` hook drop recorded (advisory, fail-open); drop record
  under the intent's `.aidlc-engine/hooks-health/` (not committed).

## Sanitization

- OS username redacted as `C:\Users\<user>` in doctor captures.
- Audit shard renamed from its `<host>-<clone>.md` convention filename;
  content already used `<project-dir>` placeholders (verified: no absolute
  paths or usernames inside).
- UI screenshots (8 PNGs) are retained **locally only** in the disposable
  fixture's `evidence-local/20260923T145443Z/` (to be deleted with the
  fixture); SHA-256 checksums recorded in `README.md` for attributability.
  The campaign's committed evidence is text-only per the retained-artifact
  policy.
