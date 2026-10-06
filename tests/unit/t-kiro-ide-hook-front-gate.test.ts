// covers: function:frontGateSkips, function:frontGateProjectDirs, function:noopMarkName
//
// Kiro IDE runs rebuild-stage-graph and sync-workflow-state after every shell
// command and gives them no command text, so each used to load the whole
// engine to find nothing changed (#1180). Once the full hook has found nothing
// to do, a shell command that changed nothing they read skips them before the
// engine loads. Anything that might matter (a change, a second chat writing,
// a coarse or moved clock, a link, a layout the gate does not know) runs the
// full hook, and the guards always do.

import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  REPO_ROOT,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { hooksHealthDir } from "../../dist/kiro-ide/.kiro/tools/aidlc-lib.ts";

setDefaultTimeout(120_000);

const KIRO_IDE_TREE = join(REPO_ROOT, "dist", "kiro-ide", ".kiro");
const CLONE_ID = "testclonegate1";
const GATED = ["rebuild-stage-graph", "sync-workflow-state"] as const;
type Gated = (typeof GATED)[number];

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function shardName(): string {
  const host = hostname().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "host";
  return `${host}-${CLONE_ID}.md`;
}

/**
 * A Kiro IDE project. Its engine library writes a marker file the moment it is
 * imported, so a test can tell a hook that loaded the engine from one that did not.
 */
function project(withWork = true): string {
  const dir = mkdtempSync(join(tmpdir(), "t-front-gate-"));
  created.push(dir);
  cpSync(KIRO_IDE_TREE, join(dir, ".kiro"), { recursive: true });
  const lib = join(dir, ".kiro", "tools", "aidlc-lib.ts");
  writeFileSync(
    lib,
    `require("node:fs").writeFileSync(process.env.T_ENGINE_LOADED ?? "/dev/null", "loaded");\n${readFileSync(lib, "utf-8")}`,
  );
  if (!withWork) return dir;
  const intents = intentsDirOf(dir, DEFAULT_SPACE);
  cpSync(join(KIRO_IDE_TREE, "tools", "data", "memory-seed"), join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory"), {
    recursive: true,
  });
  mkdirSync(seededRecordDir(dir), { recursive: true });
  writeFileSync(join(dir, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`);
  writeFileSync(join(intents, "active-intent"), `${DEFAULT_RECORD_DIR}\n`);
  writeFileSync(
    join(intents, "intents.json"),
    `${JSON.stringify([{ uuid: "00000000-0000-7000-8000-000000000001", slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""), status: "in-flight" }])}\n`,
  );
  writeFileSync(seededStateFile(dir), readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8"));
  writeFileSync(join(dir, "aidlc", ".aidlc-clone-id"), `${CLONE_ID}\n`);
  mkdirSync(seededAuditDir(dir), { recursive: true });
  writeFileSync(join(seededAuditDir(dir), shardName()), "# AI-DLC Audit Log\n");
  return dir;
}

function shard(dir: string): string {
  return join(seededAuditDir(dir), shardName());
}

function appendStageStarted(dir: string, slug: string): void {
  appendFileSync(
    shard(dir),
    `\n## Stage Start\n**Timestamp**: ${new Date().toISOString()}\n**Event**: STAGE_STARTED\n**Stage**: ${slug}\n**Agent**: orchestrator\n\n---\n`,
  );
}

/** Move a file's time, as a write that long ago (negative) or a clock ahead (positive) would. */
function setTime(path: string, offsetMs: number): void {
  if (!existsSync(path)) return;
  const at = new Date(Date.now() + offsetMs);
  utimesSync(path, at, at);
}

/** Every file the hooks read in the record, written a while ago. */
function ageInputs(dir: string): void {
  for (const path of [seededStateFile(dir), shard(dir), join(seededRecordDir(dir), "runtime-graph.json")]) {
    if (existsSync(path)) setTime(path, -60_000);
  }
}

// Where the full hook leaves its "nothing to do" mark: the record's hooks-health folder.
function mark(dir: string, hook: Gated): string {
  return join(seededRecordDir(dir), ".aidlc-engine", "hooks-health", `${hook}.noop`);
}

function markTime(dir: string, hook: Gated): number {
  return existsSync(mark(dir, hook)) ? statSync(mark(dir, hook)).mtimeMs : Date.now();
}

