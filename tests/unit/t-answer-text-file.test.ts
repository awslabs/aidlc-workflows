// An answer's text can come from the project (a choice's label) or from the
// person, and a shell reads $(...), backticks, %NAME%, & | < > ^ and ! in it.
// `log answer --details-file` / `--on-instruction-file` carry it in a file in
// the record's answer-text folder instead, so no shell (bash, PowerShell, or
// cmd.exe through aidlc.cmd) ever sees it: the command line holds only a path.
// covers: function:readAnswerTextFile
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject, seededRecordDir, seedStateFile } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const LOG = join(TOOLS, "aidlc-log.ts");
const FOLDER = ".aidlc-engine/answer-text";
// Every character a shell acts on, and a quote of each kind.
const HOSTILE =
  'Use "R & D" team; $(touch PWNED) `touch PWNED2` %PATH% ^caret !bang | pipe < in > out it\'s $HOME';

const projects: string[] = [];
afterAll(() => {
  for (const p of projects) cleanupTestProject(p);
});

function project(): string {
  const p = createTestProject();
  projects.push(p);
  seedStateFile(p, "state-mid-ideation.md");
  return p;
}

function log(p: string, args: string[]): { status: number; out: string } {
  const r = spawnSync(BUN, [LOG, ...args, "--project-dir", p], {
    cwd: p,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function writeAnswer(p: string, name: string, text: string): string {
  const dir = join(seededRecordDir(p), FOLDER);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${text}\n`);
  return `${FOLDER}/${name}`;
}

function field(p: string, event: string, name: string): string | null {
  const blocks = readAllAuditShards(p).split(/\n---\n/).filter((block) => block.includes(`**Event**: ${event}`));
  const last = blocks.at(-1);
  const line = last?.split("\n").find((entry) => entry.startsWith(`**${name}**: `));
  return line === undefined ? null : line.slice(`**${name}**: `.length);
}

function answered(p: string): number {
  return readAllAuditShards(p).split("\n").filter((line) => line === "**Event**: QUESTION_ANSWERED").length;
}

function askQuestion(p: string): void {
  expect(log(p, ["decision", "--stage", "feasibility", "--decision", "Which team?", "--options", "A,B"]).status).toBe(0);
}

function shellsSeeNoText(p: string): void {
  for (const where of [p, process.cwd()]) {
    expect(existsSync(join(where, "PWNED"))).toBe(false);
    expect(existsSync(join(where, "PWNED2"))).toBe(false);
  }
}

describe("t-answer-text-file: an answer's text reaches the record with no shell on the way", () => {
  test("the text is recorded exactly as written, and the file is gone after", () => {
    const p = project();
    askQuestion(p);
    const file = writeAnswer(p, "answer.txt", HOSTILE);
    const r = log(p, ["answer", "--stage", "feasibility", "--details-file", file]);
    expect(r.status, r.out).toBe(0);
    expect(field(p, "QUESTION_ANSWERED", "Details")).toBe(HOSTILE);
    expect(readdirSync(join(seededRecordDir(p), FOLDER))).toEqual([]);
    shellsSeeNoText(p);
  });

  // PowerShell 7 where it is installed, else Windows PowerShell 5.1 (Kiro IDE's
// execute_pwsh, Copilot's terminal on Windows).
const POWERSHELL = ["pwsh", "powershell"].find((exe) =>
  spawnSync(exe, ["-NoProfile", "-Command", "exit 0"]).status === 0) ?? null;

// Each shell the tools run in gets only the path on its command line, so
  // what the text holds never reaches it.
  const shells: { name: string; available: boolean; argv: (command: string) => string[] }[] = [
    { name: "bash", available: process.platform !== "win32" || spawnSync("bash", ["-c", "true"]).status === 0,
      argv: (command) => ["bash", "-c", command] },
    { name: "PowerShell", available: POWERSHELL !== null,
      argv: (command) => [POWERSHELL!, "-NoProfile", "-Command", `& ${command}`] },
    { name: "cmd.exe", available: process.platform === "win32",
      argv: (command) => ["cmd.exe", "/d", "/s", "/c", `"${command}"`] },
  ];
  for (const shell of shells) {
    test.skipIf(!shell.available)(`through ${shell.name}, the command line holds only the path`, () => {
      const p = project();
      askQuestion(p);
      const file = writeAnswer(p, "answer.txt", HOSTILE);
      const quote = (value: string) => shell.name === "cmd.exe" ? `"${value}"` : `'${value}'`;
      const command = [BUN, LOG, "answer", "--stage", "feasibility", "--details-file", file, "--project-dir", p]
        .map(quote).join(" ");
      expect(command).not.toContain("touch");
      const [exe, ...args] = shell.argv(command);
      const r = spawnSync(exe, args, {
        cwd: p, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        windowsVerbatimArguments: shell.name === "cmd.exe",
      });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      expect(field(p, "QUESTION_ANSWERED", "Details")).toBe(HOSTILE);
      shellsSeeNoText(p);
    });
  }

  test("a file anywhere but the record's answer-text folder is never read", () => {
    const p = project();
    askQuestion(p);
    writeFileSync(join(seededRecordDir(p), "note.txt"), "secret\n");
    for (const file of [
      "note.txt", "aidlc-state.md", ".aidlc-engine/answer.txt", `${FOLDER}/../../note.txt`, `${FOLDER}/`,
      join(seededRecordDir(p), "note.txt"),
    ]) {
      const r = log(p, ["answer", "--stage", "feasibility", "--details-file", file]);
      expect(r.status, `${file}: ${r.out}`).not.toBe(0);
      expect(r.out).not.toContain("secret");
    }
    // Each refusal is logged as an error, and nothing was answered or copied.
    expect(answered(p)).toBe(0);
    expect(readAllAuditShards(p)).not.toContain("secret");
  });

  // A live run named the file from the project folder, and the refusal cost a
  // round trip (#2167). It is the same file, so it is read under that name too,
  // and the full path as well; a name that climbs out of the folder is not.
  test("the folder's file named from the project folder, or in full, is the same file", () => {
    for (const named of [
      (p: string, name: string) => relative(p, join(seededRecordDir(p), FOLDER, name)),
      (p: string, name: string) => relative(p, join(seededRecordDir(p), FOLDER, name)).replaceAll("/", "\\"),
      (p: string, name: string) => join(seededRecordDir(p), FOLDER, name),
    ]) {
      const p = project();
      askQuestion(p);
      writeAnswer(p, "answer.txt", HOSTILE);
      const r = log(p, ["answer", "--stage", "feasibility", "--details-file", named(p, "answer.txt")]);
      expect(r.status, r.out).toBe(0);
      expect(field(p, "QUESTION_ANSWERED", "Details")).toBe(HOSTILE);
      expect(readdirSync(join(seededRecordDir(p), FOLDER))).toEqual([]);
    }
    const p = project();
    askQuestion(p);
    writeFileSync(join(seededRecordDir(p), "note.txt"), "secret\n");
    writeAnswer(p, "answer.txt", "kept");
    for (const file of [
      relative(p, join(seededRecordDir(p), FOLDER, "..", "..", "note.txt")),
      `${relative(p, join(seededRecordDir(p), FOLDER))}/../../note.txt`,
      relative(p, join(seededRecordDir(p), FOLDER)),
      join(p, FOLDER, "answer.txt"),
    ]) {
      const r = log(p, ["answer", "--stage", "feasibility", "--details-file", file]);
      expect(r.status, `${file}: ${r.out}`).not.toBe(0);
      expect(r.out).not.toContain("secret");
    }
    expect(answered(p)).toBe(0);
  });

  test.skipIf(process.platform === "win32")("a link in the folder, an oversized or empty file, or both flags are refused", () => {
    const p = project();
    askQuestion(p);
    const dir = join(seededRecordDir(p), FOLDER);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(seededRecordDir(p), "note.txt"), "secret\n");
    symlinkSync(join(seededRecordDir(p), "note.txt"), join(dir, "link.txt"));
    writeFileSync(join(dir, "big.txt"), "x".repeat(64 * 1024 + 1));
    writeFileSync(join(dir, "empty.txt"), "\n");
    for (const args of [
      ["--details-file", `${FOLDER}/link.txt`],
      ["--details-file", `${FOLDER}/big.txt`],
      ["--details-file", `${FOLDER}/empty.txt`],
      ["--details", "Team A", "--details-file", writeAnswer(p, "both.txt", "Team B")],
    ]) {
      const r = log(p, ["answer", "--stage", "feasibility", ...args]);
      expect(r.status, `${args.join(" ")}: ${r.out}`).not.toBe(0);
      expect(r.out).not.toContain("secret");
    }
    expect(answered(p)).toBe(0);
    expect(readAllAuditShards(p)).not.toContain("secret");
  });

  test("the person's words that left a choice to the agent travel the same way", () => {
    const p = project();
    const human = spawnSync(BUN, [join(TOOLS, "aidlc.ts"), "engine", "hook", "record-human-turn"], {
      cwd: p, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      env: { ...process.env, CLAUDE_PROJECT_DIR: p, AIDLC_PROJECT_DIR: p },
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "t-answer-text", prompt: "up to you & $HOME" }),
    });
    expect(human.status, `${human.stdout}${human.stderr}`).toBe(0);
    askQuestion(p);
    const words = writeAnswer(p, "words.txt", "up to you & $HOME");
    const r = log(p, ["answer", "--stage", "feasibility", "--details", "A", "--on-instruction-file", words]);
    expect(r.status, r.out).toBe(0);
    expect(field(p, "QUESTION_ANSWERED", "Instruction")).toBe("up to you & $HOME");
  });
});
