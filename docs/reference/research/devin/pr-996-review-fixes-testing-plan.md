# Testing Plan — PR #996 Review Fixes

## Purpose and execution status

Execute this plan after implementing [PR #996 Review Fixes](pr-996-review-fixes-implementation-plan.md). It verifies both generated configuration and runtime behavior: a registered hook or valid frontmatter alone is not proof of enforcement.

Prepared on 2026-09-05. This document defines planned verification; none of these tests is claimed to have run or passed.

## 1. Entry criteria and test environment

Before execution:

- Record the implementation commit, upstream baseline, operating system, Bun version, Devin CLI version, and Desktop version where applicable.
- Confirm implementation changes and intended generated distributions are present. Record `git status --short`; do not overwrite unrelated changes.
- Use disposable installed-project fixtures copied from `dist/devin/`, with deterministic workflow state, audit shards, and sentinel application files. Do not exercise denial or mutation cases against a real project.
- Use isolated test configuration for Claude coexistence and global-rule experiments. Do not edit the operator's real global configuration or disable repository security controls.
- Approve fixture hooks through the supported trust flow and fully restart Devin before live checks. Verify hooks are active with a known benign event.
- Disable live-model gates for deterministic suite execution. Obtain approval before live sessions that consume model credits or require external services.
- Preserve minimal redacted evidence; never retain credentials, private prompts, or unrelated global-rule contents.

### Environment matrix

| Environment | Required coverage |
|---|---|
| Linux with supported CLI | Deterministic suite and live CLI behavior |
| macOS with supported CLI | PATH discovery, live CLI smoke |
| macOS with Desktop | Bundled binary discovery and actual Desktop hook execution |
| Native Windows, where supported by project CI | Deterministic portability, path quoting, and missing-bundle behavior |
| Version stubs | Below-floor, exact-floor, newer, malformed, and failed version commands |
| Actual minimum supported CLI, if available | Live blocking compatibility at the advertised minimum |

Version stubs prove comparison logic, not historical CLI behavior. If an actual minimum-version binary cannot be tested, record that limitation and the documentary basis for the floor.

## 2. Execution order and commands

Run from the repository root. Capture command, exit code, duration, commit, and output for each run.

### A. Inspect committed output before regeneration

```bash
git status --short
bun scripts/package.ts --check
```

The initial drift check must pass. Do not hide stale committed output by regenerating first. If it fails, record the failure and return it to implementation.

### B. Focused regression tests

```bash
bash tests/run-tests.sh --unit --filter 't68-|t221-|t239-|t331-|t332-' --no-llm
```

Add the exact filenames introduced or extended for runner generation, persona projection, doctor discovery, onboarding size, plugin composition, and coexistence to the execution manifest. Run those tests in their actual tiers. The filter above is a starting set, not complete coverage; confirm every selected test actually ran.

### C. Full deterministic verification

```bash
bun run check
bash tests/run-tests.sh --ci --no-llm
bash tests/run-tests.sh --e2e --no-llm
```

`bun run check` includes packaging parity, type checking, and lint. `--ci` selects smoke, unit, and integration. `--no-llm` does not establish live CLI or Desktop coverage.

### D. Regeneration reproducibility

After the committed-output check has passed:

```bash
bun scripts/package.ts
bun scripts/package.ts --check
git diff --exit-code -- dist
```

Expected: regeneration produces no tracked distribution changes relative to the implementation commit. Any intentionally uncommitted generated changes must be resolved before final execution.

### E. Live validation

Execute sections 4–6 in disposable installations. Repeat failed live cases after correcting configuration; preserve the original failure evidence. A setup failure is BLOCKED, not PASS.

## 3. Deterministic test matrix

### T01 — Release metadata and integration

**Procedure:** Run the version/changelog synchronization test and initial packaging parity check. Review release metadata against the chosen upstream baseline.

**Expected:** Authored version, README badge, and newest changelog heading agree; no duplicate version headings; upstream entries are retained; all generated versions match. No manual distribution edits are needed.

### T02 — Inert usage registration removal

**Procedure:** Parse emitted Devin hooks and enumerate adapter targets by event. Assert neither PreToolUse nor PostToolUse invokes `fold-usage`. Exercise representative tool events with subprocess dispatch instrumentation in the fixture.

**Expected:** Zero `aidlc-fold-usage.ts` dispatches from Devin registrations; remaining required hooks still dispatch. Shared core availability and other harness wiring remain unchanged unless explicitly intended.

**Evidence:** Event-to-target inventory and dispatch trace. Timing may be reported as supporting evidence, but an arbitrary latency threshold is not the correctness gate.

### T03 — Realistic payloads and project resolution

**Procedure:** Run captured-shape fixtures without `cwd` or `transcript_path`; include measured `prompt_id` and `tool_use_id` on appropriate events. Set DEVIN_PROJECT_DIR to the fixture root while running from another directory, including a root containing spaces. Separately test no-environment fallback and any newly supported fallback precedence.

**Expected:** Writes and reads resolve to the intended fixture; session identity remains correct; no mutation occurs in the caller directory. Synthetic compatibility fields are clearly separated from captured cases. Every supported fallback matches the documented implementation.

**Negative cases:** Missing optional fields, unknown tool, malformed input, and unsupported event shape follow the documented adapter contract without accidental mutation. Do not change malformed-input policy merely to satisfy this plan.

### T04 — Subagent completion deduplication guard

**Procedure:** Deliver one valid run_subagent completion followed by two read_subagent polls for that delegate. Also deliver read_subagent directly to the log-subagent adapter target, bypassing matcher filtering.

**Expected:** Exactly one completion event attributable to the original run; polls append no completion events and no unknown-agent entries. Preserve the inner tool-name guard even if the matcher changes.

**Boundary:** This proves poll exclusion, not deduplication of repeated run_subagent deliveries unless the implementation explicitly promises that behavior.

### T05 — Matcher validity and coverage

**Procedure:** Parse emitted hook registrations; identify adapter targets independently of quoted command paths. Verify the relevant PreToolUse guards share compatible matcher coverage. Test empty matchers and any explicit read/write/shell matchers. Introduce an invalid named tool in a disposable packaging fixture.

**Expected:** Unknown named matcher tools fail validation with a useful error. Broad empty matchers remain valid. Reviewer-scope, review-freeze, and plan-approval registrations cover the intended tools; unrelated tools pass through. Every explicitly selected tool has a fixture or documented equivalent coverage.

### T06 — Actual guard enforcement

**Procedure:** Invoke guards through the emitted Devin adapter with realistic payloads against deterministic states:

| State | Attempt | Expected |
|---|---|---|
| Plan approval pending | Edit a protected application file | Denied; sentinel bytes unchanged |
| Plan approved through valid receipt | Same eligible edit | Allowed |
| Reviewer scope active | Read outside permitted scope | Denied |
| Reviewer scope active | Read within scope | Allowed |
| Review receipt freeze active | Write frozen deliverable | Denied; bytes unchanged |
| Freeze legitimately cleared | Same eligible write | Allowed |
| Protected workflow state | Direct unsupported state mutation | Denied |
| Valid framework transition | Authorized engine operation | Allowed |
| Any protected state | Unrelated supported benign tool | Not spuriously denied |

For each denial, assert the expected adapter blocking exit/output convention and intelligible reason. For allowed controls, assert successful intended behavior. Test relevant write and shell forms, not just a single edit payload. Do not fabricate a human approval receipt for the live acceptance test.

### T07 — User-only runner generation

**Procedure:** Enumerate mutating runners from graph/generator classifications rather than hard-coded counts. Parse each emitted Devin skill. Regenerate installed runners and repeat; include plugin-contributed runners where supported.

**Expected:** Every classified runner has exactly the intended `triggers: [user]` semantics. No duplicate or malformed frontmatter keys. Regeneration preserves restrictions. Non-Devin output is unchanged except approved shared changes.

### T08 — Persona projection

**Procedure:** Parse every emitted Devin persona, including relevant plugin composition output. Verify unsupported keys are absent and allowed-tools is well formed. Check representative developer, reviewer, and composer requirements against the intended role policy.

**Expected:** `run_subagent` is absent where delegation is prohibited; necessary read/write/shell tools remain available by role; unsupported `disallowedTools` and `maxTurns` claims do not remain in emitted profiles. Other harness restrictions are preserved.

### T09 — Doctor binary discovery and version evaluation

Use executable stubs and injectable discovery paths; do not modify real Desktop bundles or PATH-installed binaries.

| Case | Expected |
|---|---|
| Supported PATH binary; bundle also exists | PATH binary selected and source reported |
| PATH absent; supported macOS bundle | Bundle selected and version checked |
| Neither candidate exists | Explicit advisory: version not verified |
| Selected binary reports 3000.3.21 | Hard failure with upgrade guidance |
| Selected binary reports 3000.3.22 | Version check passes |
| Selected binary reports newer valid version | Version check passes |
| Selected binary exits nonzero | Failure; not missing-binary advisory |
| Selected binary returns malformed/empty output | Failure; not verified support |
| Non-macOS host, no PATH candidate | No assumed macOS bundle support; explicit advisory |
| Candidate path contains spaces | Correct invocation and parsing |
| Old PATH binary, newer bundle available | No silent masking of the selected old binary |

Assert doctor result status and useful output, not merely a substring containing “version.”

### T10 — Onboarding size and content

**Procedure:** Render every harness onboarding file and measure UTF-8 bytes. Check the agreed project-owned limit (proposed ≤12 KiB). Assert required startup/resumption, approval-boundary, artifact-location, and untrusted-document instructions remain. Check DocumentKB duplication is removed.

**Expected:** Every rendered file meets the selected limit; critical instructions occur early; no unresolved template tokens; referenced on-demand resources exist in a copied distribution. A static byte check is not treated as proof against all user-context truncation.

### T11 — Documentation and artifact hygiene

**Procedure:** Validate updated Devin guidance against emitted settings and doctor output. Search docs and README for stale versions, moved evidence paths, old usage-hook claims, unsupported persona keys, and model-invocable runner claims. Check links after any approved relocation.

**Expected:** Documentation states capability limitations, coexistence behavior, and version requirements accurately. Useful evidence remains accessible. No unrelated artifact is deleted without approval.

### T12 — Retained merged features and cross-harness regression

**Procedure:** Identify the existing runtime-release and `.devin` harness-resolution tests from the merged contribution, record their filenames, and rerun them. Exercise unreadable/missing harness metadata according to the supported fallback contract. Run the full deterministic matrix and applicable plugin composition tests.

**Expected:** Previously merged Devin behavior is retained; no unintended Claude fallback; other harnesses continue to pass their existing contracts. A comment saying a contribution merged is not itself proof that the feature still works.

## 4. Live Devin CLI acceptance

Record exact CLI build, fixture commit, trust configuration, commands/prompts, tool results, and before/after artifact hashes. Use actual tool execution results and filesystem/audit evidence; model narration alone is insufficient.

### L01 — Blocking and recovery

1. Start a supported CLI in a trusted fixture with plan approval pending.
2. Request a harmless edit to a protected sentinel file before approval.
3. Verify the hook blocks the tool, the reason is visible, and bytes are unchanged.
4. Complete the native human approval flow.
5. Repeat the same edit and verify success.
6. Exercise reviewer out-of-scope read and frozen-deliverable write cases with matching allowed controls.

**Pass:** Denial is enforced by the live harness and legitimate recovery works. A model voluntarily declining to call the tool does not prove blocking; mark that attempt inconclusive and use a controlled invocation or repeatable fixture driver.

### L02 — Runner invocation boundaries

1. Use an ordinary coding prompt without explicitly invoking an AIDLC runner.
2. Inspect exposed/discoverable skill invocation metadata where available and the actual tool trace.
3. Attempt model-initiated invocation of a user-only runner using a controlled harness test if available.
4. Invoke that runner explicitly as the user in a fresh fixture.

**Pass:** Model initiation is unavailable/refused by the supported trigger policy; explicit user invocation works and emits only the intended workflow boundaries. Merely observing that a model happened not to choose a runner is supporting evidence, not proof of restriction.

### L03 — Persona tool restrictions

1. Launch a representative restricted persona through the normal orchestrator path.
2. Verify delegation is not exposed or is refused by the harness.
3. Verify the persona can perform its legitimate role task.

**Pass:** Native restrictions prevent delegation without breaking required role tools. Prompt compliance alone does not establish tool enforcement.

### L04 — Hook dispatch and audit uniqueness

1. Perform one known eligible edit and one subagent run followed by repeated polls.
2. Inspect adapter dispatch and resulting audit events.
3. Confirm no usage-fold subprocess is launched.

**Pass:** Each expected logical event appears once; polling adds no completion records; remaining audit/sensor behavior works. Compare event identity/type, not total ledger line counts.

## 5. Coexistence and Desktop acceptance

### L05 — Claude/Devin coexistence

Use isolated projects/configuration; keep the real user configuration untouched.

1. Run a Devin-only installation and capture a known event's audit result.
2. Install both harness surfaces with default compatibility imports and characterize duplicate registration/execution.
3. Apply the documented method for selecting one AIDLC hook source.
4. Restart and repeat the same operation in a fresh fixture.

**Pass:** The documented configuration produces one logical audit event and retains required enforcement. Default coexistence behavior is documented accurately. Do not require the default mixed installation to deduplicate unless implementation explicitly provides that feature.

### L06 — Desktop binary discovery

1. On macOS with Desktop installed, hide standalone Devin from the fixture process PATH.
2. Run doctor against the fixture and record the chosen bundled binary/version.
3. Compare the discovered version with that binary's own version output.

**Pass:** Doctor discovers and evaluates the real bundle without relying on PATH. This does not prove Desktop hook execution.

### L07 — Actual Desktop hook execution

1. Open the trusted fixture through Desktop's actual agent interface.
2. Trigger a benign hook event and inspect evidence that the fixture hook ran.
3. Repeat L01's denied edit and approval recovery through Desktop.

**Pass:** Desktop itself executes the hooks, enforces blocking, and permits valid recovery. Running the bundled binary in a terminal is not a substitute. If unavailable or inconclusive, mark Desktop runtime support unverified and prohibit an unconditional support claim.

## 6. Live onboarding injection

### L08 — Always-on content retention

Test rendered onboarding in:

- An isolated clean global-rule context.
- An isolated context with substantial representative global rules, with exact byte counts recorded.
- An intentionally oversized positive-control rule to validate truncation detection.

For each case:

1. Place unique harmless sentinels near the beginning and end of the fixture onboarding file.
2. Start a fresh session and capture injected context through a supported diagnostic mechanism if available.
3. Otherwise ask for exact sentinel recall before permitting file reads and inspect the tool trace to ensure the model did not read the source file.
4. Check the exact marker `Rule content truncated`, rather than the generic word “truncated.”
5. Verify on-demand reference material can subsequently be read from the installed distribution.

**Pass:** Both sentinels and critical instructions are retained in tested normal contexts, on-demand links work, and the positive control validates the measurement technique. Model-only reports are weaker evidence: record their limits and repeat rather than asserting universal proof.

Do not infer a shared-budget architecture from these results alone. No onboarding size can guarantee retention under arbitrarily large user rules; report tested context sizes and observed limitations.

## 7. Regression sensitivity and evidence

For each major fix, retain implementation-time red/green evidence when available. If missing, use a disposable worktree or fixture to restore only the relevant old behavior and confirm the new targeted test fails. Do not revert the working branch or rewrite history.

At minimum demonstrate sensitivity for:

- Reintroducing either usage registration.
- Removing user-only runner triggers.
- Restoring the old doctor missing-binary behavior or version floor.
- Removing the inner subagent logging guard.
- Reintroducing oversized onboarding or removing a critical instruction.
- Removing persona delegation restrictions.

A test that still passes with its target defect restored is insufficient and must be strengthened.

Store results in an agreed evidence location or attach them to the PR. For every case record:

| Field | Required content |
|---|---|
| Test ID | T01–T12 or L01–L08 |
| Commit/environment | Exact tested revision and versions |
| Method | Command or reproducible live procedure |
| Expected/actual | Assertion and observed result |
| Status | PASS, FAIL, BLOCKED, or NOT RUN |
| Evidence | Redacted logs, dispatch trace, hashes, audit extracts, or screenshots |
| Follow-up | Defect or explicit limitation and owner |

Do not report BLOCKED or NOT RUN cases as passed. Reproduce suspected pre-existing failures on the selected upstream baseline in an isolated environment before classifying them as unrelated. Do not modify global Git/LFS configuration to force baseline tests through.

## 8. Exit criteria

### Implementation acceptance

- All deterministic cases pass, including new regression tests and cross-harness checks.
- Initial and post-regeneration parity checks pass.
- Relevant tests demonstrably detect their target defects.
- No new untriaged failures, unrelated file changes, or unapproved policy/configuration changes remain.
- Documentation and release metadata match implemented behavior.

### Runtime support acceptance

- Live CLI enforcement, approval recovery, runner restrictions, persona restrictions, audit behavior, and onboarding injection have evidence.
- Coexistence guidance is verified in isolation.
- Desktop support is claimed only if L06 and L07 pass; discovery alone is not sufficient.
- Any untested minimum-version or platform behavior is explicitly recorded.

A baseline exception requires documented evidence and maintainer acceptance; it is not an automatic pass. If a required live test remains blocked, report deterministic verification separately and leave the affected runtime capability unverified rather than declaring complete success.
