// covers: subcommand:aidlc-orchestrate:next
//
// A person's request reaches AI-DLC through a file the agent writes, so no
// shell reads it on the way: on Windows, cmd.exe ends a command at a line
// break and replaces a %NAME% pair even inside quotes, and the aidlc launcher
// is read by cmd.exe again. The words arrive exactly as typed and the file is
// removed. Only a plain file in the one folder for it is ever read.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hooksHealthDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, REPO_ROOT, toPortablePath } from "../harness/fixtures.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const FILE = "aidlc/.aidlc-request-text/request.txt";
const WORDS = 'Book rooms for the team\nat 50% of %TEMP% capacity, say "hi" & !T241! to C:\\dir\\';
const USAGE = "--request-file needs a file directly inside aidlc/.aidlc-request-text/ in this project";
const DIR_LINK = process.platform === "win32" ? "junction" : "dir";

const projects: string[] = [];
const outsides: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
  for (const dir of outsides) rmSync(dir, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function installed(): string {
  let proj = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aidlc-request-file-"));
  try {
    proj = realpathSync(proj);
  } catch {
    // Keep the temp path as created.
  }
  proj = toPortablePath(proj);
  projects.push(proj);
  cpSync(join(REPO_ROOT, "dist", "opencode"), proj, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: proj });
  return proj;
}

type Directive = { kind: string; message?: string };

function next(proj: string, args: string[], extra: Record<string, string> = {}): Directive {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1", ...extra };
  for (const key of ["AIDLC_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "AIDLC_SESSION_OVERRIDE", "AIDLC_UNATTENDED"]) {
    delete env[key];
  }
  const r = spawnSync(process.execPath, [join(proj, ".aidlc", "tools", "aidlc-orchestrate.ts"), "next", ...args], {
    cwd: proj,
    encoding: "utf-8",
    env,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Directive;
}

function writeRequest(proj: string, text: string, file = FILE): void {
  mkdirSync(join(proj, "aidlc", ".aidlc-request-text"), { recursive: true });
  writeFileSync(join(proj, file), text, "utf-8");
}

// The requests the engine kept for its questions, in the person's words.
function keptRequests(proj: string): string[] {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "questions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => (JSON.parse(readFileSync(join(dir, name), "utf-8")) as { text: string }).text);
}

describe("next --request-file: the person's words arrive exactly, through no shell", () => {
  test("the words in the file reach AI-DLC exactly as typed, and the file is removed", () => {
    const proj = installed();
    writeRequest(proj, `${WORDS}\n`);
    const directive = next(proj, ["--request-file", FILE]);
    expect(directive.kind, JSON.stringify(directive)).toBe("ask");
    expect(keptRequests(proj)).toEqual([WORDS]);
    expect(existsSync(join(proj, FILE))).toBe(false);
  });

  test("Windows slashes name the same file, and a scope typed with it still names the plan", () => {
    const proj = installed();
    writeRequest(proj, WORDS);
    const directive = next(proj, ["bugfix", "--request-file", FILE.replaceAll("/", "\\")]);
    expect(directive.kind, JSON.stringify(directive)).toBe("print");
    expect(directive.message ?? "").toContain("intent create --scope bugfix");
    expect(keptRequests(proj)).toEqual([WORDS]);
    expect(existsSync(join(proj, FILE))).toBe(false);
  });

  test("only a plain file in that one folder is read, and nothing else is touched", () => {
    const proj = installed();
    writeFileSync(join(proj, "README.md"), "keep me\n", "utf-8");
    writeRequest(proj, WORDS);
    for (const file of [
      "README.md",
      "aidlc/.aidlc-request-text/../../README.md",
      join(proj, "README.md"),
      "aidlc/.aidlc-request-text",
      "aidlc/.aidlc-request-text/",
      "aidlc/.aidlc-request-text/sub/request.txt",
    ]) {
      const refused = next(proj, ["--request-file", file]);
      expect(refused.kind, file).toBe("error");
      expect(refused.message ?? "", file).toContain(USAGE);
    }
    expect(readFileSync(join(proj, "README.md"), "utf-8")).toBe("keep me\n");
    expect(existsSync(join(proj, FILE))).toBe(true);
    expect(keptRequests(proj)).toEqual([]);

    expect(next(proj, ["--request-file"]).message ?? "").toContain(USAGE);
    expect(next(proj, ["--request-file", FILE, "--request-file", FILE]).kind).toBe("error");
    expect(next(proj, ["--request-file", FILE, "--", "more words"]).kind).toBe("error");
    expect(existsSync(join(proj, FILE))).toBe(true);

    writeRequest(proj, "\n");
    const empty = next(proj, ["--request-file", FILE]);
    expect(empty.kind).toBe("error");
    expect(empty.message ?? "").toContain("Send your request again.");
    expect(keptRequests(proj)).toEqual([]);
  });

  test("a next stopped before any work keeps the file, so the same command runs again", () => {
    const proj = installed();
    writeRequest(proj, WORDS);
    const stopped = next(proj, ["--request-file", FILE], { AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0" });
    expect(stopped.kind, JSON.stringify(stopped)).toBe("print");
    expect(stopped.message ?? "").toContain("Quit opencode and start it again");
    expect(existsSync(join(proj, FILE))).toBe(true);
    mkdirSync(hooksHealthDir(proj), { recursive: true });
    writeFileSync(join(hooksHealthDir(proj), "record-human-turn.last"), new Date().toISOString(), "utf-8");
    const asked = next(proj, ["--request-file", FILE], { AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0" });
    expect(asked.kind, JSON.stringify(asked)).toBe("ask");
    expect(keptRequests(proj)).toEqual([WORDS]);
    expect(existsSync(join(proj, FILE))).toBe(false);
  });

  test("a linked folder is not read through, and what it points at stays", () => {
    const proj = installed();
    const outside = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aidlc-request-file-outside-"));
    outsides.push(outside);
    writeFileSync(join(outside, "request.txt"), WORDS, "utf-8");
    mkdirSync(join(proj, "aidlc"), { recursive: true });
    symlinkSync(outside, join(proj, "aidlc", ".aidlc-request-text"), DIR_LINK);
    const refused = next(proj, ["--request-file", FILE]);
    expect(refused.kind).toBe("error");
    expect(refused.message ?? "").toContain("Send your request again.");
    expect(readFileSync(join(outside, "request.txt"), "utf-8")).toBe(WORDS);
    expect(keptRequests(proj)).toEqual([]);
  });

  test("a read-only probe of the same command leaves the file for the real one", () => {
    const proj = installed();
    writeRequest(proj, WORDS);
    spawnSync(process.execPath, [join(proj, ".aidlc", "tools", "aidlc-orchestrate.ts"), "next", "--request-file", FILE], {
      cwd: proj,
      encoding: "utf-8",
      env: { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1", AIDLC_ROUTE_CHECK: "1" },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(existsSync(join(proj, FILE))).toBe(true);
    expect(next(proj, ["--request-file", FILE]).kind).toBe("ask");
    expect(keptRequests(proj)).toContain(WORDS);
    expect(existsSync(join(proj, FILE))).toBe(false);
  });
});