let calls = 0;
/** One shell command's PostToolUse call through the dispatcher, as Kiro IDE runs it. */
function shellHook(dir: string, target: string, env: Record<string, string> = {}): { code: number; engineLoaded: boolean } {
  const loaded = join(dir, `engine-loaded-${++calls}`);
  const payload = JSON.stringify({
    session_id: "sess_front_gate",
    hook_event_name: target === "enforce-approval-gate" ? "PreToolUse" : "PostToolUse",
    cwd: dir,
    tool_name: "execute_bash",
    tool_input: {},
    tool_response: "ok",
  });
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: dir,
    T_ENGINE_LOADED: loaded,
    ...env,
  };
  delete childEnv.USER_PROMPT;
  delete childEnv.AIDLC_PROJECT_DIR;
  delete childEnv.AIDLC_HOOK_DEBUG;
  if (env.AIDLC_HOOK_DEBUG) childEnv.AIDLC_HOOK_DEBUG = env.AIDLC_HOOK_DEBUG;
  const result = spawnSync("bun", [join(dir, ".kiro", "tools", "aidlc.ts"), "engine", "adapter", "kiro-ide", target], {
    cwd: dir,
    input: payload,
    encoding: "utf-8",
    env: childEnv as NodeJS.ProcessEnv,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, engineLoaded: existsSync(loaded) };
}

/** The full hook runs once on aged files and finds nothing to do. */
function settled(dir: string, hook: Gated): void {
  ageInputs(dir);
  const first = shellHook(dir, hook);
  expect(first.code).toBe(0);
  expect(first.engineLoaded).toBe(true);
}

function currentStage(dir: string): string {
  return /^- \*\*Current Stage\*\*: *(.*)$/m.exec(readFileSync(seededStateFile(dir), "utf-8"))?.[1]?.trim() ?? "";
}

describe("a shell command that changed nothing the hook reads skips the engine", () => {
  test.each([...GATED])("%s: the second call does not load the engine", (hook) => {
    const dir = project();
    settled(dir, hook);
    const second = shellHook(dir, hook);
    expect(second.code).toBe(0);
    expect(second.engineLoaded).toBe(false);
  });

  test.each([...GATED])("%s with no AI-DLC work in the folder does not load the engine", (hook) => {
    const dir = project(false);
    const call = shellHook(dir, hook);
    expect(call.code).toBe(0);
    expect(call.engineLoaded).toBe(false);
  });

  test("the guards always load the engine", () => {
    const dir = project();
    settled(dir, "rebuild-stage-graph");
    settled(dir, "sync-workflow-state");
    expect(shellHook(dir, "enforce-approval-gate").engineLoaded).toBe(true);
  });

  test("a skipped rebuild still says the hook fired", () => {
    const dir = project();
    settled(dir, "rebuild-stage-graph");
    const heartbeat = join(hooksHealthDir(dir), "rebuild-stage-graph.last");
    writeFileSync(heartbeat, "2026-01-01T00:00:00Z");
    expect(shellHook(dir, "rebuild-stage-graph").engineLoaded).toBe(false);
    expect(Date.parse(readFileSync(heartbeat, "utf-8"))).toBeGreaterThan(Date.now() - 60_000);
  });

  test.each([...GATED])("%s: finding nothing to do leaves the mark where the engine keeps hook health", (hook) => {
    const dir = project();
    settled(dir, hook);
    expect(join(seededRecordDir(dir), ".aidlc-engine", "hooks-health")).toBe(hooksHealthDir(dir));
    expect(existsSync(mark(dir, hook))).toBe(true);
  });
});

