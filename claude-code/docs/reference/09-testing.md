# Testing

## Overview

The AI-DLC test suite is organized as a three-layer pyramid that balances speed vs. thoroughness.

```
            /\
           /  \    ACCEPTANCE — full workflows, artifact + experience verification
          / L3 \   When: before releases (weekly or pre-merge to main)
         /------\
        /        \
       /   L2     \  STAGE — individual stages with stub input, verify artifacts
      /------------\ When: CI push (every PR)
     /              \
    /      L1        \  PROTOCOL — contracts, structure, cross-references
   /------------------\ When: every local change
```

## Layer 1: Protocol (every change, no LLM, seconds)

Verifies the orchestrator's structural correctness without invoking the LLM. If these pass, the protocol is internally consistent — stages reference valid files, inputs/outputs chain correctly, routing tables match stage files.

**Tiers:** smoke, unit, feature

**What it tests:**
- File existence, permissions, naming conventions (smoke)
- Hook scripts (10 TypeScript via bun), stage frontmatter, knowledge inventory (unit)
- Scope-stage mapping, graph consistency, stage I/O contract chains, protocol compliance (feature)
- Stage output-to-step validation: all declared outputs referenced in instruction steps (feature, deterministic via the `aidlc-validate.ts` CLI tool)

**Run:** `bash tests/run-tests.sh` (default, no flags needed)

## Layer 2: Stage (CI push, LLM, minutes)

Runs individual stages in isolation with known workspace + state fixtures. Verifies each stage produces correct artifacts when given deterministic input.

**Tiers:** integration, stage

**What it tests:**
- Preflight health gate: Claude CLI on PATH, AWS credentials valid, Claude responds (exit 0), response non-empty (preflight)
- CLI tool utility handlers: --init, --doctor, --status, --stage, --phase (integration)
- Individual stages with greenfield/brownfield stubs, artifact verification (stage)

**Run:** `bash tests/run-tests.sh --ci`

## Layer 3: Acceptance (release, LLM, hours)

Runs full workflows and verifies the experience: beyond state transitions, it checks artifact content, cross-stage coherence, and domain correctness.

**Tiers:** workflow

**What it tests:**
- Full bugfix lifecycle with brownfield stub + artifact assertions
- Full POC lifecycle with greenfield stub + artifact assertions
- State progression, scope routing, audit completeness, jump mechanics
- LLM semantic review of stage instruction quality (clarity, logical flow, ambiguity detection)

**Run:** `bash tests/run-tests.sh --release`

## Cross-Platform Coverage

The test suite runs on macOS, Linux, and Windows (via Git Bash). At runtime this implementation's hooks and CLI tools only require `bun` — the Bash dependency is strictly a test-harness concern. The same `tests/run-tests.sh` script executes identically on all three platforms.

**Validated milestone 24 (2026-04-17)** on Windows Server 2022 via EC2 SSM:

| Tier | macOS | Windows Server 2022 | Notes |
|---|---|---|---|
| L1 (smoke + unit + feature) | 1273 / 1273 | 1273 / 1273 | Identical |
| L1 + L2 + L3 (`--all --debug`) | 1516 / 1516 | 1516 / 1516 | Identical after the portability fixes in this PR |

**Portability constraints baked into the suite:**

- **Paths**: `create_test_project` in `tests/lib/fixtures.sh` uses `cygpath -m` on Windows to return forward-slash absolute paths (`C:/Users/.../aidlc-test-X`). These round-trip cleanly through JSON (backslash escapes are an error in JSON) and are readable by both Git Bash utilities and native Windows `bun`.
- **In-place sed**: `sed -i ''` is BSD-only; `sed -i` is GNU-only. Use the portable `sed_i` helper in `tests/lib/fixtures.sh` — it writes to a tempfile and `mv`s, which behaves identically on every platform.
- **`grep -qiF`**: Git Bash has a known bug combining `-i` and `-F`. Use `-i` alone if your pattern has no regex metacharacters. Tests hit this in t16 before it was fixed.
- **`tar` archives**: macOS `tar` injects `._*` AppleDouble sidecar files by default. When bundling source for cross-platform test runs, use `COPYFILE_DISABLE=1 tar …` or `git archive`.
- **LLM timing on Windows**: Bedrock calls from Windows EC2 can be meaningfully slower than from macOS (first-call cold start, MSYS process fork overhead). Tests that invoke `claude -p` should respect the `CLAUDE_RC` convention documented in `tests/lib/fixtures.sh` — skip post-condition assertions when `CLAUDE_RC == 124` (timeout) rather than failing loudly on incomplete state. t70/t71 are canonical examples.

**Running the suite on Windows:**

1. Install Git for Windows (provides Git Bash + GNU coreutils `timeout`).
2. Install `bun` — prefer the official PowerShell installer or release zip over `npm install -g bun`, which can silently fail under unattended provisioning (SYSTEM account).
3. For L2/L3 only: install the Claude Code CLI with the native installer — PowerShell `irm https://claude.ai/install.ps1 | iex`. It drops a standalone `claude` binary on your user PATH and auto-updates. Ensure that PATH entry is also visible to Git Bash (a Machine/User PATH entry is; a PowerShell-session-only one is not) so `claude` resolves from the bash test runner.
4. Run `bash tests/run-tests.sh [--ci | --all]` from Git Bash.

No WSL. No Docker. Native Windows works.

## Preflight Validation

Before running any LLM-dependent tier (integration, stage, or workflow), the runner executes `t19-preflight-health.sh` as a gate. If the preflight fails, all LLM tiers are skipped.

| # | Assertion | On fail |
|---|-----------|---------|
| 1 | `claude` CLI on PATH | bail — no point continuing |
| 2 | `claude -p "echo ok"` exits 0 | bail — API unreachable |
| 3 | Response is non-empty | bail — API unresponsive |

After critical assertions pass, the script logs advisory diagnostics as TAP comments:
- **Response time** — warns if > 30s (API degradation)
- **Skill loading** — runs `/aidlc --help` and reports whether "AI-DLC" appeared

Advisory failures don't affect the exit code or gate. They appear in `--verbose` logs for debugging degradation.

## Test Registry

Complete inventory of all test files across tiers. Each entry is extracted from the `# tNN:` comment header in the source file.

> **Note:** t19 appears in both unit (`t19-tool-jump.sh`) and integration (`t19-preflight-health.sh`). The integration t19 is the preflight gate; the unit t19 tests the jump CLI tool.

### Smoke Tests

