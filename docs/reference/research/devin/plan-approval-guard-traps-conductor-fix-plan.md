# Task: Fix "plan-approval-guard traps conductor at code-generation entry"

## Context

A live Devin e2e run (`docs/rfcs/handoff-run-real-devin-session-notes.md`,
§"CRITICAL BUG: plan-approval-guard traps conductor at code-generation entry"
through §"Shell-redirection diagnosis") found that the
`aidlc-plan-approval-guard.ts` PreToolUse hook traps the conductor at the
code-generation boundary on Devin 3000.6.14. The 2.7.4 fix
(`human-turn-not-written-on-ask-user-question-fix-plan.md`) unblocked
`HUMAN_TURN` minting and challenge preservation. This plan addresses the
**guard-trap** facets that remain open.

## Background: what the 2.7.4 fix already did

- Devin + codex adapters now recognize Devin's native `ask_user_question`
  answer shape, so a structured-UI answer mints `HUMAN_TURN`.
- The Stop hook now carves out a pending Plan Approval challenge before the
  engine probe, so the probe can no longer delete the challenge.

Those fixes unblock the **receipt-recording** path. They do not touch the
plan-approval-guard's early-exit logic, the shell-redirect parsing, the
`workdir` normalization, or the `git` subcommand allowlist. Those are the
facets this plan covers.

## The three facets to fix

### Facet A — Shell redirects trigger the guard trap

- **File:** `core/hooks/aidlc-plan-approval-guard.ts` line 706
- **Parser file:** `core/hooks/review-freeze-command.ts` lines 775–849
  (`shellWriteTargets`)
- **Root cause:** `shellWriteTargets` scans for `>` outside quotes and treats
  the following word as a write target. `2>/dev/null` produces a write target
  (`/dev/null`), and `2>&1 | cat` takes the opaque-shell path. Both prevent
  the early-exit at line 706 and fall through to the directive check at line
  711, which blocks when the active directive is not a v2 `code-generation`
  `run-stage`.
- **Observed trap:** `bun .devin/tools/aidlc-orchestrate.ts next 2>/dev/null`
  is blocked. The error message tells the conductor to run `next`, but `next`
  with any redirect is also blocked. The conductor escaped only by running
  bare `next` with no pipes/redirects — fragile and non-obvious.

### Facet B — `workdir` not normalized into top-level `cwd`

- **File:** `harness/devin/hooks/aidlc-devin-adapter.ts` lines 626–633
- **Root cause:** Devin's `exec` tool passes the working directory in
  `tool_input.workdir`, not at the top-level `cwd` field the guard reads
  (`parsed.cwd` at `aidlc-plan-approval-guard.ts` line 665). The adapter's
  `rewriteStdinToolName` only rewrites `tool_name`; it does not lift
  `tool_input.workdir` into the top-level `cwd`. The guard then falls back to
  `projectDir` (line 665), and `isFrameworkToolInvocation` (line 487) resolves
  the script path against `cwd` — which may not match the directory the
  conductor actually ran the command in.
- **Status in the notes:** the handoff notes (line 1031–1034) mark this as
  "a hypothesis, not a confirmed cause" because the full `exec` command and
  `workdir` were never captured. Phase 0 captures the real payload before any
  fix is written.

### Facet C — `git add`/`git commit` blocked at code-generation boundary

- **File:** `core/hooks/aidlc-plan-approval-guard.ts` lines 524–537
- **Root cause:** `git` is not in `READ_ONLY_SHELL_COMMANDS`. The `git`
  branch only allows `branch --show-current` and the subcommands in
  `READ_ONLY_GIT_SUBCOMMANDS` (`branch`, `diff`, `grep`, `log`, `ls-files`,
  `rev-parse`, `show`, `status`). `add`, `commit`, `restore`, `stash` are
  blocked when the workflow is at code-generation without an approved plan.
- **Observed impact:** the conductor cannot `git add` + `git commit` workflow
  state at the code-generation boundary. The user must either run git
  manually in a separate terminal or proceed with code generation first.

---

## Execution model: subagent dispatch

