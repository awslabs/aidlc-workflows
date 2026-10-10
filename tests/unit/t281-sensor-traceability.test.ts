// covers: function:artifactFilename

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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

  // The stage guidance names each Unit's construction directory `u{n}-{description}`,
  // while the edge block names the Unit without that prefix (the engine names
  // construction/<unit>/ after the edge block). `U5`, `u5-identity-kyc` and
  // `identity-kyc` are one Unit to the sensor: by ID, by directory, or by name.
  test("U5, u5-identity-kyc and identity-kyc name the same Unit", () => {
    const proj = project();
    write(proj, "inception/requirements-analysis/requirements.md", "# Requirements\n\n- FR1 Identity\n- NFR1 Security\n");
    write(proj, "inception/user-stories/stories.md", [
      "# Stories",
      "",
      "## US1.1 Verify identity",
      "- AC1.1.1 accepts a passport",
      "",
      "## US1.2 Open an account",
      "- AC1.2.1 creates the account",
    ].join("\n"));
    write(proj, "inception/units-generation/unit-of-work.md", [
      "# Units",
      "",
      "| Unit ID | Directory | Kind |",
      "|---|---|---|",
      "| U5 | u5-identity-kyc | service |",
      "| U6 | u6-accounts | service |",
    ].join("\n"));
    write(proj, "inception/units-generation/unit-of-work-dependency.md", [
      "# Dependencies",
      "",
      "```yaml",
      "units:",
      "  - name: identity-kyc",
      "    kind: service",
      "    depends_on: []",
      "  - name: accounts",
      "    kind: service",
      "    depends_on: [identity-kyc]",
      "```",
    ].join("\n"));
    write(proj, "inception/units-generation/unit-of-work-story-map.md", [
      "# Story Map",
      "",
      "| Story | Unit ID | Directory |",
      "|---|---|---|",
      "| US1.1 | U5 | u5-identity-kyc |",
      "| US1.2 | U6 | u6-accounts |",
    ].join("\n"));
    const file = trace(proj, "inception/units-generation/traceability.json", {
      stage: "units-generation",
      upstream_ids: ["US1.1", "US1.2"],
      coverage: [
        { id: "US1.1", status: "OK", target: "U5" },
        { id: "US1.2", status: "OK", target: "u6-accounts" },
      ],
    });
    const units = run(proj, "units-generation", file);
    expect(units.result.invalid_targets).toEqual([]);
    expect(units.result.gaps).toEqual([]);
    expect(units.result.pass, units.result.reason).toBe(true);

    write(proj, "construction/identity-kyc/functional-design/rules.md", "# Rules\n\n- BR1.1 Passport must be valid\n");
    const design = trace(proj, "construction/identity-kyc/functional-design/traceability.json", {
      stage: "functional-design",
      unit: "identity-kyc",
      upstream_ids: ["AC1.1.1"],
      coverage: [{ id: "AC1.1.1", status: "OK", target: "BR1.1" }],
    });
    const out = run(proj, "functional-design", design);
    expect(out.result.pass, out.result.reason).toBe(true);
  });

  // When a scope skips user-stories the source ids fall back from US to FR
  // (stage prose: "otherwise enumerate every FR"), and the story map rows carry
  // FR ids. The assignment parse has to follow the same fallback, or every FR
  // is reported as a phantom gap even though each row maps it to a unit.
  // NFR rows are optional, but must join when present.
  test("units-generation joins FR rows when user-stories is skipped", () => {
    const proj = project();
    write(proj, "inception/requirements-analysis/requirements.md", [
      "# Requirements",
      "",
      "## Functional",
      "- FR1 Login",
      "- FR2 Recovery",
      "",
      "## Non-functional",
      "- NFR1 Latency",
    ].join("\n"));
    seedUnits(proj);
    write(proj, "inception/units-generation/unit-of-work-story-map.md", [
      "# Story Map",
      "",
      "| Requirement | Unit ID | Directory |",
      "|---|---|---|",
      "| FR1 | U1 | u1-auth |",
      "| FR2 | U2 | u2-profile |",
      "| NFR1 | U2 | u2-profile |",
    ].join("\n"));
    const file = trace(proj, "inception/units-generation/traceability.json", {
      stage: "units-generation",
      upstream_ids: ["FR1", "FR2"],
      coverage: [
        { id: "FR1", status: "OK", target: "U1" },
        { id: "FR2", status: "OK", target: "u2-profile" },
      ],
    });
    write(proj, "inception/units-generation/unit-requirement-assignments.json", JSON.stringify({ version: 1, assignments: [
      { id: "FR1", owner: "u1-auth", related: [], required_for: "owner" },
      { id: "FR2", owner: "u2-profile", related: [], required_for: "owner" },
      { id: "NFR1", owner: "u2-profile", related: [], required_for: "all" },
    ] }));
    let out = run(proj, "units-generation", file);
    expect(out.result.pass).toBe(true);
    expect(out.result.gaps).toEqual([]);
    expect(out.result.missing_from_upstream_ids).toEqual([]);

    trace(proj, "inception/units-generation/traceability.json", {
      stage: "units-generation",
      upstream_ids: ["FR1", "FR2", "NFR1"],
      coverage: [
        { id: "FR1", status: "OK", target: "U1" },
        { id: "FR2", status: "OK", target: "u2-profile" },
        { id: "NFR1", status: "OK", target: "U2" },
      ],
    });
    out = run(proj, "units-generation", file);
    expect(out.result.invalid_targets).toEqual([]);
    expect(out.result.pass).toBe(true);

    // Rows that map FR2 and NFR1 to the wrong unit are still broken joins.
    write(proj, "inception/units-generation/unit-of-work-story-map.md", [
      "# Story Map",
      "",
      "| Requirement | Unit ID | Directory |",
      "|---|---|---|",
      "| FR1 | U1 | u1-auth |",
      "| FR2 | U1 | u1-auth |",
      "| NFR1 | U1 | u1-auth |",
    ].join("\n"));
    out = run(proj, "units-generation", file);
    expect(out.result.pass).toBe(false);
    expect(out.result.invalid_targets).toContain(
      'FR2: target "u2-profile" is not mapped in unit-of-work-story-map.md',
    );
    expect(out.result.invalid_targets).toContain(
      'NFR1: target "U2" is not mapped in unit-of-work-story-map.md',
    );
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

  // A zero-Unit directive (no Unit DAG: poc, bugfix, refactor, security-patch,
  // express) writes code-generation artifacts under construction/code-generation/
  // with no Unit segment. The sensor must resolve that stage-level location
  // instead of refusing to derive a Unit from it.
  test("code-generation resolves the zero-Unit stage-level location", () => {
    const proj = project();
    write(proj, "inception/requirements-analysis/requirements.md", [
      "# Requirements",
      "",
      "## Functional",
      "- FR1 Login",
      "",
      "## Non-functional",
      "- NFR1 Security",
    ].join("\n"));
    write(proj, "construction/functional-design/rules.md", [
      "# Rules",
      "",
      "- BR1.1 Validate credentials",
    ].join("\n"));
    const source = join(proj, "src", "auth.ts");
    mkdirSync(join(source, ".."), { recursive: true });
    writeFileSync(source, "export const auth = true;\n");
    const file = trace(proj, "construction/code-generation/traceability.json", {
      stage: "code-generation",
      upstream_ids: ["FR1", "NFR1", "BR1.1"],
      coverage: [
        { id: "FR1", status: "OK", target: "src/auth.ts" },
        { id: "NFR1", status: "OK", target: "src/auth.ts" },
        { id: "BR1.1", status: "OK", target: "src/auth.ts" },
      ],
    });
    let out = run(proj, "code-generation", file);
    expect(out.result.pass).toBe(true);
    expect(out.result.gaps).toEqual([]);

    // The stage-level rules file is part of the upstream set: a file that
    // omits BR1.1 is refused because the resolved upstream id is undeclared.
    const partial = trace(proj, "construction/code-generation/traceability.json", {
      stage: "code-generation",
      upstream_ids: ["FR1", "NFR1"],
      coverage: [
        { id: "FR1", status: "OK", target: "src/auth.ts" },
        { id: "NFR1", status: "OK", target: "src/auth.ts" },
      ],
    });
    out = run(proj, "code-generation", partial);
    expect(out.result.pass).toBe(false);
    expect(out.result.missing_from_upstream_ids).toContain("BR1.1");
  });

  test("code-generation rejects a stage-level location when a Unit DAG exists", () => {
    const proj = project();
    seedUserStories(proj);
    seedUnits(proj);
    const source = join(proj, "src", "auth.ts");
    mkdirSync(join(source, ".."), { recursive: true });
    writeFileSync(source, "export const auth = true;\n");
    const file = trace(proj, "construction/code-generation/traceability.json", {
      stage: "code-generation",
      upstream_ids: ["AC1.1.1", "AC1.1.2", "AC1.2.1"],
      coverage: [
        { id: "AC1.1.1", status: "OK", target: "src/auth.ts" },
        { id: "AC1.1.2", status: "OK", target: "src/auth.ts" },
        { id: "AC1.2.1", status: "OK", target: "src/auth.ts" },
      ],
    });
    const out = run(proj, "code-generation", file);
    expect(out.result.pass).toBe(false);
    expect(out.result.reason).toContain("cannot derive the construction unit");
  });

  test("missing file and missing output-path keep the CLI error contract", () => {
    const proj = project();
    let spawned = spawnSync("bun", [SCRIPT, "--stage", "user-stories", "--output-path", join(proj, "missing.json")], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      cwd: proj,
      env: { ...process.env, AIDLC_PROJECT_DIR: proj },
    });
    expect(spawned.status).toBe(1);
    expect(spawned.stderr).toContain("not found");

    spawned = spawnSync("bun", [SCRIPT, "--stage", "user-stories"], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      cwd: proj,
      env: { ...process.env, AIDLC_PROJECT_DIR: proj },
    });
    expect(spawned.status).toBe(1);
    expect(spawned.stderr).toContain("--output-path is required");
  });
});

