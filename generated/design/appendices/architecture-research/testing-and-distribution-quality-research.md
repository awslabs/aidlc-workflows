# Testing & Distribution Quality — Domain Research

**Project:** Cursor IDE Harness for AI-DLC Workflows 2.0
**Domain:** Testing & Distribution Quality
**Researcher:** Research Agent
**Date:** 2026-07

---

## Research Domain

How existing AI-DLC harnesses are tested (packaging parity tests, hook adapter contract tests), how the `--doctor` health-check works in `core/tools/aidlc-utility.ts`, and how byte-parity is enforced via the `--check` flag. This domain also covers the test suite structure (`t*.test.ts` naming, test tiers, bun test runner configuration).

---

## Reference Architectures

No external AWS reference architectures apply. This is a pure developer-tooling project — all patterns are codebase-internal, established by the four existing harnesses (Claude, Kiro, Codex, opencode).

| Pattern Source | Applicability | Key Patterns |
|---|---|---|
| `t150-codex-packaging.test.ts` | High — direct analog | Drift-guard subprocess, TS parity check, doctor invocation |
| `t240-opencode-packaging.test.ts` | High — direct analog | Drift-guard subprocess, shell-shape checks, adapter test |
| `t147-kiro-hook-adapter.test.ts` | High — direct analog | Subprocess shim pattern, fixture corpus, fail-open assertion |
| `t149-codex-hook-adapter.test.ts` | High — direct analog | Payload fixture, cwd rewriting, ×2 idempotency guard |
| `t218-kiro-ide-hook-adapter.test.ts` | Medium — env-var variant | USER_PROMPT channel, open-stdin guard |
| `scripts/package.ts` | High — diffTrees mechanism | Byte-parity algorithm, temp-dir check, ORPHAN/MISSING/DIFFERS |

---

## Managed Services

Not applicable. This project has no cloud infrastructure.

---

## Service Lifecycle Status

Not applicable. This project has no cloud services.

---

## Service Limits / Quotas

Not applicable. This project has no cloud services.

---

## Detailed Research

### Q1: What does an existing packaging parity test look like and what does it check?

**Source files:** `tests/unit/t150-codex-packaging.test.ts`, `tests/unit/t240-opencode-packaging.test.ts`

Both packaging parity tests follow an identical structure anchored on **subprocess invocation** of the packager CLI:

#### Structure Pattern

```
describe("tNNN dist/<harness> packaging parity + drift guard", () => {
  test("1: committed dist/<harness> matches the packaging script (drift guard)", ...)
  test("2: every packaged .ts file is byte-identical to its dist/claude source ...")
  test("3: shipped prose names no other harness's engine dir ...")
  test("4+: harness-specific structural checks ...")
  test("N: doctor passes in a fresh project ...")
})
```

#### Test 1 — Drift Guard (canonical pattern)

```typescript
test("1: committed dist/codex matches the packaging script (drift guard)", () => {
  const r = spawnSync("bun", [PACKAGE_SCRIPT, "codex", "--check"], {
    encoding: "utf-8",
    cwd: REPO_ROOT,
  });
  if (r.status !== 0) console.error(r.stderr); // surfaces file list on failure
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("in sync");
});
```

**Why subprocess:** "The packager is a CLI; we pin its observable behavior, not its internals." The packager builds a temp tree, diffs it byte-for-byte against committed `dist/`, exits 0 on match. Tests rely on the packager's own output rather than re-implementing the diff.

#### Test 2 — Core TypeScript Parity

Walks `.ts` files in `dist/<harness>/<harnessDir>/{tools,hooks}/`, compares bytes to the equivalent file in `dist/claude/.claude/`. Skips harness-specific adapters (e.g. `aidlc-codex-adapter.ts`). The contract: "the generator may transform prose/data paths, never code."

#### Test 3 — No Cross-Harness Prose Contamination

