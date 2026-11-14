// covers: stage:construction/functional-design, stage:construction/code-generation, stage:construction/build-and-test
//
// A Unit's Functional Design or Code Generation table can mark a criterion
// `N/A` with a reason such as `delivered by u2-profile`. Nothing checked that
// hand-off: the named Unit might not be on the story's row in the story map, so
// it was never asked for the criterion, and Build and Test's rollup settled an
// ID nothing builds because every row that listed it was `N/A` with a reason.
// An `N/A` whose reason names another Unit of the plan is now a hand-off: that
// Unit must be on the ID's row, and the rollup counts the ID as built only when
// some Unit built it.
// Runs the built sensor.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createTestProject, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SENSOR = join(AIDLC_SRC, "tools", "aidlc-sensor-traceability.ts");
const projects: string[] = [];
afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop()!);
});

interface SensorResult {
  pass: boolean;
  invalid_targets: string[];
  findings_count: number;
  reason?: string;
}

interface Final {
  pass: boolean;
  uncovered: string[];
  reason?: string;
  coverage: Array<{ id: string; covered: boolean; handed_off?: string[]; not_applicable?: string[]; built_in?: string[] }>;
}

interface Row {
  id: string;
  status: string;
  target?: string;
}

function write(proj: string, relative: string, content: string): string {
  const path = join(seededRecordDir(proj), ...relative.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function table(proj: string, unit: string, stage: string, rows: Row[]): string {
  return write(proj, `construction/${unit}/${stage}/traceability.json`, `${JSON.stringify({
    stage,
    unit,
    upstream_ids: rows.map((row) => row.id),
    coverage: rows,
  }, null, 2)}\n`);
}

interface Plan {
  // Cell of the story map's row for US1.1 (or FR1 without stories).
  row: string;
  stories?: boolean;
}

// Two Units, u1-ledger and u2-profile. The item u1-ledger owns sits on `row`.
function project(plan: Plan): string {
  const proj = createTestProject();
  projects.push(proj);
  mkdirSync(join(seededStateFile(proj), ".."), { recursive: true });
  writeFileSync(seededStateFile(proj), "# State\n");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "ledger.ts"), "export const ledger = true;\n");
  writeFileSync(join(proj, "src", "profile.ts"), "export const profile = true;\n");
  const withStories = plan.stories !== false;
  // Prose with no requirement IDs: the rollup then reports criteria only.
  write(proj, "inception/requirements-analysis/requirements.md", withStories
    ? "# Requirements\n\nPost entries and edit a profile.\n"
    : "# Requirements\n\n- FR1 Post an entry\n- FR2 Edit a profile\n");
  if (withStories) {
    write(proj, "inception/user-stories/stories.md", [
      "# Stories",
      "",
      "## US1.1 Post an entry",
      "- AC1.1.1 the entry is saved once",
      "- AC1.1.2 the owner is shown",
      "",
      "## US1.2 Edit a profile",
      "- AC1.2.1 the new name is shown",
    ].join("\n"));
    // User Stories' own table: no requirement IDs to trace, so the rollup reports criteria only.
    write(proj, "inception/user-stories/traceability.json", `${JSON.stringify({ stage: "user-stories", upstream_ids: [], coverage: [] })}\n`);
  }
  write(proj, "inception/units-generation/unit-of-work.md", [
    "# Units",
    "",
    "| Unit ID | Directory | Purpose |",
    "|---|---|---|",
    "| U1 | u1-ledger | Ledger |",
    "| U2 | u2-profile | Profiles |",
  ].join("\n"));
  write(proj, "inception/units-generation/unit-of-work-dependency.md", [
    "# Dependencies",
    "",
    "```yaml",
    "units:",
    "  - name: u1-ledger",
    "    kind: service",
    "    depends_on: []",
    "  - name: u2-profile",
    "    kind: service",
    "    depends_on: [u1-ledger]",
    "```",
  ].join("\n"));
  const first = withStories ? "US1.1" : "FR1";
  const second = withStories ? "US1.2" : "FR2";
  write(proj, "inception/units-generation/unit-of-work-story-map.md", [
    "# Story Map",
    "",
    "| Item | Unit ID | Directory |",
    "|---|---|---|",
    `| ${first} | ${plan.row} |`,
    `| ${second} | U2 | u2-profile |`,
  ].join("\n"));
  write(proj, "construction/u1-ledger/functional-design/rules.md", "# Rules\n\n- BR1.1 an entry is posted once\n");
  return proj;
}

