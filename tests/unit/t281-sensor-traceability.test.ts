// covers: function:artifactFilename

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  artifactFilename,
  parseStageFrontmatter,
  producesArtifactFile,
} from "../../core/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const SCRIPT = join(import.meta.dir, "../../core/tools/aidlc-sensor-traceability.ts");
const STAGES = join(import.meta.dir, "../../core/aidlc-common/stages");
const projects: string[] = [];

interface SensorResult {
  pass: boolean;
  gaps: string[];
  orphans: string[];
  missing_from_table: string[];
  missing_from_upstream_ids: string[];
  invalid_entries: string[];
  invalid_targets: string[];
  findings_count: number;
  reason?: string;
}

function project(): string {
  const proj = createTestProject();
  projects.push(proj);
  mkdirSync(join(seededStateFile(proj), ".."), { recursive: true });
  writeFileSync(seededStateFile(proj), "# State\n");
  return proj;
}

afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop()!);
});

function write(proj: string, relative: string, content: string): string {
  const path = join(seededRecordDir(proj), ...relative.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function trace(
  proj: string,
  relative: string,
  value: unknown,
  raw = false,
): string {
  return write(proj, relative, raw ? String(value) : `${JSON.stringify(value, null, 2)}\n`);
}

function run(
  proj: string,
  stage: string,
  outputPath: string,
  windowsPath = false,
): { status: number | null; result: SensorResult; stdout: string; stderr: string } {
  const argPath = windowsPath ? outputPath.replace(/\//g, "\\") : outputPath;
  const spawned = spawnSync("bun", [SCRIPT, "--stage", stage, "--output-path", argPath], {
    encoding: "utf-8",
    cwd: proj,
    env: { ...process.env, AIDLC_PROJECT_DIR: proj },
  });
  const stdout = spawned.stdout ?? "";
  expect(stdout.trim().split(/\r?\n/)).toHaveLength(1);
  return {
    status: spawned.status,
    result: JSON.parse(stdout) as SensorResult,
    stdout,
    stderr: spawned.stderr ?? "",
  };
}

function seedUserStories(proj: string): void {
  write(proj, "inception/requirements-analysis/requirements.md", [
    "# Requirements",
    "",
    "## Functional",
    "- FR1 Login",
    "- FR2 Recovery",
    "",
    "## Non-functional",
    "- NFR1 Security",
  ].join("\n"));
  write(proj, "inception/user-stories/stories.md", [
    "# Stories",
    "",
    "## US1.1 Login",
    "- AC1.1.1 accepts valid credentials",
    "- AC1.1.2 rejects invalid credentials",
    "",
    "## US1.2 Recovery",
    "- AC1.2.1 sends a reset link",
  ].join("\n"));
}

function seedUnits(proj: string): void {
  write(proj, "inception/units-generation/unit-of-work.md", [
    "# Units",
    "",
    "| Unit ID | Directory | Purpose |",
    "|---|---|---|",
    "| U1 | u1-auth | Authentication |",
    "| U2 | u2-profile | Profiles |",
  ].join("\n"));
  write(proj, "inception/units-generation/unit-of-work-dependency.md", [
    "# Dependencies",
    "",
    "```yaml",
    "units:",
    "  - name: u1-auth",
    "    kind: service",
    "    depends_on: []",
    "  - name: u2-profile",
    "    kind: service",
    "    depends_on: [u1-auth]",
    "```",
  ].join("\n"));
  write(proj, "inception/units-generation/unit-of-work-story-map.md", [
    "# Story Map",
    "",
    "| Story | Unit ID | Directory |",
    "|---|---|---|",
    "| US1.1 | U1 | u1-auth |",
    "| US1.2 | U2 | u2-profile |",
  ].join("\n"));
}

describe("t281 traceability artifact contract", () => {
  test("all emitting stages declare traceability.json as a required artifact", () => {
    const emitting = [
      ["inception", "user-stories"],
      ["inception", "domain-design"],
      ["inception", "units-generation"],
      ["construction", "functional-design"],
      ["construction", "nfr-requirements"],
      ["construction", "nfr-design"],
      ["construction", "infrastructure-design"],
      ["construction", "code-generation"],
    ];
    expect(artifactFilename("traceability")).toBe("traceability.json");
    expect(
      producesArtifactFile(
        { slug: "user-stories", produces: ["traceability"] },
        "/project/record/inception/user-stories/traceability.json",
        new Set(),
      ),
    ).toBe(true);
    expect(
      producesArtifactFile(
        { slug: "user-stories", produces: ["traceability"] },
        "/project/record/inception/user-stories/traceability.md",
        new Set(),
      ),
    ).toBe(false);
    for (const [phase, slug] of emitting) {
      const source = readFileSync(join(STAGES, phase, `${slug}.md`), "utf-8");
      expect(source.length).toBeGreaterThan(0);
      const frontmatter = parseStageFrontmatter(source);
      expect(frontmatter.produces).toContain("traceability");
      expect(frontmatter.sensors).toContain("traceability");
      expect(frontmatter.outputs).toContain("traceability.json");
    }
  });
});

describe("t281 runtime schema and status validation", () => {
  test("clean user-stories JSON passes with exactly one stdout JSON line", () => {
    const proj = project();
    seedUserStories(proj);
    const file = trace(proj, "inception/user-stories/traceability.json", {
      stage: "user-stories",
      upstream_ids: ["FR1", "FR2", "NFR1"],
      coverage: [
        { id: "FR1", status: "OK", target: "US1.1" },
        { id: "FR2", status: "OK", target: "US1.2" },
        { id: "NFR1", status: "Deferred", target: "nfr-requirements" },
      ],
    });
    const out = run(proj, "user-stories", file);
    expect(out.status).toBe(0);
    expect(out.result.pass).toBe(true);
    expect(out.result.findings_count).toBe(0);
  });

  test("malformed JSON and wrong-shaped entries fail without crashing", () => {
    const proj = project();
    const malformed = trace(proj, "inception/user-stories/traceability.json", "{nope", true);
    let out = run(proj, "user-stories", malformed);
    expect(out.status).toBe(0);
    expect(out.result.pass).toBe(false);
    expect(out.result.reason).toContain("invalid JSON");

    const wrong = trace(proj, "inception/user-stories/traceability.json", {
      upstream_ids: ["FR1"],
      coverage: [null],
    });
    out = run(proj, "user-stories", wrong);
    expect(out.status).toBe(0);
    expect(out.result.pass).toBe(false);
    expect(out.result.reason).toContain("coverage[0]");
  });

  test("unknown statuses, reverse GAP, and OK without target are findings", () => {
    const proj = project();
    seedUserStories(proj);
    const file = trace(proj, "inception/user-stories/traceability.json", {
      upstream_ids: ["FR1", "FR2", "NFR1"],
      coverage: [
        { id: "FR1", status: "Covered", target: "US1.1" },
        { id: "FR2", status: "OK" },
        { id: "NFR1", status: "Deferred", target: "nfr-requirements" },
      ],
      reverse: [{ id: "US9.9", status: "GAP" }],
    });
    const out = run(proj, "user-stories", file);
    expect(out.result.pass).toBe(false);
    expect(out.result.invalid_entries.join("\n")).toContain("unknown status");
    expect(out.result.invalid_entries.join("\n")).toContain("status OK requires");
    expect(out.result.gaps).toContain("US9.9");
  });
});

describe("t281 upstream and target verification", () => {
  test("missing upstream artifacts fail closed for inception stages", () => {
    const proj = project();
    const userStories = trace(proj, "inception/user-stories/traceability.json", {
      upstream_ids: ["FR1"],
      coverage: [{ id: "FR1", status: "OK", target: "US1.1" }],
    });
    let out = run(proj, "user-stories", userStories);
    expect(out.result.pass).toBe(false);
    expect(out.result.reason).toContain("requirements.md");

    const domain = trace(proj, "inception/domain-design/traceability.json", {
      upstream_ids: ["FR1"],
      coverage: [{ id: "FR1", status: "OK", target: "AuthService" }],
    });
    out = run(proj, "domain-design", domain);
    expect(out.result.pass).toBe(false);
    expect(out.result.reason).toContain("requirements.md");
  });

  test("user-stories verifies OK targets against stories.md", () => {
    const proj = project();
    seedUserStories(proj);
    const file = trace(proj, "inception/user-stories/traceability.json", {
      upstream_ids: ["FR1", "FR2", "NFR1"],
      coverage: [
        { id: "FR1", status: "OK", target: "US1.1" },
        { id: "FR2", status: "OK", target: "US9.9" },
        { id: "NFR1", status: "N/A", target: "not user-facing" },
      ],
    });
    const out = run(proj, "user-stories", file);
    expect(out.result.pass).toBe(false);
    expect(out.result.invalid_targets).toContain("FR2: target US9.9 is absent from stories.md");
  });

  test("declared and extracted upstream sets are diffed both ways", () => {
    const proj = project();
    seedUserStories(proj);
    const file = trace(proj, "inception/user-stories/traceability.json", {
      upstream_ids: ["FR1", "NFR1", "FR9"],
      coverage: [
        { id: "FR1", status: "OK", target: "US1.1" },
        { id: "NFR1", status: "Deferred", target: "nfr-requirements" },
      ],
    });
    const out = run(proj, "user-stories", file);
    expect(out.result.missing_from_table).toContain("FR9");
    expect(out.result.missing_from_upstream_ids).toContain("FR2");
  });

  test("units-generation derives Units and verifies every story-map join", () => {
    const proj = project();
    seedUserStories(proj);
    seedUnits(proj);
    const file = trace(proj, "inception/units-generation/traceability.json", {
      stage: "units-generation",
      upstream_ids: ["US1.1", "US1.2"],
      coverage: [
        { id: "US1.1", status: "OK", target: "U1" },
        { id: "US1.2", status: "OK", target: "u2-profile" },
      ],
    });
    let out = run(proj, "units-generation", file);
    expect(out.result.pass).toBe(true);

    write(proj, "inception/units-generation/unit-of-work-story-map.md", [
      "# Story Map",
      "",
      "| Story | Unit ID | Directory |",
      "|---|---|---|",
      "| US1.1 | U1 | u1-auth |",
    ].join("\n"));
    out = run(proj, "units-generation", file);
    expect(out.result.pass).toBe(false);
    expect(out.result.gaps).toContain("US1.2");
  });
});

describe("t281 per-Unit scope, reverse derivation, and code targets", () => {
  test("functional-design joins Windows-style paths through Unit artifacts", () => {
    const proj = project();
    seedUserStories(proj);
    seedUnits(proj);
    write(proj, "construction/u1-auth/functional-design/rules.md", [
      "# Rules",
      "",
      "## Authentication",
      "- BR1.1 Validate credentials",
      "- BR1.2 Rate-limit failures",
    ].join("\n"));
    const file = trace(proj, "construction/u1-auth/functional-design/traceability.json", {
      stage: "functional-design",
      unit: "u1-auth",
      upstream_ids: ["AC1.1.1", "AC1.1.2"],
      coverage: [
        { id: "AC1.1.1", status: "OK", target: "BR1.1" },
        { id: "AC1.1.2", status: "OK", target: "BR1.2" },
      ],
    });
    const out = run(proj, "functional-design", file, true);
    expect(out.status).toBe(0);
    expect(out.result.pass).toBe(true);
  });

  test("functional-design verifies BR targets and derives unexplained orphans", () => {
    const proj = project();
    seedUserStories(proj);
    seedUnits(proj);
    write(proj, "construction/u1-auth/functional-design/rules.md", [
      "# Rules",
      "",
      "## Authentication",
      "- BR1.1 Validate credentials",
      "- BR1.2 Rate-limit failures",
    ].join("\n"));
    const file = trace(proj, "construction/u1-auth/functional-design/traceability.json", {
      upstream_ids: ["AC1.1.1", "AC1.1.2"],
      coverage: [
        { id: "AC1.1.1", status: "OK", target: "BR1.1" },
        { id: "AC1.1.2", status: "OK", target: "BR9.9" },
      ],
    });
    const out = run(proj, "functional-design", file);
    expect(out.result.pass).toBe(false);
    expect(out.result.invalid_targets).toContain("AC1.1.2: target BR9.9 is absent from rules.md");
    expect(out.result.orphans).toContain("BR1.2");
  });

  test("per-Unit stages fail closed when the scoped upstream set is empty", () => {
    const proj = project();
    seedUserStories(proj);
    seedUnits(proj);
    write(proj, "inception/units-generation/unit-of-work-story-map.md", [
      "# Story Map",
      "",
      "| Story | Unit ID | Directory |",
      "|---|---|---|",
      "| US1.2 | U2 | u2-profile |",
    ].join("\n"));
    write(proj, "construction/u1-auth/functional-design/rules.md", "# Rules\n\n## Auth\n- BR1.1 Rule\n");
    const file = trace(proj, "construction/u1-auth/functional-design/traceability.json", {
      upstream_ids: ["AC1.1.1"],
      coverage: [{ id: "AC1.1.1", status: "OK", target: "BR1.1" }],
    });
    const out = run(proj, "functional-design", file);
    expect(out.result.pass).toBe(false);
    expect(out.result.reason).toContain('no stories in unit-of-work-story-map.md map to unit "u1-auth"');
  });

  test("code-generation verifies workspace-relative target files", () => {
    const proj = project();
    seedUserStories(proj);
    seedUnits(proj);
    const source = join(proj, "src", "auth.ts");
    mkdirSync(join(source, ".."), { recursive: true });
    writeFileSync(source, "export const auth = true;\n");
    const file = trace(proj, "construction/u1-auth/code-generation/traceability.json", {
      upstream_ids: ["AC1.1.1", "AC1.1.2"],
      coverage: [
        { id: "AC1.1.1", status: "OK", target: "src/auth.ts" },
        { id: "AC1.1.2", status: "OK", target: "src/missing.ts" },
      ],
    });
    const out = run(proj, "code-generation", file);
    expect(out.result.pass).toBe(false);
    expect(out.result.invalid_targets).toContain("AC1.1.2: target file does not exist: src/missing.ts");
  });

  test("missing file and missing output-path keep the CLI error contract", () => {
    const proj = project();
    let spawned = spawnSync("bun", [SCRIPT, "--stage", "user-stories", "--output-path", join(proj, "missing.json")], {
      encoding: "utf-8",
      cwd: proj,
      env: { ...process.env, AIDLC_PROJECT_DIR: proj },
    });
    expect(spawned.status).toBe(1);
    expect(spawned.stderr).toContain("not found");

    spawned = spawnSync("bun", [SCRIPT, "--stage", "user-stories"], {
      encoding: "utf-8",
      cwd: proj,
      env: { ...process.env, AIDLC_PROJECT_DIR: proj },
    });
    expect(spawned.status).toBe(1);
    expect(spawned.stderr).toContain("--output-path is required");
  });
});
