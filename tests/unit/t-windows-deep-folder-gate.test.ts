// covers: file:core/tools/aidlc-folder-depth.ts, subcommand:aidlc-orchestrate:report
//
// A Unit's name adds to every per-Unit record, so a project folder that config
// and doctor rightly stay silent for can still be too deep once Units
// Generation names the Units. On Windows the Units Generation gate says the
// same line once, from the same helper, with the depth the Unit names make:
// not when the open gate is shown again, not for short names, and never on
// Linux or macOS.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seedAidlcMemory,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const HELPER = join(import.meta.dir, "..", "..", "core", "tools", "aidlc-folder-depth.ts");
const WINDOWS = process.platform === "win32";
const SAID = "characters deep; Windows tools refuse paths over 260 characters and AI-DLC's records add about";
const STAGE = "units-generation";
const SEP = "\u2014";
const made: string[] = [];

afterAll(() => {
  while (made.length > 0) {
    const path = made.pop();
    if (path?.includes("aidlc-test-")) cleanupTestProject(path);
    else if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe("the helper with the Unit names", () => {
  // A 70-character Windows folder: config and doctor stay silent (70 + 1 + 185 = 256).
  const folder = `C:\\Users\\${"u".repeat(70 - "C:\\Users\\\\my-app".length)}\\my-app`;

  test("the number grows by the longest Unit name, measured from the per-Unit records", async () => {
    const { RECORD_DEPTH, UNIT_RECORD_DEPTH, deepFolder } = await import(HELPER);
    expect(folder).toHaveLength(70);
    expect(deepFolder(folder, "win32")).toBeNull();
    // Infrastructure Design's per-Unit review brief with an empty name:
    // aidlc/spaces/default/intents/<YYMMDD>-<label>/.aidlc-engine/reviews/infrastructure-design/units/<unit>/briefs/<sha256>.md
    expect(UNIT_RECORD_DEPTH).toBe(186);
    const named = deepFolder(folder, "win32", ["u2-billing", "u1-order-management"]);
    expect(named?.adds).toBe(UNIT_RECORD_DEPTH + "u1-order-management".length);
    expect(named?.facts).toBe(`70 ${SAID} ${UNIT_RECORD_DEPTH + 19}`);
    expect(named?.adds).toBeGreaterThan(RECORD_DEPTH);
    // 70 + 1 + 186 + 3 is 260, not over it.
    expect(deepFolder(folder, "win32", ["api"])).toBeNull();
    expect(deepFolder(folder, "win32", ["apis"])?.depth).toBe(70);
  });

  test("on Linux and macOS the names change nothing", async () => {
    const { deepFolder } = await import(HELPER);
    expect(deepFolder(`/home/${"u".repeat(200)}`, "linux", ["u1-order-management"])).toBeNull();
    expect(deepFolder(`/Users/${"u".repeat(200)}`, "darwin", ["u1-order-management"])).toBeNull();
  });

  test("the per-Unit review paths the engine builds stay within the number", async () => {
    const { UNIT_RECORD_DEPTH } = await import(HELPER);
    const lib = await import("../../core/tools/aidlc-lib.ts");
    const record = `aidlc/spaces/default/intents/${lib.intentDirNameBase("w".repeat(64))}`;
    const unit = "u1-order-management";
    const attempt = lib.reviewAttemptId("");
    for (const slug of ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"]) {
      const paths = [
        lib.reviewDraftRelativePath(slug, unit, attempt, 1, `review:${"0".repeat(32)}`),
        lib.reviewRecordRelativePath(slug, unit, attempt, 1),
        `${lib.REVIEW_RECORDS_DIR}/${slug}/units/${unit}/briefs/${"0".repeat(64)}.md`,
      ];
      for (const path of paths) {
        expect(`${record}/${path}`.length, path).toBeLessThanOrEqual(UNIT_RECORD_DEPTH + unit.length);
      }
    }
  });
});

function row(marker: " " | "-" | "x", slug: string): string {
  return `- [${marker}] ${slug} ${SEP} EXECUTE`;
}

const STATE = `# AI-DLC State Tracking

## Project Information
- **Project**: deep folder at the Units Generation gate
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Unit Ownership**: solo

## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Review Override**: none

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
- **Summary Confirmation**: off (set by you)

## Stage Progress

### INCEPTION PHASE
${row("x", "domain-design")}
${row("-", STAGE)}

### CONSTRUCTION PHASE
${row(" ", "functional-design")}
${row(" ", "nfr-requirements")}
${row(" ", "nfr-design")}
${row(" ", "infrastructure-design")}
${row(" ", "code-generation")}
${row(" ", "build-and-test")}

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: ${STAGE}
- **Status**: Running
`;

// A project at Units Generation in a folder about 70 characters deep, its
// units block naming `units`.
function project(units: (depth: number) => string[]): { proj: string; units: string[] } {
  const base = mkdtempSync(join(tmpdir(), "dg-"));
  made.push(base);
  // createTestProject adds `/aidlc-test-XXXXXX` (18) under TMPDIR.
  const room = 70 - 18 - base.length - 1;
  const parent = room > 0 ? join(base, "g".repeat(room)) : base;
  mkdirSync(parent, { recursive: true });
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = parent;
  let proj: string;
  try {
    proj = createTestProject();
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
  made.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), STATE);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, proj);
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  const names = units(proj.length);
  writeFileSync(join(dir, "unit-of-work.md"), `# Units of Work\n\n| Unit ID | Directory | Name |\n|---|---|---|\n${
    names.map((name, i) => `| U${i + 1} | ${name} | ${name} |`).join("\n")
  }\n`);
  writeFileSync(join(dir, "unit-of-work-story-map.md"), "# Story Map\n\n| Item | Unit ID |\n|---|---|\n| FR1 | U1 |\n");
  writeFileSync(join(dir, "traceability.json"), "{}\n");
  writeFileSync(join(dir, "unit-of-work-dependency.md"), `# Unit Dependencies\n\n\`\`\`yaml\nunits:\n${
    names.map((name, i) => `  - name: ${name}\n    depends_on: [${i > 0 ? names[i - 1] : ""}]`).join("\n")
  }\n\`\`\`\n`);
  return { proj, units: names };
}

function openGate(proj: string): Record<string, unknown> {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const r = spawnSync(BUN, [ORCH, "report", "--stage", STAGE, "--result", "awaiting-approval", "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const line = out.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  expect(line, out).toBeDefined();
  return JSON.parse(line ?? "{}") as Record<string, unknown>;
}

const times = (text: string, part: string): number => text.split(part).length - 1;

describe("the Units Generation gate", () => {
  test("Unit names that make the folder too deep: the gate says it once, and not again when it is shown again", async () => {
    const { UNIT_RECORD_DEPTH } = await import(HELPER);
    // A name long enough to pass 260 from this folder, and config's own threshold not met.
    const { proj, units } = project((depth) => {
      const length = Math.min(64, Math.max(4, 260 - depth - UNIT_RECORD_DEPTH));
      return ["u2-billing", `u1-${"o".repeat(length - 3)}`];
    });
    expect(proj.length + 1 + 185, proj).toBeLessThanOrEqual(260);
    const longest = Math.max(...units.map((name) => name.length));
    const opened = openGate(proj);
    console.log(`gate in a ${proj.length}-character folder:\n${JSON.stringify(opened, null, 2)}`);
    expect(opened.kind, JSON.stringify(opened)).toBe("print");
    const narration = String(opened.narration ?? "");
    expect(times(narration, SAID), narration).toBe(WINDOWS ? 1 : 0);
    expect(JSON.stringify(opened).split(SAID).length - 1).toBe(WINDOWS ? 1 : 0);
    if (WINDOWS) {
      expect(narration).toContain(
        `This project folder is ${proj.length} ${SAID} ${UNIT_RECORD_DEPTH + longest}, so move the project`,
      );
    }
    const again = openGate(proj);
    expect(JSON.stringify(again)).not.toContain(SAID);
  });

  test("short Unit names: the gate says nothing about the folder", async () => {
    const { UNIT_RECORD_DEPTH } = await import(HELPER);
    const { proj } = project((depth) => {
      const length = Math.max(1, 260 - depth - 1 - UNIT_RECORD_DEPTH);
      return ["a".repeat(length)];
    });
    // Short enough that the longest name lands the deepest record at 260, not over it.
    expect(proj.length, proj).toBeLessThanOrEqual(260 - 1 - UNIT_RECORD_DEPTH - 1);
    const opened = openGate(proj);
    expect(opened.kind, JSON.stringify(opened)).toBe("print");
    expect(JSON.stringify(opened)).not.toContain(SAID);
  });
});