```typescript
const r = spawnSync("grep", ["-rn", "bun .claude/tools/", join(REPO_ROOT, "dist", "codex")], ...);
expect(r.status).toBe(1); // grep exits 1 on no matches = exactly what we want
```

Asserts that the wrong harness directory string never leaks into generated prose.

#### Test 4 — Method Relocation Check (opencode-specific)

Verifies `aidlc/spaces/default/memory/` exists and contains the expected rule files; the old harness-dir-hosted method tree is absent.

#### Test 5 — Harness-Native Wiring Check

For Codex: checks `hooks.json` event names and that every command routes through the single adapter. For opencode: checks `.opencode/` shape and subagent frontmatter.

#### Doctor Test (subprocess)

Both packaging tests exercise `--doctor` in a scratch project created with `cpSync` + `mkdtempSync`:

```typescript
function runDoctorWithCodexVersion(version: string): { status: number; output: string } {
  const root = mkdtempSync(join(tmpdir(), "t150-codex-version-"));
  try {
    const project = join(root, "project");
    cpSync(join(REPO_ROOT, "dist", "codex", ".codex"), join(project, ".codex"), { recursive: true });
    cpSync(join(REPO_ROOT, "dist", "codex", "aidlc"), join(project, "aidlc"), { recursive: true });
    // ... set up fake binary ...
    const tool = join(project, ".codex", "tools", "aidlc-utility.ts");
    const result = spawnSync(process.execPath, [tool, "doctor", "--project-dir", project], {
      cwd: project, encoding: "utf-8", env: { ...process.env, PATH: `${binDir}${delimiter}...` },
    });
    return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
```

Pattern: create a real on-disk copy of the dist tree, invoke `aidlc-utility.ts doctor`, assert on stdout/exit code.

#### Fixtures Used

- `tests/harness/fixtures.ts` — `REPO_ROOT`, `AIDLC_SRC`, `createTestProject()`, `seededRecordDir()`, `seededStateFile()`
- `tests/fixtures/state-brownfield-feature.md` — state fixture with an active workflow
- `tests/fixtures/kiro-hook-payloads/payloads.json`, `tests/fixtures/codex-hook-payloads/payloads.json` — captured live payloads

---

### Q2: How does the `--doctor` arm work and what does it validate?

**Source file:** `dist/claude/.claude/tools/aidlc-utility.ts`, function `handleDoctor`

The doctor arm is **harness-aware via `harnessDir()`** (reads `tools/data/harness.json` → `harnessDir` field). It dispatches on the harness string (`.claude`, `.kiro`, `.codex`, `.aidlc`) and runs a series of boolean checks that accumulate into a `results` array.

#### Validation Steps (in order)

**Step 1 — bun installed**
Checks `Bun.which("bun")` and falls back to `~/.bun/bin/bun`. Fails loudly; exit 1.

**Step 2 — Hook presence**
- `.claude`: reads `settings.json`, extracts all `aidlc-*.ts` filenames referenced, checks each exists in `hooks/`.
- Other harnesses: checks an explicit roster of core hook bodies (`aidlc-audit-logger.ts`, `aidlc-sync-statusline.ts`, etc.) plus the harness-specific adapter (`aidlc-kiro-adapter.ts`, `aidlc-codex-adapter.ts`).

**Step 3 — Harness wiring config**
| Harness | Checked files |
|---|---|
| `.claude` | `settings.json` |
| `.kiro` | `agents/aidlc.json`, `settings/cli.json` |
| `.codex` | `config.toml`, `hooks.json`, `rules/default.rules` |
| `.aidlc` (opencode) | `opencode.json` or `opencode.jsonc`, `.opencode/command/aidlc.md` |

For Cursor, the analogous files would be `hooks.json`, `.cursor/skills/aidlc/SKILL.md`, and at least one rule file.

**Step 4 — Workspace shell ready**
Checks `<harnessEngineDir>/` and `aidlc/spaces/default/memory/` both exist.
Label: `"workspace shell ready (<harnessDir>/ + aidlc/spaces/default/memory/)"`.

