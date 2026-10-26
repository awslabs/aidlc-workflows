// covers: hook:aidlc-sync-workflow-state
//
// Mechanism = none. Port of tests/unit/t29-hook-sync-statusline.sh (TAP plan 7).
// The unit under test is the PostToolUse hook dist/claude/.claude/hooks/
// aidlc-sync-workflow-state.ts. A hook is mechanism=none — it has no CLI arg
// surface; it is driven by feeding Claude Code's PostToolUse JSON on stdin.
// So every .sh case is preserved here by SPAWNING the hook via
// node:child_process spawnSync with the JSON piped through `input:`, exactly
// as the .sh did `echo '<json>' | CLAUDE_PROJECT_DIR=<p> bun "$HOOK"`.
//
// The hook resolves the project dir from CLAUDE_PROJECT_DIR (aidlc-lib.ts)
// and, on a qualifying TaskUpdate, (a) writes a health heartbeat at
// aidlc-docs/.aidlc-engine/hooks-health/sync-statusline.last and (b) shells out to
// <projectDir>/.claude/tools/aidlc-utility.ts set-status, which rewrites
// Current Stage / Lifecycle Phase / Active Agent / Status / Last Updated in
// aidlc-state.md (aidlc-utility.ts). For the hook to find that tool,
// the .sh symlinks $AIDLC_SRC -> $proj/.claude (create_hook_test_project,
// t29-hook-sync-statusline.sh). We replicate that symlink here.
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
//        by set-status (aidlc-utility.ts) - verified live via
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
//
// The second describe drives the real tools through an isolated `--single` run
// while the work waits at Intent Capture: the plan step the agent posts for that
// run (Codex's update_plan arrives here as the same TaskUpdate) reaches this
// hook, and the work keeps its place under every Guard Policy.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  runOrchestrateNext,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { readAllAuditShards, resolveGuardPolicy } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { loadGraph } from "../../dist/claude/.claude/tools/aidlc-graph.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-sync-workflow-state.ts");
const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

function hookProject(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  symlinkSync(AIDLC_SRC, join(proj, ".claude"));
  return proj;
}

// Per-intent layout: state + heartbeat live under the default intent's record
// (seedStateFile seeds it so the active-intent cursor resolves; the hook and
// the setStatus implementation it calls both anchor under that record).
const statePath = (p: string): string => seededStateFile(p);
const heartbeatPath = (p: string): string =>
  join(seededRecordDir(p), ".aidlc-engine/hooks-health", "sync-workflow-state.last");

interface HookResult {
  status: number;
  out: string;
}