| Test ID | File | Description |
|---------|------|-------------|
| t01 | `tests/smoke/t01-file-structure.sh` | Verify all expected files exist in dist/claude/.claude/ |
| t02 | `tests/smoke/t02-hook-executability.sh` | All 10 hooks are present (all .ts, run via bun — no executable bit needed) |
| t03 | `tests/smoke/t03-settings-json.sh` | settings.json schema validation |
| t04 | `tests/smoke/t04-shell-lint.sh` | Guard two shell anti-patterns in tests/ (#34 trailing `[ ] && action`, #41 unbraced `$VAR` + non-ASCII) (2 tests) |
| t05 | `tests/smoke/t05-run-tests-parallel.sh` | Smoke guard for `--parallel N`: invalid-value handling, serial-vs-parallel parity, interleaving detection, failure propagation, sidecar cleanup, plus `--worktree` tier dispatch under `--ci` (14 tests) |
| t06 | `tests/smoke/t06-claude-md-paths.sh` | Distributable CLAUDE.md describes post-Wave-1 layout — no legacy `practices/`, `aidlc-knowledge/`, or `rules/aidlc/guardrails/` paths; mentions `.claude/sensors/` and `aidlc-org` rule file (6 tests) |
| t86 | `tests/smoke/t86-stage-protocol-section-13.sh` | v0.5.0 milestone 4 (+ milestone 16) — stage-protocol §13 (Learnings Ritual) prose pin + MEMORY_EMPTY registry placement + the SKILL.md run-stage-gate-branch wiring that makes the orchestrator call the gate; asserts `## 13. Learnings Ritual` heading, four canonical memory.md headings, two-surface learnings + `sensors:` bind (no `applies_to` fossil), MEMORY_EMPTY in three sources (TS / audit-format.md / 12-state-machine.md), the immutability invariant subsection, the SKILL.md gated run-stage branch call to `aidlc-learnings.ts surface` + `persist` (test-run-guarded), and the Test-Run-block §13 skip declaration (7 tests) |
| t119 | `tests/smoke/t119-skill-md-line-budget.sh` | v0.6.0 Wave 2 milestone 8 — `SKILL.md` stays under the Agent Skills 500-line ceiling after the engine-forwarding-loop cutover (was 895 lines). Pins the 500 CEILING, not the actual landing (a later increment collapses the body further). `wc -l` ≤ 500 (1 test) |
| t123 | `tests/smoke/t123-skills-spec-conformance.sh` | v0.6.0 Wave 3 milestone 11 (+ milestone 13 + milestone 14) — smoke-tier half of the "smoke + unit" conformance promise: a fast structural sweep over EVERY shipped skill dir (the unit `t123` owns the same invariants with the full parser). Derives the expected set as the unit test does — 4 base + 4 first-batch scope-runners + 29 graph-derived stage-runners (init excluded) + `aidlc-init` — dir-count guard catches an unplanned skill; per skill asserts SKILL.md exists, `name` == dir, `description` present, no `hooks:` block, body ≤ 500 lines. No LLM (191 tests: 1 + 5 per skill × 38) |
| t130 | `tests/smoke/t130-scope-runners.sh` | v0.6.0 Wave 3 milestone 13 — generated scope-runner skills (structural). Per first-batch runner (`aidlc-bugfix`/`-feature`/`-mvp`/`-security-patch`): SKILL.md exists, `name` == dir, `description` present, no `hooks:` block, body ≤ 500 lines, shell drives `aidlc-orchestrate next --scope <scope>`; plus `aidlc-runner-gen.ts scopes --check` drift-clean, a non-batch scope has no runner, and a dropped scope file makes the generator emit its runner (24 tests) |

### Unit Tests

| Test ID | File | Description |
|---------|------|-------------|
| t04 | `tests/unit/t04-agent-frontmatter.sh` | 11 agents have valid frontmatter (55 tests) |
| t05 | `tests/unit/t05-stage-files.sh` | 32 stages parse to slug + phase matching filename and directory (64 tests: 2 per stage) |
| t06 | `tests/unit/t06-skill-frontmatter.sh` | SKILL.md frontmatter valid (9 tests) |
| t07 | `tests/unit/t07-hook-audit-logger.sh` | Unit tests for audit-logger.ts via bun (16 tests) |
| t08 | `tests/unit/t08-hook-validate-state.sh` | Unit tests for validate-state.ts via bun (14 tests) |
| t09 | `tests/unit/t09-hook-log-subagent.sh` | Unit tests for log-subagent.ts via bun (8 tests) |
| t10 | `tests/unit/t10-hook-session-start.sh` | Unit tests for session-start.ts via bun (17 tests) |
| t11 | `tests/unit/t11-hook-statusline.sh` | Unit tests for aidlc-statusline.ts (62 tests) |
| t13 | `tests/unit/t13-hook-input-robustness.sh` | Adversarial input testing for the framework's stdin-driven hooks via bun (20 tests) |
| t14 | `tests/unit/t14-stage-content-validation.sh` | Validates content structure inside each of 32 stage files (160 tests) |
| t15 | `tests/unit/t15-knowledge-file-inventory.sh` | Validates knowledge file inventory and non-emptiness (~80 tests) |
| t16 | `tests/unit/t16-phase-rules-structure.sh` | Phase rules file structure validation (12 tests) |
| t17 | `tests/unit/t17-tool-state.sh` | Unit tests for aidlc-state.ts CLI tool (83 tests) |
| t18 | `tests/unit/t18-tool-audit.sh` | Unit tests for aidlc-audit.ts CLI tool (13 tests) |
| t19 | `tests/unit/t19-tool-jump.sh` | Unit tests for aidlc-jump.ts CLI tool (16 tests) |
| t20 | `tests/unit/t20-unit-workspace-scanner.sh` | Unit tests for the deterministic workspace scanner + --force semantics inside aidlc-utility init (21 tests) |
| t26 | `tests/unit/t26-delivery-agent-timeline-guardrail.sh` | Content guardrail — aidlc-delivery-agent surface must not use human-timeline framing (dynamic) |
| t27 | `tests/unit/t27-tool-utility.sh` | Unit tests for aidlc-utility.ts CLI tool (81 tests) |
| t28 | `tests/unit/t28-audit-event-sync.sh` | Validates audit event types are in sync between aidlc-audit.ts and audit-format.md (7 tests). See [State Machine](12-state-machine.md) for the canonical taxonomy this test guards. |
| t29 | `tests/unit/t29-hook-sync-statusline.sh` | Unit tests for sync-statusline.ts via bun (7 tests) |
| t30 | `tests/unit/t30-hook-session-end.sh` | Unit tests for session-end.ts hook (7 tests) |
| t31 | `tests/unit/t31-tool-log.sh` | Unit tests for aidlc-log.ts (decision, answer subcommands) (21 tests) |
| t33 | `tests/unit/t33-tool-bolt.sh` | Unit tests for aidlc-bolt.ts (start, complete, fail, set-autonomy) (25 tests) |
| t34 | `tests/unit/t34-tool-error-logged.sh` | Unit tests for ERROR_LOGGED emission via lib.ts emitError() across tool CLIs (11 tests) |
| t35 | `tests/unit/t35-tool-recovery-completed.sh` | Unit tests for RECOVERY_COMPLETED emission via acknowledge-compaction flow (11 tests) |
| t36 | `tests/unit/t36-utility-scope-change.sh` | Unit tests for /aidlc --scope <x> mid-workflow scope change (7 tests) |
| t37 | `tests/unit/t37-utility-doctor-drift.sh` | Unit tests for --doctor drift detection + graph-level checks (23 tests) |
| t38 | `tests/unit/t38-utility-status-gate-awareness.sh` | Unit tests for /aidlc --status gate awareness — who is the blocker (5 tests) |
| t46 | `tests/unit/t46-agent-no-numeric-stage-ids.sh` | Agent files reference stages by slug, not numeric ID (22 tests) |
| t60 | `tests/unit/t60-valid-scopes-derived.sh` | Scope validation derives from `.claude/scopes/*.md` presence (milestone 12); dropped fixture-scope `.md` flow (9 tests) |
| t61 | `tests/unit/t61-agent-metadata-derived.sh` | Agent display name + examples derive from `.claude/agents/*.md` frontmatter (5 tests) |
| t62 | `tests/unit/t62-stage-schema.sh` | Stage frontmatter schema — 13 fields, types, enums, reserved keys + reserved `orchestrator` pseudo-agent exemption from the agent cross-check (62 tests) |
| t63 | `tests/unit/t63-tool-graph.sh` | Unit tests for aidlc-graph.ts `artifactsRegistry()` + `artifacts` CLI (14 tests) |
| t64 | `tests/unit/t64-stage-parser.sh` | Unit tests for `parseStageFrontmatter` and `emitStageFrontmatter` (45 tests) |
| t67 | `tests/unit/t67-scope-table.sh` | aidlc-utility `scope-table` subcommand emission (rows match `.claude/scopes/*.md` count post-PR-12) + `--check` drift guard + `detect-scope --from-text` keyword inference from `.md` frontmatter (28 tests) |
| t68 | `tests/unit/t68-version-changelog-sync.sh` | Validates `AIDLC_VERSION` in `version.ts` agrees with the latest `## [N.N.N]` heading + link reference in `CHANGELOG.md`, no duplicate headings, CLI output matches, and the `README.md` version badge matches `version.ts` (6 tests) |
| t69 | `tests/unit/t69-worktree-path.sh` | Behavioural contract for `worktreePath(projectDir, boltSlug)` — `.gitignore` anchored `/.aidlc/` entry, output absolute, output ends `/bolt-<slug>`, slug passes through unsanitised (4 tests) |
| t70 | `tests/unit/t70-worktree-kb-and-skill.sh` | v0.4.0 milestone 7 KB rewrites + pipeline-deploy agent wiring — `shared/rules-reading.md` + `branching-strategies.md` runbook structure; aidlc-pipeline-deploy-agent practices-loading position. (The former SKILL.md per-Bolt Steps 0/0.5/6.5/6.75 + halt-and-ask shape assertions were retired at the engine cutover — that prose moved into the engine; covered by the t118 corpus.) (9 tests) |
| t71 | `tests/unit/t71-markdown-section-helpers.sh` | Behavioural contract for `extractMarkdownSection` / `appendUnderHeading` / `replaceSection` in `lib.ts`; load-bearing for milestone 8 practices-discovery cross-row promotion (12 tests) |
| t72 | `tests/unit/t72-worktree-info.sh` | v0.4.0 milestone 12 — deterministic contract for `aidlc-worktree info --slug` halt-and-ask correlation lookup; pins JSON shape, most-recent semantics on multiple matching blocks, non-zero exit + stderr on miss/malformed (10 tests) |
| t76 | `tests/unit/t76-state-fork-merge.sh` | Behavioural contract for `aidlc-state.ts fork` / `merge` (v0.4.0 milestone 9 state fork/merge) — byte-identical round-trip, slug validation, audit-first Parts A+B, alphabetical-slug tiebreak, idempotency, lock timeout, concurrent forks; B1/B2/M1 fold-in regressions (16 tests) |
| t77 | `tests/unit/t77-bolt-worktree-flags.sh` | v0.4.0 milestone 11 — `aidlc-bolt.ts` worktree flag branches; atomicity ordering, complete 5-field envelope shape, abort sub-classifier, default-abort worktree preservation, regression guards (28 tests) |
| t79 | `tests/unit/t79-dispatch-event-validation.sh` | v0.4.0 milestone 13 — `aidlc-bolt dispatch-event` subcommand contract for the three pre-registered MERGE_DISPATCH_* audit events; literal-per-branch `appendAuditEntry` calls (t48 invariant), per-variant flag validation, JSON envelope shape, audit-row schema fields per audit-format.md:147-149 (12 tests) |
| t80 | `tests/unit/t80-practices-runtime.sh` | v0.4.0 milestone 13 — extractMarkdownSection regex edges (lib.ts:1081) + practices-event --type empty emit; pins helper behaviour for body-less section, comments-only body, trailing-whitespace headings, sub-heading collision; PRACTICES_SECTION_EMPTY emit via the new fourth case; post-merge fold-in: helper ignores `## Heading` lines inside fenced code blocks (7 tests) |
| t81 | `tests/unit/t81-bolt-plan-override.sh` | v0.4.0 milestone 13 — discriminator-field disambiguation for PRACTICES_OVERRIDE (v5 §3a); pins that practices-event --type override accepts milestone 13's full field set; t28 audit count stays at 55 (no new event); milestone 8 write-failure path coexists with milestone 13 marker-conflict path under the same event name (4 tests) |
| t82 | `tests/unit/t82-hold-merge-invariant.sh` | v0.4.0 milestone 13 post-merge fold-in — HOLD-MERGE invariant tooling on aidlc-bolt.ts; pins hold-merge / release-merge subcommands set Merge-Held in the per-Bolt forked state file, complete --merge refuses with `reason:"merge-held"` envelope while held, refusal does not emit BOLT_COMPLETED, merge proceeds after release-merge, hold-merge errors when the Bolt has no per-Bolt forked state (10 tests) |
| t83 | `tests/unit/t83-doctor-orphan-worktree.sh` | v0.4.0 milestone 15 doctor orphan-reconciliation family (Checks 1, 3, 4, 6) — orphan worktrees (incl. preserved-by-abort sub-classification), orphan state files, orphan audit (incl. PRACTICES_OVERRIDE Reason discriminator routing per audit-format.md:138 + ms-precision AFFIRMED reconciliation + unknown-Reason advisory), MERGE_DISPATCH_INVOKED pair-matched advisory pass=true (multi-INVOKED + 1 RETURNED reports 1 orphan); merged-and-cleaned Bolts do not flag (regression for terminal-short-circuit hoist); fail-clean on no-worktrees per issue 75 line 215 (16 tests) |
| t84 | `tests/unit/t84-doctor-stale-branch.sh` | v0.4.0 milestone 15 doctor stale-branch detection (Check 2) — skips silently when not a git repo; flags `bolt-<slug>` branches whose worktree dir is gone but no terminal WORKTREE_DISCARDED/WORKTREE_MERGED audit row landed (5 tests) |
| t85 | `tests/unit/t85-doctor-practices-staleness.sh` | v0.4.0 milestone 15 doctor practices-staleness check (Check 5 per milestone 6 forward-note) — empty/template-default reads as never-affirmed; within `PRACTICES_STALENESS_DAYS` (90) passes ✓ with day count; beyond is advisory pass=true; invalid ISO 8601 string flagged readable; future-dated timestamp produces clock-skew advisory (6 tests) |
| t86 | `tests/unit/t86-sensor-manifest-schema.sh` | v0.5.0 milestone 3 + milestone 7b sensor manifest schema — pins filename↔id contract, `kind: deterministic` enum, `command:` canonical invocation prefix, `applies_to` ABSENCE (pull authoring), `default_severity`/`description` presence across the 4 framework manifests; legacy negative fixtures cover unknown-kind, applies_to-still-present, missing `id:` (28 tests) |
| t87 | `tests/unit/t87-stage-compartment-headers.sh` | v0.5.0 milestone 5 — every stage file under `aidlc-common/stages/` contains both `^## Sensors$` and `^## Learn$` H2 headings. Sentinel against future stage authors silently omitting compartments (64 tests) |
| t88 | `tests/unit/t88-parse-memory-headings.sh` | v0.5.0 milestone 8 — `parseMemoryHeadings()` in `aidlc-lib.ts` counts entries under each of the four canonical §13 H2 headings (Interpretations / Deviations / Tradeoffs / Open questions). Pure function shared by milestone 8's runtime-compile, milestone 12's gate ritual, and milestone 13's lifecycle. Covers empty input, mixed bullets/prose/ISO lines, fenced-code/blockquote/HTML-comment exclusion, non-canonical-heading termination, CRLF/BOM tolerance, exact-match heading strictness (18 tests) |
| t94 | `tests/unit/t94-sensor-fire-hook-unit.sh` | v0.5.0 milestone 10 — PostToolUse Write|Edit hook `aidlc-sensor-fire.ts` 12-step flow. Asserts TTY/stdin-parse/empty-path guards, `.aidlc-sensors/` recursion guard, audit + state-existence pre-init guards, Test Run Mode skip (sensor-fire.skipped append), heartbeat ISO-timestamp shape, missing/`none` Current Stage early-exit, missing stage-graph + stage-not-in-graph guards, empty `sensors_applicable` (workspace-scaffold), and G1 lock-in (entries without `matches` do not fire) (18 tests) |
| t96 | `tests/unit/t96-runtime-fragment-primitives.sh` | v0.5.0 milestone 11 — `aidlc-runtime fragment-fork` / `fragment-merge` primitives; asserts fragment-fork happy path + source-absent fallback + one-shot guard + worktree-missing guard + slug validation; fragment-merge happy path + idempotent fragment-absent path + slug validation + defensive fragment-absent on missing worktree; --help lists both subcommands; --project-dir plumbing in spawnSibling-style invocation order (B1 prerequisite for the bolt-start wiring) (14 tests) |
| t97 | `tests/unit/t97-learnings-primitives.sh` | v0.5.0 milestone 12 — `aidlc-learnings.ts` primitives + new `parseMemoryEntries` parser (one-entry-per-counted-line, `length === parseMemoryHeadings.total` invariant); subcommand contract (`--help`, unknown → 2, missing flags → 1); `surface` partition (candidates vs parked open questions, test-run skip, slug-not-Active → 1); `persist` (project/team scope routing + cid-marker idempotency, two-write sensor bind, framework-tier rejection, free-text source tagging, recovery, false-negative guard, test-run skip) (32 tests) |
| t100 | `tests/unit/t100-memory-template-lifecycle.sh` | v0.5.0 milestone 13 — per-stage `memory.md` template structure + parser-safety + `aidlc-state.ts` advance/approve `memory_path` JSON key; asserts the template exists with the four canonical `## ` H2 headings (lowercase-q `## Open questions`, column 0, no stray heading), a verbatim blockquote ownership header, and single-line HTML-comment seed examples so `parseMemoryHeadings(template)` returns `total === 0`; append one bullet → `total === 1`; `advance` JSON carries `memory_path === aidlc-docs/<phase>/<slug>/memory.md` (forward-slash, relative) and `approve` inherits it via `handleAdvance` delegation (19 tests) |
| t103 | `tests/unit/t103-doctor-rule-drift-coverage.sh` | v0.5.0 milestone 14 — doctor rule-drift + paired-coverage primitives; asserts `loadRules()` surfaces `frontmatter.pairing` (consumer) + `validateRuleFrontmatter` rejects bad shapes; `parseRuleHeadings` (private in `aidlc-graph.ts`, surfaced via `RuleFile.headings`) splits `## ` bodies and skips fenced / blockquote / single-line AND multi-line `<!-- -->` comments (`## Corrections` multi-line-comment-only → empty); `.headings` is the `AIDLC_RULES_DIR` read seam; rule-drift detect (populated org `## Testing Posture` overlap, empty-/absent-org no-overlap, `*-learnings.md` participation); paired-coverage prefix-strip, unpaired ghost, feedforward-only in X, M-X=0 branch, determinism (19 tests) |
| t110 | `tests/unit/t110-mcp-server-grants.sh` | MCP registry integrity + the inheritance access model — `.mcp.json` exists and is valid JSON; declares exactly the 5 expected public servers (`context7`, `aws-mcp`, `aws-pricing`, `aws-iac`, `aws-serverless`) as the sole top-level key whose value is a non-null object (no 6th entry, no stray sibling key, no array/null shape); `threat-composer-ai` is intentionally absent (deferred); each server's config shape is usable (context7 is `type: http` with a url + `CONTEXT7_API_KEY` header; each aws-* is `command: uvx` with a non-empty args array whose first element is the expected `<pkg>@latest`, and aws-mcp carries `AWS_REGION=us-east-1`); no committed secrets (every credential-position header value is a `${VAR}` placeholder and no high-entropy/literal-key shape appears anywhere); and the inheritance invariant — no agent carries a bare `mcp__<server>` grant token, and every fully-qualified `mcp__<server>__<tool>` entry names a declared server (servers are inherited, not per-agent-granted; bare tokens are no-ops; fully-qualified restriction entries are permitted but must reference a live server). Deterministic, bun-only (no `jq`) (32 tests) |
| t112 | `tests/unit/t112-learnings-distribution-guard.sh` | v0.6.0 milestone 0 — `isFrameworkDistributionPath` guard recognises the relocated framework tree after the `aidlc-claude-code/` → `dist/claude/` move. Behavioural (guard is internal): `aidlc-learnings.ts persist` with a sensor-binding selection refuses a `--project-dir` ending in `dist/claude` (exit 1, no manifest scaffolded) and accepts an ordinary project path (exit 0, manifest under the project's own `.claude/sensors`). Regression guard for the relocated `join("dist","claude",".claude","sensors")` segments — the move otherwise breaks the guard silently (3 tests) |
| t113 | `tests/unit/t113-directive-schema.sh` | v0.6.0 milestone 1 — `aidlc-directive.ts` Directive discriminated union + `validateDirective` over the 8 engine-emitted kinds (run-stage, dispatch-subagent, invoke-swarm, present-gate, ask, print, error, done); imports the validator via `bun -e` (runtime, not grep). Asserts a well-formed directive of each kind → VALID, a positive returns the parsed directive as `data`, a per-kind missing-required-field case names the field + kind, an unknown kind → specific `unknown kind` message, an unknown key on a valid run-stage → `unknown key` message, type mismatches (gate→boolean, support_agents→array, question→string), a run-stage mode enum miss, and shape failures (null/array/string → `expected object`). v0.6.0 Wave 2 milestone 9 extends `gate` to `boolean | "unresolved"` (the classify-round-trip sentinel) and adds the optional `conductor_persona` string (decision D-E): the sentinel is accepted, any other gate-string rejected, and `conductor_persona` must be a string when present. Mirrors `t62-stage-schema.sh`; unit tier, no LLM, no state (30 tests) |
| t114 | `tests/unit/t114-orchestrate-next.sh` | v0.6.0 Wave 1 milestone 3 — `aidlc-orchestrate.ts next`, the read-only orchestration-engine handler. Reads state + the compiled graph and prints exactly one validated directive (JSON) to stdout, mutating nothing; drives `next` over the existing state fixtures. Asserts an in-flight current stage → a `run-stage` directive carrying graph-node routing fields (stage, lead_agent, gate); the flag-precedence ladder (state Scope > `--scope` > `AWS_AIDLC_DEFAULT_SCOPE` > default for VALID scopes, but an invalid `--scope` errors unconditionally even over valid state — Wave-1 audit finding 4; an invalid env scope → an `error` carrying the verbatim `Unknown scope` text); read-only dispatch (`--status`/`--version` → `print`); the mutually-exclusive `--stage`+`--phase` guard → `error`; that a WITH-STATE `--phase`/`--stage` jump commits via a `print` directive naming `aidlc-jump.ts execute` with the tool-resolved target + direction (the jump is a mutation; `next` stays read-only — re-anchored from the pre-cutover run-stage assertion the release gate caught producing zero state change); and that `gate` is the human-judgement axis, not the conditional-inclusion axis (an `execution: ALWAYS` stage like `intent-capture` still emits `gate:true`); and (Wave 2 milestone 8) that the cutover invocation is engine-compatible — SKILL.md does not wrap `$ARGUMENTS` in a `--args` flag the parser drops, and a flag-bearing jump reaches the parser; and (Wave 2 milestone 8 follow-up) that `--init --test-run` threads `--test-run` into the emitted scaffold command while the control does not — the birth-init `--test-run` drop that stripped the `Test Run Mode: true` state field; and (Wave 2 milestone 8 resume leg) that `--test-run` re-entering an existing stamp-less workflow emits a run-then-continue `print` naming `aidlc-utility.ts enable-test-run` (the resume re-stamp the cutover deleted; `jump.ts` reads the field, not the flag), with controls that the field-present case does not re-emit it (loop advances to run-stage), a plain resume never emits it, and a `--scope X --test-run` against a differing scope routes to scope-change first (no shadow). Mirrors `t19-tool-jump.sh`; unit tier, no LLM (27 tests) |
| t115 | `tests/unit/t115-orchestrate-report.sh` | v0.6.0 Wave 1 milestone 4 — `aidlc-orchestrate.ts report`, the commit-the-transition engine handler. A thin dispatcher over exactly one of `aidlc-state.ts` approve / advance / complete-workflow, chosen by the acted stage's gate status then finality, so the next `next` reads fresh state. Round-trips `next` → act → `report --result <outcome>` → `next` over state fixtures. Asserts the gated approval path emits GATE_APPROVED + STAGE_COMPLETED + STAGE_STARTED with exactly one STAGE_STARTED (no double-advance after approve); non-gated advance emits STAGE_COMPLETED + STAGE_STARTED, with the PHASE_COMPLETED + PHASE_VERIFIED + PHASE_STARTED quartet in order at a phase boundary; final completion emits STAGE_COMPLETED + PHASE_COMPLETED + PHASE_VERIFIED + WORKFLOW_COMPLETED with Status=Completed; missing/unknown `--result` and an absent state file → `error` directives; the tool-level advance replay guard emits zero new events with `replay:true` (not an error); no orphan audit lock dir. Mirrors `t19-tool-jump.sh`; unit tier, no LLM (22 tests) |
| t116 | `tests/unit/t116-directive-path-resolution.sh` | v0.6.0 Wave 1 milestone 5 — the `aidlc-orchestrate.ts` emit-time artifact path resolver wired into the `run-stage` directive builder. The compiled graph stores artifacts as vocabulary NAMES (`produces` bare names, `consumes` `{artifact, required, conditional_on}` objects); the engine resolves them to canonical `aidlc-docs/...` paths and drops `conditional_on` consumes-entries against the workflow's Project Type. Drives the `run-stage` directive builder via the Branch-10 happy path (seed a fixture, pivot Current Stage to the target + mark in-flight, then bare `next`) over `state-brownfield-feature` (Brownfield, feature scope where `application-design` EXECUTEs) and `state-construction` (Greenfield, feature scope). Vehicle re-anchored at the engine cutover (it used to reach the builder via `next --stage <slug>`, but a WITH-STATE jump now emits a `print` naming `aidlc-jump.ts execute`, not a run-stage; the path-resolution behaviour is unchanged, the jump-emits-print contract is pinned by t114/t117/t118). Asserts `application-design` produces resolve to the non-per-unit shape `aidlc-docs/inception/application-design/<name>.md` (all 5 names); each consume resolves UNDER ITS PRODUCING stage, not the consuming stage (`requirements` → `inception/requirements-analysis/`, `architecture` + `component-inventory` → `inception/reverse-engineering/`), and NO consume resolves under `application-design`'s own dir; those two `conditional_on:brownfield` consumes are PRESENT for Brownfield and DROPPED for Greenfield while non-conditional produces still resolve; the per-unit stages `functional-design` / `code-generation` (`for_each: unit-of-work`) inject `{unit-name}` → `aidlc-docs/construction/{unit-name}/<stage>/<name>.md`; and a negative — a non-per-unit stage does NOT get the `construction/{unit-name}/` prefix. Mirrors `t19-tool-jump.sh`; unit tier, no LLM (13 tests) |
| t117 | `tests/unit/t117-orchestrate-branches.sh` | v0.6.0 Wave 1 milestone 6 — `aidlc-orchestrate.ts next` non-happy-path branches (jump / resume / init / scope-change / config-change / env-scope), porting the remaining `SKILL.md` handlers into the read-only engine as typed directives. Asserts forward/backward/redo jump → a `print` naming `aidlc-jump.ts execute` for the tool-resolved target + direction (a WITH-STATE jump is a mutation the conductor commits, so `next` stays read-only — re-anchored at the engine cutover), each direction cross-checked against `aidlc-jump.ts resolve`; a SKIP-for-scope jump → `error` (verbatim `is skipped for scope`); resume-with-existing-state → `ask` (the engine never calls AskUserQuestion); the init guard (state exists, no `--force`) → `error` (verbatim `Use --force to reinitialize`); init on a clean workspace → `print` that creates no state; mutually-exclusive `--stage`+`--phase` → `error`; env-scope-invalid → `error` carrying the literal `Invalid AWS_AIDLC_DEFAULT_SCOPE` substring (shelled-out, not reconstructed); scope-change / config-change against existing state → `print`; a phase jump → `print` naming execute for the first in-scope stage; freeform intent → `ask` (scope confirmation); and the init-stage jump guard (SKILL.md step 5) → `error` (`Cannot jump to initialization stages`) for `--stage <init>` and `--phase initialization`. Every reused handler is a CLI shell-out; only directive types are imported. Mirrors `t19-tool-jump.sh`; unit tier, no LLM (24 tests) |
| t118 | `tests/unit/t118-engine-differential.sh` | v0.6.0 Wave 1 milestone 7 — the differential corpus (per-scope half), the WAVE CLOSE GATE. Asserts the deterministic engine `aidlc-orchestrate.ts` emits, for each of the 9 scopes (`enterprise, feature, mvp, poc, bugfix, refactor, infra, security-patch, workshop`), the same scope-shaped directive the prose orchestrator produces today — with NO model in the loop (shells out to `next` over a Scope-swapped `state-initialization-done` fixture and diffs a FROZEN golden; never calls `run_claude`; vision §5). Per scope, the FINGERPRINT stage (first EXECUTE stage after the 3 bootstrap init stages, derived from the compiled scope grid (`scope-grid.json`) membership and cross-validated against `t56`) is re-anchored END-TO-END at the engine cutover through the post-cutover jump-commit loop (Current Stage pivoted to the last init stage so the fingerprint resolves forward): `next --stage <fp>` → a `print` naming `execute --target <fp> --direction forward`, then after running that execute and re-running `next`, a `run-stage` whose stage + phase + **gate** match the golden (gate is asserted — every fingerprint gates `gate:true`); a SKIP-for-scope stage → `error` carrying the verbatim `Stage "..." is skipped for scope "<scope>".` wording. Plus the gate-axis anchor: an initialization stage → `run-stage` `gate:false` (bootstrap auto-proceed). Plus the v0.6.0 Wave 2 milestone 9 classified-stance anchor: the first Construction Bolt (`functional-design`, no stance recorded) → `run-stage` `gate:"unresolved"` (the sentinel — the practices-derived case the engine defers to the classify round-trip). Plus a no-state workflow-birth trio (no seeded state): `next <known-scope>` → no-state error (recognised as scope, not freeform — Wave-1 audit finding 2), `next <freeform>` → `ask`, bare `next` → no-state error. Mirrors `t19-tool-jump.sh`; unit tier, no LLM, no model (38 tests) |
| t123 | `tests/unit/t123-skills-spec-conformance.sh` | v0.6.0 Wave 3 milestone 11 (+ milestone 13 + milestone 14) — Agent-Skills-spec conformance guard over every shipped skill dir under `dist/claude/.claude/skills/`. In-repo check (the published `skills-ref` validator is not installed; the plan sanctions a vendored equivalent). Discovers the live skill set, asserts it is exactly the four base skills (`aidlc`, `aidlc-outcomes-pack`, `aidlc-replay`, `aidlc-session-cost`) PLUS the four first-batch scope-runners (milestone 13 — `aidlc-bugfix`, `aidlc-feature`, `aidlc-mvp`, `aidlc-security-patch`) PLUS the 29 generated stage-runners `aidlc-<slug>` (milestone 14 — the expected stage-runner set is DERIVED from the RUNNABLE compiled stages, the 3 bootstrap initialization stages excluded, so it cannot drift from the generator; t129 owns the stage-runner-set/graph equality and t130 the scope-runner drift, this test owns conformance) PLUS the single `aidlc-init` phase wrapper (packages `/aidlc --init`, standing in for the 3 excluded per-init-stage runners), so a future skill landing without a plan update trips the dir-count guard, then per skill asserts: frontmatter `name` equals the directory name, `description` is present and non-empty (handles inline AND folded `>`/`|` block-scalar form), and the `SKILL.md` body is `<= 500` lines. Tolerates the Claude-Code-native frontmatter extensions (`user-invocable`, `argument-hint`) — documented portable-core-plus-extensions, not violations (vision §9). The `aidlc` skill no longer carries a `hooks:` block (moved to `settings.json` by milestone 13). Pure node/bun frontmatter parse, no LLM; unit tier (115 tests: 1 dir-count guard + 3 per skill × 38 skills) |
| t124 | `tests/unit/t124-scope-transpose.sh` | v0.6.0 Wave 3 milestone 12 — per-stage `scopes:` → compiled EXECUTE/SKIP grid transpose; `compile` emits `scope-grid.json`, byte-stable + deterministic, `compile --check` catches a stale/missing grid, grid cell-identical to `subgraphForScope` ×9 (12 tests) |
| t125 | `tests/unit/t125-scope-files.sh` | v0.6.0 Wave 3 milestone 12 — scopes authored as `.claude/scopes/aidlc-*.md`; `validScopes()` + metadata derive from `.md` presence/frontmatter, a dropped file becomes a valid scope with no code change, every grid column is authored (10 tests) |
| t129 | `tests/unit/t129-stage-runner-drift.sh` | v0.6.0 Wave 3 milestone 14 — stage-runner drift guard: the set of `skills/aidlc-<stage>/` runner dirs is EXACTLY the RUNNABLE compiled stage-slug list (the 29 non-initialization stages; no missing runner, no orphan). The 29 runners are generated from the compiled graph (`aidlc-runner-gen.ts`); the 3 bootstrap initialization stages ship no per-stage runner (no standalone `--single` meaning) — the init phase is packaged as the single `/aidlc-init` wrapper instead. Without this guard a stage added to the graph would silently ship without a runner. Built on the set-equality drift discipline of t28 (audit-event sync) / t60 (scope derivation) / `compile --check`. Asserts: the shipped runner set == the runnable compiled slug set (pure-bash cross-check, independent of the tool); the count is 29; the generator's own `check` agrees on the shipped tree; the guard CATCHES a deleted runner (exit 1, names it MISSING) and an orphan runner (exit 1, names it ORPHAN); regenerating restores sync. Operates on a sandbox copy for the divergence cases; unit tier, no LLM (7 tests) |
| t132 | `tests/unit/t132-hooks-doc-count-sync.sh` | v0.6.0 Wave 3 cleanup — doc-count drift guard for the hook-scope sentence in `docs/reference/06-hooks-and-tools.md`. milestone 13 corrected the prose to "ten hook scripts ... All ten project-wide ... the other nine via the `hooks` block" but no test pinned the counts (t131 pins the settings.json WIRING, not the prose). Built on t28's two-source set-equality discipline: derives ground truth from the `hooks/aidlc-*.ts` files on disk AND the `settings.json` registrations (the `hooks` block count + the `statusLine` key), cross-checks disk == settings total, then asserts the doc's three count-words ("uses N", "All N project-wide", "other M via the hooks block") agree forward (total == ground truth), internally (the two total-restatements match), against the split (M == settings hooks-block count), and arithmetically (M + 1 statusLine == N). Pure bash + bun, no LLM (8 tests) |
| t133 | `tests/unit/t133-bolt-dag-compile.sh` | v0.6.0 Wave 4 milestone 15 — Bolt-DAG runtime compile + gate-time edge-block sensor. units-generation (2.7) gains a required fenced `yaml` `units:` edge block on `unit-of-work-dependency.md`; `aidlc-runtime compile` parses that structured data (no model call) into a `bolt_dag` node on `runtime-graph.json`, and the `required-sections` sensor validates the same block at the 2.7 gate. Asserts the node carries the units + correct sorted topological `batches`, a re-compile is byte-identical (pure-data parse, no `Date.now`), a cyclic and a malformed block each omit the node with a stderr diagnostic, an absent artifact keeps the prior 4-key envelope, and the sensor reports `edge_block` ok/cyclic/absent while non-target markdown keeps the generic check. Pure bash + bun, no LLM (10 tests) |

### Feature Tests

| Test ID | File | Description |
|---------|------|-------------|
| t12 | `tests/feature/t12-state-fixture-validation.sh` | Meta-test — verify fixture state files match real template structure (20 tests) |
| t30 | `tests/feature/t30-scope-stage-mapping.sh` | Scope-to-Stage Mapping consistency — SKILL.md compiled-table region shape + per-scope EXECUTE count matches the compiled `scope-grid.json` (17 tests) |
| t31 | `tests/feature/t31-help-text-consistency.sh` | Help text compiled by `renderHelpText()` from the derived scope mapping (`.claude/scopes/*.md` + grid); stage counts stay fresh (19 tests) |
| t32 | `tests/feature/t32-stage-graph-consistency.sh` | Cross-reference Stage Graph table in SKILL.md against actual stage files |
| t33 | `tests/feature/t33-hook-concurrency.sh` | Test audit-logger lock contention under parallel writes |
| t34 | `tests/feature/t34-stage-protocol-structure.sh` | Stage protocol structure and cross-reference validation |
| t35 | `tests/feature/t35-stage-protocol-recovery.sh` | Stage protocol recovery and change handling validation |
| t36 | `tests/feature/t36-stage-protocol-governance.sh` | Stage protocol governance and phase boundary validation |
| t37 | `tests/feature/t37-stage-protocol-compliance.sh` | Cross-file protocol compliance — every stage references protocol, state template fields match sed commands, knowledge dirs match agents |
| t38 | `tests/feature/t38-stage-agent-cross-check.sh` | Cross-check Lead Agent in each stage file against Stage Graph table in SKILL.md (32 tests) |
| t39 | `tests/feature/t39-scope-stage-count-validation.sh` | For each of 9 scopes, read EXECUTE counts from the compiled `scope-grid.json` and verify ranges (9 tests) |
| t39 | `tests/feature/t39-per-scope-phase-sequence.sh` | Per-scope phase sequence test — 9 scopes, data-driven assertions on phase ordering (27 tests) |
| t40 | `tests/feature/t40-settings-hook-config.sh` | Validate settings.json hook configuration (6 tests) |
| t41 | `tests/feature/t41-jump-flag-validation.sh` | SKILL.md forwarding-loop contract + stage-graph data table — engine-cutover rewrite. Asserts the forwarding loop is present and consults the engine (`aidlc-orchestrate next`/`report`), the flag-dispatch prose is delegated to the engine (the Composable-Flag-Extraction / jump-direction / invalid-value-error prose is gone — pinned by t114/t118), and the stage-graph data table survives (15 tests) |
| t42 | `tests/feature/t42-state-jumped-fixture.sh` | Validate state-jumped.md fixture structure (12 tests) |
| t43 | `tests/feature/t43-stage-io-contracts.sh` | Stage I/O contract chain — verify inputs/outputs chain between stages (19 tests) |
| t44 | `tests/feature/t44-stage-instruction-completeness.sh` | Stage instruction completeness — verify steps describe how to produce declared outputs (41 tests) |
| t45 | `tests/feature/t45-stage-output-validation.sh` | Feature test — deterministic validation that stage file outputs are referenced in Steps |
| t47 | `tests/feature/t47-construction-bolts.sh` | Construction Bolt-by-Bolt flow — vocabulary, audit events, state field, and Glossary. (The former SKILL.md bolt-plan / walking-skeleton / ladder-prompt assertions were retired at the engine cutover — that per-Bolt orchestration prose moved into the engine.) (12 tests) |
| t48 | `tests/feature/t48-audit-event-emitters.sh` | Drift test for audit event taxonomy — every emitter-registry row matches an emission call site (16 tests) |
| t49 | `tests/feature/t49-state-machine-lifecycle.sh` | Walk through the full stage lifecycle `[ ] → [-] → [?] → [R] → [?] → [x]` via state-tool commands (14 tests) |
| t52 | `tests/feature/t52-drift-meta-validation.sh` | Meta-test — verify t48 actually catches each failure class it claims to guard (5 tests) |
| t54 | `tests/feature/t54-compaction-and-test-run.sh` | Structural assertions for the `--test-run` terminal state in aidlc-jump.ts (WORKFLOW_COMPLETED with `Reason=test-run-stopped-at-<target>`). (The former SKILL.md compaction-awareness assertions were retired at the engine cutover; the engine's resume `ask` does not yet reproduce the compaction nuance — a tracked engine gap.) (4 tests) |
| t55 | `tests/feature/t55-test-suite-drift.sh` | Drift guard for test-suite metadata — `plan N` vs header `(N tests)` vs `tests/README.md` vs `docs/reference/09-testing.md`, plus path + version-marker drift sweep and the legacy `aidlc-claude-code/` distributable-root guard (v0.6.0 milestone 0's permanent post-move residual check) (7 tests) |
| t65 | `tests/feature/t65-stage-file-migration.sh` | All 32 stage files parse + validate against milestone 5 schema, produces/consumes integrity, round-trip, topo-sort (22 tests) |
| t66 | `tests/feature/t66-graph-library.sh` | aidlc-graph.ts 8-function library + CLI — compile, traversal, parity, the milestone 12 `AIDLC_GRAPH_RESOLVE=1` cutover-parity net (frontmatter-derived grid == legacy plan ×9), env-seam + designer-export `--check` drift guard + `rules_in_context` resolution (milestone 7a) + `sensors_applicable` resolution (milestone 7b) + `withAuditLock` reentrancy guards + compile passes `ctx.agents` (unknown `lead_agent`/`support_agent` fails the build; reserved `orchestrator` exempt) (99 tests) |
| t75 | `tests/feature/t75-practices-promote.sh` | Behavioural contract for `aidlc-state.ts practices-promote` — section-replace on `team.md`, append-with-date-stamp on project-guardrails.md, atomicity (guardrails-first), partial-draft tolerance, idempotency, fail-closed on missing draft/target with `PRACTICES_OVERRIDE` emit (24 tests) |
| t76 | `tests/feature/t76-halt-and-ask-prose-shape.sh` | v0.4.0 milestone 12 + milestone 13 — line-anchored prose-shape contract for halt-and-ask across the downstream surfaces (stage-protocol.md, branching-strategies.md, aidlc-pipeline-deploy-agent.md); pins AUQ template `[path]`/`[branch_name]` interpolation, Skip/Abort same-line preservation phrasing, sibling-doc cross-link. (The SKILL.md half — slug-derivation paragraph, subheading carve-outs, milestone 13 italic carve-outs — was retired at the engine cutover; that worktree-dispatch prose moved into the engine.) (7 tests) |
| t78 | `tests/feature/t78-bolt-worktree-lifecycle.sh` | v0.4.0 milestone 11 — end-to-end Bolt-with-worktree lifecycle (Issue 75 line 216): start --worktree → complete --merge round-trip with canonical 6-event audit sequence; abort --discard tear-down (BOLT_FAILED + directory removed) vs abort-without-discard preservation; two parallel-batch Bolts cleanly round-trip without state interference (13 tests) |
| t88 | `tests/feature/t88-compile-rules-in-context.sh` | v0.5.0 milestone 7a + milestone 7b — strict-additive rule resolution at compile (pull authoring) via 5 fixture sub-dirs (org-only, org-team-project, all-four, pairing-feedforward-only, bom-frontmatter); asserts per-stage `rules_in_context` shape across full subset, `pairing` schema accept/reject, BOM-prefixed frontmatter parsing, `--check` drift, round-trip determinism (11 tests) |
| t89 | `tests/feature/t89-compile-sensors-applicable.sh` | v0.5.0 milestone 7b — pull-authoring sensor resolution at compile via 11 fixture sub-dirs; asserts per-stage `sensors_applicable` resolution + `matches` passthrough + compile-snapshot semantics + schema rejections + FIELD_ORDER positioning + round-trip determinism + `--check` drift on sensor-manifest edits (22 tests) |
| t90 | `tests/feature/t90-runtime-compile.sh` | v0.5.0 milestone 8 — `aidlc-runtime.ts compile` walks audit + memory.md to materialise `runtime-graph.json`. Asserts approved/pending pairing, re-jump, v0.4.0-backfill, MEMORY_EMPTY emit + --test-run propagation, byte-equivalent re-compile, missing state.md skip, approved+non-zero negative case, ISO-second collision determinism, --init --force re-init filtering, re-emit suppression (exactly one per (slug, gate-completion)), re-approve still-empty → fresh emit, schema nullable on instance-bearing rows (29 tests) |
| t91 | `tests/feature/t91-runtime-compile-hook.sh` | v0.5.0 milestone 8 — PostToolUse Bash hook `aidlc-runtime-compile.ts`; asserts dispatch on GATE_APPROVED, terminal-WORKFLOW via WORKFLOW_COMPLETED, gate-start via STAGE_AWAITING_APPROVAL, command-regex skip, recursion guard (standalone and composite), no-transition skip, TTY/empty-stdin and malformed-JSON guards, Test-Run propagation (13 tests) |
| t92 | `tests/feature/t92-sensor-fire.sh` | v0.5.0 milestone 9 — behavioural contract for `aidlc-sensor.ts fire`; asserts argv validation, PASSED + FAILED round-trip per sensor with findings-count derivation, tool-unavailable + script-error → PASSED + Note, budget override → SENSOR_BUDGET_OVERRIDE, concurrency (lock A + B + orphan recovery), detail-file body shape + Fire-id-keyed paths, audit-row required-fields per event type, manifest `command:` resolution, validation order, upstream-coverage `--consumes` via `loadGraph()`. Groups B/C/F-defensive use REAL fixtures under `tests/fixtures/v05-mr9-sensor-fire/` (passing-markdown, failing-required-sections, failing-upstream-coverage, passing-typescript, failing-linter, failing-type-check, slow-command) so the four shipped per-sensor scripts are exercised against authentic markdown + TS inputs (43 tests) |
| t93 | `tests/feature/t93-sensor-list-describe.sh` | v0.5.0 milestone 9 (rows updated by milestone 10) — behavioural contract for `aidlc-sensor.ts` read-only subcommands; asserts `list` deterministic alpha order across 4 framework sensors, per-sensor `describe` field shape (markdown sensors include `matches: **/aidlc-docs/**` post-PR-10 G1.5; ts/tsx sensors include `matches: **/*.{ts,js}` and `matches: **/*.{ts,tsx}`), `describe <unknown-id>` exits non-zero with known-ids hint, `--help`/`-h` prints usage, no-subcommand exits non-zero with usage hint (12 tests) |
| t95 | `tests/feature/t95-sensor-fire-hook-feature.sh` | v0.5.0 milestone 10 — end-to-end behaviour for `aidlc-sensor-fire.ts` against a mock dispatcher. Asserts argv shape (`fire <id> --stage <slug> --output-path <path>`), single-entry + multi-entry fire, multi-glob per stage (TS write fires only code sensors / markdown write fires only doc-shape sensors at the same Construction stage), glob-filter selection across mixed entries, subprocess timeout → SIGTERM-recorded `recordHookDrop` (uses a patched-timeout fast-fixture copy of the hook), subprocess exit 1 → dispatcher-exit drop, exit-code contract (no `{decision: block}`), heartbeat mtime advances on sequential calls, `sensor-fire.skipped` accumulates ISO-timestamped lines under Test Run Mode (19 tests) |
| t96 | `tests/feature/t96-runtime-instances-compile.sh` | v0.5.0 milestone 11 — `aidlc-runtime compile` `instances[]` populator. Asserts single-Bolt → no instances[]; 3-Bolt parallel → instances[].length=3 with parent fields nulled per L5/L10 + memory_path kept; outcome rollup (all approved → approved; any failed → failed; pending mix → pending); alphabetical-by-slug ordering with shuffled STATE_FORKED Timestamps; determinism on re-compile; PR-11 contract (sensor_firings:[], memory_entries:null, memory_breakdown:null on every BoltInstance) (10 tests) |
| t98 | `tests/feature/t98-sensor-firings-populator.sh` | v0.5.0 milestone 12 — `aidlc-runtime compile` `sensor_firings[]` + `learnings_captured` populators. Asserts fire_id pairing (passed/failed+detail_path/budget-override), orphan handling (closed → incomplete; open past 60s → incomplete; open under 60s → omitted; cutoff from baseline_ts, no wall-clock), 4-parallel interleaved pairing, ts-ascending sort, byte-equal re-compile; BoltInstance attribution (per-instance + worktree-scoped not double-counted on parent); `learnings_captured` (approved → {from_orchestrator, from_user_addition}, pending → null, instance-bearing parent → null); 4-state enum + fire_id invariant (16 tests) |
| t104 | `tests/feature/t104-doctor-rule-drift.sh` | v0.5.0 milestone 14 — real `/aidlc --doctor` rule-drift row rendering against `AIDLC_RULES_DIR` fixtures; asserts the N=1 headline `Rule drift: 1 team/project rule(s) overlap org policy (review for contradiction)`, detail carries file + `## Testing Posture` + quoted org sentence, `✓` advisory render (never pushes failed), N=0 quiet render, org-absent informational pass, fixture isolation (fixture posture drives N=1 — `.headings` read seam end-to-end) (6 tests) |
| t105 | `tests/feature/t105-doctor-paired-coverage.sh` | v0.5.0 milestone 14 — real `/aidlc --doctor` paired-coverage row + `GUARDRAIL_LOADED` emit pin; asserts the exact `P/(M-X)` label (`1/2 guardrails paired (1 feedforward-only)`), unpaired detail (`unpaired: … → aidlc-ghost (no stage binds it)`), `✓` advisory render, `GUARDRAIL_LOADED` row in `aidlc-docs/audit.md` with Scope/Path/Rule count fields, and the no-`pairing` M-X=0 branch still emitting `GUARDRAIL_LOADED` (6 tests) |
| t106 | `tests/feature/t106-runtime-summary.sh` | `aidlc-runtime.ts summary` deterministic aggregate over `runtime-graph.json`; asserts stage-outcome tallies (approved/failed/pending), per-phase rollup keyed by stage-graph phase, memory-entry aggregation by canonical category, `duration_minutes` (start → latest completed; null when pending-only), `--json` determinism, human-readable header render, missing-graph → exit 1 (13 tests) |
| t107 | `tests/feature/t107-session-skills-readonly.sh` | Read-only session skills (session-cost / replay / outcomes-pack); asserts each `SKILL.md` exists, declares `name` + `user-invocable: true` + `classification: read-only`, sources numbers from `aidlc-runtime.ts summary --json`, carries no retired token heuristic, emits no audit / no state advance, only outcomes-pack writes a file (24 tests) |
| t111 | `tests/feature/t111-session-skills-contract.sh` | Behavioural contract between the session skills and the `aidlc-runtime.ts summary --json` data plane; compiles a synthetic graph, then asserts the tool emits the 8 top-level keys the skills depend on, every dotted field the skills reference resolves in real tool output (phantom/renamed-field guard), and every emitted scalar is consumed by at least one skill (dark-field guard) (10 tests) |
| t118 | `tests/feature/t118-engine-differential.sh` | v0.6.0 Wave 1 milestone 7 — the differential corpus (special-path half), the feature-tier complement of the WAVE CLOSE GATE. Walks multi-step `next`/`report` sequences across the engine's components for each special path, with NO model in the loop (shells out to the `aidlc-orchestrate.ts` binary over seeded fixtures and diffs FROZEN goldens; never calls `run_claude`; vision §5). Covers all 7 paths (not a subset): jump forward/backward/redo → a `print` naming `aidlc-jump.ts execute` for the resolved target + direction (a WITH-STATE jump is a mutation the conductor commits, re-anchored at the engine cutover from run-stage), each direction cross-checked against `aidlc-jump.ts resolve` (redo has no t50-t59 source — derived from the tool per `t19`); resume → `ask`; init clean → `print` that creates no state, state-exists guard → `error` (verbatim `Use --force to reinitialize`); scope-change → `print` (no t50-t59 golden — derived from the engine branch); test-run → a full `next` → `report --test-run` → `next` round-trip stamping `Test-Run: true` on the GATE_APPROVED row (absent in the no-`--test-run` control). Plus three cross-component WALKS (`next` → `report` → `next`): a non-gated advance walk, a gated approve walk (exactly one STAGE_STARTED), and the v0.6.0 Wave 2 milestone 9 CLASSIFY round-trip (`functional-design` `gate:"unresolved"` → `report --skeleton-stance on` records the stance with no transition → the follow-up `next` re-emits with the determined `gate:true`). Mirrors `t19-tool-jump.sh`; feature tier, no LLM, no model (27 tests) |
| t120 | `tests/feature/t120-classify-roundtrip.sh` | v0.6.0 Wave 2 milestone 9 — the walking-skeleton classify round-trip (vision §6, the one knowledge round-trip the engine DEFERS rather than decides; review Major A). The first Construction Bolt's gate depends on the walking-skeleton STANCE, which an LLM classifies from a team's free-form `## Walking Skeleton` prose — the engine honours the boundary with a round-trip, with NO model in the loop (shells out to `aidlc-orchestrate.ts next`/`report` over `state-construction-bolt1`; never calls `run_claude`). Per stance (on / off / scope-dependent): step 1 — `next` → `run-stage(functional-design)` `gate:"unresolved"` (the sentinel; engine defers the skeleton gate); step 2 — `report --skeleton-stance <s>` → `print` and the `Skeleton Stance` field written to state; step 3 — the follow-up `next` → `run-stage(functional-design)` with the DETERMINED boolean `gate:true` (true for every stance per the verified resolution prose — the stance picks the ceremony, not whether Bolt 1 gates). Plus a backward-compat assertion (a non-skeleton construction stage `nfr-design` keeps its boolean `gate:true`, never the sentinel) and three negative paths (kind + verbatim wording): invalid stance, stance off the skeleton-gate stage, stance with no state file → `error`. Mirrors `tests/feature/t118-engine-differential.sh`; feature tier, no LLM, no model (19 tests) |
| t121 | `tests/feature/t121-stop-hook-enforce.sh` | v0.6.0 Wave 2 milestone 10 — behavioural contract for the Stop hook `aidlc-stop.ts`, the framework's FIRST flow-altering hook (it may emit `{"decision":"block"}` — a sanctioned loop-enforcement contract, distinct from the sensor-fire hook's advisory never-block contract). Mirrors `t95`'s harness: runs the real hook with `CLAUDE_PROJECT_DIR` at a temp project carrying a MOCK `aidlc-orchestrate.ts` whose directive `kind` is set by `MOCK_KIND`. Asserts (a) a pending `run-stage` → stdout `{"decision":"block","reason":...}` where the reason is an on-task continuation naming the pending work + re-feeding the forwarding loop (no override-shaped verbs); (b) `done` → empty stdout + exit 0 (stop allowed); (c) the recursion guard, asserted hardest — the no-progress counter at the default cap (8) with `stop_hook_active:true` RELEASES, a low-cap (3) no-progress streak flips block→block→RELEASE→RELEASE and stays released, and a stage pivot (progress) RESETS the streak; (d) no-op outside AIDLC — no `aidlc-state.md` → exit 0, no block; plus garbage stdin + a non-zero/unparseable engine fail OPEN (exit 0, never crash, never trap). No test for the human-stop carve-out (SPIKE 1: Stop hooks don't fire on Esc). (13 tests) |
| t127 | `tests/feature/t127-single-stage-invariant.sh` | v0.6.0 Wave 3 milestone 14 — the `--single` stage-runner POINTER INVARIANT: a single-stage run NEVER touches the main workflow's `Current Stage`. Over a seeded ACTIVE feature workflow parked at `feasibility`, runs a DIFFERENT stage (`code-generation`) via `--single` and asserts both halves leave the main pointer at `feasibility`: `next --stage code-generation --single` → one `run-stage` directive for `code-generation` (carrying the conductor persona — D-E, this is the conductor's first directive of the single run); `report --single --stage code-generation --result completed` → a `done` directive after committing exactly one STAGE_STARTED + one STAGE_COMPLETED tagged with the synthetic `Workflow: single-stage:code-generation` (audit-only). Plus the tool-enforced refusals: `report --single` with NO `--stage` (the "advance the main workflow" attempt) → `error` committing nothing; `next --single` with no `--stage` → `error`; an init-stage `--single` → `error`; a SKIP-for-scope stage `--single` (no-state, `--scope bugfix`) → the verbatim skip wording; `--single --phase` → `error`. Feature tier, no LLM, no model (16 tests) |
| t128 | `tests/feature/t128-custom-runner.sh` | v0.6.0 Wave 3 milestone 14 — proves the extensibility headline "to add a stage, write a stage file": in a sandbox `.claude/` copy, authors a custom stage file under `aidlc-common/stages/operation/`, pre-seeds its `{slug, number, name}` row, recompiles the graph, runs `aidlc-runner-gen.ts write`, and asserts the custom stage gets a spec-conformant `skills/aidlc-<slug>/` runner (frontmatter `name` == dir; body drives `next --stage <slug> --single`), the drift guard returns to in-sync, and the custom stage is drivable via `next --stage <slug> --single` (injected EXECUTE into a fixture scope via the post-PR-12 `scope-grid.json` + a `.claude/scopes/aidlc-fixture-scope.md` file, mirroring t60). Sandbox-only — the shipped tree is never touched. Feature tier, no LLM (8 tests) |
| t130 | `tests/feature/t130-scope-runners.sh` | v0.6.0 Wave 3 milestone 13 — scope-runners drive the engine with their baked scope (behavioural). Per first-batch runner, seeds a `--test-run` init under that scope, runs `aidlc-orchestrate next --scope <scope>` (the runner shell's first move), and asserts a real `run-stage` for that scope's first EXECUTE stage plus the engine-delivered `conductor_persona` field (decision D-E). Full drive-to-done proven per scope by t118. No LLM, no model (12 tests) |
| t131 | `tests/feature/t131-hooks-settings-fire.sh` | v0.6.0 Wave 3 milestone 13 — the hooks move (Fork 2→B). Registration: `settings.json` registers the six workflow-spine hooks (audit-logger + sensor-fire on PostToolUse `Write\|Edit`, sync-statusline on `TaskUpdate`, runtime-compile on `Bash`, validate-state on `PreCompact`, log-subagent on `SubagentStop`) plus `Stop`, with `aidlc/SKILL.md` carrying no `hooks:` block. Behaviour: inside a workflow audit-logger appends an audit row and runtime-compile emits `runtime-graph.json`; outside any workflow both self-gate to exit-0 no-ops. No LLM (16 tests) |
| t135 | `tests/feature/t135-invoke-swarm.sh` | v0.6.0 Wave 4 milestone 17 — the `invoke-swarm` directive end-to-end, deterministic (no live model). Engine: a Construction project parked at `code-generation` (in-flight) with a `bolt_dag` batch on `runtime-graph.json` — `Construction Autonomy Mode: autonomous` makes the engine emit `{"kind":"invoke-swarm","units":[...]}` naming the batch, while a gated grant falls back to a `run-stage` for code-generation (the swarm is gated on the autonomy grant). Referee: the harness plays the conductor over a real worktree fixture — `prepare` a mixed 2-unit batch, stage only one unit's impl, then `finalize` claiming both (the lying-conductor guard refuses the unstaged one). Asserts the three batch-level audit events `SWARM_STARTED` (prepare) / `SWARM_COMPLETED` (with converged/failed tally) / `SWARM_BATON_RETURNED` (per failed unit) all land, and `finalize` exits 2 (baton returns). Plus the structural skeleton guard (under `bugfix` scope, code-generation is the walking-skeleton gate stage, so the swarm never fires even under autonomy). No LLM (8 tests) |

### Integration Tests

| Test ID | File | Description |
|---------|------|-------------|
| t19 | `tests/integration/t19-preflight-health.sh` | Preflight health check — validates Claude CLI before integration tests |
| t20 | `tests/integration/t20-integration-status.sh` | Integration test for /aidlc --status (7 tests) |
| t21 | `tests/integration/t21-integration-init.sh` | Integration test for /aidlc --init — first run (10 tests) |
| t21b | `tests/integration/t21b-integration-init-idempotent.sh` | Integration test for /aidlc --init — --force semantics (6 tests) |
| t22 | `tests/integration/t22-integration-doctor.sh` | Integration test for /aidlc --doctor (10 tests) |
| t23 | `tests/integration/t23-integration-help.sh` | Integration test for /aidlc --help (6 tests) |
| t24 | `tests/integration/t24-integration-stage-jump.sh` | Integration test — forward --stage jump via claude CLI (12 tests) |
| t25 | `tests/integration/t25-integration-phase-jump.sh` | Integration test — backward --phase jump via claude CLI (6 tests) |
| t26 | `tests/integration/t26-integration-backward-jump.sh` | Integration test — backward jump via claude CLI (8 tests) |
| t27 | `tests/integration/t27-integration-depth-override.sh` | Integration test — --depth flag override via claude CLI (7 tests) |
| t28 | `tests/integration/t28-integration-test-strategy.sh` | Integration test — --test-strategy flag via claude CLI (6 tests) |
| t29 | `tests/integration/t29-integration-env-scope.sh` | Integration test — AWS_AIDLC_DEFAULT_SCOPE env var via claude CLI (5 tests) |
| t45 | `tests/integration/t45-revision-loop.sh` | Integration test — gate → reject → revise → gate cycle on a gated stage (10 tests) |
| t46 | `tests/integration/t46-parallel-bolt.sh` | Parallel-bolt concurrency test — 5 processes racing on audit.md (5 tests) |
| t47 | `tests/integration/t47-failure-injection.sh` | Failure-injection test — chaos conditions the state machine must handle without data loss (8 tests) |
| t48 | `tests/integration/t48-runtime-graph-end-to-end.sh` | v0.5.0 milestone 8 — runtime-graph compile end-to-end against a real `bugfix` workflow; asserts pre-approve pending → post-approve approved transition, ≥2 rows after first approve, v0.4.0 backfill, byte-equivalent re-compile (10 tests) |
| t49 | `tests/integration/t49-bolt-sensor-failures.sh` | v0.5.0 milestone 11 — end-to-end real-tool flow for Bolt fork/merge runtime-graph + parallel instances[] + failure modes; asserts 3-Bolt parallel batch → instances[auth, cart, pay] alphabetical, sensors are advisory (synthesized SENSOR_FAILED in pay's worktree audit propagates to main on audit-merge but all instances stay outcome:approved), PR-11 contract under live SENSOR_FAILED, Bolt failure rollup (pay BOLT_FAILED + abort --discard → instance pay:failed + parent:failed), idempotent re-merge (state-merge errors first), lock-acquire failure ordering (planted lock-dir + AIDLC_AUDIT_LOCK_RETRIES=1 → fragment-merge never reached), soft-gap closure (fragment-merge fails after audit-merge succeeds → BOLT_COMPLETED → STATE_MERGED → AUDIT_MERGED → BOLT_FAILED partial-success audit signature), determinism under failure mix (8 tests) |
| t99 | `tests/integration/t99-learnings-gate-flow.sh` | v0.5.0 milestone 12 — §13 learning-gate end-to-end (surface → simulated-AUQ glue → persist); asserts mixed-memory surface → project + team learnings + 2 audit rows, test-run skip, sensor proposal → manifest + `aidlc-graph compile` binds the id into `sensors_applicable` (two-write install) + `SENSOR_PROPOSED` Destinations array, admission conflict-check with stubbed verdict (reject no-writes / escalate writes through), idempotent re-run, concurrent persist serialises to exactly one row + line, recovery re-writes line + skips emit, glue label↔candidate_id mapping + §13 fossil sweep (16 tests) |
| t102 | `tests/integration/t102-memory-roundtrip.sh` | v0.5.0 milestone 13 — `memory.md` producer → milestone 8 runtime-compile round-trip (scripted, deterministic); asserts a stage's `memory.md` is created from the real template at start (4 headings, total 0), after N real entries + approval the compile records `memory_entries === N` with breakdown summing to N, a template-only approved stage emits one `MEMORY_EMPTY` while N≥1 entries emit none, the file persists across a second compile, and an absent `memory.md` compiles to `memory_entries: null` with no `MEMORY_EMPTY` (no-storm backfill) (6 tests) |

### Stage Tests

| Test ID | File | Description |
|---------|------|-------------|
| t70 | `tests/stage/t70-stage-workspace-detection-greenfield.sh` | Stage test — workspace detection classifies greenfield stub (8 assertions, 25 turns) |
| t71 | `tests/stage/t71-stage-workspace-detection-brownfield.sh` | Stage test — workspace detection classifies brownfield stub (10 assertions, 25 turns) |
| t72 | `tests/stage/t72-stage-reverse-engineering.sh` | Stage test — reverse engineering on brownfield stub (15 assertions, 25 turns) |
| t73 | `tests/stage/t73-stage-intent-capture.sh` | Stage test — intent capture with greenfield stub (12 assertions, 25 turns) |
| t74 | `tests/stage/t74-stage-requirements-analysis.sh` | Stage test — requirements analysis with brownfield stub + RE artifacts (12 assertions, 25 turns) |
| t101 | `tests/stage/t101-stage-memory-lifecycle.sh` | v0.5.0 milestone 13 — per-stage `memory.md` start→approval lifecycle on a gated stage; asserts init-from-template at stage start (four canonical headings, verbatim blockquote ownership header), logged observation carries an ISO-8601 prefix under a canonical heading, persist-on-approval (no cleanup), idempotent re-entry, `parseMemoryHeadings` ↔ disk agreement, and the hook-fired runtime-compile read seam carries `memory_path`; LLM-output-dependent assertions skip on timeout or copy-approximation (8 assertions) |

### Worktree Tests

L2 tier without LLM dependency. Fires after the preflight gate so a missing `claude` CLI doesn't skip it. Tests exercise `git worktree`-related primitives: fixture creation via `mktemp + git init`, worktree-list assertions, idempotent cleanup, and the `aidlc-worktree` CLI's create/merge/discard/list/verify subcommands. v0.4.0 Wave 1 milestone 3 landed the tier infrastructure + the helpers meta-test; v0.4.0 milestone 7 added five tool-exercising tests (t02-t06); v0.4.0 milestone 10 added one audit-fork/merge test (t07).

| Test ID | File | Description |
|---------|------|-------------|
| t01 | `tests/worktree/t01-helpers.sh` | Meta-test for `tests/lib/worktree-helpers.sh` — fixture creation, worktree assertions, defence-in-depth path guard, idempotent cleanup (7 tests) |
| t02 | `tests/worktree/t02-worktree-create.sh` | `aidlc-worktree create` — happy path emits `WORKTREE_CREATED` and registers worktree on `bolt-<slug>` branch; pre-audit guards reject bad slug, missing base branch, double-create on same slug; 3 parallel creates with distinct slugs all succeed (15 tests) |
| t03 | `tests/worktree/t03-worktree-merge.sh` | `aidlc-worktree merge` — squash strategy emits `WORKTREE_MERGED` and removes the worktree; defensive HEAD check rejects merge from wrong branch; conflict envelope shape (`status`/`detail` + `conflict_files` lists the actual conflicting path via `git diff --diff-filter=U`) with worktree preserved; rebase strategy errors when no remote configured (13 tests) |
| t04 | `tests/worktree/t04-worktree-discard-list-verify.sh` | `aidlc-worktree discard` removes the worktree + branch and emits `WORKTREE_DISCARDED`; idempotent on already-gone slugs; `list` filters to `bolt-*` worktrees only; `verify` exits 0 when the matching event is fresh, non-zero with `absent` reason when missing, non-zero with `stale` reason when older than `--max-age-seconds` (12 tests) |
| t05 | `tests/worktree/t05-worktree-audit-first.sh` | Audit-first invariant — Part A: chmod `audit.md` to read-only, create exits non-zero pre-git with no worktree directory created and no `WORKTREE_CREATED` row in audit.md. Part B: induce git-time failure post-audit (chmod parent dir read-only); `WORKTREE_CREATED` audit-of-intent row landed before git failure, `ERROR_LOGGED` row appended with `[slug=<slug>]` for doctor correlation (7 tests) |
| t06 | `tests/worktree/t06-worktree-sibling-rejection.sh` | `aidlc-worktree` refuses to run from inside a sibling worktree (Construction's `.aidlc/worktrees/bolt-*` are siblings of the main checkout, not nested); error message names the main-checkout requirement (3 tests) |
| t07 | `tests/worktree/t07-audit-fork-merge.sh` | `aidlc-audit audit-fork` / `audit-merge` primitive — fork creates byte-identical worktree audit + AUDIT_FORKED in both audits with matching Fork Boundary; merge appends delta + AUDIT_MERGED in main only; edge cases (empty delta, missing aidlc-docs subdir auto-created, missing main audit fails loud, prefix-hash mismatch refusal, lock contention via 50ms-staggered N=2 mergers, lock-timeout failure path with planted stuck lock, 65-char slug rejected with length error, post-emit failure ERROR_LOGGED carries [fork-emitted:<iso-ts>] for doctor correlation); property — N=4 alphabetical / reverse-alphabetical / same-second-timestamps / one-empty-delta scenarios all preserve per-Bolt fork→merge bracket order in the merged main audit (31 tests) |
| t09 | `tests/worktree/t09-halt-and-ask-preservation.sh` | v0.4.0 milestone 12 — halt-and-ask preserves the worktree on simulated `BOLT_FAILED`; pins on-disk persistence, `Bolt slug` field correlation, zero-discard invariant, info still resolves (8 tests) |
| t10 | `tests/worktree/t10-halt-and-ask-discard.sh` | v0.4.0 milestone 12 — explicit `aidlc-worktree discard --slug` cleans up: directory gone, `WORKTREE_DISCARDED` with `Reason: agent-discard`, idempotent second discard, info still resolves from audit (8 tests) |
| t11 | `tests/worktree/t11-halt-and-ask-retry-correlation.sh` | v0.4.0 milestone 12 — retry-then-fail correlation: `info` returns same path across multiple `BOLT_FAILED` emits, exactly one `WORKTREE_CREATED` (retry doesn't re-create), worktree preserved across multiple failures (6 tests) |
| t12 | `tests/worktree/t12-bolt-runtime-graph-fork.sh` | v0.5.0 milestone 11 — Bolt runtime-graph fork/merge round-trip + parallel batch + abort-discard. Three scenarios: (a) single-Bolt round-trip (fragment created on start --worktree, removed on complete --merge, no instances[] on compile per L5 ≥2 threshold); (b) 3-Bolt parallel batch in non-alphabetical start order → instances[] always alphabetical [auth, cart, pay] regardless of merge order, all 3 fragments removed; (c) abort --discard removes worktree + fragment transitively, abort without --discard preserves both, manual aidlc-worktree discard cleans up the orphan via git worktree remove (defense-in-depth) (9 tests) |
| t134 | `tests/worktree/t134-swarm-referee.sh` | v0.6.0 Wave 4 milestone 16 — `aidlc-swarm.ts`, the stateless convergence **referee** the conductor consults, over real git worktrees. No headless `claude -p` worker survives, so there is no binary to swap: the harness plays the conductor, driving `prepare` / `check` / `finalize` directly and staging each worktree's on-disk state. `prepare` forks a worktree per unit + emits `SWARM_STARTED`; `check` is the stateless verdict (exit 0 only on a genuine convergence — the real check command, never a self-claim — same answer on repeat calls); the anti-tamper guard rejects an edited protected `--test-file` (baseline re-derived from the git fork); `finalize` re-verifies every claimed unit before merging — the **lying-conductor guard** refuses a falsely-claimed-converged (red-on-disk) unit, lands it in the failure envelope (`SWARM_UNIT_FAILED` + `SWARM_BATON_RETURNED`), and exits 2; a mixed batch tallies converged + failed + `SWARM_COMPLETED`; `prepare --degraded-from ultracode` emits `SWARM_DEGRADED`; a `../`-escaping `--test-file` is a typed error; `finalize --reasons <unit>=unsatisfiable` lands the conductor's typed attribution on a declined unit, but cannot override a claimed-but-red unit's `error` verdict (13 tests) |

### Workflow Tests

| Test ID | File | Description |
|---------|------|-------------|
| t50 | `tests/workflow/t50-workflow-bugfix-scope.sh` | Workflow test — bugfix scope full lifecycle via --test-run (24 tests) |
| t51 | `tests/workflow/t51-workflow-poc-scope.sh` | Workflow test — POC scope via --test-run (19 tests) |
| t51 | `tests/workflow/t51-bugfix-event-parity.sh` | End-to-end event parity test for the bugfix scope — full audit stream vs expected (15 tests) |
| t52 | `tests/workflow/t52-workflow-state-progression.sh` | Workflow test — state file progression during bugfix (10 tests) |
| t53 | `tests/workflow/t53-workflow-scope-routing.sh` | Workflow test — bugfix scope routing (skip Ideation) (11 tests) |
| t54 | `tests/workflow/t54-workflow-audit-completeness.sh` | Workflow test — audit trail completeness during bugfix (10 tests) |
| t55 | `tests/workflow/t55-workflow-init-then-resume.sh` | Workflow test — two-phase: --init then bugfix --test-run resume (8 tests) |
| t56 | `tests/workflow/t56-workflow-forward-jump.sh` | Workflow test — forward jump + auto-init with --test-run (8 tests) |
| t57 | `tests/workflow/t57-workflow-backward-jump.sh` | Workflow test — backward jump + replay with --test-run (5 tests) |
| t58 | `tests/workflow/t58-workflow-workshop-scope.sh` | Workflow test — workshop scope routing (skip Ideation) (14 tests) |
| t59 | `tests/workflow/t59-workflow-depth-override.sh` | Workflow test — depth override persists through bugfix workflow (6 tests) |
| t60 | `tests/workflow/t60-construction-worktrees-enterprise.sh` | Construction-worktrees per-scope contract for enterprise; scope-grid codegen mode + dispatch-event + practices-discovery EXECUTE + v7 state fields. The four SKILL.md prose-presence checks were retired at the engine cutover — behaviour now in the engine + aidlc-bolt.ts + stage-protocol.md (5 tests) |
| t61 | `tests/workflow/t61-construction-worktrees-feature.sh` | Construction-worktrees per-scope contract for feature (skeleton-on, practices-discovery EXECUTE); four SKILL.md prose-presence checks retired at the engine cutover (5 tests) |
| t62 | `tests/workflow/t62-construction-worktrees-mvp.sh` | Construction-worktrees per-scope contract for mvp; four SKILL.md prose-presence checks retired at the engine cutover (5 tests) |
| t63 | `tests/workflow/t63-construction-worktrees-poc.sh` | Construction-worktrees per-scope contract for poc (skeleton-on, practices-discovery SKIP); four SKILL.md prose-presence checks retired at the engine cutover (5 tests) |
| t64 | `tests/workflow/t64-construction-worktrees-workshop.sh` | Construction-worktrees per-scope contract for workshop (multi-engineer parallel scenario); four shared prose-presence checks plus two inline workshop-resume / resume-mid-batch greps retired at the engine cutover (3 tests) |
| t65 | `tests/workflow/t65-construction-worktrees-bugfix.sh` | Construction-worktrees per-scope contract for bugfix (skeleton-off, practices-discovery SKIP); four SKILL.md prose-presence checks retired at the engine cutover (4 tests) |
| t66 | `tests/workflow/t66-construction-worktrees-refactor.sh` | Construction-worktrees per-scope contract for refactor (skeleton-off, practices-discovery SKIP); four SKILL.md prose-presence checks retired at the engine cutover (4 tests) |
| t67 | `tests/workflow/t67-construction-worktrees-security-patch.sh` | Construction-worktrees per-scope contract for security-patch (skeleton-off, practices-discovery SKIP); four SKILL.md prose-presence checks retired at the engine cutover (4 tests) |
| t122 | `tests/workflow/t122-stop-hook-e2e.sh` | v0.6.0 Wave 2 milestone 10 — workflow-tier END-TO-END enforcement of the Stop hook `aidlc-stop.ts`, the framework's FIRST flow-altering hook. Closes the one named-coverage gap left by the feature-tier MOCK test `t121`: t122 runs the REAL hook against the REAL `aidlc-orchestrate` engine, including one genuinely live `claude -p` pass (a build-time probe confirmed Stop hooks fire under `claude -p` and that block-and-inject resumes the same headless session — this IS the live interactive path, not a simulation). Asserts: (e2e) `/aidlc --status` over a COMPLETED workflow runs to completion under the live Stop hook with no 124 hang and exits 0 reporting the workflow complete (the spec's run-to-`done`-under-the-hook), and — guarded on the durable heartbeat, since the skill-scoped Stop hook does not fire on every `-p` turn — the live hook took the `done`->allow path (`resetGuard` wrote `block-count.json` count 0); (real engine) a PENDING workflow drives a real `run-stage` and the real hook emits a real `{"decision":"block"}` naming the pending stage + re-feeding the loop with no override verbs (t121's mock omits the real engine); (real engine) `done` -> empty stdout + exit 0; (real engine) recursion release — a genuinely-pending engine with the counter seeded AT the cap + `stop_hook_active:true` RELEASES (empty stdout, exit 0, drop record), so a stuck loop never traps the session (light re-confirm; t121 owns the exhaustive guard corpus). Requires the claude CLI; the Esc carve-out needs no test (SPIKE 1) (6 tests) |

## Trigger Points

| Trigger | Layer | Command | Where |
|---------|-------|---------|-------|
| `git commit` | L1 | `bash tests/run-tests.sh` | Local (pre-commit hook) |
| CI pipeline | L2 | `bash tests/run-tests.sh --ci` | CI/CD pipeline |
| Release / merge to main | L3 | `bash tests/run-tests.sh --release` | CI/CD pipeline |

L1 can be enforced via a git pre-commit hook: `bash tests/run-tests.sh || exit 1`.

## Stubs

### Greenfield Stub: `tests/fixtures/greenfield-todo/`

A project description with no source code. Workspace-detection classifies as greenfield. Gives the LLM deterministic intent context for ideation stages.

Contents: Just `README.md` describing a React Todo App with TypeScript and Vite.

### Brownfield Stub: `tests/fixtures/brownfield-todo/`

Minimal React+TypeScript+Vite source (~10 files, ~200 LOC). Workspace-detection classifies as brownfield. RE, requirements, and design stages have concrete code to analyze.

Contents:
- `package.json` — react, react-dom, typescript, vite, vitest
- `tsconfig.json`, `vite.config.ts`, `index.html`
- `src/main.tsx`, `src/App.tsx`
- `src/types/todo.ts` — Todo interface (id, title, completed)
- `src/components/TodoList.tsx` — list + add form (~40 lines)
- `src/components/TodoItem.tsx` — checkbox + title + delete button
- `src/hooks/useTodos.ts` — addTodo, toggleTodo, deleteTodo

### RE Artifacts Fixture: `tests/fixtures/re-artifacts/`

Pre-seeded reverse-engineering output for downstream stage tests. Copied into `$PROJ/aidlc-docs/inception/reverse-engineering/` during setup.

Contents: 4 minimal .md files (architecture-overview, technology-stack, codebase-analysis, integration-points) describing the brownfield-todo app.

### Inception Artifacts Fixture: `tests/fixtures/inception-artifacts/`

Pre-seeded inception phase output for tests that jump into construction. Copied into `$PROJ/aidlc-docs/inception/{requirements-analysis,application-design,units-generation}/` during setup.

Contents: 7 minimal .md files (requirements, components, component-methods, services, component-dependency, unit-of-work, unit-of-work-story-map) describing the Todo app. Unit name: `todo-core`.

### Construction Artifacts Fixture: `tests/fixtures/construction-artifacts/`

Pre-seeded construction phase output for tests that jump to mid-construction stages (e.g., code-generation). Copied into `$PROJ/aidlc-docs/construction/todo-core/functional-design/` during setup.

Contents: 1 minimal .md file (functional-design) describing the todo-core unit's component specs and state management.

## State Fixtures

| Fixture | Project Type | Scope | State | Used By |
|---------|-------------|-------|-------|---------|
| `state-pre-workspace-detection.md` | -- | feature | Welcome+scaffold done, workspace-detection next | t70, t71 |
| `state-initialization-done.md` | Greenfield | feature | Init done, intent-capture next | t73 |
| `state-brownfield-init-done.md` | Brownfield | bugfix | Init done, RE next | t72 |
| `state-mid-inception.md` | Brownfield | bugfix | RE done, requirements-analysis next | t74 |
| `state-mid-ideation.md` | Greenfield | feature | Intent+market done, feasibility next | t08, t10, t11, t12, t20, t22, t24, t25, t37 |
| `state-construction.md` | -- | -- | Construction phase | t07, t10, t11, t26, t57 |
| `state-operation.md` | -- | -- | Operation phase | t07, t10, t11 |
| `state-completed.md` | -- | -- | All stages done | t08, t11 |
| `state-jumped.md` | Brownfield | bugfix | Mid-workflow with jump history | t11, t37, t42 |
| `state-corrupted.md` | -- | -- | Invalid/corrupted state | t08, t10 |

## How to Add a Stage Test

1. Choose the stage to test and identify what state fixture it needs (the state must show that stage as the current/next stage)
2. Create or reuse a state fixture in `tests/fixtures/`
3. Create `tests/stage/tNN-stage-SLUG.sh`:

```bash
#!/bin/bash
# tNN: Stage test — SLUG (N assertions, M turns)
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

plan N

# Setup: scaffold project with stub + state fixture
PROJ=$(setup_integration_project \
  --with-state "$FIXTURES_DIR/state-FIXTURE.md" \
  --with-brownfield-stub)  # or --with-greenfield-stub

# Run the stage
run_claude "$PROJ" "/aidlc --stage SLUG --test-run" --max-turns M

STATE="$PROJ/aidlc-docs/aidlc-state.md"

# Assertions...
# 1. Check state marks stage [x] completed
# 2. Check artifact directory exists
# 3. Check artifact files exist and have content
# 4. Check artifacts reference domain concepts
# 5. Check artifact size bounds

cleanup_test_project "$PROJ"
finish
```

4. Run with `bash tests/run-tests.sh --stage` or directly: `bash tests/stage/tNN-stage-SLUG.sh`

## How to Add Acceptance Assertions

To add artifact assertions to existing workflow tests (t50-t58):

1. Read the current test and understand what it already checks
2. Add assertions after the existing ones (increment the `plan` count)
3. Use flexible patterns: `grep -ri "[Tt]odo" "$DIR"` not exact strings
4. Use `skip` for assertions that depend on LLM output format
5. Use `assert_file_min_size` for size-bound checks

## Assertion Design Principles

- **Keyword classes** — Use case-insensitive regex: `[Tt]odo`, `[Rr]eact`, `[Bb]rownfield`
- **Flexible discovery** — Use `find` + `wc -l` to count files rather than checking exact names
- **Size bounds** — Use `assert_file_min_size` or `wc -c` + `assert_gt` for minimum content
- **Graceful degradation** — Use `skip` when an assertion depends on non-deterministic LLM output
- **Structure over content** — Check for markdown headings (`^#`), file existence, directory creation before checking content

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AIDLC_TEST_TIMEOUT` | `1800` | Per-`claude -p` call timeout in seconds. Set to `0` to disable. |

## CLI Reference

```bash
# Tier flags (combinable)
--smoke         # Structural validation
--unit          # Single-component isolation
--feature       # Cross-component contracts
--integration   # CLI tool utilities via claude
--stage         # Individual stage tests with stubs
--workflow      # Full multi-stage workflows
--worktree      # Worktree primitive tests (git worktree add/remove + helpers)

# Profile flags (shortcuts)
(default)       # L1: smoke + unit + feature
--ci            # L2: + integration + stage + worktree
--release       # L3: + workflow + worktree
--all           # Same as --release

# Output modifiers
--verbose       # Write per-test logs to tests/logs/
--debug         # Implies --verbose; adds bash -x traces
--filter PAT    # Only run tests whose filename matches extended regex PAT
--parallel N    # Run up to N test files concurrently within a tier (alias: -P N).
                # Default: 1 (serial). Smoke and unit tiers are always serial.
```

## Parallel Execution

`--parallel N` (or `-P N`) runs up to N test files concurrently within a tier. Default is serial (`1`).

**When it helps.** Integration, stage, and workflow tiers each spend most of their wall-clock on `claude -p` subprocess startup and LLM turns. These tests are already filesystem-isolated — `setup_integration_project` scaffolds a fresh `$PROJ` per test — so they can run side-by-side without interfering.

**Spike results (2026-05-06, Opus 4.7 via Bedrock):**

| Scenario | Serial | `--parallel 4` | `--parallel 8` |
|---|---|---|---|
| 4 × `/aidlc --help` | 56s | 16s (3.5x) | — |
| 8 × `/aidlc --help` | — | — | 31s |

All 8 parallel calls observed `cache_read=73789` — Bedrock prompt caching stays warm across concurrent workers. No throttling or corruption observed at 8-way.

**What stays serial.** Smoke and unit tiers ignore `--parallel` and run serially regardless. They already complete in seconds and their interleaved output would hurt debuggability for no wall-clock gain. The preflight gate (`t19-preflight-health.sh`) also runs serially because the LLM tiers depend on its exit status.

**Output under parallelism.** `START` markers stream live (several can appear back-to-back before the first `DONE` — that's the visible signal workers are concurrent), but each worker's TAP body is buffered and flushed to stdout as one contiguous block under a directory-mutex (`mkdir $LOG_DIR/.stdout.lock`, atomic on POSIX — works on macOS bash 3.2 without `flock`). So `ok`/`not ok` lines from different files never interleave; stdout reads top-to-bottom like a serial run, just with the file completion order determined by how long each test took rather than dispatch order. The trade-off: you don't see individual `ok` lines tick as a worker runs — you see its entire block when it finishes. For a live per-test stream, run serially (`--parallel 1`, the default). Per-test logs (`$LOG_DIR/<name>.log`) and trace files (`$LOG_DIR/<name>.trace.log`) are always per-file — there is no combined trace file, since concurrent workers would interleave writes. `cat $LOG_DIR/*.trace.log` reproduces the combined view on demand.

**Worker coordination.** The parent backgrounds `run_test_file` with `&` and holds a slot gate via `jobs -rp | wc -l`. Each worker writes an atomic `.meta` sidecar to `$LOG_DIR/_results/`; the parent reads them after `wait` to populate the summary tables. macOS ships bash 3.2.57 (no `wait -n`), so the gate polls every 200ms — negligible next to minute-long LLM calls.

**Guidance.** Start with `--parallel 4`. Raise to `8` if Bedrock capacity and your bill tolerate it. Drop back to serial for debugging a single failing test — or use `--filter` to isolate it.