describe("anything that might matter runs the full hook", () => {
  test("a new stage started after the mark: the sync moves the stage", () => {
    const dir = project();
    settled(dir, "sync-workflow-state");
    expect(currentStage(dir)).toBe("requirements-analysis");
    appendStageStarted(dir, "user-stories");
    setTime(mark(dir, "sync-workflow-state"), -30_000);
    const call = shellHook(dir, "sync-workflow-state");
    expect(call.engineLoaded).toBe(true);
    expect(currentStage(dir)).toBe("user-stories");
  });

  test("a transition after the mark: the rebuild compiles the graph", () => {
    const dir = project();
    settled(dir, "rebuild-stage-graph");
    const graph = join(seededRecordDir(dir), "runtime-graph.json");
    const before = existsSync(graph) ? statSync(graph).mtimeMs : 0;
    appendStageStarted(dir, "requirements-analysis");
    setTime(mark(dir, "rebuild-stage-graph"), -30_000);
    const call = shellHook(dir, "rebuild-stage-graph");
    expect(call.engineLoaded).toBe(true);
    expect(existsSync(graph) && statSync(graph).mtimeMs > before).toBe(true);
  });

  test.each([...GATED])("%s: another chat writes the audit after the mark", (hook) => {
    const dir = project();
    settled(dir, hook);
    appendFileSync(shard(dir), "\n## Decision Recorded\n**Event**: DECISION_RECORDED\n\n---\n");
    expect(shellHook(dir, hook).engineLoaded).toBe(true);
  });

  test.each([...GATED])("%s: a write just before the mark, inside the margin (a race or a 2 s clock)", (hook) => {
    const dir = project();
    settled(dir, hook);
    const at = new Date(markTime(dir, hook) - 1_000);
    utimesSync(shard(dir), at, at);
    expect(shellHook(dir, hook).engineLoaded).toBe(true);
  });

  test.each([...GATED])("%s: the same timestamp on the mark and a write (a coarse file system)", (hook) => {
    const dir = project();
    settled(dir, hook);
    const at = new Date(Math.floor(markTime(dir, hook) / 2_000) * 2_000);
    utimesSync(shard(dir), at, at);
    if (existsSync(mark(dir, hook))) utimesSync(mark(dir, hook), at, at);
    expect(shellHook(dir, hook).engineLoaded).toBe(true);
  });

  test.each([...GATED])("%s: the mark is ahead of the clock (the clock moved back)", (hook) => {
    const dir = project();
    settled(dir, hook);
    setTime(mark(dir, hook), 60_000);
    expect(shellHook(dir, hook).engineLoaded).toBe(true);
  });

  test.each([...GATED])("%s: a file the hook reads is ahead of the clock", (hook) => {
    const dir = project();
    settled(dir, hook);
    setTime(shard(dir), 60_000);
    expect(shellHook(dir, hook).engineLoaded).toBe(true);
  });

  test("sync: the state file changed after the mark", () => {
    const dir = project();
    settled(dir, "sync-workflow-state");
    writeFileSync(seededStateFile(dir), readFileSync(seededStateFile(dir), "utf-8"));
    expect(shellHook(dir, "sync-workflow-state").engineLoaded).toBe(true);
  });

  test("rebuild: the graph was compiled after the mark", () => {
    const dir = project();
    settled(dir, "rebuild-stage-graph");
    writeFileSync(join(seededRecordDir(dir), "runtime-graph.json"), "{}\n");
    expect(shellHook(dir, "rebuild-stage-graph").engineLoaded).toBe(true);
  });

  test.each([...GATED])("%s: a second piece of work the hook has not looked at", (hook) => {
    const dir = project();
    settled(dir, hook);
    const other = join(intentsDirOf(dir, DEFAULT_SPACE), "other-00000002");
    mkdirSync(join(other, "audit"), { recursive: true });
    writeFileSync(join(other, "aidlc-state.md"), readFileSync(seededStateFile(dir), "utf-8"));
    writeFileSync(join(other, "audit", shardName()), "# AI-DLC Audit Log\n");
    for (const path of [join(other, "aidlc-state.md"), join(other, "audit", shardName())]) setTime(path, -60_000);
    expect(shellHook(dir, hook).engineLoaded).toBe(true);
  });

  test.each([...GATED])("%s: the flat layout from before spaces", (hook) => {
    const dir = project();
    settled(dir, hook);
    mkdirSync(join(dir, "aidlc-docs"));
    expect(shellHook(dir, hook).engineLoaded).toBe(true);
  });

  test.each([...GATED])("%s: hook debugging is on", (hook) => {
    const dir = project();
    settled(dir, hook);
    expect(shellHook(dir, hook, { AIDLC_HOOK_DEBUG: "1" }).engineLoaded).toBe(true);
  });

  test.skipIf(process.platform === "win32").each([...GATED])("%s: a linked audit folder", (hook) => {
    const dir = project();
    settled(dir, hook);
    const audit = seededAuditDir(dir);
    const moved = `${audit}-real`;
    cpSync(audit, moved, { recursive: true });
    for (const name of readdirSync(audit)) unlinkSync(join(audit, name));
    rmdirSync(audit);
    symlinkSync(moved, audit);
    expect(shellHook(dir, hook).engineLoaded).toBe(true);
  });
});