// Every stage file that runs once per Unit and declares the traceability
// sensor, read from frontmatter so a new per-Unit stage is pinned as well.
function perUnitTraceabilityStages(): string[] {
  const slugs: string[] = [];
  for (const phase of readdirSync(STAGES, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    for (const file of readdirSync(join(STAGES, phase.name)).filter((name) => name.endsWith(".md"))) {
      const frontmatter = parseStageFrontmatter(readFileSync(join(STAGES, phase.name, file), "utf-8"));
      const sensors = Array.isArray(frontmatter.sensors) ? frontmatter.sensors : [];
      if (frontmatter.for_each === "unit-of-work" && sensors.includes("traceability")) {
        slugs.push(String(frontmatter.slug));
      }
    }
  }
  return slugs.sort();
}

function stageProgress(proj: string, lines: Array<[string, string, "EXECUTE" | "SKIP"]>): void {
  writeFileSync(seededStateFile(proj), [
    "# State",
    "",
    "## Stage Progress",
    ...lines.map(([mark, slug, action]) => `- [${mark}] ${slug} \u2014 ${action}`),
    "",
  ].join("\n"));
}

function seedRequirements(proj: string): void {
  write(proj, "inception/requirements-analysis/requirements.md", [
    "# Requirements",
    "",
    "## Functional",
    "- FR1 Login",
    "- FR2 Recovery",
    "",
    "## Non-functional",
    "- NFR1 Latency",
    "- NFR2 Availability",
  ].join("\n"));
}

const UNITS_DECLARED =
  "cannot derive the construction unit from output path while unit-of-work-dependency.md declares Units";

// When the plan has no Units, the engine writes every per-Unit stage under
// construction/<stage>/ with no Unit segment. The sensor must resolve that
// location for each of them, not only code-generation.
describe("t281 zero-Unit plans: every per-Unit stage", () => {
  test("each per-Unit stage resolves its own stage-level folder, and only that folder", () => {
    const stages = perUnitTraceabilityStages();
    for (const known of ["code-generation", "functional-design", "infrastructure-design", "nfr-design", "nfr-requirements"]) {
      expect(stages).toContain(known);
    }
    for (const stage of stages) {
      const proj = project();
      seedRequirements(proj);
      const body = {
        stage,
        upstream_ids: ["FR1"],
        coverage: [{ id: "FR1", status: "OK", target: "covered" }],
      };
      const own = trace(proj, `construction/${stage}/traceability.json`, body);
      let out = run(proj, stage, own);
      expect(out.result.reason ?? "").not.toContain("cannot derive the construction unit");
      expect(out.result.reason ?? "").not.toContain("has no traceability upstream resolver");

      const other = stages.find((slug) => slug !== stage)!;
      const misplaced = trace(proj, `construction/${other}/traceability.json`, body);
      out = run(proj, stage, misplaced);
      // The reason names the path with forward slashes on every OS.
      expect(out.result.reason).toContain(
        `cannot derive the construction unit from output path: ${misplaced.replaceAll("\\", "/")}`,
      );

      seedUnits(proj);
      out = run(proj, stage, own);
      expect(out.result.pass).toBe(false);
      expect(out.result.reason).toContain(UNITS_DECLARED);
    }
  });

  // A scope change after Units Generation leaves the old Unit DAG on disk while
  // the plan now skips Units Generation. The engine then places artifacts at
  // stage level and ignores that DAG, so the sensor follows the plan too.
  test("a plan that skips Units Generation wins over a Unit DAG left on disk", () => {
    const proj = project();
    seedRequirements(proj);
    seedUnits(proj);
    write(proj, "construction/functional-design/rules.md", "# Rules\n\n- BR1.1 Validate credentials\n- BR1.2 Lock after failures\n");
    const file = trace(proj, "construction/functional-design/traceability.json", {
      stage: "functional-design",
      upstream_ids: ["FR1", "FR2"],
      coverage: [
        { id: "FR1", status: "OK", target: "BR1.1" },
        { id: "FR2", status: "OK", target: "BR1.2" },
      ],
    });
    // Units Generation never ran in this plan: the DAG on disk is left over.
    const plan = (unitsAction: "EXECUTE" | "SKIP") => stageProgress(proj, [
      [" ", "units-generation", unitsAction],
      ["-", "functional-design", "EXECUTE"],
    ]);
    plan("SKIP");
    let out = run(proj, "functional-design", file);
    expect(out.result.pass).toBe(true);

    plan("EXECUTE");
    out = run(proj, "functional-design", file);
    expect(out.result.reason).toContain(UNITS_DECLARED);

    write(proj, "inception/units-generation/unit-of-work-dependency.md", "# Dependencies\n\nNo units block.\n");
    out = run(proj, "functional-design", file);
    expect(out.result.reason).toContain("unit-of-work-dependency.md is");

    plan("SKIP");
    out = run(proj, "functional-design", file);
    expect(out.result.pass).toBe(true);
  });

  test("Units Generation that already ran keeps its Units when a scope change skips it: a stage-level file is refused", () => {
    // #1401: the Units it made carry on per Unit, where the engine writes them.
    const proj = project();
    seedRequirements(proj);
    seedUnits(proj);
    write(proj, "construction/functional-design/rules.md", "# Rules\n\n- BR1.1 Validate credentials\n- BR1.2 Lock after failures\n");
    const file = trace(proj, "construction/functional-design/traceability.json", {
      stage: "functional-design",
      upstream_ids: ["FR1", "FR2"],
      coverage: [
        { id: "FR1", status: "OK", target: "BR1.1" },
        { id: "FR2", status: "OK", target: "BR1.2" },
      ],
    });
    stageProgress(proj, [
      ["x", "units-generation", "SKIP"],
      ["-", "functional-design", "EXECUTE"],
    ]);
    const out = run(proj, "functional-design", file);
    expect(out.result.pass).toBe(false);
    expect(out.result.reason).toContain(UNITS_DECLARED);
  });

  test("functional-design checks BR targets against the stage-level rules.md", () => {
    const proj = project();
    seedRequirements(proj);
    write(proj, "construction/functional-design/rules.md", "# Rules\n\n- BR1.1 Validate credentials\n- BR1.2 Lock after failures\n");
    const file = trace(proj, "construction/functional-design/traceability.json", {
      stage: "functional-design",
      upstream_ids: ["FR1", "FR2"],
      coverage: [
        { id: "FR1", status: "OK", target: "BR1.1" },
        { id: "FR2", status: "OK", target: "BR1.2" },
      ],
    });
    let out = run(proj, "functional-design", file);
    expect(out.result.pass).toBe(true);

    trace(proj, "construction/functional-design/traceability.json", {
      stage: "functional-design",
      upstream_ids: ["FR1", "FR2"],
      coverage: [
        { id: "FR1", status: "OK", target: "BR1.1" },
        { id: "FR2", status: "OK", target: "BR9.9" },
      ],
    });
    out = run(proj, "functional-design", file);
    expect(out.result.pass).toBe(false);
    expect(out.result.invalid_targets).toContain("FR2: target BR9.9 is absent from rules.md");
    expect(out.result.orphans).toContain("BR1.2");
  });

  test("nfr-requirements traces the NFRs in requirements.md", () => {
    const proj = project();
    seedRequirements(proj);
    const file = trace(proj, "construction/nfr-requirements/traceability.json", {
      stage: "nfr-requirements",
      upstream_ids: ["NFR1", "NFR2"],
      coverage: [
        { id: "NFR1", status: "OK", target: "NFR1.1" },
        { id: "NFR2", status: "OK", target: "NFR2.1" },
      ],
    });
    let out = run(proj, "nfr-requirements", file);
    expect(out.result.pass).toBe(true);

    trace(proj, "construction/nfr-requirements/traceability.json", {
      stage: "nfr-requirements",
      upstream_ids: ["NFR1"],
      coverage: [{ id: "NFR1", status: "OK", target: "NFR1.1" }],
    });
    out = run(proj, "nfr-requirements", file);
    expect(out.result.pass).toBe(false);
    expect(out.result.missing_from_upstream_ids).toContain("NFR2");
  });

  test("nfr-design reads the stage-level NFR requirements", () => {
    const proj = project();
    write(proj, "construction/nfr-requirements/security-requirements.md", "# Security\n\n- NFR1.1 Encrypt at rest\n- NFR1.2 Rotate keys\n");
    const file = trace(proj, "construction/nfr-design/traceability.json", {
      stage: "nfr-design",
      upstream_ids: ["NFR1.1", "NFR1.2"],
      coverage: [
        { id: "NFR1.1", status: "OK", target: "KMS-backed storage" },
        { id: "NFR1.2", status: "OK", target: "Scheduled key rotation" },
      ],
    });
    let out = run(proj, "nfr-design", file);
    expect(out.result.pass).toBe(true);

    trace(proj, "construction/nfr-design/traceability.json", {
      stage: "nfr-design",
      upstream_ids: ["NFR1.1"],
      coverage: [{ id: "NFR1.1", status: "OK", target: "KMS-backed storage" }],
    });
    out = run(proj, "nfr-design", file);
    expect(out.result.missing_from_upstream_ids).toContain("NFR1.2");

    write(proj, "construction/nfr-requirements/security-requirements.md", "# Security\n\nNothing numbered yet.\n");
    out = run(proj, "nfr-design", file);
    expect(out.result.reason).toContain("NFR requirement artifacts for the zero-Unit run contain no NFRx.y IDs");
  });

  test("infrastructure-design reads the stage-level NFR design", () => {
    const proj = project();
    write(proj, "construction/nfr-design/security-design.md", "# Security design\n\n- NFR1.1 KMS-backed storage\n- NFR1.2 Key rotation\n");
    const file = trace(proj, "construction/infrastructure-design/traceability.json", {
      stage: "infrastructure-design",
      upstream_ids: ["NFR1.1", "NFR1.2"],
      coverage: [
        { id: "NFR1.1", status: "OK", target: "KMS key" },
        { id: "NFR1.2", status: "OK", target: "Rotation schedule" },
      ],
    });
    let out = run(proj, "infrastructure-design", file);
    expect(out.result.pass).toBe(true);

    trace(proj, "construction/infrastructure-design/traceability.json", {
      stage: "infrastructure-design",
      upstream_ids: ["NFR1.1"],
      coverage: [{ id: "NFR1.1", status: "OK", target: "KMS key" }],
    });
    out = run(proj, "infrastructure-design", file);
    expect(out.result.missing_from_upstream_ids).toContain("NFR1.2");
  });
});

// A later NFR stage traces the nearest earlier NFR stage that ran. A stage the
// plan or the run skipped hands over to the one before it; without NFR
// Requirements the IDs are the NFRn ones in requirements.md.
describe("t281 skipped earlier NFR stages", () => {
  test("infrastructure-design traces NFR Requirements when NFR Design did not run", () => {
    const proj = project();
    seedUnits(proj);
    stageProgress(proj, [
      ["x", "units-generation", "EXECUTE"],
      ["x", "nfr-requirements", "EXECUTE"],
      [" ", "nfr-design", "SKIP"],
      ["-", "infrastructure-design", "EXECUTE"],
    ]);
    write(proj, "construction/u1-auth/nfr-requirements/performance-requirements.md", "# Performance\n\n- NFR2.1 p95 under 200ms\n- NFR2.2 1k rps\n");
    const file = trace(proj, "construction/u1-auth/infrastructure-design/traceability.json", {
      stage: "infrastructure-design",
      unit: "u1-auth",
      upstream_ids: ["NFR2.1", "NFR2.2"],
      coverage: [
        { id: "NFR2.1", status: "OK", target: "CloudFront cache" },
        { id: "NFR2.2", status: "OK", target: "Autoscaling group" },
      ],
    });
    let out = run(proj, "infrastructure-design", file);
    expect(out.result.pass).toBe(true);

    trace(proj, "construction/u1-auth/infrastructure-design/traceability.json", {
      stage: "infrastructure-design",
      unit: "u1-auth",
      upstream_ids: ["NFR2.1"],
      coverage: [{ id: "NFR2.1", status: "OK", target: "CloudFront cache" }],
    });
    out = run(proj, "infrastructure-design", file);
    expect(out.result.missing_from_upstream_ids).toContain("NFR2.2");

    // Unit runs keep naming the Unit in the empty-source message.
    write(proj, "construction/u1-auth/nfr-requirements/performance-requirements.md", "# Performance\n\nNothing numbered yet.\n");
    out = run(proj, "infrastructure-design", file);
    expect(out.result.reason).toContain('NFR requirement artifacts for unit "u1-auth" contain no NFRx.y IDs');

    // NFR Design files that do exist are read even though the plan skipped it.
    write(proj, "construction/u1-auth/nfr-design/security-design.md", "# Security design\n\n- NFR9.1 WAF\n");
    out = run(proj, "infrastructure-design", file);
    expect(out.result.missing_from_upstream_ids).toEqual(["NFR9.1"]);
  });

  test("with both NFR stages skipped, infrastructure-design traces requirements.md", () => {
    const proj = project();
    seedRequirements(proj);
    stageProgress(proj, [
      [" ", "units-generation", "SKIP"],
      [" ", "nfr-requirements", "SKIP"],
      [" ", "nfr-design", "SKIP"],
      ["-", "infrastructure-design", "EXECUTE"],
    ]);
    const file = trace(proj, "construction/infrastructure-design/traceability.json", {
      stage: "infrastructure-design",
      upstream_ids: ["NFR1", "NFR2"],
      coverage: [
        { id: "NFR1", status: "OK", target: "Single small instance" },
        { id: "NFR2", status: "OK", target: "Multi-AZ deployment" },
      ],
    });
    let out = run(proj, "infrastructure-design", file);
    expect(out.result.pass).toBe(true);

    trace(proj, "construction/infrastructure-design/traceability.json", {
      stage: "infrastructure-design",
      upstream_ids: ["NFR1"],
      coverage: [{ id: "NFR1", status: "OK", target: "Single small instance" }],
    });
    out = run(proj, "infrastructure-design", file);
    expect(out.result.pass).toBe(false);
    expect(out.result.missing_from_upstream_ids).toEqual(["NFR2"]);
  });

  test("NFR Requirements skipped at runtime: both later NFR stages trace requirements.md", () => {
    const proj = project();
    seedRequirements(proj);
    stageProgress(proj, [
      [" ", "units-generation", "SKIP"],
      ["S", "nfr-requirements", "EXECUTE"],
      ["x", "nfr-design", "EXECUTE"],
      ["-", "infrastructure-design", "EXECUTE"],
    ]);
    // An NFR Design that ran without NFR Requirements cites NFRn, not NFRx.y.
    write(proj, "construction/nfr-design/security-design.md", "# Security design\n\n- NFR1 small instance\n- NFR2 multi-AZ\n");
    const body = (stage: string) => ({
      stage,
      upstream_ids: ["NFR1", "NFR2"],
      coverage: [
        { id: "NFR1", status: "OK", target: "Single small instance" },
        { id: "NFR2", status: "OK", target: "Multi-AZ deployment" },
      ],
    });
    const design = trace(proj, "construction/nfr-design/traceability.json", body("nfr-design"));
    let out = run(proj, "nfr-design", design);
    expect(out.result.pass).toBe(true);
    const infra = trace(proj, "construction/infrastructure-design/traceability.json", body("infrastructure-design"));
    out = run(proj, "infrastructure-design", infra);
    expect(out.result.pass).toBe(true);
  });

  test("an earlier NFR stage that ran but left no files still fails closed", () => {
    const proj = project();
    seedRequirements(proj);
    stageProgress(proj, [
      [" ", "units-generation", "SKIP"],
      ["x", "nfr-requirements", "EXECUTE"],
      ["x", "nfr-design", "EXECUTE"],
      ["-", "infrastructure-design", "EXECUTE"],
    ]);
    const design = trace(proj, "construction/nfr-design/traceability.json", {
      stage: "nfr-design",
      upstream_ids: ["NFR1"],
      coverage: [{ id: "NFR1", status: "OK", target: "Single small instance" }],
    });
    let out = run(proj, "nfr-design", design);
    expect(out.result.pass).toBe(false);
    expect(out.result.reason).toContain("required upstream NFR requirement artifacts are missing under");

    write(proj, "construction/nfr-requirements/security-requirements.md", "# Security\n\n- NFR1.1 Encrypt at rest\n");
    const infra = trace(proj, "construction/infrastructure-design/traceability.json", {
      stage: "infrastructure-design",
      upstream_ids: ["NFR1.1"],
      coverage: [{ id: "NFR1.1", status: "OK", target: "KMS key" }],
    });
    out = run(proj, "infrastructure-design", infra);
    expect(out.result.pass).toBe(false);
    expect(out.result.reason).toContain("required upstream NFR design artifacts are missing under");

    // No Stage Progress at all reads as "ran": the same refusal.
    writeFileSync(seededStateFile(proj), "# State\n");
    out = run(proj, "infrastructure-design", infra);
    expect(out.result.reason).toContain("required upstream NFR design artifacts are missing under");

    // NFR Design ran with no files while NFR Requirements was skipped: still
    // red, not a fallback to requirements.md.
    stageProgress(proj, [
      [" ", "units-generation", "SKIP"],
      ["S", "nfr-requirements", "EXECUTE"],
      ["x", "nfr-design", "EXECUTE"],
      ["-", "infrastructure-design", "EXECUTE"],
    ]);
    rmSync(join(seededRecordDir(proj), "construction", "nfr-requirements"), { recursive: true });
    const nfrOnly = trace(proj, "construction/infrastructure-design/traceability.json", {
      stage: "infrastructure-design",
      upstream_ids: ["NFR1", "NFR2"],
      coverage: [
        { id: "NFR1", status: "OK", target: "Single small instance" },
        { id: "NFR2", status: "OK", target: "Multi-AZ deployment" },
      ],
    });
    out = run(proj, "infrastructure-design", nfrOnly);
    expect(out.result.pass).toBe(false);
    expect(out.result.reason).toContain("required upstream NFR design artifacts are missing under");
  });
});