// A plan whose US1.1/FR1 row names the Units in `cells` as `U1 | u1-ledger`.
const ROW_LEDGER = "U1 | u1-ledger";
const ROW_BOTH = "U1; U2 | u1-ledger; u2-profile";

function run(proj: string, stage: string, file: string): SensorResult {
  const spawned = spawnSync("bun", [SENSOR, "--stage", stage, "--output-path", file], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: proj,
    env: { ...process.env, AIDLC_PROJECT_DIR: proj },
  });
  const stdout = spawned.stdout ?? "";
  expect(stdout.trim().split(/\r?\n/)).toHaveLength(1);
  return JSON.parse(stdout) as SensorResult;
}

function final(proj: string): Final {
  const spawned = spawnSync("bun", [SENSOR, "--stage", "build-and-test"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: proj,
    env: { ...process.env, AIDLC_PROJECT_DIR: proj },
  });
  return JSON.parse(spawned.stdout ?? "") as Final;
}

const DESIGN_OK: Row[] = [
  { id: "AC1.1.1", status: "OK", target: "BR1.1" },
];
const designTable = (proj: string, reason: string): string =>
  table(proj, "u1-ledger", "functional-design", [...DESIGN_OK, { id: "AC1.1.2", status: "N/A", target: reason }]);
const codeTable = (proj: string, reason: string): string =>
  table(proj, "u1-ledger", "code-generation", [
    { id: "AC1.1.1", status: "OK", target: "src/ledger.ts" },
    { id: "AC1.1.2", status: "N/A", target: reason },
    { id: "BR1.1", status: "OK", target: "src/ledger.ts" },
  ]);

describe("Functional Design: an N/A that hands a criterion to another Unit", () => {
  test("fails when the named Unit is not on the story's row", () => {
    const proj = project({ row: ROW_LEDGER });
    const result = run(proj, "functional-design", designTable(proj, "delivered by u2-profile"));
    expect(result.pass).toBe(false);
    expect(result.invalid_targets).toHaveLength(1);
    const finding = result.invalid_targets[0];
    expect(finding.startsWith("AC1.1.2: ")).toBe(true);
    expect(finding).toContain("u2-profile");
    expect(finding).toContain("US1.1");
    expect(finding).toContain("unit-of-work-story-map.md");
  });

  test("passes when the named Unit is on the row", () => {
    const proj = project({ row: ROW_BOTH });
    const result = run(proj, "functional-design", designTable(proj, "delivered by u2-profile"));
    expect(result.invalid_targets).toEqual([]);
    expect(result.pass, result.reason).toBe(true);
  });

  test("a U{n} ID names the Unit, and so does a name inside punctuation", () => {
    for (const reason of ["handled by U2", "(u2-profile, u3-reports)", "see: u2-profile."]) {
      const proj = project({ row: ROW_LEDGER });
      const result = run(proj, "functional-design", designTable(proj, reason));
      expect(result.invalid_targets, reason).toHaveLength(1);
      expect(result.invalid_targets[0], reason).toContain("u2-profile");
    }
  });

  test("a name that only contains another Unit's name does not name it", () => {
    const proj = project({ row: ROW_LEDGER });
    const result = run(proj, "functional-design", designTable(proj, "left to u2-profiles-old"));
    expect(result.invalid_targets).toEqual([]);
    expect(result.pass, result.reason).toBe(true);
  });

  test("a reason that names no Unit is not a hand-off", () => {
    const proj = project({ row: ROW_LEDGER });
    const result = run(proj, "functional-design", designTable(proj, "not offered in this release"));
    expect(result.invalid_targets).toEqual([]);
    expect(result.pass, result.reason).toBe(true);
  });

  test("a reason that names only the Unit itself is not a hand-off", () => {
    const proj = project({ row: ROW_LEDGER });
    const result = run(proj, "functional-design", designTable(proj, "already done in u1-ledger (U1)"));
    expect(result.invalid_targets).toEqual([]);
    expect(result.pass, result.reason).toBe(true);
  });

  test("without stories the same check reads the requirement's row", () => {
    const proj = project({ row: ROW_LEDGER, stories: false });
    const file = table(proj, "u1-ledger", "functional-design", [{ id: "FR1", status: "N/A", target: "delivered by u2-profile" }]);
    const result = run(proj, "functional-design", file);
    expect(result.invalid_targets).toHaveLength(1);
    expect(result.invalid_targets[0].startsWith("FR1: ")).toBe(true);
    expect(result.invalid_targets[0]).toContain("u2-profile");

    const both = project({ row: ROW_BOTH, stories: false });
    const ok = table(both, "u1-ledger", "functional-design", [{ id: "FR1", status: "N/A", target: "delivered by u2-profile" }]);
    expect(run(both, "functional-design", ok).invalid_targets).toEqual([]);
  });
});