Every phase is a subagent. Dependencies gate dispatch order; independent
work runs in parallel. Facets A and C both edit
`core/hooks/aidlc-plan-approval-guard.ts` — dispatch them as a single
subagent to avoid a write conflict. Facet B edits
`harness/devin/hooks/aidlc-devin-adapter.ts` and
`harness/codex/hooks/aidlc-codex-adapter.ts` — dispatch as a separate
subagent. Phase 0 (capture) is a gate for Facet B only; Facets A+C do not
depend on it, so Subagent A runs in parallel with Phase 0. Phase 2.0
(fixtures) is a subagent that must complete before the test subagents (the
fixtures file is shared). Phase 3 (repackage), Verification, and Release
prep are each subagents.

```
Phase 0 + Phase 1-A (parallel background subagents)
   ├── Subagent 0 (subagent_explore): capture the real exec tool_input shape
   └── Subagent A (subagent_general): Facets A + C — guard early-exit + git carve-out
   │
   ▼ (wait for Subagent 0)
Phase 1-B (background subagent)
   └── Subagent B (subagent_general): Facet B — workdir normalization in devin + codex adapters
   │
   ▼ (wait for Subagents A + B)
Phase 2 (background subagent, then parallel background subagents)
   ├── Subagent C (subagent_general): create fixtures in payloads.json
   │  ▼ (wait for C)
   ├── Subagent D (subagent_general): t265 tests (plan-approval-guard)
   ├── Subagent E (subagent_general): t332 tests (devin adapter workdir)
   └── Subagent F (subagent_general): t149 tests (codex adapter parity)
   │
   ▼ (wait for all)
Phase 3 (background subagent)
   └── Subagent G (subagent_general): repackage — bun scripts/package.ts + --check
   │
   ▼ (wait for G)
Verification (background subagent)
   └── Subagent H (subagent_general): run targeted test suite
   │
   ▼ (wait for H)
Release prep (background subagent)
   └── Subagent I (subagent_general): version bump + changelog + README + repackage + t68
```

---

## Phase 0 — Capture Devin's real `exec` tool_input shape

**Dispatch:** `subagent_explore` (background, Subagent 0). Runs in parallel
with Subagent A (Facets A+C) since A does not depend on the captured shape.

**Goal:** Determine the exact field name Devin uses for the working
directory in `exec` tool_input before writing the normalization in Facet B.

### Steps

1. Search `/home/wiley/.local/share/devin/cli/_versions/3000.6.14/share/devin/docs`
   for the `exec` tool schema and any `workdir`/`cwd`/`working_directory`
   field names.
2. Search `/home/wiley/.local/share/devin/cli/_versions/3000.6.14/share/devin/`
   (source) for the same.
3. If the docs/source do not contain the shape, run `strings` on the devin
   binary and grep for `workdir`, `cwd`, `working_directory`.
4. Document the exact field name in the "Phase 1 — Facet B" section below
   (append a "Captured shape" subsection).

### Exit criteria

- The exact field name for the working directory in Devin's `exec`
  `tool_input` is documented in this plan.
- If the field is `workdir`, Facet B proceeds as written. If it is something
  else, update Facet B's code to use the captured name.

---

## Phase 1 — Facets A + C: guard early-exit + git carve-out

**Dispatch:** `subagent_general` (background, Subagent A). Runs in parallel
with Subagent 0 (Phase 0 capture) since Facets A+C do not depend on the
captured `exec` shape. Implements both facets in the same file in sequence:
Facet A first, then Facet C.

**Goal:** Prevent shell redirects from defeating the framework-tool
exemption, and allow `git add`/`git commit` of inception-phase artifacts at
the code-generation boundary.

### File to edit

- `core/hooks/aidlc-plan-approval-guard.ts`

### Step 1.1 — Filter pseudo-device targets before the early-exit (Facet A)

In `core/hooks/aidlc-plan-approval-guard.ts`, locate the early-exit check at
line 706:

```typescript
if (!guardedDispatch && mutation.targets.length === 0 && !mutation.opaqueShell) {
  return 0;
}
```

Replace it with:

```typescript
// Shell redirects to pseudo-devices (2>/dev/null, 2>&1, 1>/dev/null) produce
// write targets that defeat the framework-tool exemption: the guard sees
// targets.length > 0, skips the early-exit, and falls through to the
// directive check, which blocks bare `bun .devin/tools/aidlc-*.ts next`
// commands run with any redirect. Pseudo-device redirects are semantically
// no-ops (they discard or pass through output), so exclude them from the
// mutation-target count for the early-exit path. Real file redirects are
// still tracked.
const PSEUDO_DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);
const realTargets = mutation.targets.filter(
  (t) => !PSEUDO_DEVICES.has(resolve(t)),
);
if (!guardedDispatch && realTargets.length === 0 && !mutation.opaqueShell) {
  return 0;
}
```

`resolve` is already imported from `node:path`.

### Step 1.2 — Ignore opaque-shell for framework-tool invocations (Facet A)

The handoff notes (line 1024) report that `2>&1` takes the opaque-shell
path — the parser reports an extra command named `1`, making
`mutation.opaqueShell` true, which also prevents the early-exit.

Locate the early-exit check you just modified. Replace it with:

```typescript
// `2>&1` and similar redirects take the opaque-shell path (the parser
// reports an extra command). For framework-tool invocations, the exemption
// already trusts the command; an opaque shell wrapper around a trusted
// command should not trap it. Re-resolve the invocation to check.
const isFrameworkBash =
  toolName === "Bash" &&
  typeof toolInput.command === "string" &&
  shellCommandInvocations(toolInput.command).some(
    (inv) => isFrameworkToolInvocation(projectDir, cwd, inv.name, inv.args),
  );
if (
  !guardedDispatch &&
  realTargets.length === 0 &&
  (!mutation.opaqueShell || isFrameworkBash)
) {
  return 0;
}
```

`shellCommandInvocations` is already imported (line 597–600, via
`aidlc-review-freeze.ts`). `isFrameworkToolInvocation` is already defined
(line 464).

### Step 1.3 — Allow `git add`/`git commit` at the code-generation boundary (Facet C)

> **Superseded (2026-09-12):** The `invocations.some(...)` implementation below allowed unrelated mutations in compound commands to bypass plan approval. Keep this snippet as historical context only; use the [compound Git bypass tightening plan](plan-approval-compound-git-bypass-fix-plan.md) for the corrected all-invocations, concrete-target, and dynamic-evaluation checks.

In `core/hooks/aidlc-plan-approval-guard.ts`, locate the `mutationIntent`
function (lines 582–623). Insert this check immediately before the
`shellWriteTargets` call at line 600:

```typescript
// `git add` and `git commit` of inception-phase artifacts (scope, codekb,
// intents, memory) are not code-generation writes. The guard's purpose is
// to prevent code-generation before Plan Approval, not to prevent git
// checkpointing of already-completed inception work. Treat `git add` and
// `git commit` as non-opaque (allow the early-exit) — the mutation-target
// detection already determines whether the command touches concrete files,
// and `git add`/`git commit` do not produce write targets via
// `shellWriteTargets`. The block happens in `shellInvocationNeedsApproval`,
// which returns true for `git add`/`git commit` because they are not in
// `READ_ONLY_GIT_SUBCOMMANDS`. This carve-out overrides that for the
// plan-approval-guard only — review-freeze is unaffected.
if (toolName === "Bash" && typeof toolInput?.command === "string") {
  const invocations = shellCommandInvocations(toolInput.command);
  const isGitAddOrCommit = invocations.some(
    (inv) =>
      normalizedCommandName(inv.name) === "git" &&
      ["add", "commit"].includes(gitSubcommand(inv.args) ?? ""),
  );
  if (isGitAddOrCommit) {
    return { targets: [], opaqueShell: false, shellCommand: toolInput.command };
  }
}
```

`shellCommandInvocations`, `normalizedCommandName`, and `gitSubcommand` are
already defined or imported in the guard. This short-circuits `git add`/`git
commit` to non-opaque before `shellWriteTargets` runs, so the early-exit at
line 706 applies.

### Step 1.4 — Update the comment block

Update the comment at the top of the `mutationIntent` function (line 582) to
document the `git add`/`git commit` carve-out.

### Exit criteria

- `bun .devin/tools/aidlc-orchestrate.ts next 2>/dev/null` is allowed (exit 0)
  when the active directive is not a v2 code-generation run-stage.
- `bun .devin/tools/aidlc-orchestrate.ts next 2>&1 | cat` is allowed (exit 0)
  in the same state.