**Step 5 — Plugin selection integrity**
Verifies `tools/data/harness.json` agrees with `stage-graph.json` plugin flags; checks no enabled stage files are missing on disk.

**Step 6 — Stage graph compiled**
Verifies `tools/data/stage-graph.json` is present and non-stale.

**Step 7 — Workflow state analysis (if workflow active)**
Reads state file + audit, runs `runDoctorAnalysis()`, emits findings with severity levels. Non-zero findings from the `runDiagnosis()` path do NOT affect doctor's exit code.

**Exit code:** `passed = results.filter(r => r.pass).length`, `failed = results.filter(r => !r.pass).length`. Exit 1 if `failed > 0`.

**Output format:** Each result prints as `✓  label` or `✗  label\n   fix: ...`.

#### Adding Cursor to the Doctor

The doctor dispatches on `harnessDir()` from `tools/data/harness.json`. For Cursor (`.cursor`), a new `else if (harness === ".cursor")` branch would check:
- `hooks.json` present (hook registry)
- `.cursor/skills/aidlc/SKILL.md` present (entry point)
- At least one rule in `.cursor/rules/` (method context)
- `AGENTS.md` present (onboarding)

The `harnessDir()` seam reads the value dynamically, so no hardcoded map change is needed in the core doctor function — only a new branch.

---

### Q3: What is the bun test runner configuration and how are tests organized by tier?

**Source files:** `tests/run-tests.ts`, `tests/run-tests.sh`, `tests/tsconfig.json`

#### Test Runner Architecture

The test runner is a full TypeScript file (`tests/run-tests.ts`) invoked via `bun tests/run-tests.ts`. `tests/run-tests.sh` is a thin POSIX wrapper that prepends `~/.bun/bin` to PATH and delegates.

#### Four-Tier Structure

| Tier | Directory | Purpose | Parallelism |
|---|---|---|---|
| smoke | `tests/smoke/` | Structural validation (files exist, permissions, JSON validity) | Always serial |
| unit | `tests/unit/` | Single-component isolation (hooks, frontmatter, packaging parity) | Always serial |
| integration | `tests/integration/` | Cross-component contracts, live CLI utilities | Configurable (`--parallel N`) |
| e2e | `tests/e2e/` | Full lifecycle, worktree, rendered terminal journeys | Configurable (`--parallel N`) |

Smoke and unit are always serial; integration and e2e default to serial but support `--parallel N`.

**Profile shortcuts:**
- Default / `--ci`: smoke + unit + integration
- `--release` / `--all`: smoke + unit + integration + e2e

#### Test File Naming Convention

All test files follow `t<number>[-description].test.ts`:
- Sequential numbers within a tier: `t04`, `t05`, `t06`, ... `t247`
- Descriptive slugs after the number: `t150-codex-packaging.test.ts`, `t147-kiro-hook-adapter.test.ts`
- Special suffix `.serial.test.ts` forces serial execution within integration/e2e
- Plugin tests live at `plugins/<name>/tests/*.test.ts` and are folded into the integration tier

#### File Discovery

The runner uses `readdirSync(dir).filter(f => f.endsWith('.test.ts')).sort()` — alphabetical sort ensures stable order. Numbers pad naturally for sort correctness.

#### bun test Invocation

Each file is run as:
```bash
bun test <file> --reporter=junit --reporter-outfile=<tmpfile>
```

The runner captures stdout+stderr, parses the JUnit XML for pass/fail counts, and aggregates into a summary table.

#### Environment Variables Injected Per Test

```typescript
const env = {
  ...process.env,
  AIDLC_TEST_NAME: base,
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  AIDLC_SKIP_REVISION_BACKSTOP: "1",
};
```

Tests that need to re-enable guards must clear these in their own subprocess invocations.

#### tsconfig.json

```json
{
  "extends": "../tsconfig.json",
  "include": ["**/*.ts"],
  "exclude": ["fixtures/**"]
}
```

