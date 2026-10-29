// The ddd plugin's model-schema sensor: observed passing AND observed failing.
//
// Every defect class the sensor claims to catch has a fixture derived from the schema doc's own
// example by ONE mutation, and a test asserting the sensor fails on exactly that class. A check that
// has never been seen failing proves nothing — the same discipline the plugin imposes on projects.
//
// Run: bun test plugins/ddd/tests/model-schema-sensor.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { composePluginFixture } from "../../../tests/harness/plugin-kit.ts";
import { validateModel } from "../tools/aidlc-sensor-ddd-model-schema.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const FIXTURES = join(HERE, "fixtures", "model-schema");
const SENSOR = join(PLUGIN_ROOT, "tools", "aidlc-sensor-ddd-model-schema.ts");
const SCHEMA = join(
  PLUGIN_ROOT,
  "knowledge",
  "aidlc-architect-agent",
  "ddd-model-and-rule-schema.md",
);

interface SensorOut {
  pass: boolean;
  findings_count: number;
  findings: string[];
  checks?: number;
}

function runSensor(outputPath: string): { status: number | null; out: SensorOut } {
  const r = spawnSync("bun", [SENSOR, "--stage", "ddd-domain-modeling", "--output-path", outputPath], {
    encoding: "utf-8",
  });
  return { status: r.status, out: JSON.parse(r.stdout) as SensorOut };
}
const fixture = (name: string) => join(FIXTURES, name, "ddd-domain-model.md");
/** Check-id prefixes of the findings, e.g. `ev-agg`, `fsm`, `id-ctx`. */
function classes(findings: string[]): string[] {
  return [
    ...new Set(
      findings.map((f) => f.split(":")[0].replace(/-(orders|riverbend|<).*$/, "")),
    ),
  ].sort();
}

describe("ddd-model-schema sensor — the schema doc is self-consistent", () => {
  test("the schema's own frontmatter example passes every check", () => {
    const doc = readFileSync(SCHEMA, "utf-8");
    const yaml = doc.match(/```yaml\n([\s\S]*?)```/)?.[1];
    expect(yaml).toBeDefined();
    const artifact = `---\n${yaml}---\n\n## Ubiquitous Language\n## Bounded Contexts\n## Aggregates\n`;
    const { findings, checks } = validateModel(artifact);
    expect(findings).toEqual([]);
    expect(checks).toBeGreaterThan(50);
  });

  test("the schema doc states the three rules the sensor enforces that the old stage prose omitted", () => {
    const doc = readFileSync(SCHEMA, "utf-8");
    expect(doc).toMatch(/`domain_events\[\]`.*\*\*`aggregate`\*\*/);
    expect(doc).toMatch(/`kind: invariant`.*\*\*`aggregate`\*\*/);
    expect(doc).toMatch(/\{ from, on, to \}/);
    expect(doc).toMatch(/\*\*any\*\* token is past-tense/);
  });
});

describe("ddd-model-schema sensor — observed passing", () => {
  test("good fixture passes", () => {
    const { status, out } = runSensor(fixture("good"));
    expect(status).toBe(0);
    expect(out.pass).toBe(true);
    expect(out.findings).toEqual([]);
  });

  test("phrasal past-tense event names (checked-out) pass — regression for the false positive", () => {
    const { out } = runSensor(fixture("good-phrasal-past-tense"));
    expect(out.pass).toBe(true);
  });

  test("any non-model artifact path is a clean pass-through", () => {
    const { status, out } = runSensor(join(FIXTURES, "good", "some-other-artifact.md"));
    expect(status).toBe(0);
    expect(out).toEqual({ pass: true, findings_count: 0, findings: [] });
  });

  test("a missing model file is a clean pass-through (not an error)", () => {
    const { status, out } = runSensor(join(FIXTURES, "nope", "ddd-domain-model.md"));
    expect(status).toBe(0);
    expect(out.pass).toBe(true);
  });
});

