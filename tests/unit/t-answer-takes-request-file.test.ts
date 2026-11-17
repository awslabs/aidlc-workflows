// covers: cli:aidlc-log(answer), function:readRequestFile
//
// An agent handed `next --request-file` for the person's words (the opencode
// and Kiro IDE skills on Windows, the engine's own pick step) can carry the
// same file to the answer: `log answer --request-file` reads it as `next`
// does, through no shell, from the one request folder only. The file goes
// once the answer is taken, so a refused answer keeps the person's words for
// the same command again.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject, seededRecordDir, seedStateFile } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const LOG = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools", "aidlc-log.ts");
const FILE = "aidlc/.aidlc-request-text/request.txt";
const ANSWER_FILE = ".aidlc-engine/answer-text/answer.txt";
const WORDS = `I'll edit the file: "R & D" $(touch PWNED) %PATH% !bang | pipe < in > out ^caret`;
const USAGE = "--request-file needs a file directly inside aidlc/.aidlc-request-text/ in this project";
const DIR_LINK = process.platform === "win32" ? "junction" : "dir";

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
  const r = spawnSync(process.execPath, [LOG, ...args, "--project-dir", p], {
    cwd: p,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function writeRequest(p: string, text: string): void {
  mkdirSync(join(p, "aidlc", ".aidlc-request-text"), { recursive: true });
  writeFileSync(join(p, FILE), `${text}\n`, "utf-8");
}

function details(p: string): string | null {
  const last = readAllAuditShards(p).split(/\n---\n/).filter((block) => block.includes("**Event**: QUESTION_ANSWERED")).at(-1);
  const line = last?.split("\n").find((entry) => entry.startsWith("**Details**: "));
  return line === undefined ? null : line.slice("**Details**: ".length);
}

function answered(p: string): number {
  return readAllAuditShards(p).split("\n").filter((line) => line === "**Event**: QUESTION_ANSWERED").length;
}

function askQuestion(p: string): void {
  expect(log(p, ["decision", "--stage", "feasibility", "--decision", "Which team?", "--options", "A,B"]).status).toBe(0);
}

describe("t-answer-takes-request-file: log answer reads the request file next reads", () => {
  for (const [form, file] of [["forward", FILE], ["Windows", FILE.replaceAll("/", "\\")]] as const) {
    test(`the file's words are the answer, exactly, and the file is gone (${form} slashes)`, () => {
      const p = project();
      askQuestion(p);
      writeRequest(p, WORDS);
      const r = log(p, ["answer", "--stage", "feasibility", "--request-file", file]);
      expect(r.status, r.out).toBe(0);
      expect(details(p)).toBe(WORDS);
      expect(existsSync(join(p, FILE))).toBe(false);
      expect(existsSync(join(p, "PWNED"))).toBe(false);
    });
  }

  test("a refused answer keeps the file, so the same command records it", () => {
    const p = project();
    askQuestion(p);
    writeRequest(p, WORDS);
    const refused = log(p, ["answer", "--stage", "feasibility", "--checkpoint", "not-a-checkpoint", "--request-file", FILE]);
    expect(refused.status, refused.out).not.toBe(0);
    expect(readFileSync(join(p, FILE), "utf-8")).toBe(`${WORDS}\n`);
    expect(answered(p)).toBe(0);
    const r = log(p, ["answer", "--stage", "feasibility", "--request-file", FILE]);
    expect(r.status, r.out).toBe(0);
    expect(details(p)).toBe(WORDS);
    expect(existsSync(join(p, FILE))).toBe(false);
  });

  // The recovery and Plan Approval answers are kept by their own records, not
  // by a row of the answer's: the file goes all the same once the answer is taken.
  test("an answer taken without a row of its own still removes the file", () => {
    const p = project();
    writeRequest(p, "Request Changes");
    const r = log(p, ["answer", "--stage", "feasibility", "--checkpoint", "guard-recovery", "--request-file", FILE]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("nothing to record");
    expect(existsSync(join(p, FILE))).toBe(false);
  });

  test("only a plain file directly in the request folder is read, and nothing else is touched", () => {
    const p = project();
    askQuestion(p);
    writeFileSync(join(p, "README.md"), "keep me\n", "utf-8");
    writeRequest(p, WORDS);
    for (const file of [
      "README.md",
      "aidlc/.aidlc-request-text/../../README.md",
      join(p, FILE),
      "aidlc/.aidlc-request-text",
      "aidlc/.aidlc-request-text/sub/request.txt",
    ]) {
      const r = log(p, ["answer", "--stage", "feasibility", "--request-file", file]);
      expect(r.status, `${file}: ${r.out}`).not.toBe(0);
      expect(r.out, file).toContain(USAGE);
      expect(r.out, file).not.toContain("keep me");
    }
    expect(readFileSync(join(p, "README.md"), "utf-8")).toBe("keep me\n");
    expect(existsSync(join(p, FILE))).toBe(true);
    expect(answered(p)).toBe(0);
  });

  test("the request file beside --details or --details-file is refused, and both files stay", () => {
    const p = project();
    askQuestion(p);
    writeRequest(p, WORDS);
    const answerText = join(seededRecordDir(p), ANSWER_FILE);
    mkdirSync(join(answerText, ".."), { recursive: true });
    writeFileSync(answerText, "B\n", "utf-8");
    for (const other of [["--details", "A"], ["--details-file", ANSWER_FILE]]) {
      const r = log(p, ["answer", "--stage", "feasibility", "--request-file", FILE, ...other]);
      expect(r.status, `${other[0]}: ${r.out}`).not.toBe(0);
      expect(r.out).toContain("Pass one of --details, --details-file or --request-file, not two.");
    }
    expect(existsSync(join(p, FILE))).toBe(true);
    expect(existsSync(answerText)).toBe(true);
    expect(answered(p)).toBe(0);
  });

  test("a linked request folder is not read through, and what it points at stays", () => {
    const p = project();
    askQuestion(p);
    const elsewhere = join(p, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "request.txt"), "secret\n", "utf-8");
    mkdirSync(join(p, "aidlc"), { recursive: true });
    symlinkSync(elsewhere, join(p, "aidlc", ".aidlc-request-text"), DIR_LINK);
    const r = log(p, ["answer", "--stage", "feasibility", "--request-file", FILE]);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).not.toContain("secret");
    expect(readFileSync(join(elsewhere, "request.txt"), "utf-8")).toBe("secret\n");
    expect(answered(p)).toBe(0);
  });
});
