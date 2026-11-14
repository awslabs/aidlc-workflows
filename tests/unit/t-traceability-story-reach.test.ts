// covers: stage:inception/units-generation
//
// Units Generation's traceability passed as soon as every story had a row
// naming a declared Unit. A story a person uses could sit on a row of `library`
// Units only: Functional Design asks a `library` Unit for rules and entities,
// never for a screen, so nobody was asked who exposes the story, and the plan
// read as complete. With stories.md, a story whose row names no `ui` or
// `service` Unit (and no untagged one) now says how it is reached, on its row
// or once for the whole map: `existing: <where>` (already in the product) or
// `interface` (the caller is a developer or another system).

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
  gaps: string[];
  invalid_targets: string[];
  findings_count: number;
  reason?: string;
}

function write(proj: string, relative: string, content: string): string {
  const path = join(seededRecordDir(proj), ...relative.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

interface Plan {
  // kind per Unit; null leaves the Unit untagged.
  ledger?: string | null;
  profile?: string | null;
  // Lines of unit-of-work-story-map.md after its title.
  map: string[];
  stories?: boolean;
}

// Two Units: a ledger and a profile. US1.1 sits on the ledger's row, US1.2 on
// the profile's, unless the map says otherwise.
function project(plan: Plan): { proj: string; file: string } {
  const proj = createTestProject();
  projects.push(proj);
  mkdirSync(join(seededStateFile(proj), ".."), { recursive: true });
  writeFileSync(seededStateFile(proj), "# State\n");
  write(proj, "inception/requirements-analysis/requirements.md", "# Requirements\n\n- FR1 Post an entry\n- FR2 Edit a profile\n");
  const withStories = plan.stories !== false;
  if (withStories) {
    write(proj, "inception/user-stories/stories.md", [
      "# Stories",
      "",
      "## US1.1 Post an entry",
      "- AC1.1.1 the entry is saved once",
      "",
      "## US1.2 Edit a profile",
      "- AC1.2.1 the new name is shown",
    ].join("\n"));
  }
  write(proj, "inception/units-generation/unit-of-work.md", [
    "# Units",
    "",
    "| Unit ID | Directory | Purpose |",
    "|---|---|---|",
    "| U1 | u1-ledger | Ledger |",
    "| U2 | u2-profile | Profiles |",
  ].join("\n"));
  const kind = (value: string | null | undefined, fallback: string): string[] => {
    const resolved = value === undefined ? fallback : value;
    return resolved === null ? [] : [`    kind: ${resolved}`];
  };
  write(proj, "inception/units-generation/unit-of-work-dependency.md", [
    "# Dependencies",
    "",
    "```yaml",
    "units:",
    "  - name: u1-ledger",
    ...kind(plan.ledger, "service"),
    "    depends_on: []",
    "  - name: u2-profile",
    ...kind(plan.profile, "library"),
    "    depends_on: [u1-ledger]",
    "```",
  ].join("\n"));
  write(proj, "inception/units-generation/unit-of-work-story-map.md", ["# Story Map", "", ...plan.map].join("\n"));
  const ids = withStories ? ["US1.1", "US1.2"] : ["FR1", "FR2"];
  const file = write(proj, "inception/units-generation/traceability.json", `${JSON.stringify({
    stage: "units-generation",
    upstream_ids: ids,
    coverage: [
      { id: ids[0], status: "OK", target: "U1" },
      { id: ids[1], status: "OK", target: "U2" },
    ],
  }, null, 2)}\n`);
  return { proj, file };
}

function run(proj: string, file: string): SensorResult {
  const spawned = spawnSync("bun", [SENSOR, "--stage", "units-generation", "--output-path", file], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: proj,
    env: { ...process.env, AIDLC_PROJECT_DIR: proj },
  });
  const stdout = spawned.stdout ?? "";
  expect(stdout.trim().split(/\r?\n/)).toHaveLength(1);
  return JSON.parse(stdout) as SensorResult;
}

const PLAIN_MAP = [
  "| Story | Unit ID | Directory |",
  "|---|---|---|",
  "| US1.1 | U1 | u1-ledger |",
  "| US1.2 | U2 | u2-profile |",
];

describe("Units Generation: a story says how it is reached", () => {
  test("a story on a row of library Units only is named, with the three ways to answer", () => {
    const { proj, file } = project({ map: PLAIN_MAP });
    const result = run(proj, file);
    expect(result.pass).toBe(false);
    expect(result.gaps).toEqual([]);
    expect(result.invalid_targets).toHaveLength(1);
    const finding = result.invalid_targets[0];
    expect(finding.startsWith("US1.2: ")).toBe(true);
    expect(finding).toContain("u2-profile (library)");
    expect(finding).toContain("ui or service Unit");
    expect(finding).toContain("existing: <where>");
    expect(finding).toContain("interface");
  });

  test("spec and packaging Units do not expose a story either", () => {
    for (const kind of ["spec", "packaging"]) {
      const { proj, file } = project({ profile: kind, map: PLAIN_MAP });
      const result = run(proj, file);
      expect(result.pass).toBe(false);
      expect(result.invalid_targets[0]).toContain(`u2-profile (${kind})`);
    }
  });

  test("a ui or service Unit on the row answers it", () => {
    for (const kind of ["ui", "service"]) {
      const { proj, file } = project({ profile: kind, map: PLAIN_MAP });
      expect(run(proj, file).pass).toBe(true);
    }
    const shared = project({
      map: [
        "| Story | Unit ID | Directory |",
        "|---|---|---|",
        "| US1.1 | U1 | u1-ledger |",
        "| US1.2 | U2; U1 | u2-profile; u1-ledger |",
      ],
    });
    expect(run(shared.proj, shared.file).pass).toBe(true);
  });

  test("an untagged Unit counts, as it owes every design document", () => {
    const { proj, file } = project({ profile: null, map: PLAIN_MAP });
    expect(run(proj, file).pass).toBe(true);
  });

  test("the row may say the story is reached through what the product already has", () => {
    const { proj, file } = project({
      map: [
        "| Story | Unit ID | Directory | Reached through |",
        "|---|---|---|---|",
        "| US1.1 | U1 | u1-ledger | |",
        "| US1.2 | U2 | u2-profile | existing: the profile page |",
      ],
    });
    expect(run(proj, file).pass).toBe(true);
  });

  test("a cell that only starts with the word is not an answer", () => {
    const { proj, file } = project({
      map: [
        "| Story | Unit ID | Directory | Title |",
        "|---|---|---|---|",
        "| US1.1 | U1 | u1-ledger | Post an entry |",
        "| US1.2 | U2 | u2-profile | Existing members edit a profile |",
      ],
    });
    const result = run(proj, file);
    expect(result.pass).toBe(false);
    expect(result.invalid_targets[0]).toContain("no Unit on its row exposes it");
  });

  test("existing with no place is refused", () => {
    const { proj, file } = project({
      map: [
        "| Story | Unit ID | Directory | Reached through |",
        "|---|---|---|---|",
        "| US1.1 | U1 | u1-ledger | |",
        "| US1.2 | U2 | u2-profile | existing |",
      ],
    });
    const result = run(proj, file);
    expect(result.pass).toBe(false);
    expect(result.invalid_targets).toHaveLength(1);
    expect(result.invalid_targets[0]).toContain("US1.2");
    expect(result.invalid_targets[0]).toContain("existing: <where>");
  });

  test("the row may say the caller is a developer or another system", () => {
    const { proj, file } = project({
      map: [
        "| Story | Unit ID | Directory | Reached through |",
        "|---|---|---|---|",
        "| US1.1 | U1 | u1-ledger | |",
        "| US1.2 | U2 | u2-profile | `interface` |",
      ],
    });
    expect(run(proj, file).pass).toBe(true);
  });

  test("one line answers for a plan of library Units only, and a row's own answer still wins", () => {
    const allLibrary = project({ ledger: "library", map: [...PLAIN_MAP, "", "**Reached through:** interface"] });
    expect(run(allLibrary.proj, allLibrary.file).pass).toBe(true);

    const none = project({ ledger: "library", map: PLAIN_MAP });
    const unanswered = run(none.proj, none.file);
    expect(unanswered.pass).toBe(false);
    expect(unanswered.invalid_targets.map((finding) => finding.split(":")[0])).toEqual(["US1.1", "US1.2"]);

    const bugFix = project({
      ledger: "library",
      map: [
        "Reached through: existing: the screens this fix sits behind",
        "",
        "| Story | Unit ID | Directory | Reached through |",
        "|---|---|---|---|",
        "| US1.1 | U1 | u1-ledger | |",
        "| US1.2 | U2 | u2-profile | existing |",
      ],
    });
    const result = run(bugFix.proj, bugFix.file);
    expect(result.pass).toBe(false);
    expect(result.invalid_targets).toHaveLength(1);
    expect(result.invalid_targets[0]).toContain("US1.2");
  });

  test("without stories.md the rows are requirements and nothing is asked", () => {
    const { proj, file } = project({
      ledger: "library",
      stories: false,
      map: [
        "| Requirement | Unit ID | Directory |",
        "|---|---|---|",
        "| FR1 | U1 | u1-ledger |",
        "| FR2 | U2 | u2-profile |",
      ],
    });
    expect(run(proj, file).pass).toBe(true);
  });
});
