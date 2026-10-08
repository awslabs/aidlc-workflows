// covers: hook:aidlc-fold-usage, hook:aidlc-reviewer-scope
//
// t352-hook-phase-trace - AIDLC_HOOK_TRACE_DIR is an opt-in diagnostic: with it
// unset (the default) a hook process writes nothing; with an absolute directory
// each hook or adapter process appends its phases to its own hook-<pid>.ndjson;
// the trace never changes what a hook returns or prints; and the writer keeps
// no handle open between lines, creates its files owner-only, and never
// follows or blocks on a link or FIFO planted at its path.
//
// Mechanism: cli for the dispatcher cases (bun spawns the shipped
// dist/claude dispatcher in a temp project), in-process for the module cases.
// Zero tokens.

import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOOK_TRACE_DIR_ENV,
  hookTrace,
  hookTraceEnabled,
  hookTracePath,
} from "../../dist/claude/.claude/tools/aidlc-hook-trace.ts";
import { tracedHookRoute } from "../../dist/claude/.claude/tools/aidlc.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SHIPPED_CLAUDE_TREE = join(REPO_ROOT, "dist", "claude", ".claude");
const SHIPPED_CODEX_TREE = join(REPO_ROOT, "dist", "codex", ".codex");
const SESSION = "11111111-2222-4333-8444-555555555555";

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  delete process.env[HOOK_TRACE_DIR_ENV];
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

type Fixture = { root: string; project: string; transcript: string };

function fixture(): Fixture {
  const root = tempDir("aidlc-hook-trace-");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  cpSync(SHIPPED_CLAUDE_TREE, join(project, ".claude"), { recursive: true });
  cpSync(SHIPPED_CODEX_TREE, join(project, ".codex"), { recursive: true });
  const transcript = join(root, "session.jsonl");
  writeFileSync(
    transcript,
    `${JSON.stringify({
      uuid: "m1",
      timestamp: "t",
      isSidechain: false,
      type: "assistant",
      message: {
        id: "msg_1",
        role: "assistant",
        model: "converse/us.anthropic.claude-opus-4-8",
        usage: {
          input_tokens: 10,
          output_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    })}\n`,
  );
  return { root, project, transcript };
}

function runHook(
  fx: Fixture,
  hook: string,
  event: "PreToolUse" | "PostToolUse",
  traceDir: string | undefined,
): { code: number; stdout: string; stderr: string; payloadBytes: number; payloadUnits: number } {
  const payload = JSON.stringify({
    session_id: SESSION,
    transcript_path: fx.transcript,
    cwd: fx.project,
    hook_event_name: event,
    tool_name: "Read",
    // Non-ASCII on purpose: stdin-end must count UTF-8 bytes, not UTF-16 units.
    tool_input: { file_path: join(fx.project, "notes-\u00e9t\u00e9.md") },
  });
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: fx.project,
    AIDLC_DISABLE_USAGE_TRACKING: "0",
  };
  delete env[HOOK_TRACE_DIR_ENV];
  if (traceDir !== undefined) env[HOOK_TRACE_DIR_ENV] = traceDir;
  const result = Bun.spawnSync(
    [process.execPath, join(fx.project, ".claude", "tools", "aidlc.ts"), "engine", "hook", hook],
    { cwd: fx.project, env, stdin: Buffer.from(payload), stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    payloadBytes: Buffer.byteLength(payload, "utf8"),
    payloadUnits: payload.length,
  };
}

function runCodexAdapter(fx: Fixture, target: string, traceDir: string | undefined): { code: number; stdout: string; stderr: string } {
  const payload = JSON.stringify({
    session_id: SESSION,
    hook_event_name: "PreToolUse",
    tool_name: "shell",
    tool_input: { command: ["ls"] },
    cwd: fx.project,
  });
  const env: Record<string, string | undefined> = { ...process.env };
  delete env[HOOK_TRACE_DIR_ENV];
  if (traceDir !== undefined) env[HOOK_TRACE_DIR_ENV] = traceDir;
  const result = Bun.spawnSync(
    [process.execPath, join(fx.project, ".codex", "tools", "aidlc.ts"), "engine", "adapter", "codex", target],
    { cwd: fx.project, env, stdin: Buffer.from(payload), stdout: "pipe", stderr: "pipe" },
  );
  return { code: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

type TraceLine = { at: string; sinceStartMs: number; pid: number; ppid: number; phase: string } & Record<string, unknown>;

function traceFiles(dir: string): Map<number, TraceLine[]> {
  const files = new Map<number, TraceLine[]>();
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir)) {
    const match = /^hook-(\d+)\.ndjson$/.exec(name);
    expect(match).not.toBeNull();
    const lines = readFileSync(join(dir, name), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as TraceLine);
    files.set(Number(match?.[1]), lines);
  }
  return files;
}