function runHook(proj: string, json: string): HookResult {
  const res = spawnSync(BUN, [HOOK], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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

describe("t29 aidlc-sync-workflow-state hook (migrated from t29-hook-sync-statusline.sh, plan 7)", () => {
  test("1: updates Current Stage on in_progress with [slug]", () => {
    const p = hookProject();
    seedStateFile(p, MID_IDEATION); // Current Stage starts as feasibility
    const r = runHook(
      p,
      '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"in_progress","activeForm":"Running Scope Definition [scope-definition]"}}',
    );
    expect(r.status).toBe(0);
    expect(stateField(p, "Current Stage")).toBe("scope-definition");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("2: skips when status is completed", () => {
    const p = hookProject();
    seedStateFile(p, MID_IDEATION);
    const before = readFileSync(statePath(p), "utf-8");
    runHook(
      p,
      '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"completed"}}',
    );
    expect(readFileSync(statePath(p), "utf-8")).toBe(before);
    // The status guard returns before the heartbeat write.
    expect(existsSync(heartbeatPath(p))).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // --- T5: no state file -> hook exits 0 (won't fire before handleInit) ---
  test("5: exits 0 when no state file", () => {
    const p = hookProject();
    const r = runHook(
      p,
      '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"in_progress","activeForm":"Running Feasibility [feasibility]"}}',
    );
    expect(r.status).toBe(0);
    expect(existsSync(statePath(p))).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("5b: an unknown stage fails open without changing state", () => {
    const p = hookProject();
    seedStateFile(p, MID_IDEATION);
    const before = readFileSync(statePath(p), "utf-8");
    const r = runHook(
      p,
      '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"in_progress","activeForm":"Running Unknown [unknown-stage]"}}',
    );
    expect(r.status).toBe(0);
    expect(readFileSync(statePath(p), "utf-8")).toBe(before);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("6: updates Lifecycle Phase from stage graph", () => {
    const p = hookProject();
    seedStateFile(p, MID_IDEATION); // Lifecycle Phase starts as IDEATION
    runHook(
      p,
      '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"in_progress","activeForm":"Running Code Generation [code-generation]"}}',
    );
    // set-status uppercases findStageBySlug("code-generation").phase ("construction").
    expect(stateField(p, "Lifecycle Phase")).toBe("CONSTRUCTION");
    // And it advances Current Stage in the same write (same set-status call).
    expect(stateField(p, "Current Stage")).toBe("code-generation");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("7: writes health heartbeat", () => {
    const p = hookProject();
    seedStateFile(p, MID_IDEATION);
    expect(existsSync(heartbeatPath(p))).toBe(false);
    runHook(
      p,
      '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"in_progress","activeForm":"Running Feasibility [feasibility]"}}',
    );
    expect(existsSync(heartbeatPath(p))).toBe(true);
    // The heartbeat is a non-empty ISO-8601 UTC timestamp (isoTimestamp(),
    // aidlc-lib.ts).
    const hb = readFileSync(heartbeatPath(p), "utf-8");
    expect(hb).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t29 an isolated --single run leaves the work's place", () => {
  const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
  const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
  const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
  const RE = "reverse-engineering";

  function tool(script: string, proj: string, args: string[]): { status: number; stdout: string } {
    const r = spawnSync(BUN, [script, ...args, "--project-dir", proj], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "" };
  }

  function recordDir(proj: string): string {
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    return join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim());
  }

  // Where the work stands: the cursor fields and every stage box.
  function place(state: string): string[] {
    return state.split("\n").filter((line) =>
      /^- \*\*(Current Stage|In Progress|Lifecycle Phase|Active Agent|Status)\*\*:/.test(line) ||
      /^- \[.\] [a-z]/.test(line)
    );
  }

  function planStep(proj: string, activeForm: string): HookResult {
    return runHook(proj, JSON.stringify({ tool_name: "TaskUpdate", tool_input: { status: "in_progress", activeForm } }));
  }

  for (const policy of ["off", "relaxed", "strict"] as const) {
    test(`Guard Policy ${policy}: the run's plan step keeps the work at Intent Capture, and the run records its own work`, () => {
      const p = createOrchestrationTestProject();
      tempDirs.push(p);
      symlinkSync(AIDLC_SRC, join(p, ".claude"));
      mkdirSync(join(p, "src"), { recursive: true });
      writeFileSync(join(p, "src", "app.ts"), "export const app = 1;\n");
      expect(tool(UTIL, p, [
        "intent-create", "--scope", "feature", "--project-type", "brownfield", "--arguments", "build auth",
      ]).status).toBe(0);
      const statePath = join(recordDir(p), "aidlc-state.md");
      writeFileSync(
        statePath,
        readFileSync(statePath, "utf-8").replace(/^- \*\*Guard Policy\*\*: .*$/m, `- **Guard Policy**: ${policy} (set by you)`),
      );
      expect(resolveGuardPolicy(p).value).toBe(policy);

      // The work waits at Intent Capture's answer-mode question.
      expect(runOrchestrateNext(ORCH, p).directive?.stage).toBe("intent-capture");
      expect(tool(LOG, p, [
        "decision", "--stage", "intent-capture", "--decision", "How would you like to answer the questions?",
        "--options", "Guide me,I'll edit the file,Chat", "--question-kind", "answer-mode",
      ]).status).toBe(0);
      const waiting = runOrchestrateNext(ORCH, p).directive;
      expect(waiting?.stage).toBe("intent-capture");
      const before = place(readFileSync(statePath, "utf-8"));

      // The person asks for Reverse Engineering on its own; the agent posts the
      // protocol's plan step for it, and then one naming another stage.
      const single = runOrchestrateNext(ORCH, p, ["--stage", RE, "--single"]).directive;
      expect(single?.kind).toBe("run-stage");
      expect(single?.single).toBe(true);
      expect(planStep(p, "Running Reverse Engineering [reverse-engineering]").status).toBe(0);
      expect(planStep(p, "Running Requirements Analysis [requirements-analysis]").status).toBe(0);
      expect(place(readFileSync(statePath, "utf-8"))).toEqual(before);
      expect(existsSync(join(recordDir(p), ".aidlc-engine/hooks-health", "sync-workflow-state.last"))).toBe(false);

      // The run records its own work: its lead link, then its completion.
      const produces = loadGraph().find((stage) => stage.slug === RE)?.produces ?? [];
      const codekb = join(p, "aidlc", "spaces", "default", "codekb", basename(p));
      mkdirSync(codekb, { recursive: true });
      for (const name of produces) writeFileSync(join(codekb, `${name}.md`), `# ${name}\n`);
      const owed = (single?.pipeline as { record: Array<{ command: string }> }).record;
      expect(owed.length).toBeGreaterThan(0);
      for (const { command } of owed) {
        const artifact = /--artifact (\S+)/.exec(command)?.[1];
        if (artifact) {
          mkdirSync(dirname(join(p, artifact)), { recursive: true });
          writeFileSync(join(p, artifact), "## Developer Code Scan Results\n\n### Scan Coverage\n\n- src/\n\n## Handoff Summary\n\nDone.\n");
        }
        expect(tool(LOG, p, command.split(" ").slice(2)).status).toBe(0);
      }
      const done = JSON.parse(tool(ORCH, p, ["report", "--single", "--stage", RE, "--result", "completed"]).stdout.trim());
      expect(done.kind).toBe("done");
      const runRows = readAllAuditShards(p).split("\n---\n").filter((block) => block.includes(`**Workflow**: single-stage:${RE}`));
      expect(runRows.filter((block) => block.includes("**Event**: STAGE_STARTED"))).toHaveLength(1);
      expect(runRows.filter((block) => block.includes("**Event**: STAGE_COMPLETED"))).toHaveLength(1);

      // The way on after the run is the work's own step, as before it: not the
      // run's step again and not the work's Reverse Engineering.
      const resumed = runOrchestrateNext(ORCH, p).directive;
      expect(resumed?.single).toBeUndefined();
      expect({ kind: resumed?.kind, stage: resumed?.stage, gate: resumed?.gate, narration: resumed?.narration })
        .toEqual({ kind: waiting?.kind, stage: waiting?.stage, gate: waiting?.gate, narration: waiting?.narration });
      expect(place(readFileSync(statePath, "utf-8"))).toEqual(before);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }
});