describe("ddd-model-schema sensor — observed FAILING, one fixture per defect class", () => {
  const cases: Array<[fixture: string, expectedClass: string]> = [
    ["bad-missing-agg-event", "ev-agg"],
    ["bad-missing-agg-rule", "rule-agg"],
    ["bad-event-key", "fsm"],
    ["bad-undeclared-ctx", "id-ctx"],
    ["bad-present-tense", "ev-past"],
    ["bad-authored-rule0", "rule-kind"],
    ["bad-no-version", "top-version"],
  ];
  for (const [name, cls] of cases) {
    test(`${name} fails on exactly class '${cls}'`, () => {
      const { status, out } = runSensor(fixture(name));
      expect(status).toBe(0); // a finding is a pass:false result, not a tool crash
      expect(out.pass).toBe(false);
      expect(out.findings_count).toBeGreaterThan(0);
      expect(classes(out.findings)).toEqual([cls]);
    });
  }

  test("the `event` transition key is named explicitly in the finding so the fix is obvious", () => {
    const { out } = runSensor(fixture("bad-event-key"));
    expect(out.findings.some((f) => f.includes("uses key `event`") && f.includes("`on`"))).toBe(true);
  });
});

describe("ddd-model-schema sensor — wired into the modeling stage", () => {
  test("ddd-domain-modeling declares the sensor and cites the schema as normative", () => {
    const stage = readFileSync(
      join(PLUGIN_ROOT, "stages", "inception", "ddd-domain-modeling.md"),
      "utf-8",
    );
    expect(stage).toMatch(/^sensors:\n(?: {2}- [\w-]+\n)* {2}- ddd-model-schema\n/m);
    expect(stage).toContain("ddd-model-and-rule-schema.md");
    expect(stage).toContain("`aggregate:");
    expect(stage).toContain("{ from, on, to }");
  });

  test("the sensor manifest is blocking and fires at the gate", () => {
    const manifest = readFileSync(
      join(PLUGIN_ROOT, "sensors", "aidlc-ddd-model-schema.md"),
      "utf-8",
    );
    expect(manifest).toContain("id: ddd-model-schema");
    expect(manifest).toContain("default_severity: blocking");
    expect(manifest).toContain("fire_on: gate");
    expect(manifest).toContain("aidlc-sensor-ddd-model-schema.ts");
  });

  test("ddd-conformance compiles from the schema field names (on, aggregate)", () => {
    const stage = readFileSync(
      join(PLUGIN_ROOT, "stages", "construction", "ddd-conformance.md"),
      "utf-8",
    );
    expect(stage).toContain("{ from, on, to }");
    expect(stage).toContain("`transitions[].on`");
    expect(stage).toMatch(/aggregate citation/);
  });
});

describe("ddd-model-schema sensor — lands in a composed install", () => {
  let projectDir = "";
  let tmpRoot = "";

  beforeAll(() => {
    const f = composePluginFixture({ plugin: "ddd", harness: "claude" });
    projectDir = f.projectDir;
    tmpRoot = dirname(projectDir);
  }, 120_000);

  afterAll(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("manifest, tool, and the schema knowledge file are all copied", () => {
    const h = join(projectDir, ".claude");
    expect(existsSync(join(h, "sensors", "aidlc-ddd-model-schema.md"))).toBe(true);
    expect(existsSync(join(h, "tools", "aidlc-sensor-ddd-model-schema.ts"))).toBe(true);
    expect(
      existsSync(
        join(h, "knowledge", "aidlc-architect-agent", "ddd-model-and-rule-schema.md"),
      ),
    ).toBe(true);
  });

  test("the composed modeling stage carries the sensor in its frontmatter", () => {
    const stage = readFileSync(
      join(projectDir, ".claude", "aidlc-common", "stages", "inception", "ddd-domain-modeling.md"),
      "utf-8",
    );
    expect(stage).toContain("- ddd-model-schema");
  });

  test("the installed tool runs from the install and fails the bad fixture", () => {
    const tool = join(projectDir, ".claude", "tools", "aidlc-sensor-ddd-model-schema.ts");
    const r = spawnSync(
      "bun",
      [tool, "--stage", "ddd-domain-modeling", "--output-path", fixture("bad-missing-agg-event")],
      { encoding: "utf-8" },
    );
    const out = JSON.parse(r.stdout) as SensorOut;
    expect(out.pass).toBe(false);
    expect(classes(out.findings)).toEqual(["ev-agg"]);
  });
});
