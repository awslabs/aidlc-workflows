# Failure RCA Methodology

Methodology knowledge for root-causing failed mabl test runs against application
source code.

## The Flow

**resolve run → pull AI analysis → pull artifacts → correlate with source → classify + report**

## Step-by-Step Procedure

### 1. Resolve to a Concrete Failed Test Run

End state: a single failed `testRunId` (`-jr`) in a known workspace.

- Given a `-jr` → use directly
- Given a test id (`-j`) → `list_mabl_test_runs(testId)`, pick most recent `failed`
- Given a plan run (`-pr`) → `get_mabl_plan_run(planRunId)`, list failed test runs
- Given a mabl URL → extract the run id

### 2. Pull mabl's AI Failure Analysis

Call `analyze_mabl_failure(runId, 'test', workspaceId, includeEvidence: true)`.

Capture:
- **Synopsis** — one-line failure summary
- **Root cause + Next steps** — mabl's AI assessment
- **evidenceDetails** — contains `gs://` artifact URIs and historical data
- **Failing step** — which step, what assertion (expected vs actual)
- **Target** — the selector, URL, or network request that failed

Check if the Runtime Recovery Agent (auto-heal) was involved — a "passed via healing"
run signals selector drift worth fixing at the source.

### 3. Pull Supporting Artifacts

**Via MCP (surgical):** `get_mabl_test_run_artifact(artifactUri, workspaceId)`
- Screenshot at failing step → rendered visual state
- DOM snapshot → confirm element presence/absence
- Console logs → JS exceptions
- HAR → network requests (status, payload, response)

**Via CLI (bulk):**
```bash
mabl test-runs export <testRunId> --types doms hars console_logs screenshots --file "$DIR/run"
```

⚠️ Filter before grepping: `awk 'length($0) < 300'` first (base64 payloads).

### 4. Correlate with Source Code

Map each evidence piece to the application source:

| Evidence | Correlation |
|----------|-------------|
| Selector target (failing find/assertion) | Grep front-end for `data-testid`, label text, `aria-label`, role, `id` |
| Network failure (4xx/5xx from HAR) | Map request path to API route/controller |
| Console exception | Map stack trace to source file:line |
| DOM vs expectation (empty/error state) | Follow data path: component → fetch → endpoint |

**Blame window:** Using "since green" history, `git log --oneline <lastGreen>..<rev>`
on implicated files and `git blame` to surface likely culprit commits.

### 5. Classify the Failure

Assign exactly one verdict with a confidence score (0–1):

| Verdict | Meaning | Fix |
|---------|---------|-----|
| `product` | App code broke a real behavior | Fix the app code (human-gated) |
| `stale-test` | UI/contract changed intentionally | Update the test selector/assertion |
| `env-data` | Seed data, creds, config, or down dependency | Reset precondition or fix env |
| `mabl-flake` | Race condition or non-deterministic behavior | Retry; if persists, reclassify |

**Distinguishing signals:**
- Element present but text/attribute changed → `stale-test`
- Element absent + component conditionally rendered → check gate condition
- 500 response + new/changed handler → `product`
- Same test passes on rerun → `mabl-flake` (correlate with historical pass rate)
- Wrong user state (already tracked, wrong persona) → `env-data`

### 6. Deliver the Report

1. **Verdict** with confidence
2. **Failing step & assertion** — expected vs actual in plain terms
3. **Evidence trail** — each conclusion tied to its artifact
4. **Pinpointed cause** — `file:line` in the repo + suspect commits
5. **Recommended fix** — concrete diff sketch
6. **Links** — mabl run URL and result-analysis session

## Common Traps

- **"Element not found" often means wrong app state, not missing element.** Lists
  that filter by state hide controls (e.g. "Add" button missing because item is
  already added). Check the live page before blaming the diff.

- **A headless re-run cannot isolate cause.** It shows symptoms, not root cause.
  Use a live step-through (`mabl agent debug session start`) for definitive blame.

- **GenAI assertion failures in local runs are harness limitations.** Never classify
  a GenAI-only failure as a product regression unless `--allow-billable-features`
  was passed and it still failed.

- **Auto-heal masks drift.** If the Recovery Agent healed a step, the run "passed"
  but the selector drifted — flag it as an `autoHealCandidate` for proactive fix.
