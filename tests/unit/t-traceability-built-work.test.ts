// covers: stage:inception/units-generation
//
// Units Generation can run again after Construction began. Its traceability only
// checked that each story had a row naming a declared Unit, so a story whose row
// named only Units that are already finished read as covered, even when those
// Units never built it (they marked the criterion `N/A`, the criterion came
// after they finished, or the story reached their row only now). A finished Unit
// is not worked again, so nobody would build it. With stories.md and at least
// one finished Unit, a story whose row names only finished Units must have every
// criterion built (an `OK` row with an existing file) in one of them. The same
// list is printed by `--stage units-generation --built`.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createTestProject, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SENSOR = join(AIDLC_SRC, "tools", "aidlc-sensor-traceability.ts");
const projects: string[] = [];
afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop()!);
});

interface SensorResult {
  pass: boolean;
  gaps: string[];
  invalid_targets: string[];
  findings_count: number;
  reason?: string;
}

interface BuiltList {
  finished_units: string[];
  started_units: string[];
  unbuilt: Array<{ story: string; units: string[]; criteria: string[] }>;
}

interface Row {
  owner?: string;
  // The five stage cells, then the gate cell.
  cells: string[];
  merged?: "[x]" | "[ ]";
}

type Cell = { id: string; status: string; target?: string };

interface Plan {
  // Rows of the Unit Progress table; none leaves the table out.
  progress?: Record<string, Row>;
  // The `merged` column is written (a team main that has landed a Unit).
  mergedColumn?: boolean;
  // Lines of unit-of-work-story-map.md after its title.
  map: string[];
  // Each Unit's Code Generation table, as rows; a Unit left out has none.
  tables?: Record<string, Cell[]>;
  // Files the workspace has.
  files?: string[];
}

const STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
const DONE = ["[x]", "[x]", "[x]", "[x]", "[x]", "[x]"];
const FRESH = ["[ ]", "[ ]", "[ ]", "[ ]", "[ ]", "[ ]"];

