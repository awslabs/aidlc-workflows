// covers: function:recordHostHookCall, function:readHostHookCall, function:hostPromptHookChecks, function:heartbeatAt, subcommand:aidlc-utility:doctor
//
// #976: in some Cursor chats beforeSubmitPrompt never fires while every other
// hook does, so none of the person's replies is recorded and doctor stayed
// green. These cases drive the packaged Cursor tree and pin:
//   - the adapter stamps Cursor's own call for a chat's start and for each
//     prompt before any AIDLC logic, so a prompt whose core hook fails still
//     leaves its stamp, and a background agent's prompt leaves none;
//   - doctor warns once when a chat started, tools ran after it, and no prompt
//     came, and says nothing when a prompt came, when no tool ran yet, or when
//     the install predates the stamps.

import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hooksHealthDir, hookLiveness, writeSessionPidEntry } from "../../dist/cursor/.cursor/tools/aidlc-lib.ts";
import { hostPromptHookChecks } from "../../dist/cursor/.cursor/tools/aidlc-utility.ts";
import { createTestProject, seedAuditFile, seedStateFile } from "../harness/fixtures.ts";

setDefaultTimeout(remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS * 4));

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CURSOR_DIST = join(REPO_ROOT, "dist", "cursor", ".cursor");
const WARNING = "Your replies in the latest Cursor chat are not reaching AI-DLC";
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cursorProject(): string {
  const root = createTestProject();
  scratch.push(root);
  cpSync(CURSOR_DIST, join(root, ".cursor"), { recursive: true });
  seedStateFile(root, "state-construction.md");
  seedAuditFile(root);
  return root;
}

function stampPath(projectDir: string, call: "chat-start" | "prompt"): string {
  return join(projectDir, "aidlc", ".aidlc-sessions", "host-hooks", `${call}.last`);
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function writeStamp(projectDir: string, call: "chat-start" | "prompt", ms: number): void {
  mkdirSync(join(projectDir, "aidlc", ".aidlc-sessions", "host-hooks"), { recursive: true });
  writeFileSync(stampPath(projectDir, call), iso(ms));
}

function writeBeat(projectDir: string, hook: string, ms: number): void {
  const dir = hooksHealthDir(projectDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${hook}.last`), iso(ms));
}

function runAdapter(projectDir: string, target: string, payload: Record<string, unknown>) {
  const session = payload.conversation_id;
  if (target === "mint" && typeof session === "string") writeSessionPidEntry(projectDir, process.pid, session);
  return spawnSync("bun", [join(projectDir, ".cursor", "hooks", "aidlc-cursor-adapter.ts"), target], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: projectDir,
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: { ...process.env, AIDLC_PROJECT_DIR: projectDir, AIDLC_HARNESS_DIR: ".cursor" },
  });
}

const chat = (extra: Record<string, unknown> = {}) => ({
  conversation_id: "c-976",
  session_id: "c-976",
  hook_event_name: "beforeSubmitPrompt",
  prompt: "approve",
  ...extra,
});

const warnings = (projectDir: string) => hostPromptHookChecks(projectDir, hookLiveness(projectDir));

describe("Cursor prompt hook stamps (#976)", () => {
  test("the adapter stamps a chat's start and a prompt, but not a background agent's prompt", () => {
    const proj = cursorProject();
    expect(runAdapter(proj, "session-start", chat({ hook_event_name: "sessionStart" })).status).toBe(0);
    expect(existsSync(stampPath(proj, "chat-start"))).toBe(true);
    expect(runAdapter(proj, "mint", chat({ is_background_agent: true })).status).toBe(0);
    expect(existsSync(stampPath(proj, "prompt"))).toBe(false);
    expect(runAdapter(proj, "mint", chat({ is_background_agent: false })).status).toBe(0);
    expect(existsSync(stampPath(proj, "prompt"))).toBe(true);
  });

  test("a prompt whose core hook cannot run still leaves its stamp", () => {
    const proj = cursorProject();
    rmSync(join(proj, ".cursor", "hooks", "aidlc-record-human-turn.ts"));
    expect(runAdapter(proj, "mint", chat()).status).toBe(0);
    expect(existsSync(stampPath(proj, "prompt"))).toBe(true);
  });
});

describe("doctor on a Cursor chat that never passed a prompt (#976)", () => {
  const now = Date.now();

  test("a chat that ran tools with no prompt after its start is one warning", () => {
    const proj = cursorProject();
    writeStamp(proj, "prompt", now - 60 * 60 * 1000);
    writeStamp(proj, "chat-start", now - 120_000);
    writeBeat(proj, "write-audit-log", now - 60_000);
    const rows = warnings(proj);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pass: false, severity: "warn" });
    expect(rows[0]?.label).toContain(WARNING);
    expect(rows[0]?.fix).toContain("Customize > Hooks");
  });

  test("a prompt at or just before the chat's start, a chat with no tool yet, or no start stamp says nothing", () => {
    const prompted = cursorProject();
    writeStamp(prompted, "chat-start", now - 120_000);
    writeStamp(prompted, "prompt", now - 125_000);
    writeBeat(prompted, "write-audit-log", now - 60_000);
    expect(warnings(prompted)).toEqual([]);

    const idle = cursorProject();
    writeStamp(idle, "chat-start", now - 120_000);
    writeBeat(idle, "session-start", now - 60_000);
    writeBeat(idle, "write-audit-log", now - 600_000);
    expect(warnings(idle)).toEqual([]);

    const older = cursorProject();
    writeBeat(older, "write-audit-log", now - 60_000);
    expect(warnings(older)).toEqual([]);
  });

  test("doctor in the Cursor tree shows the warning row", () => {
    const proj = cursorProject();
    writeStamp(proj, "chat-start", now - 120_000);
    writeBeat(proj, "write-audit-log", now - 60_000);
    const doctor = spawnSync(
      "bun",
      [join(proj, ".cursor", "tools", "aidlc-utility.ts"), "doctor", "--verbose", "--project-dir", proj],
      {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        cwd: proj,
        encoding: "utf-8",
        env: { ...process.env, AIDLC_HARNESS_DIR: ".cursor" },
      },
    );
    expect(doctor.stdout).toContain(WARNING);
  });
});
