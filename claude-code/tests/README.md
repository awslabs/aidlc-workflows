# AI-DLC Test Registry

This file provides an LLM-discoverable index of every test in the suite. Each entry is extracted from the `# tNN:` comment header in the corresponding source file.

For the full test strategy, layers, fixtures, and assertion guidelines, see [docs/reference/09-testing.md](../docs/reference/09-testing.md).

## Cross-Platform

The suite runs on macOS, Linux, and Windows (via Git Bash for Windows). Validated on Windows Server 2022 for milestone 24: L1 passes 1273/1273 and `--all --debug` passes 1516/1516 identically to macOS. Portability conventions used throughout the suite:

- Use `create_test_project` from `lib/fixtures.sh` — it returns `cygpath -m` mixed-mode paths on Windows so JSON encoding and `bun` both work.
- Use `sed_i` helper, not `sed -i` (BSD/GNU incompatible).
- Guard LLM-dependent assertions with `CLAUDE_RC == 124` skip checks — see the `run_claude` docblock in `lib/fixtures.sh` and the t70/t71 examples.
- Avoid `grep -qiF` in favour of `grep -qi` (Git Bash combo-flag bug).

See [docs/reference/09-testing.md § Cross-Platform Coverage](../docs/reference/09-testing.md#cross-platform-coverage) for the full story.

## Test Registry

> **Note:** t19 appears in both unit (`t19-tool-jump.sh`) and integration (`t19-preflight-health.sh`). The integration t19 is the preflight gate; the unit t19 tests the jump CLI tool.

### Smoke (L1)

| Test ID | File | Description |
|---------|------|-------------|

### Unit (L1)

| Test ID | File | Description |
|---------|------|-------------|

### Feature (L1)

| Test ID | File | Description |
|---------|------|-------------|

### Integration (L2)

| Test ID | File | Description |
|---------|------|-------------|
| t19 | `integration/t19-preflight-health.sh` | Preflight health check — validates Claude CLI before integration tests |
| t20 | `integration/t20-integration-status.sh` | Integration test for /aidlc --status (7 tests) |
| t21 | `integration/t21-integration-init.sh` | Integration test for /aidlc --init — first run (10 tests) |
| t21b | `integration/t21b-integration-init-idempotent.sh` | Integration test for /aidlc --init — --force semantics (6 tests) |
| t22 | `integration/t22-integration-doctor.sh` | Integration test for /aidlc --doctor (10 tests) |
| t23 | `integration/t23-integration-help.sh` | Integration test for /aidlc --help (6 tests) |
| t24 | `integration/t24-integration-stage-jump.sh` | Integration test — forward --stage jump via claude CLI (12 tests) |
| t25 | `integration/t25-integration-phase-jump.sh` | Integration test — backward --phase jump via claude CLI (6 tests) |
| t26 | `integration/t26-integration-backward-jump.sh` | Integration test — backward jump via claude CLI (8 tests) |
| t27 | `integration/t27-integration-depth-override.sh` | Integration test — --depth flag override via claude CLI (7 tests) |
| t28 | `integration/t28-integration-test-strategy.sh` | Integration test — --test-strategy flag via claude CLI (6 tests) |
| t29 | `integration/t29-integration-env-scope.sh` | Integration test — AWS_AIDLC_DEFAULT_SCOPE env var via claude CLI (5 tests) |

### Stage (L2)

| Test ID | File | Description |
|---------|------|-------------|
| t70 | `stage/t70-stage-workspace-detection-greenfield.sh` | Stage test — workspace detection classifies greenfield stub (8 assertions, 25 turns) |
| t71 | `stage/t71-stage-workspace-detection-brownfield.sh` | Stage test — workspace detection classifies brownfield stub (10 assertions, 25 turns) |
| t72 | `stage/t72-stage-reverse-engineering.sh` | Stage test — reverse engineering on brownfield stub (15 assertions, 25 turns) |
| t73 | `stage/t73-stage-intent-capture.sh` | Stage test — intent capture with greenfield stub (12 assertions, 25 turns) |
| t74 | `stage/t74-stage-requirements-analysis.sh` | Stage test — requirements analysis with brownfield stub + RE artifacts (12 assertions, 25 turns) |
| t101 | `stage/t101-stage-memory-lifecycle.sh` | v0.5.0 milestone 13 — per-stage `memory.md` start→approval lifecycle on a gated stage. Asserts init-from-template fired at stage start (file exists, four canonical headings, verbatim blockquote ownership header), any logged observation carries an ISO-8601 prefix under a canonical heading, persist-on-approval (no cleanup), idempotent re-entry (a sentinel entry survives re-running the stage), `parseMemoryHeadings` ↔ disk agreement, and the hook-fired runtime-compile read seam carries `memory_path` on the stage row; LLM-output-dependent assertions skip on timeout or when the orchestrator approximated the copy (8 assertions) |

### Worktree (L2)

| Test ID | File | Description |
|---------|------|-------------|

### Workflow (L3)

| Test ID | File | Description |
|---------|------|-------------|
| t50 | `workflow/t50-workflow-bugfix-scope.sh` | Workflow test — bugfix scope full lifecycle via --test-run (24 tests) |
| t51 | `workflow/t51-workflow-poc-scope.sh` | Workflow test — POC scope via --test-run (19 tests) |
| t52 | `workflow/t52-workflow-state-progression.sh` | Workflow test — state file progression during bugfix (10 tests) |
| t53 | `workflow/t53-workflow-scope-routing.sh` | Workflow test — bugfix scope routing (skip Ideation) (11 tests) |
| t54 | `workflow/t54-workflow-audit-completeness.sh` | Workflow test — audit trail completeness during bugfix (10 tests) |
| t55 | `workflow/t55-workflow-init-then-resume.sh` | Workflow test — two-phase: --init then bugfix --test-run resume (8 tests) |
| t56 | `workflow/t56-workflow-forward-jump.sh` | Workflow test — forward jump + auto-init with --test-run (8 tests) |
| t57 | `workflow/t57-workflow-backward-jump.sh` | Workflow test — backward jump resets target + downstream stages with --test-run (5 tests) |
| t58 | `workflow/t58-workflow-workshop-scope.sh` | Workflow test — workshop scope routing (skip Ideation) (14 tests) |
| t59 | `workflow/t59-workflow-depth-override.sh` | Workflow test — depth override persists through bugfix workflow (6 tests) |
| t122 | `workflow/t122-stop-hook-e2e.sh` | v0.6.0 Wave 2 milestone 10 — workflow-tier END-TO-END enforcement of the Stop hook `aidlc-stop.ts`, the framework's FIRST flow-altering hook. Closes the one named-coverage gap left by the feature-tier MOCK test `t121` (which exercises the hook's block/done/guard logic against a MOCK engine): t122 runs the REAL hook against the REAL `aidlc-orchestrate` engine, including one genuinely live `claude -p` pass. A build-time probe confirmed the Stop hook fires under `claude -p` AND that block-and-inject resumes the same headless session — so this IS the live interactive path, not a simulation. Asserts: (e2e) `/aidlc --status` over a COMPLETED workflow (`state-completed`) runs to completion under the live Stop hook with no 124 hang, the session exits 0 reporting the workflow complete (the spec's "the loop runs to `done` under the hook end-to-end"), and — guarded on the durable heartbeat, since the skill-scoped Stop hook does not fire on every `-p` turn — the live hook took the `done`->allow path (`resetGuard` wrote `block-count.json` count 0); (real engine) a PENDING workflow (`state-final-stage`, final stage `[-]`) drives the real engine's real `run-stage` directive and the real hook emits a real `{"decision":"block"}` naming the pending stage + re-feeding the forwarding loop with no override-shaped verbs (the integration `t121`'s mock omits); (real engine) `done` -> empty stdout + exit 0; (real engine) recursion release — a genuinely-pending engine with the no-progress counter seeded AT the cap + `stop_hook_active:true` RELEASES the stop (empty stdout, exit 0, drop record), so a stuck loop never traps the session (light re-confirm; `t121` owns the exhaustive guard corpus). Requires the claude CLI (workflow tier); the human-stop Esc carve-out needs no test (SPIKE 1). (6 tests) |

## Test numbering

When adding a new test, pick the next free integer from the appropriate tier (unit, feature, integration, workflow, worktree). Don't gap-fill skipped numbers from prior PRs — drift-quintet (t55) catches the rename either way, and contiguous numbering keeps the registry readable.

If two parallel PRs both pick the same number, the second to merge rebases and renumbers to the next free integer in the same tier. The drift-quintet enforces five sites that must agree on `(N tests)` after a rename: file header line 1-3, TAP `plan N`, this README row, the `docs/reference/09-testing.md` row, and the README↔09-testing cross-check at `tests/feature/t55-test-suite-drift.sh`. Renaming touches all five.

## Quick Reference

```bash
# Run L1 (protocol — no LLM, seconds)
bash tests/run-tests.sh

# Run L1+L2 (protocol + stage — requires claude CLI)
bash tests/run-tests.sh --ci

# Run all layers (protocol + stage + workflow)
bash tests/run-tests.sh --release

# Run a single tier
bash tests/run-tests.sh --smoke
bash tests/run-tests.sh --unit
bash tests/run-tests.sh --feature
bash tests/run-tests.sh --integration
bash tests/run-tests.sh --stage
bash tests/run-tests.sh --workflow

# Filter by pattern
bash tests/run-tests.sh --integration --filter "t25|t26"

# Run tests concurrently within a tier (LLM tiers benefit most; smoke/unit stay serial)
bash tests/run-tests.sh --all --parallel 4
bash tests/run-tests.sh --integration -P 8

# Verbose / debug output
bash tests/run-tests.sh --verbose
bash tests/run-tests.sh --debug

# Run a single test directly
bash tests/smoke/t01-file-structure.sh
```
