// covers: hook:aidlc-sync-statusline
//
// Mechanism = none. Port of tests/unit/t29-hook-sync-statusline.sh (TAP plan 7).
// The unit under test is the PostToolUse hook dist/claude/.claude/hooks/
// aidlc-sync-statusline.ts. A hook is mechanism=none — it has no CLI arg
// surface; it is driven by feeding Claude Code's PostToolUse JSON on stdin.
// So every .sh case is preserved here by SPAWNING the hook via
// node:child_process spawnSync with the JSON piped through `input:`, exactly
// as the .sh did `echo '<json>' | CLAUDE_PROJECT_DIR=<p> bun "$HOOK"`.
//
// The hook resolves the project dir from CLAUDE_PROJECT_DIR (aidlc-lib.ts:116)
// and, on a qualifying TaskUpdate, (a) writes a health heartbeat at
// aidlc-docs/.aidlc-hooks-health/sync-statusline.last and (b) shells out to
// <projectDir>/.claude/tools/aidlc-utility.ts set-status, which rewrites
// Current Stage / Lifecycle Phase / Active Agent / Status / Last Updated in
// aidlc-state.md (aidlc-utility.ts:2432-2456). For the hook to find that tool,
// the .sh symlinks $AIDLC_SRC -> $proj/.claude (create_hook_test_project,
// t29-hook-sync-statusline.sh:25-30). We replicate that symlink here.
//
// PARITY MAP (every .sh `ok` -> one expect()-bearing test() case here):
//   .sh T1 assert_grep 'Current Stage.*scope-definition'  -> T1: STRONGER —
//        exact field value `getField(state,"Current Stage") === "scope-definition"`
//        scoped to the field line, not a file-wide regex grep. Plus the hook
//        exit code is pinned to 0 (the .sh discarded it).
//   .sh T2 md5 before==after on status=completed             -> T2: byte-equality
//        of aidlc-state.md before/after (md5sum -> readFileSync compare; same
//        observable: file untouched). Heartbeat absence asserted too (STRONGER:
//        the hook returns before the heartbeat write on the status guard).
//   .sh T3 md5 before==after on no activeForm                -> T3: byte-equality
//        + heartbeat absent (STRONGER).
//   .sh T4 md5 before==after on activeForm w/o [slug]         -> T4: byte-equality
//        + heartbeat absent (STRONGER).
//   .sh T5 RC==0 when no state file                          -> T5: res.status===0
//        (same observable). STRONGER: also asserts the state file stays absent
//        (the hook never recreates it).
//   .sh T6 assert_grep 'Lifecycle Phase.*CONSTRUCTION'        -> T6: STRONGER —
//        exact `getField(state,"Lifecycle Phase") === "CONSTRUCTION"`. The phase
//        comes from the stage graph: code-generation -> construction, uppercased
//        by set-status (aidlc-utility.ts:2442,2446) — verified live via
//        findStageBySlug("code-generation").phase === "construction".
//   .sh T7 assert_file_exists sync-statusline.last           -> T7: existsSync
//        of the heartbeat file (same observable) + its content is a non-empty
//        ISO timestamp (STRONGER; the .sh only checked existence).
//
// 7 .sh asserts -> 7 expect()-bearing test() cases here. FIXTURE DISCIPLINE
// mirrors the .sh: each case scaffolds a FRESH temp project (createTestProject)
// with .claude symlinked to AIDLC_SRC and aidlc-state.md seeded from the shared
// state-mid-ideation.md fixture (seedStateFile). toPortablePath round-trips the
// path on Windows so the hook's CLAUDE_PROJECT_DIR resolution and the state file
// it reads back agree. Symlinks are not followed by rmSync's recursive delete
// of the link node, so cleanupTestProject removes only the temp tree, never the
// shipped AIDLC_SRC. All temp dirs cleaned in afterAll. Nothing is written under
// tests/fixtures/**.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-sync-statusline.ts");
const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/**
 * create_hook_test_project (t29:25-30): a fresh temp project whose .claude is a
 * symlink to the shipped AIDLC_SRC, so the hook can resolve
 * <projectDir>/.claude/tools/aidlc-utility.ts. State seeded separately.
 */
function hookProject(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  symlinkSync(AIDLC_SRC, join(proj, ".claude"));
  return proj;
}

const statePath = (p: string): string =>
  join(p, "aidlc-docs", "aidlc-state.md");
const heartbeatPath = (p: string): string =>
  join(p, "aidlc-docs", ".aidlc-hooks-health", "sync-statusline.last");

interface HookResult {
  status: number;
  out: string;
}