- `bun .devin/tools/aidlc-orchestrate.ts next` (bare) is still allowed (no
  regression).
- A real write redirect (`echo x > real-file.txt`) is still tracked as a
  write target (no regression on the guard's actual job).
- `git add -A` is allowed (exit 0) at the code-generation boundary when the
  active directive is not a v2 code-generation run-stage.
- `git commit -m "checkpoint"` is allowed (exit 0) in the same state.
- `git push` is still blocked (exit 2) in the same state.
- `git reset --hard` is still blocked (exit 2) in the same state.
- Existing t265 tests still pass.

---

## Phase 1 — Facet B: normalize `workdir` into `cwd` in the devin adapter

**Dispatch:** `subagent_general` (background, Subagent B). Waits for
Subagent 0 (Phase 0 capture) to complete before writing the normalization,
since the field name comes from the captured shape. Independent of
Subagent A (Facets A+C).

**Goal:** Ensure the plan-approval-guard resolves framework-tool script
paths against the directory the conductor actually ran the command in, not
the project root.

### Files to edit

- `harness/devin/hooks/aidlc-devin-adapter.ts` (the `plan-approval-guard`
  `exec` branch, lines 626–633)
- `harness/codex/hooks/aidlc-codex-adapter.ts` (the `plan-approval-guard`
  `exec` branch — locate by grepping for `plan-approval-guard`)

### Step 2.1 — Add a `rewriteStdinCwd` helper to the devin adapter

In `harness/devin/hooks/aidlc-devin-adapter.ts`, immediately after the
`rewriteStdinToolName` function (line 374), add:

```typescript
// Lift tool_input.workdir into the top-level cwd field the core
// plan-approval-guard reads (parsed.cwd at aidlc-plan-approval-guard.ts:665).
// The guard's isFrameworkToolInvocation resolves framework-tool script
// paths against cwd (resolve(cwd, script) at line 487). Without this lift,
// a `bun .devin/tools/aidlc-*.ts` command run from a subdirectory (Devin
// passes the subdirectory as workdir) fails the framework-tool exemption
// because the guard resolves the script path against the project root.
function rewriteStdinCwd(rawInput: string, devin: DevinHookInput): string {
  const workdir = devin.tool_input?.workdir;
  if (typeof workdir !== "string" || !workdir) return rawInput;
  try {
    const parsed = JSON.parse(rawInput) as Record<string, unknown>;
    if (typeof parsed.cwd !== "string" || !parsed.cwd) {
      parsed.cwd = workdir;
      return JSON.stringify(parsed);
    }
    return rawInput;
  } catch {
    return rawInput;
  }
}
```

If Phase 0 captures a different field name than `workdir`, update the
`devin.tool_input?.workdir` access to use the captured name.

### Step 2.2 — Apply `rewriteStdinCwd` in the devin adapter's exec branch

In `harness/devin/hooks/aidlc-devin-adapter.ts`, locate the
`plan-approval-guard` `exec` branch (lines 626–633):

```typescript
if (tool === "exec") {
  const rewritten = rewriteStdinToolName(rawInput, devin);
  const r = runCoreWithStderr("aidlc-plan-approval-guard.ts", rewritten);
  if (r.code === 2) {
    process.stderr.write(r.stderr);
    return 2;
  }
  return 0;
}
```

Replace the `rewritten` line with:

```typescript
const rewritten = rewriteStdinCwd(rewriteStdinToolName(rawInput, devin), devin);
```

The composition order is `rewriteStdinCwd(rewriteStdinToolName(...))` —
tool-name mapping first, then cwd lifting. The fields do not collide.

### Step 2.3 — Apply the same fix to the codex adapter

In `harness/codex/hooks/aidlc-codex-adapter.ts`:
1. Add the same `rewriteStdinCwd` helper (adjust the input type to the
   codex adapter's hook input type).
2. Locate the `plan-approval-guard` `exec` branch (grep for
   `plan-approval-guard`).
3. Apply the same `rewriteStdinCwd(rewriteStdinToolName(...))` composition.

### Step 2.4 — Update the comment block

Update the comment at the top of the devin adapter's `plan-approval-guard`
section (lines 618–625) to document that `workdir` is lifted into `cwd` for
the guard to resolve framework-tool script paths correctly.

### Exit criteria

- A `bun .devin/tools/aidlc-orchestrate.ts next` command run from a
  subdirectory (Devin passes the subdirectory as `workdir`) is allowed by
  the guard when the framework-tool exemption applies.
- A command run from the project root (no `workdir` or `workdir` == project
  root) is unaffected (no regression).
- The codex adapter has the same fix.
- Existing t332 + t149 tests still pass.

---

## Phase 2 — Tests

**Prerequisite:** Subagents A and B have completed. Dispatch Subagent C
(fixtures) first; wait for it, then dispatch D, E, F in parallel.

### Step 2.0 — Dispatch `subagent_general` C: create fixtures

**Dispatch:** `subagent_general` (background, Subagent C). Must complete
before the test subagents since the fixtures file is shared.

**Subagent task:**

> In `tests/fixtures/devin-hook-payloads/payloads.json`, add these fixtures:
>
> - `preToolUse_exec_planApprovalGuard_bareNext` — `bun
>   .devin/tools/aidlc-orchestrate.ts next` with no redirect, `workdir` ==
>   project root.
> - `preToolUse_exec_planApprovalGuard_nextWithRedirect` — same command with
>   `2>/dev/null`.
> - `preToolUse_exec_planApprovalGuard_nextWith2And1` — same command with
>   `2>&1 | cat`.
> - `preToolUse_exec_planApprovalGuard_nextWithWorkdir` — same command with
>   `workdir` set to a subdirectory.
> - `preToolUse_exec_planApprovalGuard_gitAdd` — `git add -A`.
> - `preToolUse_exec_planApprovalGuard_gitCommit` — `git commit -m "checkpoint"`.
>
> Match the shape of existing fixtures in the same file. Each fixture is a
> JSON object with `tool_name`, `tool_input`, `tool_response`, and
> `session_id` fields as appropriate for a PreToolUse `exec` payload.

### Step 2.1 — Dispatch `subagent_general` D: t265 plan-approval-guard tests

**Subagent task:**

> In `tests/unit/t265-plan-approval-guard.test.ts`, add these test cases to
> the `t265b hook lifecycle` describe block (around line 626):
>
> 1. **Facet A — redirect to /dev/null allowed:** Seed state with
>    `seedState(proj)` and a `load-steering` active directive (add a
>    `seedActiveDirectiveLoadSteering` helper if one does not exist — it
>    should call `writeActiveDirectiveMarker` with `kind: "load-steering"`).
>    Run the hook with a `Bash` payload whose `command` is
>    `bun .devin/tools/aidlc-orchestrate.ts next 2>/dev/null`. Assert
>    `r.code === 0`.
> 2. **Facet A — 2>&1 pipe allowed:** Same seed. Run the hook with a `Bash`
>    payload whose `command` is
>    `bun .devin/tools/aidlc-orchestrate.ts next 2>&1 | cat`. Assert
>    `r.code === 0`.
> 3. **Facet A — real write redirect still blocked:** Same seed. Run the
>    hook with a `Bash` payload whose `command` is
>    `echo x > real-file.txt`. Assert `r.code === 2`. (Regression guard.)
> 4. **Facet C — git add allowed:** Same seed. Run the hook with a `Bash`
>    payload whose `command` is `git add -A`. Assert `r.code === 0`.
> 5. **Facet C — git commit allowed:** Same seed. Run the hook with a
>    `Bash` payload whose `command` is `git commit -m "checkpoint"`. Assert
>    `r.code === 0`.
> 6. **Facet C — git push still blocked:** Same seed. Run the hook with a
>    `Bash` payload whose `command` is `git push`. Assert `r.code === 2`.
>
> Use the existing `BASH` helper (line 607) to construct payloads and the
> existing `runHook` helper (line 613) to run the hook.
>
> Run `bun test tests/unit/t265-plan-approval-guard.test.ts` to verify all
> tests pass.

### Step 2.2 — Dispatch `subagent_general` E: t332 devin adapter tests

**Subagent task:**

> In `tests/unit/t332-devin-adapter.test.ts`, add these test cases for
> Facet B:
>
> 1. **workdir lifted into cwd:** Construct a `plan-approval-guard` `exec`
>    payload with `tool_input.workdir` set to a subdirectory (e.g.,
>    `/tmp/subdir`). Run the devin adapter's `plan-approval-guard` target.
>    Assert the forwarded payload (captured via a test spy or by inspecting
>    the core guard's behavior) has `cwd` == the subdirectory.
> 2. **no workdir — no regression:** Construct a `plan-approval-guard` `exec`
>    payload with no `workdir`. Run the adapter. Assert the forwarded
>    payload has `cwd` unset (or set to project root) — no regression.
>
> Look at existing `plan-approval-guard` tests in the file (around line 558)
> for the pattern. Use the fixtures from
> `tests/fixtures/devin-hook-payloads/payloads.json`.
>
> Run `bun test tests/unit/t332-devin-adapter.test.ts` to verify all tests
> pass.

### Step 2.3 — Dispatch `subagent_general` F: t149 codex adapter tests

**Subagent task:**

> In `tests/unit/t149-codex-hook-adapter.test.ts`, add this test case for
> Facet B parity:
>
> 1. **workdir lifted into cwd:** Construct a `plan-approval-guard` `exec`
>    payload with `tool_input.workdir` set to a subdirectory. Run the codex
>    adapter's `plan-approval-guard` target. Assert the forwarded payload
>    has `cwd` == the subdirectory.
>
> Look at existing `plan-approval-guard` tests in the file (around line 566)
> for the pattern.
>
> Run `bun test tests/unit/t149-codex-hook-adapter.test.ts` to verify all
> tests pass.

### Exit criteria

- All new tests pass.
- Existing tests in t265, t332, and t149 still pass (no regression).
- The tests assert the **effect** (exit code, forwarded payload), not just
  that the hook ran.

---

## Phase 3 — Repackage

**Dispatch:** `subagent_general` (background, Subagent G). Waits for
Subagents D, E, F to complete.

**Subagent task:**

> Run these commands in order and report the output:
>
> ```bash
> bun scripts/package.ts
> bun scripts/package.ts --check
> ```
>
> The `--check` must pass (all 8 harness trees in sync: claude, codex,
> copilot, cursor, devin, kiro, kiro-ide, opencode). If drift is detected,
> re-run `bun scripts/package.ts` and re-check.

### Exit criteria

- `package.ts --check` passes.
- No drift in any `dist/` tree.

---

## Verification

**Dispatch:** `subagent_general` (background, Subagent H). Waits for
Subagent G (repackage) to complete.

**Subagent task:**

> Run the full targeted test suite and report the results:
>
> ```bash
> bun test tests/unit/t265-plan-approval-guard.test.ts \
>          tests/unit/t332-devin-adapter.test.ts \
>          tests/unit/t149-codex-hook-adapter.test.ts
> ```
>
> Report the pass/fail counts. If any test fails, report the failure output.

### Exit criteria

- All tests pass (0 fail).
- The new tests cover:
  - Facet A: redirects excluded from mutation detection (3 tests).
  - Facet B: workdir normalized into cwd (2 tests in t332, 1 in t149).
  - Facet C: git add/commit allowed, git push still blocked (3 tests).
- No regression in existing tests.

---

## Release preparation

**Dispatch:** `subagent_general` (background, Subagent I). Waits for
Subagent H (verification) to complete.

Per the repository's user-visible-change policy (AGENTS.md §"Changelog
Policy"), bump the version, README badge, and changelog.

**Subagent task:**

> 1. Bump `core/tools/aidlc-version.ts`: `2.7.4` → `2.7.5`.
> 2. Bump `README.md` badge: `version-2.7.4-blue` → `version-2.7.5-blue`.
> 3. In `CHANGELOG.md`, insert before the `## [2.7.4]` heading:
>
> ```markdown
> ## [2.7.5] - YYYY-MM-DD
>
> Fixes three facets of the plan-approval-guard trap that blocked the conductor
> at the code-generation boundary on Devin 3000.6.14. Shell redirects
> (`2>/dev/null`, `2>&1`) no longer defeat the framework-tool exemption;
> `tool_input.workdir` is now lifted into the top-level `cwd` so the guard
> resolves framework-tool script paths against the directory the conductor
> ran the command in; and `git add`/`git commit` of inception-phase artifacts
> is no longer blocked at the code-generation boundary. **Upgrade:** re-copy
> `dist/devin/` (and `dist/codex/` if you use codex) into your project, then
> fully restart Devin CLI.
>
> * plan-approval-guard: pseudo-device redirects (`/dev/null`, `/dev/stdout`,
>   `/dev/stderr`) are excluded from mutation-target detection, and opaque-shell
>   `2>&1` wrappers around framework-tool invocations no longer trap the
>   early-exit. Pre-fix, `bun .devin/tools/aidlc-orchestrate.ts next 2>/dev/null`
>   was blocked because the redirect produced a write target, preventing the
>   early-exit and falling through to the directive check.
> * devin + codex adapters: `tool_input.workdir` is now lifted into the
>   top-level `cwd` field before piping to the core plan-approval-guard, so
>   `isFrameworkToolInvocation` resolves framework-tool script paths against
>   the directory the conductor ran the command in. Pre-fix, a `bun
>   .devin/tools/aidlc-*.ts` command run from a subdirectory could fail the
>   framework-tool exemption because the guard resolved the script path
>   against the project root.
> * plan-approval-guard: `git add` and `git commit` are now allowed at the
>   code-generation boundary when the active directive is not a v2
>   code-generation run-stage. Pre-fix, all `git` commands (including
>   `git add`/`git commit` of inception-phase artifacts) were blocked because
>   `git` is not in `READ_ONLY_SHELL_COMMANDS` and `add`/`commit` are not in
>   `READ_ONLY_GIT_SUBCOMMANDS`. `git push`, `git reset --hard`, and other
>   mutating git subcommands are still blocked.
> * Tests: t265 +6 (redirect exclusion, 2>&1 opaque-shell, real-write
>   regression, git add/commit allowed, git push blocked), t332 +2 (workdir
>   lifted, no-workdir no-regression), t149 +1 (codex workdir parity).
> ```
>
> 4. Regenerate dist and verify drift:
>
> ```bash
> bun scripts/package.ts
> bun scripts/package.ts --check
> ```
>
> 5. Verify version sync:
>
> ```bash
> bun test tests/unit/t68-version-changelog-sync.test.ts
> ```
>
> Report the results of each step.

### Exit criteria

- `aidlc-version.ts`, `README.md` badge, and `CHANGELOG.md` heading all agree
  on `2.7.5`.
- `package.ts --check` passes.
- `t68` passes.

---

## Constraints

- Do not hand-edit `dist/`; edit `core/` or `harness/` and regenerate.
- Do not disable the plan-approval-guard (`AIDLC_DISABLE_PLAN_APPROVAL_GUARD`).
- Do not add `git add`/`git commit` to `READ_ONLY_GIT_SUBCOMMANDS` — Facet C
  uses a guard-specific carve-out in `mutationIntent`, not the shared
  allowlist, to avoid weakening review-freeze.
- Do not exclude all shell redirects from `shellWriteTargets` — Facet A
  excludes only pseudo-devices (`/dev/null`, `/dev/stdout`, `/dev/stderr`),
  not real file redirects.
- Do not change `shellInvocationNeedsApproval`'s `git` branch — Facet C is
  in the guard's `mutationIntent`, not the shared helper.
- Preserve fail-open behavior for malformed or unsupported payloads.
- Do not fabricate receipts or disable guards.

---

## References

- Handoff notes (the source of the bug):
  `docs/rfcs/handoff-run-real-devin-session-notes.md` lines 869–1066
- Prior fix (2.7.4, unblocked HUMAN_TURN + challenge preservation):
  `docs/rfcs/human-turn-not-written-on-ask-user-question-fix-plan.md`
- Prior fix (2.7.3, post-merge fixes for the devin release-engineering PR):
  `docs/rfcs/pr1-post-merge-fix-plan.md`
- Guard source: `core/hooks/aidlc-plan-approval-guard.ts`
- Shell parser: `core/hooks/review-freeze-command.ts`
- Devin adapter: `harness/devin/hooks/aidlc-devin-adapter.ts`
- Codex adapter: `harness/codex/hooks/aidlc-codex-adapter.ts`
- Tests: `tests/unit/t265-plan-approval-guard.test.ts`,
  `tests/unit/t332-devin-adapter.test.ts`,
  `tests/unit/t149-codex-hook-adapter.test.ts`