describe("Code Generation: an N/A that hands a criterion to another Unit", () => {
  test("fails when the named Unit is not on the story's row", () => {
    const proj = project({ row: ROW_LEDGER });
    const result = run(proj, "code-generation", codeTable(proj, "delivered by u2-profile"));
    expect(result.pass).toBe(false);
    expect(result.invalid_targets).toHaveLength(1);
    expect(result.invalid_targets[0].startsWith("AC1.1.2: ")).toBe(true);
    expect(result.invalid_targets[0]).toContain("u2-profile");
    expect(result.invalid_targets[0]).toContain("US1.1");
  });

  test("passes when the named Unit is on the row, and when no Unit is named", () => {
    const both = project({ row: ROW_BOTH });
    expect(run(both, "code-generation", codeTable(both, "delivered by u2-profile")).invalid_targets).toEqual([]);
    const plain = project({ row: ROW_LEDGER });
    const result = run(plain, "code-generation", codeTable(plain, "not offered in this release"));
    expect(result.invalid_targets).toEqual([]);
    expect(result.pass, result.reason).toBe(true);
  });
});

// The rollup: AC1.1.2 is handed by u1-ledger to u2-profile. u2-profile's own
// story (US1.2, AC1.2.1) is built so only the hand-off is in question.
function rollup(proj: string, ledgerReason: string, profile: Row[]): Final {
  table(proj, "u1-ledger", "code-generation", [
    { id: "AC1.1.1", status: "OK", target: "src/ledger.ts" },
    { id: "AC1.1.2", status: "N/A", target: ledgerReason },
  ]);
  table(proj, "u2-profile", "code-generation", [{ id: "AC1.2.1", status: "OK", target: "src/profile.ts" }, ...profile]);
  return final(proj);
}

describe("Build and Test: a criterion handed to another Unit", () => {
  test("is uncovered when the Unit it was handed to did not build it", () => {
    const proj = project({ row: ROW_BOTH });
    const out = rollup(proj, "delivered by u2-profile", []);
    expect(out.pass).toBe(false);
    expect(out.uncovered).toEqual(["AC1.1.2"]);
    const row = out.coverage.find((entry) => entry.id === "AC1.1.2");
    expect(row?.covered).toBe(false);
    expect(row?.handed_off).toEqual(["u1-ledger/code-generation: delivered by u2-profile"]);
  });

  test("is covered when the Unit it was handed to built it", () => {
    const proj = project({ row: ROW_BOTH });
    const out = rollup(proj, "delivered by u2-profile", [{ id: "AC1.1.2", status: "OK", target: "src/profile.ts" }]);
    expect(out.reason).toBeUndefined();
    expect(out.uncovered).toEqual([]);
    expect(out.pass).toBe(true);
    const row = out.coverage.find((entry) => entry.id === "AC1.1.2");
    expect(row?.covered).toBe(true);
    expect(row?.handed_off).toBeUndefined();
  });

  test("a plain N/A that names no Unit settles the criterion, as before", () => {
    const proj = project({ row: ROW_BOTH });
    const out = rollup(proj, "not offered in this release", [{ id: "AC1.1.2", status: "N/A", target: "not offered in this release" }]);
    expect(out.reason).toBeUndefined();
    expect(out.uncovered).toEqual([]);
    expect(out.pass).toBe(true);
    const row = out.coverage.find((entry) => entry.id === "AC1.1.2");
    expect(row?.covered).toBe(true);
    expect(row?.not_applicable).toHaveLength(2);
    expect(row?.handed_off).toBeUndefined();
  });
});
