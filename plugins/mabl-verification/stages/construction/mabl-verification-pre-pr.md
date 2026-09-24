---
slug: mabl-verification-pre-pr
number: 3.90
name: mabl Pre-PR Verification
plugin: mabl-verification
phase: construction
execution: CONDITIONAL
condition: Execute after build-and-test when the mabl plugin is active, the mabl CLI is authenticated, the mabl MCP server is connected, and the workspace has mabl tests covering the application under development.
lead_agent: mabl-verification-agent
support_agents: []
mode: inline
produces:
  - mabl-verification-impact
  - mabl-verification-run-results
consumes:
  - artifact: build-and-test-summary
    required: true
requires_stage:
  - build-and-test
sensors:
  - mabl-run-status
scopes:
  - enterprise
  - feature
  - mvp
  - mabl-verification-validation
  - classic
  - workshop
inputs: Build outputs from build-and-test, the current git diff (working tree or committed), and the mabl workspace's test catalog via MCP
outputs: mabl-verification-impact.md, mabl-verification-run-results.md (under this stage's record dir, engine-resolved)
---

# mabl Pre-PR Verification

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

Map the code changes from `build-and-test` to the mabl tests that exercise those
user-facing flows, then run the best matches locally through the mabl CLI so the
developer sees pass/fail against their own build within minutes — no waiting on CI
or a cloud plan run. This stage answers two questions: **Q1 — which tests are
affected?** and **Q2 — do they pass?**

The flow: **diff → derive intent → match tests → run locally → triage → report.**

---

## Steps

### Step 1: Load Agent Persona

Load mabl-verification-agent persona from `agents/mabl-verification-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/mabl-verification-agent/`.

### Step 2: Preflight Checks

Verify the mabl toolchain is ready before proceeding:

1. **CLI present & authenticated:**
   ```bash
   mabl --version && mabl auth info
   ```
   If missing or expired, report the gap and halt with remediation instructions.

2. **mabl MCP server connected:** Confirm that MCP tools (`search_mabl_tests`,
   `list_mabl_workspaces`, `analyze_mabl_failure`) are available in this session.
   If not connected, report the gap and halt.

3. **Workspace resolution:** Resolve the target mabl workspace (from team knowledge
   at `aidlc/spaces/<active-space>/knowledge/mabl-verification-agent/workspace-constants.md`,
   or `mabl config get workspace-id`, or by listing and asking). Record the workspaceId.

4. **Git repository:** Confirm `git rev-parse --is-inside-work-tree`.

5. **Local dev server:** Detect a running server (probe ports 3000, 3001, 5173, 8080)
   or read it from project config. Record the run URL.

### Step 3: Resolve the Change Set

Analyze what the app under test actually runs. A local dev server serves the
**working tree**, so that — not the last commit — is what mabl will exercise.

```bash
git status --short
```

- **Dirty tree:** analyze working tree — committed diff PLUS uncommitted changes.
  This matches what the dev server serves.
- **Clean tree:** analyze the branch's committed diff (`main...HEAD`).

Produce a concise list of changed files grouped by area (frontend pages, components,
routes, API/controllers, backend logic, styles, config). Skip lockfiles, generated
files, and pure-formatting churn.

### Step 4: Derive User-Facing Intent

mabl tests exercise **end-user behavior**, not code internals. Translate the diff
into the user-facing flows it affects.

**Spec-first path (preferred):** If a project spec or requirements document exists
for the current feature, read its acceptance criteria first. Observable browser
behavior specs convert directly into search queries — more reliable than diff inference.

**Diff-only fallback:** Use mapping heuristics:
- Page/route component → the flow by name
- Shared UI component → the flows that render it
- API endpoint/controller → API tests for that resource
- Backend logic → the user-facing feature it powers

Write **1–5 short natural-language search queries** from the inferred flows.

### Step 5: Discover Relevant Tests

Run MCP `search_mabl_tests` once per query (pass `workspaceId`), then merge and
de-duplicate by test id. Use the returned descriptions and step summaries to judge
fit. Rank candidates by relevance:
- **Strong match** — exact flow match
- **Partial** — same feature area
- **Tangential** — related but indirect

Drop anything clearly unrelated. If queries return nothing, broaden once (feature
area instead of specific page) before concluding there is no coverage.

### Step 6: Confirm the Run Set

Present the ranked candidates:
- Changed files grouped by area
- Inferred flows
- Matched tests with relevance rating

Default to running the top 3 matches. Ask for confirmation only if picks are
ambiguous or there are zero matches.

With **zero matches**, report plainly: this change may have no existing mabl
coverage — flag it as a gap for the coverage-gap stage.

### Step 7: Execute Tests Locally

For each selected test, run via the mabl CLI against the local dev server.

Resolve `applicationId` and `environmentId` from team knowledge or MCP
(`list_mabl_applications`, `list_mabl_environments`). Resolve credentials from
`list_mabl_credentials` — the right persona depends on what the test asserts.

```bash
mabl tests run \
  --id <testId> \
  -w <workspaceId> \
  --url <localUrl> \
  --application-id <applicationId> \
  --environment-id <environmentId> \
  --credentials-id <credentialsId> \
  --reporter mabl
```

Run tests **sequentially** (shared dev server). Do NOT pass `--keep-browser-open`
(blocks the command). Parse `Passed:`/`Failed:` counts from the log — **do not trust
the exit code alone** (`mabl tests run` can exit 0 on failure).

**GenAI/visual assertions:** Local CLI runs disable these by default. Check
`get_mabl_test_steps` for GenAI assertions before running. If present, either run
with `--allow-billable-features` (confirm with user — consumes credits) or treat a
failure on only those steps as a harness skip, not a code regression.

### Step 8: Confirm Results via Cloud

Verify each run's outcome authoritatively through MCP:
- `list_mabl_test_runs(testId, workspaceId)` — latest run status
- `get_mabl_test_run(testRunId)` — detailed status and failure summary

For each failed run, note the failing step, expected vs actual, and whether it is a
billable-assertion skip vs a real failure.

### Step 9: Triage Results

For each test result, classify:

- **Pass** — test passed all concrete assertions.
- **Billable skip** — only GenAI/visual assertions failed (harness limitation, not regression).
- **Code regression** — a concrete assertion failed on a step the diff touches.
- **Stale test** — a selector/assertion broke because the UI intentionally changed.
- **Environment/data** — wrong seed data, missing precondition, or down dependency.
- **Flake** — timing race or non-deterministic behavior (correlate with history).

For failures classified as code regression or stale test, cross-reference the
failing step against the diff from Step 3 to localize the cause.

If deeper analysis is needed, invoke the failure-RCA methodology from
`{{HARNESS_DIR}}/knowledge/mabl-verification-agent/failure-rca-methodology.md`:
pull AI analysis (`analyze_mabl_failure`), retrieve artifacts (DOM, HAR, console),
and correlate with source.

### Step 10: Produce Artifacts

Write **two** artifacts to this stage's engine-resolved record dir:

1. **`mabl-verification-impact.md`** — the change summary, inferred flows, search
   queries, matched tests (with relevance), and any zero-match gaps.

2. **`mabl-verification-run-results.md`** — per-test execution results: test name,
   test id, status (pass/fail/billable-skip), failing step (if any), classification,
   confidence, mabl run link, and recommended next action.

Include a machine-readable JSON summary block at the end of each artifact for
downstream sensor consumption:

```json
{
  "tests_matched": 3,
  "tests_run": 3,
  "passed": 2,
  "failed": 1,
  "billable_skipped": 0,
  "coverage_zero_match": false,
  "failures": [
    {
      "testId": "...",
      "testRunId": "...",
      "class": "stale-test",
      "confidence": 0.85,
      "failingStep": "Step 7: Assert heading contains 'Dashboard'"
    }
  ]
}
```

### Step 11: Open the Approval Gate

Run `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage mabl-verification-pre-pr --result awaiting-approval`.

### Step 12: Present Completion & Request Approval

Completion emoji: :test_tube:
Review path: this stage's engine-resolved record dir.
Standard 2-option approval (Approve / Request Changes).
STOP for the human response. Report Approve with
`--result approved --user-input "<exact choice>"`; report
Request Changes with `--result rejected --user-input "<feedback>"`, revise the
artifacts, then report `--result revised` before re-presenting.

---

## Sensors

This stage binds the `mabl-run-status` sensor which reads the JSON summary from
`mabl-verification-run-results.md` and reports pass/fail counts and any unresolved
failures.

---

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under: Interpretations, Deviations, Tradeoffs, Open questions —
each with an ISO 8601 timestamp.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file.
