---
slug: mabl-verification-coverage-gap
number: 3.95
name: mabl Coverage Gap Analysis
plugin: mabl-verification
phase: construction
execution: CONDITIONAL
condition: Execute after mabl-verification-pre-pr when the plugin is active and either (a) the pre-pr stage reported coverageZeroMatch for any inferred flow, (b) the matched test count is below the inferred flow count, or (c) the user explicitly requests a coverage assessment.
lead_agent: mabl-verification-agent
support_agents: []
mode: inline
produces:
  - mabl-verification-coverage-report
consumes:
  - artifact: mabl-verification-impact
    required: true
  - artifact: mabl-verification-run-results
    required: false
requires_stage:
  - mabl-verification-pre-pr
sensors:
  - mabl-coverage-threshold
scopes:
  - enterprise
  - feature
  - mvp
  - mabl-verification-validation
  - classic
inputs: The impact artifact from mabl-verification-pre-pr (inferred flows, matched tests, zero-match flags) and the mabl workspace's test catalog via MCP
outputs: mabl-verification-coverage-report.md (under this stage's record dir, engine-resolved)
---

# mabl Coverage Gap Analysis

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

Coverage is the question the pass/fail signal cannot answer: a change can be
all-green simply because **nothing tests it**. This stage finds the user-facing
flows a change touches that have no mabl test, rates them by severity, and
recommends authoring to close critical gaps — or delegates to mabl's authoring
tools when the user opts in. It answers **Q5 — is there a gap in coverage?**

The flow: **load impact → identify uncovered paths → rate + recommend →
optionally author → emit coverage report.**

---

## Steps

### Step 1: Load Agent Persona

Load mabl-verification-agent persona from `agents/mabl-verification-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/mabl-verification-agent/`.

### Step 2: Load Upstream Impact

Read the `mabl-verification-impact` artifact produced by `mabl-verification-pre-pr`.
Extract:
- The inferred user-facing flows (from diff analysis)
- The matched tests (with relevance ratings)
- Any `coverageZeroMatch` flags (flows with no test match at all)
- The search queries that were used

If the impact artifact is unavailable (stage ran standalone), derive flows from the
current diff using the same heuristics as the pre-pr stage Step 4.

### Step 3: Identify Uncovered Paths

For each inferred flow from Step 2, determine coverage status:

1. **Covered** — a strong-match test exists and ran (from pre-pr results).
2. **Weakly covered** — only a partial/tangential match exists.
3. **Uncovered** — no test matched this flow at all (`coverageZeroMatch`).

Cross-check suspected gaps with a broadened `search_mabl_tests` query before
declaring them — avoid false gaps from an over-narrow earlier search. Use feature-area
queries rather than specific-page queries.

Additionally, call `identify_coverage_gaps` (MCP) scoped to the workspace and
application, biased toward the flows from Step 2. This uses mabl's AI coverage
model for a second opinion beyond the semantic search.

### Step 4: Rate Gaps by Severity

For each confirmed gap, assign a severity:

| Severity | Criteria | Examples |
|----------|----------|----------|
| `critical` | Core money/auth/data-integrity flow, or the primary behavior the change introduces | Payment processing, login/logout, account transfer, the new feature's main card |
| `normal` | Secondary or edge behavior of a covered feature | Settings page update, notification preference toggle |
| `low` | Cosmetic or rarely-hit path | Footer link, tooltip text, empty-state illustration |

### Step 5: Recommend Actions

For each gap, set a recommendation:

- **`author`** — critical or normal severity on a shipped flow → a new mabl test
  should be created before shipping.
- **`defer`** — low severity, or indirectly covered by another test's broader flow.
- **`none`** — not a real gap (false positive from narrow search).

A `critical` gap with `recommendation: author` is a **ship-blocker input** for the
downstream `mabl-verification-ship-gate` stage.

### Step 6: Author Missing Tests (Optional)

When the user opts to close a gap (or the workflow policy requires it for critical
gaps), hand off to mabl's authoring tools:

1. **Plan the test** — call `mabl_authoring_plan` with the flow description, target
   application, and environment.
2. **Initiate local authoring** — use `mabl_authoring_initiate_local` with:
   - The planned test case description
   - The local dev server URL
   - Stable selectors from the project's design artifacts (prefer `data-testid`)
   - Negative constraints: no time-of-day greetings, no GenAI assertions for local
     verification, stable class/attribute selectors only
3. **Track the session** — local authoring takes 30–45 minutes. Launch detached and
   poll. Record the created `testId` on completion.
4. **Verify the new test** — run the authored test locally to confirm it passes
   against the current build.

If authoring is declined or deferred, proceed with the recommendation only.

### Step 7: Produce Coverage Report

Write **`mabl-verification-coverage-report.md`** to this stage's record dir:

For each inferred flow:
- Flow name and description
- Coverage status (covered / weakly-covered / uncovered)
- Severity (if uncovered)
- Recommendation (author / defer / none)
- Authored test id (if Step 6 produced one)

Include a machine-readable JSON summary:

```json
{
  "total_flows": 5,
  "covered": 3,
  "weakly_covered": 1,
  "uncovered": 1,
  "gaps": [
    {
      "flow": "Account transfer confirmation dialog",
      "severity": "critical",
      "recommendation": "author",
      "authored_test_id": null,
      "has_test": false
    }
  ],
  "gap_found": true,
  "critical_gap_count": 1,
  "ship_blocker": true
}
```

### Step 8: Open the Approval Gate

Run `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage mabl-verification-coverage-gap --result awaiting-approval`.

### Step 9: Present Completion & Request Approval

Completion emoji: :mag:
Review path: this stage's engine-resolved record dir.
Standard 2-option approval (Approve / Request Changes).
STOP for the human response. Report Approve with
`--result approved --user-input "<exact choice>"`; report
Request Changes with `--result rejected --user-input "<feedback>"`, revise the
artifacts, then report `--result revised` before re-presenting.

---

## Sensors

This stage binds the `mabl-coverage-threshold` sensor which reads the JSON summary
from `mabl-verification-coverage-report.md` and reports whether critical/normal gaps
exist. A critical gap with `has_test == false` is reported as an advisory finding
(the framework has no blocking sensor severity yet).

---

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under: Interpretations, Deviations, Tradeoffs, Open questions —
each with an ISO 8601 timestamp.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file.
