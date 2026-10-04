// covers: function:writeHookStatusFile, function:removeHookStatusFile, function:recordHookDrop, function:recordHookTrace
//
// Hook status files (the `<hook>.last` heartbeats, drop and trace lines, the
// debug log) are written through no link inside the record. A linked file or
// directory is left exactly as it was, its target is unchanged, and the link
// stays in place, so a later check can tell why nothing was written.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  hooksHealthDir,
  recordHookDrop,
  recordHookTrace,
  removeHookStatusFile,
  writeHookStatusFile,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-write-audit-log.ts");
const DIR_LINK = process.platform === "win32" ? "junction" : "dir";

const projects: string[] = [];
const links: string[] = [];
const outsides: string[] = [];

afterEach(() => {
  // Remove each link itself first, so no cleanup walks into its target.
  for (const link of links.splice(0)) {
    try {
      unlinkSync(link);
    } catch {
      rmSync(link, { force: true });
    }
  }
  for (const p of projects.splice(0)) cleanupTestProject(p);
  for (const dir of outsides.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const p = createTestProject();
  projects.push(p);
  return p;
}

function outsideDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-hook-status-outside-"));
  outsides.push(dir);
  return dir;
}

function link(target: string, path: string, kind?: "dir" | "junction"): void {
  symlinkSync(target, path, kind);
  links.push(path);
}

function fireAuditHook(p: string): number | null {
  const r = Bun.spawnSync({
    cmd: [BUN, HOOK],
    stdin: new TextEncoder().encode(""),
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, CLAUDE_PROJECT_DIR: p },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return r.exitCode;
}

describe("hook status files are written without following links", () => {
  test("a plain hooks-health directory gets its files written and appended", () => {
    const healthDir = hooksHealthDir(project());
    expect(writeHookStatusFile(healthDir, "session-start.last", "one")).toBe(true);
    expect(writeHookStatusFile(healthDir, "session-start.last", "two")).toBe(true);
    expect(readFileSync(join(healthDir, "session-start.last"), "utf-8")).toBe("two");
    expect(writeHookStatusFile(healthDir, "run-sensors.drops", "a\n", "append")).toBe(true);
    expect(writeHookStatusFile(healthDir, "run-sensors.drops", "b\n", "append")).toBe(true);
    expect(readFileSync(join(healthDir, "run-sensors.drops"), "utf-8")).toBe("a\nb\n");
  });

  test.skipIf(process.platform === "win32")("a linked heartbeat or drop file is left as it is, with its target unchanged", () => {
    const p = project();
    const healthDir = hooksHealthDir(p);
    mkdirSync(healthDir, { recursive: true });
    const outside = outsideDir();
    const heartbeatTarget = join(outside, "heartbeat-target.txt");
    const dropTarget = join(outside, "drop-target.txt");
    writeFileSync(heartbeatTarget, "keep me", "utf-8");
    writeFileSync(dropTarget, "keep me too", "utf-8");
    const heartbeat = join(healthDir, "session-start.last");
    const drops = join(healthDir, "write-audit-log.drops");
    link(heartbeatTarget, heartbeat);
    link(dropTarget, drops);

    expect(writeHookStatusFile(healthDir, "session-start.last", "2026-10-03T00:00:00Z")).toBe(false);
    recordHookDrop(p, "write-audit-log", "audit emission failed: EACCES");

    expect(readFileSync(heartbeatTarget, "utf-8")).toBe("keep me");
    expect(readFileSync(dropTarget, "utf-8")).toBe("keep me too");
    // The skipped write leaves the link itself, so a later check can see it.
    expect(lstatSync(heartbeat).isSymbolicLink()).toBe(true);
    expect(lstatSync(drops).isSymbolicLink()).toBe(true);
  });

  test("a linked hooks-health directory is left as it is, and nothing lands in its target", () => {
    const p = project();
    const healthDir = hooksHealthDir(p);
    mkdirSync(dirname(healthDir), { recursive: true });
    const outside = outsideDir();
    writeFileSync(join(outside, "session-start.last"), "keep me", "utf-8");
    link(outside, healthDir, DIR_LINK);

    expect(writeHookStatusFile(healthDir, "session-start.last", "new")).toBe(false);
    expect(writeHookStatusFile(healthDir, "validate-state.last", "new")).toBe(false);
    recordHookDrop(p, "run-sensors", "sensor aidlc-linter timed out: subprocess killed by SIGTERM");

    expect(readdirSync(outside)).toEqual(["session-start.last"]);
    expect(readFileSync(join(outside, "session-start.last"), "utf-8")).toBe("keep me");
    expect(lstatSync(healthDir).isSymbolicLink()).toBe(true);
  });

  test("removing a status file through a linked hooks-health directory leaves the target's file alone", () => {
    const plainDir = hooksHealthDir(project());
    expect(writeHookStatusFile(plainDir, "plugin-compose-test.drops", "x\n")).toBe(true);
    expect(removeHookStatusFile(plainDir, "plugin-compose-test.drops")).toBe(true);
    expect(existsSync(join(plainDir, "plugin-compose-test.drops"))).toBe(false);

    const p = project();
    const healthDir = hooksHealthDir(p);
    mkdirSync(dirname(healthDir), { recursive: true });
    const outside = outsideDir();
    writeFileSync(join(outside, "plugin-compose-test.drops"), "keep me", "utf-8");
    link(outside, healthDir, DIR_LINK);

    expect(removeHookStatusFile(healthDir, "plugin-compose-test.drops")).toBe(false);
    recordHookTrace(p, "continue-workflow", "allowing the stop (human-wait carve-out)");

    expect(readdirSync(outside)).toEqual(["plugin-compose-test.drops"]);
    expect(readFileSync(join(outside, "plugin-compose-test.drops"), "utf-8")).toBe("keep me");
    expect(lstatSync(healthDir).isSymbolicLink()).toBe(true);
  });

  test("a linked .aidlc-engine directory is left as it is, and nothing lands in its target", () => {
    const p = project();
    const healthDir = hooksHealthDir(p);
    const engineDir = dirname(healthDir);
    mkdirSync(dirname(engineDir), { recursive: true });
    const outside = outsideDir();
    link(outside, engineDir, DIR_LINK);

    expect(writeHookStatusFile(healthDir, "session-start.last", "new")).toBe(false);

    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(engineDir).isSymbolicLink()).toBe(true);
  });

  test("a real hook carries on past a linked hooks-health directory and writes nothing through it", () => {
    // The same hook in a plain project writes its heartbeat.
    const plain = project();
    expect(fireAuditHook(plain)).toBe(0);
    expect(existsSync(join(hooksHealthDir(plain), "write-audit-log.last"))).toBe(true);

    const p = project();
    const healthDir = hooksHealthDir(p);
    mkdirSync(dirname(healthDir), { recursive: true });
    const outside = outsideDir();
    link(outside, healthDir, DIR_LINK);

    expect(fireAuditHook(p)).toBe(0);
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(healthDir).isSymbolicLink()).toBe(true);
  });
});