function write(proj: string, relative: string, content: string): string {
  const path = join(seededRecordDir(proj), ...relative.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function stateBody(plan: Plan): string {
  const lines = ["# State", ""];
  if (plan.progress) {
    const merged = plan.mergedColumn === true;
    lines.push(
      "## Unit Progress",
      `| unit | owner | ${STAGES.join(" | ")} | gate |${merged ? " merged |" : ""}`,
      `| --- | --- | ${STAGES.map(() => "---").join(" | ")} | --- |${merged ? " --- |" : ""}`,
    );
    for (const [unit, row] of Object.entries(plan.progress)) {
      lines.push(`| ${unit} | ${row.owner ?? "-"} | ${row.cells.join(" | ")} |${merged ? ` ${row.merged ?? "[ ]"} |` : ""}`);
    }
    lines.push("");
  }
  lines.push("## Current Status", "- **Current Stage**: units-generation", "");
  return lines.join("\n");
}

// Three Units: a ledger, a profile and reports. US1.1 (two criteria) is on the
// ledger's row, US1.2 (two criteria) on the profile's, unless the map says
// otherwise. Every Unit is a `service`, so no story is left unreached.
function project(plan: Plan): { proj: string; file: string } {
  const proj = createTestProject();
  projects.push(proj);
  mkdirSync(dirname(seededStateFile(proj)), { recursive: true });
  writeFileSync(seededStateFile(proj), stateBody(plan));
  write(proj, "inception/requirements-analysis/requirements.md", "# Requirements\n\n- FR1 Post an entry\n- FR2 Edit a profile\n");
  write(proj, "inception/user-stories/stories.md", [
    "# Stories",
    "",
    "## US1.1 Post an entry",
    "- AC1.1.1 the entry is saved once",
    "- AC1.1.2 the entry shows its date",
    "",
    "## US1.2 Edit a profile",
    "- AC1.2.1 the new name is shown",
    "- AC1.2.2 the old name is kept in history",
  ].join("\n"));
  write(proj, "inception/units-generation/unit-of-work.md", [
    "# Units",
    "",
    "| Unit ID | Directory | Purpose |",
    "|---|---|---|",
    "| U1 | u1-ledger | Ledger |",
    "| U2 | u2-profile | Profiles |",
    "| U3 | u3-reports | Reports |",
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
    "  - name: u3-reports",
    "    kind: service",
    "    depends_on: [u1-ledger]",
    "```",
  ].join("\n"));
  write(proj, "inception/units-generation/unit-of-work-story-map.md", ["# Story Map", "", ...plan.map].join("\n"));
  for (const [unit, coverage] of Object.entries(plan.tables ?? {})) {
    write(proj, `construction/${unit}/code-generation/traceability.json`, `${JSON.stringify({
      stage: "code-generation",
      unit,
      upstream_ids: coverage.map((entry) => entry.id),
      coverage,
    }, null, 2)}\n`);
  }
  for (const relative of plan.files ?? []) {
    const path = join(proj, ...relative.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "export {};\n");
  }
  const file = write(proj, "inception/units-generation/traceability.json", `${JSON.stringify({
    stage: "units-generation",
    upstream_ids: ["US1.1", "US1.2"],
    coverage: [
      { id: "US1.1", status: "OK", target: "U1" },
      { id: "US1.2", status: "OK", target: "U2" },
    ],
  }, null, 2)}\n`);
  return { proj, file };
}

function sensor(proj: string, args: string[]): string {
  const spawned = spawnSync("bun", [SENSOR, "--stage", "units-generation", ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: proj,
    env: { ...process.env, AIDLC_PROJECT_DIR: proj },
  });
  const stdout = spawned.stdout ?? "";
  expect(stdout.trim().split(/\r?\n/), spawned.stderr).toHaveLength(1);
  return stdout;
}

function run(proj: string, file: string): SensorResult {
  return JSON.parse(sensor(proj, ["--output-path", file])) as SensorResult;
}

function built(proj: string): BuiltList {
  return JSON.parse(sensor(proj, ["--built"])) as BuiltList;
}

const PLAIN_MAP = [
  "| Story | Unit ID | Directory |",
  "|---|---|---|",
  "| US1.1 | U1 | u1-ledger |",
  "| US1.2 | U2 | u2-profile |",
];

const LEDGER_DONE: Cell[] = [
  { id: "AC1.1.1", status: "OK", target: "src/ledger.ts" },
  { id: "AC1.1.2", status: "OK", target: "src/ledger.ts" },
];
const PROFILE_DONE: Cell[] = [
  { id: "AC1.2.1", status: "OK", target: "src/profile.ts" },
  { id: "AC1.2.2", status: "OK", target: "src/profile.ts" },
];
const FILES = ["src/ledger.ts", "src/profile.ts"];

// u1-ledger and u2-profile have landed; u3-reports has not started.
const LANDED = {
  "u1-ledger": { cells: DONE, merged: "[x]" },
  "u2-profile": { cells: DONE, merged: "[x]" },
  "u3-reports": { cells: FRESH, merged: "[ ]" },
} satisfies Record<string, Row>;

function landed(extra: Partial<Plan> = {}): Plan {
  return {
    progress: LANDED,
    mergedColumn: true,
    map: PLAIN_MAP,
    tables: { "u1-ledger": LEDGER_DONE, "u2-profile": PROFILE_DONE },
    files: FILES,
    ...extra,
  };
}

describe("Units Generation: a story whose Units are all finished must be built there", () => {
  test("first run: no Unit Progress table says nothing, and --built prints three empty arrays", () => {
    const { proj, file } = project({ map: PLAIN_MAP });
    const result = run(proj, file);
    expect(result.pass, JSON.stringify(result)).toBe(true);
    expect(built(proj)).toEqual({ finished_units: [], started_units: [], unbuilt: [] });
  });

  test("a table with no finished Unit says nothing", () => {
    const { proj, file } = project({
      progress: { "u1-ledger": { cells: FRESH }, "u2-profile": { cells: FRESH } },
      map: PLAIN_MAP,
    });
    expect(run(proj, file).pass).toBe(true);
    expect(built(proj)).toEqual({ finished_units: [], started_units: [], unbuilt: [] });
  });

  test("every criterion OK with an existing file in the finished Units passes", () => {
    const { proj, file } = project(landed());
    const result = run(proj, file);
    expect(result.pass, JSON.stringify(result)).toBe(true);
    expect(built(proj)).toEqual({ finished_units: ["u1-ledger", "u2-profile"], started_units: [], unbuilt: [] });
  });

  test("a criterion the finished Unit marked N/A is named with the story, the Unit and the criterion", () => {
    const { proj, file } = project(landed({
      tables: {
        "u1-ledger": LEDGER_DONE,
        "u2-profile": [PROFILE_DONE[0], { id: "AC1.2.2", status: "N/A", target: "not needed" }],
      },
    }));
    const result = run(proj, file);
    expect(result.pass).toBe(false);
    expect(result.invalid_targets).toHaveLength(1);
    const finding = result.invalid_targets[0];
    expect(finding.startsWith("US1.2: ")).toBe(true);
    expect(finding).toContain("u2-profile");
    expect(finding).toContain("AC1.2.2");
    expect(finding).not.toContain("AC1.2.1");
    expect(finding).toContain("finished");
    expect(finding).toContain("add a Unit that is not finished to the row, or reopen one of them");
  });

  test("a criterion in stories.md that the finished Unit's table does not list is named", () => {
    const { proj, file } = project(landed({ tables: { "u1-ledger": LEDGER_DONE, "u2-profile": [PROFILE_DONE[0]] } }));
    const result = run(proj, file);
    expect(result.invalid_targets).toHaveLength(1);
    expect(result.invalid_targets[0]).toContain("AC1.2.2");
  });

  test("a story put on a finished Unit's row whose table has none of its criteria lists all of them", () => {
    const { proj, file } = project(landed({
      map: [
        "| Story | Unit ID | Directory |",
        "|---|---|---|",
        "| US1.1 | U1 | u1-ledger |",
        "| US1.2 | U1 | u1-ledger |",
      ],
      tables: { "u1-ledger": LEDGER_DONE },
    }));
    // The coverage row still targets U2, which the moved row no longer names:
    // that finding is not this rule's.
    const findings = run(proj, file).invalid_targets.filter((text) => text.includes("is finished"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^US1\.2: .*u1-ledger.*AC1\.2\.1, AC1\.2\.2;/);
  });

  test("an unfinished Unit added to the row of a story with an unbuilt criterion passes", () => {
    const plan = landed({
      tables: {
        "u1-ledger": LEDGER_DONE,
        "u2-profile": [PROFILE_DONE[0], { id: "AC1.2.2", status: "N/A", target: "not needed" }],
      },
      map: [
        "| Story | Unit ID | Directory |",
        "|---|---|---|",
        "| US1.1 | U1 | u1-ledger |",
        "| US1.2 | U2; U3 | u2-profile; u3-reports |",
      ],
    });
    const { proj, file } = project(plan);
    const result = run(proj, file);
    expect(result.pass, JSON.stringify(result)).toBe(true);
    expect(built(proj).unbuilt).toEqual([]);
  });

  test("a criterion built by another finished Unit on the row counts", () => {
    const { proj, file } = project(landed({
      map: [
        "| Story | Unit ID | Directory |",
        "|---|---|---|",
        "| US1.1 | U1 | u1-ledger |",
        "| US1.2 | U1; U2 | u1-ledger; u2-profile |",
      ],
      tables: {
        "u1-ledger": [...LEDGER_DONE, PROFILE_DONE[1]],
        "u2-profile": [PROFILE_DONE[0]],
      },
    }));
    const result = run(proj, file);
    expect(result.pass, JSON.stringify(result)).toBe(true);
  });

  test("an OK row whose file does not exist is not built", () => {
    const { proj, file } = project(landed({ files: ["src/ledger.ts"] }));
    const result = run(proj, file);
    expect(result.pass).toBe(false);
    expect(result.invalid_targets).toHaveLength(1);
    expect(result.invalid_targets[0]).toMatch(/^US1\.2: .*AC1\.2\.1, AC1\.2\.2/);
  });

  test("a landed Unit with skipped design stages counts as finished", () => {
    const skipped = ["[S]", "[S]", "[S]", "[S]", "[x]", "[x]"];
    const { proj, file } = project(landed({
      progress: { ...LANDED, "u1-ledger": { cells: skipped, merged: "[x]" }, "u2-profile": { cells: skipped, merged: "[x]" } },
    }));
    expect(built(proj).finished_units).toEqual(["u1-ledger", "u2-profile"]);
    expect(run(proj, file).pass).toBe(true);

    const unbuilt = project(landed({
      progress: { ...LANDED, "u2-profile": { cells: skipped, merged: "[x]" } },
      tables: { "u1-ledger": LEDGER_DONE },
    }));
    expect(run(unbuilt.proj, unbuilt.file).invalid_targets).toHaveLength(1);
  });

  test("a started but unfinished Unit is listed as started, and its stories raise nothing", () => {
    const { proj, file } = project(landed({
      progress: {
        "u1-ledger": { cells: DONE, merged: "[x]" },
        "u2-profile": { owner: "profile-team", cells: ["[x]", "[x]", "[ ]", "[ ]", "[ ]", "[ ]"], merged: "[ ]" },
        "u3-reports": { cells: FRESH, merged: "[ ]" },
      },
      tables: { "u1-ledger": LEDGER_DONE },
    }));
    const result = run(proj, file);
    expect(result.pass, JSON.stringify(result)).toBe(true);
    expect(built(proj)).toEqual({ finished_units: ["u1-ledger"], started_units: ["u2-profile"], unbuilt: [] });
  });

  test("a Unit with an owner and no stage done is started", () => {
    const { proj } = project(landed({
      progress: { ...LANDED, "u3-reports": { owner: "reports-team", cells: FRESH, merged: "[ ]" } },
    }));
    expect(built(proj).started_units).toEqual(["u3-reports"]);
  });

  test("--built prints the same stories and criteria as the findings", () => {
    const { proj, file } = project(landed({
      map: [
        "| Story | Unit ID | Directory |",
        "|---|---|---|",
        "| US1.1 | U1 | u1-ledger |",
        "| US1.2 | U1; U2 | u1-ledger; u2-profile |",
      ],
      tables: {
        "u1-ledger": [LEDGER_DONE[0]],
        "u2-profile": [{ id: "AC1.2.1", status: "OK", target: "src/profile.ts" }],
      },
    }));
    const list = built(proj);
    expect(list.finished_units).toEqual(["u1-ledger", "u2-profile"]);
    expect(list.unbuilt).toEqual([
      { story: "US1.1", units: ["u1-ledger"], criteria: ["AC1.1.2"] },
      { story: "US1.2", units: ["u1-ledger", "u2-profile"], criteria: ["AC1.2.2"] },
    ]);
    const findings = run(proj, file).invalid_targets;
    expect(findings).toHaveLength(2);
    for (const entry of list.unbuilt) {
      const finding = findings.find((text) => text.startsWith(`${entry.story}: `));
      expect(finding, JSON.stringify(findings)).toBeTruthy();
      for (const unit of entry.units) expect(finding).toContain(unit);
      expect(finding).toContain(entry.criteria.join(", "));
    }
  });

  test("a table without a merged column is read as finished when every stage cell and the gate are done", () => {
    const { proj, file } = project({
      progress: {
        "u1-ledger": { cells: DONE },
        "u2-profile": { cells: ["[x]", "[S]", "[S]", "[S]", "[x]", "[x]"] },
        "u3-reports": { cells: ["[x]", "[x]", "[ ]", "[ ]", "[ ]", "[ ]"] },
      },
      map: PLAIN_MAP,
      tables: { "u1-ledger": LEDGER_DONE, "u2-profile": [PROFILE_DONE[0]] },
      files: FILES,
    });
    expect(built(proj)).toMatchObject({
      finished_units: ["u1-ledger", "u2-profile"],
      started_units: ["u3-reports"],
      unbuilt: [{ story: "US1.2", units: ["u2-profile"], criteria: ["AC1.2.2"] }],
    });
    expect(run(proj, file).invalid_targets).toHaveLength(1);
  });

  test("a table without a merged column and with the gate still open finishes nothing", () => {
    const { proj } = project({
      progress: { "u1-ledger": { cells: ["[x]", "[x]", "[x]", "[x]", "[x]", "[ ]"] } },
      map: PLAIN_MAP,
    });
    expect(built(proj)).toEqual({ finished_units: [], started_units: ["u1-ledger"], unbuilt: [] });
  });

  test("without stories.md the rule says nothing (rows are requirements)", () => {
    const { proj, file } = project(landed({ tables: {} }));
    // The FR-keyed case is not checked against built work.
    rmSync(join(seededRecordDir(proj), "inception", "user-stories", "stories.md"));
    const result = run(proj, file);
    expect(result.invalid_targets.filter((text) => text.includes("is finished"))).toEqual([]);
    expect(built(proj).unbuilt).toEqual([]);
  });
});