describe("t352 - opt-in hook phase trace", () => {
  test("off by default: unset or a relative directory writes nothing", () => {
    const fx = fixture();
    const unset = runHook(fx, "fold-usage", "PostToolUse", undefined);
    expect(unset.code).toBe(0);
    const relative = runHook(fx, "fold-usage", "PostToolUse", "hook-trace-relative");
    expect(relative.code).toBe(0);
    expect(existsSync(join(fx.project, "hook-trace-relative"))).toBe(false);
    expect(readdirSync(fx.project).filter((n) => n.startsWith("hook-"))).toEqual([]);
  });

  test("on: each fold-usage process writes its own file with every phase in order", () => {
    const fx = fixture();
    const traceDir = join(fx.root, "trace");
    const result = runHook(fx, "fold-usage", "PostToolUse", traceDir);
    expect(result.code).toBe(0);
    const files = traceFiles(traceDir);
    expect(files.size).toBe(1);
    const [[pid, lines]] = [...files.entries()];
    expect(lines.map((l) => l.phase)).toEqual([
      "dispatcher-start",
      "stdin-begin",
      "stdin-end",
      "hook-import-begin",
      "hook-import-end",
      "fold-imports-loaded",
      "fold-begin",
      "usage-lock-wait",
      "usage-lock-wait-end",
      "usage-lock-released",
      "fold-end",
      "hook-run-end",
      "exit",
    ]);
    for (const line of lines) {
      expect(line.pid).toBe(pid);
      expect(typeof line.ppid).toBe("number");
      expect(Number.isNaN(Date.parse(line.at))).toBe(false);
      expect(typeof line.sinceStartMs).toBe("number");
    }
    const byPhase = new Map(lines.map((l) => [l.phase, l]));
    expect(byPhase.get("dispatcher-start")?.hook).toBe("fold-usage");
    expect(Number.isNaN(Date.parse(String(byPhase.get("dispatcher-start")?.runtimeStartedAt)))).toBe(false);
    expect(byPhase.get("stdin-end")?.bytes).toBe(result.payloadBytes);
    // The payload is multibyte, so a UTF-16 count would differ.
    expect(result.payloadBytes).toBeGreaterThan(result.payloadUnits);
    expect(byPhase.get("fold-begin")?.mode).toBe("holdback");
    expect(byPhase.get("hook-run-end")?.code).toBe(0);
    expect(byPhase.get("exit")?.code).toBe(0);
  });

  test("never changes a hook's outcome, even when the trace cannot be written", () => {
    const fx = fixture();
    const blocker = join(fx.root, "not-a-directory");
    writeFileSync(blocker, "x");
    for (const [hook, event] of [
      ["fold-usage", "PostToolUse"],
      ["reviewer-scope", "PreToolUse"],
    ] as const) {
      const off = runHook(fx, hook, event, undefined);
      const on = runHook(fx, hook, event, join(fx.root, `trace-${hook}`));
      const unwritable = runHook(fx, hook, event, join(blocker, "trace"));
      for (const traced of [on, unwritable]) {
        expect({ hook, code: traced.code, stdout: traced.stdout, stderr: traced.stderr })
          .toEqual({ hook, code: off.code, stdout: off.stdout, stderr: off.stderr });
      }
      expect(traceFiles(join(fx.root, `trace-${hook}`)).size).toBe(1);
    }
  });

  test("only hook and adapter routes are traced; other commands write nothing", () => {
    expect(tracedHookRoute(["engine", "hook", "fold-usage"])).toBe("hook");
    expect(tracedHookRoute(["engine", "adapter", "codex", "reviewer-scope"])).toBe("adapter");
    expect(tracedHookRoute(["engine", "hook"])).toBeUndefined();
    expect(tracedHookRoute(["engine", "orchestrate", "next"])).toBeUndefined();
    expect(tracedHookRoute(["version"])).toBeUndefined();
    const fx = fixture();
    const traceDir = join(fx.root, "trace-other");
    const env: Record<string, string | undefined> = { ...process.env, [HOOK_TRACE_DIR_ENV]: traceDir };
    for (const args of [["version"], ["engine", "orchestrate", "no-such-verb"]]) {
      Bun.spawnSync([process.execPath, join(fx.project, ".claude", "tools", "aidlc.ts"), ...args], {
        cwd: fx.project, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
    }
    expect(existsSync(traceDir)).toBe(false);
  });

  test("an adapter route writes its own phases with its harness and target", () => {
    const fx = fixture();
    const traceDir = join(fx.root, "trace-adapter");
    const off = runCodexAdapter(fx, "reviewer-scope", undefined);
    const on = runCodexAdapter(fx, "reviewer-scope", traceDir);
    expect({ code: on.code, stdout: on.stdout, stderr: on.stderr })
      .toEqual({ code: off.code, stdout: off.stdout, stderr: off.stderr });
    const files = traceFiles(traceDir);
    expect(files.size).toBe(1);
    const [lines] = [...files.values()];
    expect(lines.map((l) => l.phase)).toEqual([
      "dispatcher-start",
      "stdin-begin",
      "stdin-end",
      "adapter-import-begin",
      "adapter-import-end",
      "adapter-run-end",
      "exit",
    ]);
    expect(lines[0]).toMatchObject({ adapter: "codex", target: "reviewer-scope" });
    expect(lines.find((l) => l.phase === "adapter-run-end")?.code).toBe(off.code);
  });

  test.skipIf(process.platform === "win32")("owner-only files; a planted link or FIFO is skipped, not followed", () => {
    const root = tempDir("aidlc-hook-trace-posix-");
    const dir = join(root, "trace");
    process.env[HOOK_TRACE_DIR_ENV] = dir;
    hookTrace("created");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(hookTracePath(dir)).mode & 0o777).toBe(0o600);

    const victim = join(root, "victim.txt");
    writeFileSync(victim, "untouched");
    rmSync(hookTracePath(dir));
    symlinkSync(victim, hookTracePath(dir));
    hookTrace("through-link");
    expect(readFileSync(victim, "utf-8")).toBe("untouched");

    rmSync(hookTracePath(dir));
    expect(Bun.spawnSync(["mkfifo", hookTracePath(dir)]).exitCode).toBe(0);
    // Opening a FIFO for append would block with no reader; the writer must skip it.
    const started = Date.now();
    hookTrace("into-fifo");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("the writer keeps no handle between lines and never throws", () => {
    const dir = join(tempDir("aidlc-hook-trace-mod-"), "trace");
    delete process.env[HOOK_TRACE_DIR_ENV];
    expect(hookTraceEnabled()).toBe(false);
    hookTrace("ignored");
    expect(existsSync(dir)).toBe(false);

    process.env[HOOK_TRACE_DIR_ENV] = dir;
    expect(hookTraceEnabled()).toBe(true);
    hookTrace("first", { n: 1 });
    // A handle held across calls would send the next line into the moved file
    // on POSIX and would refuse the rename on Windows.
    const moved = join(dir, "moved.ndjson");
    renameSync(hookTracePath(dir), moved);
    hookTrace("second", { n: 2 });
    expect(readFileSync(moved, "utf-8").trim().split("\n").map((l) => JSON.parse(l).phase)).toEqual(["first"]);
    const second = JSON.parse(readFileSync(hookTracePath(dir), "utf-8").trim());
    expect(second).toMatchObject({ phase: "second", n: 2, pid: process.pid });

    process.env[HOOK_TRACE_DIR_ENV] = join(dir, "moved.ndjson", "under-a-file");
    expect(() => hookTrace("unwritable")).not.toThrow();
  });
});