Inherits strict mode from the root config. Fixture data files are excluded from TypeScript compilation.

---

### Q4: How does `--check` enforce byte-parity (exact mechanism)?

**Source file:** `scripts/package.ts`, functions `checkHarness`, `diffTrees`

#### Algorithm

`--check` is a **fresh-build-then-diff** idiom:

1. Load the harness manifest from `harness/<name>/manifest.ts`
2. Build the entire harness tree into a `mkdtempSync` temp directory (runs all 5 pipeline steps: copy, harness-authored files, stage-graph compile, runner-gen, emit)
3. Diff the temp tree byte-for-byte against the committed `dist/<name>/`
4. Exit 1 with the offending paths if any difference is found; exit 0 if clean

#### `diffTrees` Function

```typescript
function diffTrees(
  built: string,     // temp tree root
  committed: string, // dist/<name> root
  relPrefix: string, // label prefix for error messages
  generatedFiles?: readonly string[],
): string[] {
  const problems: string[] = [];
  const builtFiles = new Set<string>();
  
  // Check every built file against committed: MISSING or DIFFERS
  for (const f of generatedFiles ?? walk(built)) {
    const rel = relative(built, f);
    builtFiles.add(rel);
    const c = join(committed, rel);
    if (!existsSync(c)) problems.push(`MISSING in dist: ${relPrefix}/${rel}`);
    else if (!readFileSync(f).equals(readFileSync(c))) problems.push(`DIFFERS: ${relPrefix}/${rel}`);
  }
  
  // Check committed for files NOT in the built set: ORPHAN
  if (existsSync(committed)) {
    for (const f of walk(committed)) {
      const rel = relative(committed, f);
      if (builtFiles.has(rel)) continue;
      problems.push(`ORPHAN in dist: ${relPrefix}/${rel}`);
    }
  }
  return problems;
}
```

Three problem types:
- **MISSING**: file in built tree but not in committed `dist/` (newly generated file not committed)
- **DIFFERS**: file exists in both but bytes differ (content changed, dist/ not regenerated)
- **ORPHAN**: file in committed `dist/` but not in rebuilt tree (file removed from core/ but old copy lingers in dist/)

#### Determinism Requirement

For `--check` to be meaningful, `buildTree()` must be **deterministic**:
- No timestamps in generated content
- No random values
- No environment-dependent data
- `AIDLC_TIER_CAP` env var is **ignored** under `--check` (env cap is a write-mode knob only; persistent cap in `core/memory` applies in both modes)

#### Scope

`--check` covers the entire `dist/<name>/` root (not just `<harnessDir>/`), including:
- The workspace shell (`aidlc/spaces/default/memory/`)
- Compiled data files (`tools/data/stage-graph.json`, `tools/data/scope-grid.json`, `tools/data/harness.json`)
- The memory-seed bundle (`tools/data/memory-seed/`)
- Plugin projections (`dist/plugins/<plugin>/<harness>/`)

#### Single-Harness vs. All-Harness

```bash
bun scripts/package.ts --check           # checks all discovered harnesses + plugins
bun scripts/package.ts cursor --check    # checks only the cursor harness
```

In single-harness mode, the plugin orphan sweep is suppressed (`checkPlugins(targets, !named)` → `full=false`) because other harnesses' plugin projections are intentionally absent from this run's scope.

---

### Q5: What patterns do existing hook adapter tests use?

**Source files:** `tests/unit/t147-kiro-hook-adapter.test.ts`, `tests/unit/t149-codex-hook-adapter.test.ts`, `tests/unit/t218-kiro-ide-hook-adapter.test.ts`

#### Core Pattern: Subprocess Shim Testing

All adapter tests use **subprocess invocation** rather than in-process imports. The rationale documented in the test files: "The adapter IS a subprocess shim — in-process unit testing would bypass the exact stdin/stdout/exit-code surface being contracted."