/** Pipe the PostToolUse JSON on stdin with CLAUDE_PROJECT_DIR set, like the .sh's `echo '<json>' | CLAUDE_PROJECT_DIR=<p> bun "$HOOK"`. */
function runHook(proj: string, json: string): HookResult {
  const res = spawnSync(BUN, [HOOK], {
    input: json,
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** Read a `- **Label**: value` field off the seeded state file. Returns "" when absent. */
function stateField(proj: string, label: string): string {
  if (!existsSync(statePath(proj))) return "";
  const re = new RegExp(`^- \\*\\*${label}\\*\\*:\\s*(.*)$`, "m");
  const m = readFileSync(statePath(proj), "utf-8").match(re);
  return m ? m[1].trim() : "";
}

describe("t29 aidlc-sync-statusline hook (migrated from t29-hook-sync-statusline.sh, plan 7)", () => {
  // --- T1: in_progress + [slug] -> Current Stage updated to that slug ---
  test("1: updates Current Stage on in_progress with [slug]", () => {
    const p = hookProject();
    seedStateFile(p, MID_IDEATION); // Current Stage starts as feasibility
    const r = runHook(
      p,
      '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"in_progress","activeForm":"Running Scope Definition [scope-definition]"}}',
    );
    expect(r.status).toBe(0); // STRONGER: the .sh discarded the hook exit code
    // STRONGER than `assert_grep 'Current Stage.*scope-definition'`: exact value.
    expect(stateField(p, "Current Stage")).toBe("scope-definition");
  }, 30000);

  // --- T2: status=completed -> hook returns early, state untouched ---
  test("2: skips when status is completed", () => {
    const p = hookProject();
    seedStateFile(p, MID_IDEATION);
    const before = readFileSync(statePath(p), "utf-8");
    runHook(
      p,
      '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"completed"}}',
    );
    // .sh: md5 before == md5 after. Byte-equality is the same observable.
    expect(readFileSync(statePath(p), "utf-8")).toBe(before);
    // STRONGER: the status guard returns before the heartbeat write.
    expect(existsSync(heartbeatPath(p))).toBe(false);
  }, 30000);

  // --- T3: no activeForm -> hook returns early, state untouched ---
  test("3: skips when no activeForm", () => {
    const p = hookProject();
    seedStateFile(p, MID_IDEATION);
    const before = readFileSync(statePath(p), "utf-8");
    runHook(
      p,
      '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"in_progress"}}',
    );
    expect(readFileSync(statePath(p), "utf-8")).toBe(before);
    expect(existsSync(heartbeatPath(p))).toBe(false);
  }, 30000);

  // --- T4: activeForm without a [slug] suffix -> hook returns early ---
  test("4: skips when activeForm has no [slug]", () => {
    const p = hookProject();
    seedStateFile(p, MID_IDEATION);
    const before = readFileSync(statePath(p), "utf-8");
    runHook(
      p,
      '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"in_progress","activeForm":"Validating jump target"}}',
    );
    expect(readFileSync(statePath(p), "utf-8")).toBe(before);
    expect(existsSync(heartbeatPath(p))).toBe(false);
  }, 30000);

  // --- T5: no state file -> hook exits 0 (won't fire before handleInit) ---
  test("5: exits 0 when no state file", () => {
    const p = hookProject();
    // No seedStateFile: the project has aidlc-docs/ but no aidlc-state.md.
    const r = runHook(
      p,
      '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"in_progress","activeForm":"Running Feasibility [feasibility]"}}',
    );
    expect(r.status).toBe(0);
    // STRONGER: the hook never creates the state file on this path.
    expect(existsSync(statePath(p))).toBe(false);
  }, 30000);

  // --- T6: Lifecycle Phase pulled from the stage graph (code-generation -> CONSTRUCTION) ---
  test("6: updates Lifecycle Phase from stage graph", () => {
    const p = hookProject();
    seedStateFile(p, MID_IDEATION); // Lifecycle Phase starts as IDEATION
    runHook(
      p,
      '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"in_progress","activeForm":"Running Code Generation [code-generation]"}}',
    );
    // STRONGER than `assert_grep 'Lifecycle Phase.*CONSTRUCTION'`: exact value.
    // set-status uppercases findStageBySlug("code-generation").phase ("construction").
    expect(stateField(p, "Lifecycle Phase")).toBe("CONSTRUCTION");
    // And it advances Current Stage in the same write (same set-status call).
    expect(stateField(p, "Current Stage")).toBe("code-generation");
  }, 30000);

  // --- T7: a qualifying fire writes the health heartbeat ---
  test("7: writes health heartbeat", () => {
    const p = hookProject();
    seedStateFile(p, MID_IDEATION);
    // The hook removes/recreates nothing — the heartbeat starts absent.
    expect(existsSync(heartbeatPath(p))).toBe(false);
    runHook(
      p,
      '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"in_progress","activeForm":"Running Feasibility [feasibility]"}}',
    );
    expect(existsSync(heartbeatPath(p))).toBe(true);
    // STRONGER: the .sh only checked existence; the heartbeat is a non-empty
    // ISO-8601 UTC timestamp (isoTimestamp(), aidlc-lib.ts:1452).
    const hb = readFileSync(heartbeatPath(p), "utf-8");
    expect(hb).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  }, 30000);
});
