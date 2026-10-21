// covers: subcommand:aidlc-learnings:surface, subcommand:aidlc-learnings:persist
//
// t1592 — the learnings selections file has one home per piece of work (#1592).
//
// The ritual hands the person's picks from the conductor to `persist` through a
// file. Nothing named where that file goes, so two sessions in one project wrote
// the same obvious spot: the later write replaced the earlier one, and the
// earlier session then saved the other session's picks while its own person's
// picks were lost with no error. `surface` now names the file for the piece of
// work it surfaced (`selections_file`, inside that record's gitignored
// `.aidlc-engine/learnings/`), and `persist` refuses a selections file anywhere
// else, naming the file to write instead.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import {
  AIDLC_SRC,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const LEARNINGS_TS = join(AIDLC_SRC, "tools", "aidlc-learnings.ts");
const STAGE = "user-stories";
const RECORD_A = DEFAULT_RECORD_DIR;
const RECORD_B = "fixture-b2222222";
const STATE = `# AI-DLC State Tracking\n- **Current Stage**: ${STAGE}\n- **Scope**: feature\n`;

const projects: string[] = [];
afterEach(() => {
  for (const p of projects) rmSync(p, { recursive: true, force: true });
  projects.length = 0;
});

// One project holding two pieces of work, both at the same stage's gate: the
// shape of two chats (say Claude and Codex) working side by side in one folder.
function twoIntentProject(): string {
  const pd = createTestProject();
  projects.push(pd);
  writeFileSync(seededStateFile(pd), STATE, "utf-8");
  mkdirSync(join(intentsDirOf(pd, DEFAULT_SPACE), RECORD_B), { recursive: true });
  writeFileSync(join(intentsDirOf(pd, DEFAULT_SPACE), RECORD_B, "aidlc-state.md"), STATE, "utf-8");
  return pd;
}

function useIntent(pd: string, record: string): void {
  writeFileSync(join(intentsDirOf(pd, DEFAULT_SPACE), "active-intent"), `${record}\n`, "utf-8");
}

// Each session speaks as its own chat, so neither inherits the chat running the
// test suite (which would tie both to whichever work it touched first).
const CHAT: Record<string, string> = {
  [RECORD_A]: "11111111-1111-4111-8111-111111111111",
  [RECORD_B]: "22222222-2222-4222-8222-222222222222",
};