```typescript
function runAdapter(
  projectDir: string,
  target: string,           // event name: "stop", "session-start", "audit-and-sensors", etc.
  payload: unknown,
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(
    "bun",
    [join(projectDir, "<harnessDir>", "hooks", "aidlc-<harness>-adapter.ts"), target],
    {
      cwd: projectDir,
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      timeout: 30_000,
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}
```

#### Scratch Project Setup

Every test case creates an isolated scratch project:

```typescript
function scratchProject(withState: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "t147-"));
  cpSync(KIRO_TREE, join(dir, ".kiro"), { recursive: true });  // copy real dist tree
  seedShell(dir);  // seed workspace shell (active-space + intents)
  if (withState) {
    writeFileSync(seededStateFile(dir), readFileSync(STATE_FIXTURE, "utf-8"));
    // seed audit shard, clone-id, etc.
  }
  return dir;
}
```

Projects are torn down in `finally` blocks: `rmSync(dir, { recursive: true, force: true })`.

#### Payload Fixtures

Payloads are loaded from JSON corpus files captured from live harness runs:

```typescript
const FIXTURES = JSON.parse(
  readFileSync(join(REPO_ROOT, "tests", "fixtures", "kiro-hook-payloads", "payloads.json"), "utf-8"),
) as Record<string, unknown>;
```

Fixture keys: `stop`, `agentSpawn`, `postToolUse_todo_create`, `postToolUse_subagent`, etc.

For Codex, `cwd` is patched to the scratch project dir:
```typescript
function withCwd(payload: Record<string, unknown>, dir: string): Record<string, unknown> {
  return { ...payload, cwd: dir };
}
```

#### Core Assertions Per Event

| Event | Assertion when state active | Assertion when no state |
|---|---|---|
| `stop` | `JSON.parse(stdout).decision === "block"`, `reason !== ""` | `stdout.trim() === ""` (silent allow) |
| `session-start` | `stdout` contains `"AIDLC WORKFLOW ACTIVE"` | stdout contains context |
| `state-sync` | state file's `Current Stage` field updated | clean no-op |
| `audit-and-sensors` | audit shard contains `ARTIFACT_*` event | no audit row |
| `log-subagent` | audit shard contains `SUBAGENT_COMPLETED` | — |

#### Fail-Open Contract

Every adapter test includes a malformed-stdin test:

