// covers: function:spaceHoldingTheWork, function:recordInferred, function:namedActiveSpace, function:auditLockIdentity, subcommand:aidlc-utility:status
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createTestProject, FIXTURES_DIR } from "../harness/fixtures.ts";
import { auditLockIdentity, createIntent, readSessionBinding, writeSessionBinding } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SESSION = "01995100-0000-7000-8000-000000002477";

let proj = "";
let sessions = "";

function util(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync({
    cmd: [BUN, UTIL, ...args, "--project-dir", proj],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AIDLC_SESSION_OVERRIDE: SESSION },
  });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function seed(space: string, label: string): string {
  const created = createIntent(proj, label, space, "feature");
  const recordDir = join(proj, "aidlc", "spaces", space, "intents", created.dirName);
  cpSync(join(FIXTURES_DIR, "state-construction.md"), join(recordDir, "aidlc-state.md"));
  return created.dirName;
}

function cloneOf(records: Array<[string, string]>): string[] {
  proj = createTestProject();
  sessions = join(proj, "aidlc", ".aidlc-sessions");
  const dirs = records.map(([space, label]) => seed(space, label));
  rmSync(join(proj, "aidlc", "active-space"), { force: true });
  for (const [space] of records) {
    rmSync(join(proj, "aidlc", "spaces", space, "intents", "active-intent"), { force: true });
  }
  rmSync(sessions, { recursive: true, force: true });
  return dirs;
}

function bindingFiles(): string[] {
  return existsSync(sessions) ? readdirSync(sessions).filter((name) => name.endsWith(".binding.json")) : [];
}

beforeEach(() => {
  proj = "";
});

afterEach(() => {
  if (proj !== "") cleanupTestProject(proj);
  proj = "";
});

describe("t2477 a fresh clone whose committed work sits in a named space", () => {
  test("status finds the work and says which record and space it adopted", () => {
    const [record] = cloneOf([["teamx", "spike-billing"]]);

    const res = util(["status"]);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Nothing here names this workflow, so status shows the only work it holds:");
    expect(res.stdout).toContain(`record ${record}, space teamx`);
    expect(res.stdout).toContain("AI-DLC Workflow Status");
    expect(res.stdout).toContain("Test widget feature for e-commerce platform");
    expect(res.stdout).not.toContain("No active AI-DLC workflow found");
  });

  test("an intent lock taken without a space names the space holding the work", () => {
    const [record] = cloneOf([["teamx", "spike-billing"]]);

    expect(auditLockIdentity(proj, record)).toContain("\u0000teamx\u0000");
    expect(auditLockIdentity(proj, record)).toBe(auditLockIdentity(proj, record, "teamx"));
    expect(auditLockIdentity(proj)).not.toContain("teamx");

    mkdirSync(join(proj, "aidlc", "spaces", "default"), { recursive: true });
    writeFileSync(join(proj, "aidlc", "active-space"), "default\n", "utf-8");

    expect(auditLockIdentity(proj, record)).toContain("\u0000default\u0000");
  });

  test("status alone binds no chat", () => {
    cloneOf([["teamx", "spike-billing"]]);

    const res = util(["status"]);

    expect(res.code).toBe(0);
    expect(bindingFiles()).toEqual([]);
    expect(readSessionBinding(proj, SESSION)).toBeNull();
    expect(util(["status"]).stdout).toContain("Nothing here names this workflow");
    expect(bindingFiles()).toEqual([]);
  });

  test("two spaces each holding in-flight work ask instead of picking one", () => {
    const [first, second] = cloneOf([["teamx", "spike-billing"], ["squad", "fix-login"]]);

    const res = util(["status"]);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("No work is selected in this conversation.");
    expect(res.stdout).toContain(`(record ${first}): at`);
    expect(res.stdout).toContain("(space teamx)");
    expect(res.stdout).toContain(`(record ${second}): at`);
    expect(res.stdout).toContain("(space squad)");
    expect(res.stdout).toContain("To work in another space, choose it first:");
    expect(res.stdout).not.toContain("Nothing here names this workflow");
    expect(res.stdout).not.toContain("AI-DLC Workflow Status");

    const named = util(["status", "--space", "teamx"]);

    expect(named.code).toBe(0);
    expect(named.stdout).toContain(`(record ${first}, space teamx)`);
    expect(named.stdout).toContain("AI-DLC Workflow Status");
    expect(named.stdout).not.toContain(second);
  });

  test("a record this chat already bound to is shown without being announced as adopted", () => {
    const [record] = cloneOf([["teamx", "spike-billing"]]);
    writeSessionBinding(proj, SESSION, "teamx", record, "switch");

    const res = util(["status"]);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("AI-DLC Workflow Status");
    expect(res.stdout).toContain("Test widget feature for e-commerce platform");
    expect(res.stdout).not.toContain("Nothing here names this workflow");
    expect(readSessionBinding(proj, SESSION)).toMatchObject({ space: "teamx", intent: record });
  });

  test("a binding to no record does not pin a space that holds none", () => {
    const [record] = cloneOf([["teamx", "spike-billing"]]);
    writeSessionBinding(proj, SESSION, "default", null, "unjoined");

    const res = util(["status"]);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`record ${record}, space teamx`);
    expect(res.stdout).toContain("AI-DLC Workflow Status");
    expect(readFileSync(join(proj, "aidlc", "spaces", "teamx", "intents", record, "aidlc-state.md"), "utf-8"))
      .toContain("AI-DLC State Tracking");
  });
});

describe("t2477 a space this clone's cursor names", () => {
  test("the cursor's own space wins over another space's work", () => {
    const [teamRecord, defaultRecord] = cloneOf([["teamx", "spike-billing"], ["default", "build-auth"]]);
    writeFileSync(join(proj, "aidlc", "active-space"), "teamx\n", "utf-8");

    const res = util(["status"]);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("AI-DLC Workflow Status");
    expect(res.stdout).toContain(`Nothing here names this workflow, so status shows the only work it holds:`);
    expect(res.stdout).toContain(`(record ${teamRecord})`);
    expect(res.stdout).not.toContain(defaultRecord);
    expect(res.stdout).not.toContain("space teamx");
  });
});
