---
target: build-and-test
plugin: mabl-verification
adds:
  produces:
    - mabl-verification-local-run-log
  consumes:
    - artifact: mabl-verification-coverage-report
      required: false
  sensors:
    - mabl-run-status
  required_sections:
    - "mabl Verification"
fragments:
  - anchor: after-step:10
    order: 200
  - anchor: in:Sensors
    order: 200
---

## fragment: after-step:10

### Step 10a (mabl-verification): Quick smoke-check against mabl

After the build passes and unit/integration tests are green, run a quick mabl
smoke-check to catch regressions the unit tests structurally cannot see (e.g.
selector drift, broken user flows, visual regressions).

1. **Detect the closest mabl test.** Using the changed files from the build context,
   identify the single most relevant mabl test via MCP `search_mabl_tests` (one
   natural-language query derived from the primary changed component/page). If no
   match, skip this step and note the gap for the downstream
   `mabl-verification-coverage-gap` stage.

2. **Run it locally.** Execute the matched test against the local dev server:
   ```bash
   mabl tests run \
     --id <testId> \
     -w <workspaceId> \
     --url <localUrl> \
     --application-id <applicationId> \
     --reporter mabl
   ```
   Parse `Passed:`/`Failed:` from the log (exit code is unreliable).

3. **Record the result.** Write a brief `mabl-verification-local-run-log.md` with:
   - Test name and id
   - Status (pass / fail / billable-skip)
   - Failing step (if any)
   - mabl app link to the published run

   This is a lightweight signal — full triage, multi-test runs, and coverage analysis
   happen in the dedicated `mabl-verification-pre-pr` stage. If the smoke-check fails,
   note it but do NOT block the build-and-test stage (the pre-pr stage handles triage).

4. **GenAI/visual assertions.** Local CLI runs disable these by default. If the
   matched test's only assertions are GenAI/visual, skip the run (it would produce a
   false-negative) and note that the test requires `--allow-billable-features` for
   meaningful local verification.

## fragment: in:Sensors

The mabl-verification plugin wires the `mabl-run-status` sensor onto this stage.
It reads `mabl-verification-local-run-log.md` (when present) and REPORTS the
smoke-check outcome — pass, fail, or skipped. This is ADVISORY: a local mabl
failure here does not block the build-and-test stage (the full verification pipeline
runs in `mabl-verification-pre-pr`). Treat the finding as early signal for triage
routing.