function run(pd: string, args: string[], record = RECORD_A): { status: number; out: string } {
  const r = spawnSync(BUN, [LEARNINGS_TS, ...args, "--project-dir", pd], {
    cwd: pd,
    encoding: "utf-8",
    env: { ...process.env, AIDLC_SESSION_OVERRIDE: CHAT[record], AIDLC_SESSION_OVERRIDE_SOURCE: "payload" },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function surface(pd: string, record: string): { intent: string; selections_file?: string } {
  useIntent(pd, record);
  const r = run(pd, ["surface", "--slug", STAGE], record);
  expect(r.status, r.out).toBe(0);
  return JSON.parse(r.out);
}

// What the conductor writes after the person picks: the surface-time binding
// plus one kept learning.
function selections(record: string, text: string): string {
  return JSON.stringify({
    stage_slug: STAGE,
    space: DEFAULT_SPACE,
    intent: record,
    selections: [{ candidate_id: "c1", type: "learning", scope: "project", heading: "Corrections", text }],
  });
}

function writeAt(pd: string, rel: string, body: string): void {
  mkdirSync(dirname(join(pd, rel)), { recursive: true });
  writeFileSync(join(pd, rel), body, "utf-8");
}

// A chat saves its picks while it is on its own work.
function persist(pd: string, rel: string, record = RECORD_A): { status: number; out: string } {
  useIntent(pd, record);
  return run(pd, ["persist", "--slug", STAGE, "--selections-json", rel], record);
}

function projectMd(pd: string): string {
  const p = join(pd, "aidlc", "spaces", DEFAULT_SPACE, "memory", "project.md");
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

const expectedFile = (record: string): string =>
  `aidlc/spaces/${DEFAULT_SPACE}/intents/${record}/.aidlc-engine/learnings/${STAGE}-selections.json`;

describe("t1592 one selections file per piece of work", () => {
  test("REPRODUCTION: two sessions sharing one selections file never save the wrong picks", () => {
    const pd = twoIntentProject();
    surface(pd, RECORD_A);
    surface(pd, RECORD_B);
    const shared = "aidlc/selections.json";

    // Session A writes its person's pick; session B then writes the same spot.
    writeAt(pd, shared, selections(RECORD_A, "Picked by person A"));
    writeAt(pd, shared, selections(RECORD_B, "Picked by person B"));

    // Session A saves. Before the fix this succeeded and saved B's pick while
    // A's pick was gone: A's person was told their notes were kept.
    const a = persist(pd, shared, RECORD_A);
    expect(a.status, a.out).toBe(1);
    // The way on names no path from the misplaced file: B's folder would send
    // A to copy B's picks there and lose A's person's picks all over again.
    expect(a.out).toContain(`learnings surface --slug ${STAGE}`);
    expect(a.out).not.toContain(RECORD_B);
    expect(projectMd(pd)).not.toContain("Picked by person B");
    expect(projectMd(pd)).not.toContain("Picked by person A");
  });

  test("surface names a separate file for each piece of work, inside its gitignored engine folder", () => {
    const pd = twoIntentProject();
    const a = surface(pd, RECORD_A);
    const b = surface(pd, RECORD_B);
    expect(a.selections_file).toBe(expectedFile(RECORD_A));
    expect(b.selections_file).toBe(expectedFile(RECORD_B));
  });

  test("two sessions each writing the file surface named keep both people's picks", () => {
    const pd = twoIntentProject();
    const a = surface(pd, RECORD_A);
    const b = surface(pd, RECORD_B);
    writeAt(pd, a.selections_file!, selections(RECORD_A, "Picked by person A"));
    writeAt(pd, b.selections_file!, selections(RECORD_B, "Picked by person B"));

    const ra = persist(pd, a.selections_file!);
    const rb = persist(pd, b.selections_file!, RECORD_B);
    expect(ra.status, ra.out).toBe(0);
    expect(rb.status, rb.out).toBe(0);
    expect(projectMd(pd)).toContain("Picked by person A");
    expect(projectMd(pd)).toContain("Picked by person B");
  });

  // Windows PowerShell 5.1 writes UTF-8 with a byte order mark; the person's
  // pick in a file written that way is kept, not refused as malformed (#2452).
  test("a selections file written with a byte order mark and CRLF keeps the person's pick", () => {
    const pd = twoIntentProject();
    const a = surface(pd, RECORD_A);
    writeAt(pd, a.selections_file!, `﻿${selections(RECORD_A, "Kept — from PowerShell")}\r\n`);
    const r = persist(pd, a.selections_file!);
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain("malformed");
    expect(projectMd(pd)).toContain("Kept — from PowerShell");
  });

  // However the full path is spelled, it names the same file and is accepted.
  const spellings: Array<[string, (pd: string, printed: string) => string]> = [
    ["the native path", (pd, printed) => join(pd, printed)],
    ["forward slashes", (pd, printed) => join(pd, printed).replaceAll("\\", "/")],
    ["the project folder plus the printed path as it is", (pd, printed) => `${pd}${sep}${printed}`],
    ["the project folder plus ./", (pd, printed) => `${pd}${sep}.${sep}${printed}`],
    ["a doubled separator", (pd, printed) => `${pd}${sep}${sep}${printed}`],
  ];
  if (process.platform === "win32") {
    spellings.push(["a lower-case drive letter", (pd, printed) => {
      const full = join(pd, printed);
      return full[0].toLowerCase() + full.slice(1);
    }]);
  }
  for (const [spelling, spell] of spellings) {
    test(`the file named in full is accepted: ${spelling}`, () => {
      const pd = twoIntentProject();
      const a = surface(pd, RECORD_A);
      writeAt(pd, a.selections_file!, selections(RECORD_A, "Picked by person A"));
      const r = persist(pd, spell(pd, a.selections_file!));
      expect(r.status, r.out).toBe(0);
      expect(projectMd(pd)).toContain("Picked by person A");
    });
  }

  test("a file bound to one piece of work but kept in another's folder is refused", () => {
    const pd = twoIntentProject();
    surface(pd, RECORD_A);
    writeAt(pd, expectedFile(RECORD_A), selections(RECORD_B, "Picked by person B"));
    const r = persist(pd, expectedFile(RECORD_A), RECORD_A);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`learnings surface --slug ${STAGE}`);
    expect(r.out).not.toContain(RECORD_B);
    expect(projectMd(pd)).not.toContain("Picked by person B");
  });

  test("a link in place of the selections file is refused", () => {
    const pd = twoIntentProject();
    surface(pd, RECORD_A);
    writeAt(pd, "elsewhere.json", selections(RECORD_A, "Picked by person A"));
    mkdirSync(dirname(join(pd, expectedFile(RECORD_A))), { recursive: true });
    symlinkSync(join(pd, "elsewhere.json"), join(pd, expectedFile(RECORD_A)));
    const r = persist(pd, expectedFile(RECORD_A));
    expect(r.status, r.out).toBe(1);
    expect(projectMd(pd)).not.toContain("Picked by person A");
  });

  test("a folder link on the way to the selections file is refused, and says so", () => {
    const pd = twoIntentProject();
    surface(pd, RECORD_A);
    const elsewhere = join(pd, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const learnings = dirname(join(pd, expectedFile(RECORD_A)));
    mkdirSync(dirname(learnings), { recursive: true });
    symlinkSync(elsewhere, learnings);
    writeAt(pd, expectedFile(RECORD_A), selections(RECORD_A, "Picked by person A"));
    const r = persist(pd, expectedFile(RECORD_A));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("could not be read through no link");
    expect(projectMd(pd)).not.toContain("Picked by person A");
  });

  test("writing the picks with no intent record never makes a missing space count as existing", () => {
    const pd = createTestProject();
    projects.push(pd);
    // The file's own home for a space that does not exist: writing it creates
    // the space folder, which must still be refused as the missing space.
    const rel = `aidlc/spaces/ghost/intents/.aidlc-engine/learnings/${STAGE}-selections.json`;
    writeAt(
      pd,
      rel,
      JSON.stringify({
        stage_slug: STAGE,
        space: "ghost",
        intent: null,
        selections: [{ candidate_id: "c1", type: "learning", scope: "project", heading: "Corrections", text: "Ghost" }],
      }),
    );
    const r = run(pd, ["persist", "--slug", STAGE, "--selections-json", rel]);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("missing space");
    expect(existsSync(join(pd, "aidlc", "spaces", "ghost", "memory"))).toBe(false);
  });

  test("the path surface printed works from a shell in a subfolder of the project", () => {
    const pd = twoIntentProject();
    const a = surface(pd, RECORD_A);
    writeAt(pd, a.selections_file!, selections(RECORD_A, "Picked by person A"));
    mkdirSync(join(pd, "src"), { recursive: true });
    useIntent(pd, RECORD_A);
    const r = spawnSync(BUN, [LEARNINGS_TS, "persist", "--slug", STAGE, "--selections-json", a.selections_file!, "--project-dir", pd], {
      cwd: join(pd, "src"),
      encoding: "utf-8",
      env: { ...process.env, AIDLC_SESSION_OVERRIDE: CHAT[RECORD_A], AIDLC_SESSION_OVERRIDE_SOURCE: "payload" },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(projectMd(pd)).toContain("Picked by person A");
  });

  test("a crashed save is retried from the same file without asking the person again", () => {
    const pd = twoIntentProject();
    const a = surface(pd, RECORD_A);
    writeAt(pd, a.selections_file!, selections(RECORD_A, "Picked by person A"));
    expect(persist(pd, a.selections_file!).status).toBe(0);
    const again = persist(pd, a.selections_file!);
    expect(again.status, again.out).toBe(0);
    expect(JSON.parse(again.out).rule_learned).toBe(0);
    expect(projectMd(pd).split("Picked by person A").length - 1).toBe(1);
  });
});