```typescript
test("9: malformed stdin fails open (exit 0, no output) on every target", () => {
  const dir = scratchProject(true);
  try {
    for (const target of ["stop", "session-start", "state-sync", "audit-and-sensors", "log-subagent"]) {
      const r = runAdapter(dir, target, "{not json");
      expect(`${target}:${r.code}`).toBe(`${target}:0`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

#### Cursor-Specific Adapter Considerations

Cursor's hook contract differs from all existing adapters:
- **Payload format**: camelCase JSON (`conversation_id`, `generation_id`, `hook_event_name`, `workspace_roots`)
- **Blocking mechanism**: return `{ "permission": "deny" }` to block (vs. exit code 2 in Claude/Kiro)
- **Delivery channel**: stdin (same as Kiro/Codex, unlike Kiro IDE's `USER_PROMPT` env var)
- **Event names**: `beforeSubmitPrompt`, `stop`, `beforeShellExecution`, `afterFileEdit`

A Cursor adapter test (`t145-cursor-hook-adapter.test.ts`) would follow the t147/t149 pattern but with:
- Cursor-shaped payload fixtures (camelCase fields)
- `"permission": "deny"` assertion instead of `decision: "block"`
- The four Cursor-specific event names
- A `failClosed: true` guard test for `beforeShellExecution`

#### process.execPath Guard Test

Both kiro and codex adapter tests include a "bun on PATH" regression test:

```typescript
test("14: session-start dispatches even when child PATH has no bun (uses process.execPath)", () => {
  // strips bun from PATH, invokes adapter directly via process.execPath
  // asserts the adapter's OWN child respawn doesn't fail ENOENT
});
```

This tests that adapter child processes use `process.execPath` (the running bun) rather than a bare `"bun"` string. The Cursor adapter should follow this pattern.

---

## Options Summary (Neutral)

The domain has no genuine options — there is one established testing pattern in this codebase that all harnesses use. The Cursor harness should follow the same pattern.

| Aspect | The Pattern | Notes |
|---|---|---|
| Packaging parity test | Subprocess `bun scripts/package.ts cursor --check` | Same as t150/t240 |
| Adapter contract test | `spawnSync` shim against dist tree copy | Same as t147/t149 |
| Fixture payloads | JSON corpus in `tests/fixtures/cursor-hook-payloads/payloads.json` | New file needed |
| Doctor test | `cpSync` dist to tmpdir, invoke `aidlc-utility.ts doctor` | Same as t150 test 13 |
| Test file location | `tests/unit/t145-cursor-packaging.test.ts` | Unit tier (serial) |
| Test file numbering | t145 (as cited in FR-201 and vision.md) | Confirms no gap |

---

## Decision Points for Design Agent

1. **Fixture payload capture**: Cursor hook payloads must be captured from a real Cursor run to populate `tests/fixtures/cursor-hook-payloads/payloads.json`. A synthetic approximation (hand-written JSON following Cursor's documented schema) is a viable alternative for initial test authoring. The test can be updated once live captures are available.

2. **Doctor harness branch**: `handleDoctor` dispatches on `harnessDir()`. The Cursor harness needs a new `else if (harness === ".cursor")` branch checking `hooks.json`, `skills/aidlc/SKILL.md`, at least one rule file, and `AGENTS.md`. This is a `core/tools/aidlc-utility.ts` change (FR-009 scope).

3. **Adapter blocking semantics**: Cursor returns `{ "permission": "deny" }` to block an operation; core hooks use exit code 2. The adapter must translate between these. Test `t145` should assert `stdout.includes('"permission"')` and `JSON.parse(stdout).permission === "deny"` for blocking scenarios (unlike t147/t149 which check `decision === "block"`).

4. **Test number t145**: FR-201 and vision.md explicitly name `t145-cursor-packaging.test.ts`. The next available number after scanning `tests/unit/` is indeed 145 (no existing t145 file found in the unit directory listing).

---

## External Dependencies

- `bun` runtime (existing, required for all hooks and the test runner)
- `node:child_process` `spawnSync` (built-in, used by all adapter tests)
- `node:fs` `cpSync`, `mkdtempSync`, `rmSync` (built-in, used by all packaging tests)
- `tests/harness/fixtures.ts` (existing shared fixture helpers)
- `dist/cursor/.cursor/` (output of packager — must exist before tests can run)

---

## Requirement Traceability

| Finding | Requirement |
|---|---|
| Packaging parity test pattern (subprocess drift guard) | FR-008, FR-201, NFR-202 |
| Adapter contract test pattern (subprocess shim) | FR-007, FR-201 |
| Doctor arm validation logic | FR-009 |
| `--check` byte-parity mechanism | FR-008, NFR-007 |
| Test tier structure (unit tier, bun runner) | FR-201, NFR-001 |
| process.execPath guard | FR-006, FR-007 |
| Deterministic emitter requirement | NFR-007 |

---

## Assumptions

- The Cursor harness will have `harnessDir() === ".cursor"` (from `tools/data/harness.json` written by the packager).
- The test number t145 is correct as cited in FR-201; confirmed no `t145*.test.ts` exists in `tests/unit/`.
- Cursor hook payloads for the fixture corpus will be derived from Cursor's documented hook schema (camelCase fields: `conversation_id`, `generation_id`, `hook_event_name`, `workspace_roots`) since live captures require a real Cursor install.
- The doctor arm extension stays in `core/tools/aidlc-utility.ts` as a new `else if (harness === ".cursor")` branch — no separate file needed.
