// covers: function:parseBoltDag, function:parseStageFrontmatter, function:emitStageFrontmatter, function:validateStageFrontmatter, subcommand:aidlc-runtime:compile, subcommand:aidlc-sensor-required-sections, function:applicableUnitKinds, function:addPluginProducesKinds, function:removeOrphanProducesKinds
//
// t207 - unit-kind schema/parse/compile/sensor axis. The units-generation edge
// block gains an optional `kind:` key per unit (UNIT_KINDS enum) and the four
// per-unit construction design stages gain a `produces_kinds:` frontmatter map.
// This file pins the STATIC surfaces: the parser learns the key (fail-loud on a
// bad value), the runtime compile carries it onto bolt_dag.units[], the
// gate-time edge-block sensor tolerates a valid kind and rejects an invalid one,
// and the stage-frontmatter parse/emit round-trips produces_kinds while the
// schema validator rejects malformed maps. An output a plugin adds to such a
// stage takes the kinds the stage applies to, and its entry goes with it. The
// engine PRUNING axis (directive produces + coverage + the all-vacuous approve
// branch) is t208.
//
// Mechanism = cli for the compile + sensor cases (both are process-boundary
// seams: compile writes runtime-graph.json to disk, the sensor writes Result
// JSON to stdout, mirroring t133). The parse/emit/validate cases import the pure
// functions in-process from the dist tools (the shipped bytes), the same
// boundary t65 / the schema unit tests use.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AIDLC_SRC, FIXTURES_DIR, toPortablePath } from "../harness/fixtures.ts";
import {
  auditFilePath,
  emitStageFrontmatter,
  parseBoltDag,
  parseStageFrontmatter,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { applicableUnitKinds, validateStageFrontmatter } from "../../dist/claude/.claude/tools/aidlc-stage-schema.ts";
import {
  addPluginProducesKinds,
  removeOrphanProducesKinds,
} from "../../dist/claude/.claude/tools/aidlc-plugin-produces-kinds.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const RUNTIME = join(AIDLC_SRC, "tools", "aidlc-runtime.ts");
const SENSOR = join(AIDLC_SRC, "tools", "aidlc-sensor-required-sections.ts");
const STATE_FIXTURE = join(FIXTURES_DIR, "state-construction.md");
const RECORD_REL = join("aidlc", "spaces", "default", "intents");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const AUDIT_MD = `# AI-DLC Audit Log

## Workflow Started
**Timestamp**: 2026-06-06T08:00:00Z
**Event**: WORKFLOW_STARTED
**Workflow ID**: t207-fixture
**Scope**: feature

---
`;

function recordRoot(proj: string): string {
  return join(proj, RECORD_REL);
}

function makeProject(): string {
  let proj = mkdtempSync(join(tmpdir(), "aidlc-t207-"));
  proj = toPortablePath(proj);
  tempDirs.push(proj);
  mkdirSync(join(recordRoot(proj), "inception", "units-generation"), { recursive: true });
  cpSync(STATE_FIXTURE, join(recordRoot(proj), "aidlc-state.md"));
  const shard = auditFilePath(proj);
  mkdirSync(dirname(shard), { recursive: true });
  writeFileSync(shard, AUDIT_MD, "utf-8");
  return proj;
}

function uowdPath(proj: string): string {
  return join(recordRoot(proj), "inception", "units-generation", "unit-of-work-dependency.md");
}

function graphPath(proj: string): string {
  return join(recordRoot(proj), "runtime-graph.json");
}

function writeUowd(proj: string, block: string): void {
  const body = ["# Unit Dependency DAG", "", "## Dependencies", block, "", "## Integration Points", "REST APIs between units.", ""].join("\n");
  writeFileSync(uowdPath(proj), body, "utf-8");
}

function runCompile(proj: string): void {
  spawnSync(BUN, [RUNTIME, "compile", "--project-dir", proj], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
}

// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary compiled-graph shape
function readGraph(proj: string): any {
  return JSON.parse(readFileSync(graphPath(proj), "utf-8"));
}

function runSensor(outputPath: string): { pass: boolean; edge_block?: string } {
  const res = spawnSync(BUN, [SENSOR, "--stage", "units-generation", "--output-path", outputPath], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
  const parsed = JSON.parse((res.stdout ?? "").trim());
  return { pass: parsed.pass, edge_block: parsed.edge_block };
}

// A kind-tagged block: some units carry kind, one deliberately does not (mixed).
const KIND_BLOCK = [
  "```yaml",
  "units:",
  "  - name: api",
  "    kind: service",
  "    depends_on: [auth]",
  "  - name: auth",
  "    kind: spec",
  "    depends_on: []",
  "  - name: chart",
  "    depends_on: [api]",
  "```",
].join("\n");

// Same topology, no kinds at all (the tolerance anchor).
const KINDLESS_BLOCK = [
  "```yaml",
  "units:",
  "  - name: api",
  "    depends_on: [auth]",
  "  - name: auth",
  "    depends_on: []",
  "  - name: chart",
  "    depends_on: [api]",
  "```",
].join("\n");

const INVALID_KIND_BLOCK = [
  "```yaml",
  "units:",
  "  - name: api",
  "    kind: serivce",
  "    depends_on: []",
  "```",
].join("\n");

const KIND_BEFORE_NAME_BLOCK = [
  "```yaml",
  "units:",
  "    kind: service",
  "  - name: api",
  "    depends_on: []",
  "```",
].join("\n");

describe("t207 unit-kind schema/parse/compile/sensor", () => {
  // ---- parseBoltDag (in-process) --------------------------------------------
  test("parseBoltDag: kind: on some units parses, others stay undefined", () => {
    const parsed = parseBoltDag(KIND_BLOCK);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const byName = new Map(parsed.units.map((u) => [u.name, u.kind]));
    expect(byName.get("api")).toBe("service");
    expect(byName.get("auth")).toBe("spec");
    expect(byName.get("chart")).toBeUndefined();
  });

  test("parseBoltDag: invalid kind value -> malformed naming the unit", () => {
    const parsed = parseBoltDag(INVALID_KIND_BLOCK);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("malformed");
    expect(parsed.detail).toContain("api");
    expect(parsed.detail).toContain("serivce");
  });

  test("parseBoltDag: kind: before any - name: -> malformed", () => {
    const parsed = parseBoltDag(KIND_BEFORE_NAME_BLOCK);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("malformed");
  });

  test("parseBoltDag: kindless block still parses ok (tolerance anchor)", () => {
    const parsed = parseBoltDag(KINDLESS_BLOCK);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.units.every((u) => u.kind === undefined)).toBe(true);
  });

  // ---- runtime compile (cli) ------------------------------------------------
  test("compile: kind-tagged doc -> bolt_dag.units[] carries kind; recompile byte-identical", () => {
    const proj = makeProject();
    writeUowd(proj, KIND_BLOCK);
    runCompile(proj);
    const g = readGraph(proj);
    const byName = new Map<string, string | undefined>(g.bolt_dag.units.map((u: { name: string; kind?: string }) => [u.name, u.kind]));
    expect(byName.get("api")).toBe("service");
    expect(byName.get("auth")).toBe("spec");
    expect("kind" in g.bolt_dag.units.find((u: { name: string }) => u.name === "chart")).toBe(false);
    const first = readFileSync(graphPath(proj), "utf-8");
    runCompile(proj);
    expect(readFileSync(graphPath(proj), "utf-8")).toBe(first);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("compile: kindless doc -> no kind keys on any unit (unchanged shape)", () => {
    const proj = makeProject();
    writeUowd(proj, KINDLESS_BLOCK);
    runCompile(proj);
    const g = readGraph(proj);
    expect(g.bolt_dag.units.every((u: { kind?: string }) => !("kind" in u))).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // ---- edge-block sensor (cli) ----------------------------------------------
  test("sensor: kind-tagged block -> edge_block ok, pass true", () => {
    const proj = makeProject();
    writeUowd(proj, KIND_BLOCK);
    const r = runSensor(uowdPath(proj));
    expect(r.edge_block).toBe("ok");
    expect(r.pass).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("sensor: invalid kind -> edge_block malformed, pass false", () => {
    const proj = makeProject();
    writeUowd(proj, INVALID_KIND_BLOCK);
    const r = runSensor(uowdPath(proj));
    expect(r.edge_block).toBe("malformed");
    expect(r.pass).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // ---- stage frontmatter parse/emit round-trip (in-process) -----------------
  const STAGE_WITH_MAP = [
    "---",
    "slug: demo-stage",
    "phase: construction",
    "execution: CONDITIONAL",
    "condition: demo",
    "lead_agent: aidlc-architect-agent",
    "support_agents: []",
    "mode: inline",
    "for_each: unit-of-work",
    "produces:",
    "  - alpha-doc",
    "  - beta-doc",
    "produces_kinds:",
    "  alpha-doc: [service, ui]",
    "  beta-doc: [spec]",
    "consumes: []",
    "requires_stage: []",
    "inputs: x",
    "outputs: y",
    "---",
    "",
    "# Demo",
  ].join("\n");

  test("parseStageFrontmatter: produces_kinds parses into a map", () => {
    const parsed = parseStageFrontmatter(STAGE_WITH_MAP);
    expect(parsed.produces_kinds).toEqual({ "alpha-doc": ["service", "ui"], "beta-doc": ["spec"] });
  });

  test("parse -> emit -> parse round-trips produces_kinds byte-stably", () => {
    const parsed = parseStageFrontmatter(STAGE_WITH_MAP);
    const emitted = emitStageFrontmatter(parsed);
    const reparsed = parseStageFrontmatter(emitted);
    expect(reparsed.produces_kinds).toEqual(parsed.produces_kinds);
    expect(emitted).toContain("produces_kinds:\n  alpha-doc: [service, ui]\n  beta-doc: [spec]");
  });

  test("absent produces_kinds -> the property is absent (not an empty object)", () => {
    const noMap = STAGE_WITH_MAP.replace("produces_kinds:\n  alpha-doc: [service, ui]\n  beta-doc: [spec]\n", "");
    const parsed = parseStageFrontmatter(noMap);
    expect("produces_kinds" in parsed).toBe(false);
  });

  // ---- schema validator (in-process) ----------------------------------------
  function validate(overrides: Record<string, unknown>) {
    const base: Record<string, unknown> = {
      slug: "demo-stage",
      phase: "construction",
      execution: "CONDITIONAL",
      condition: "demo",
      lead_agent: "aidlc-architect-agent",
      support_agents: [],
      mode: "inline",
      produces: ["alpha-doc", "beta-doc"],
      consumes: [],
      requires_stage: [],
      inputs: "x",
      outputs: "y",
    };
    return validateStageFrontmatter({ ...base, ...overrides });
  }

  test("validator: a valid produces_kinds map passes", () => {
    const r = validate({ produces_kinds: { "alpha-doc": ["service", "ui"], "beta-doc": ["spec"] } });
    expect(r.valid).toBe(true);
  });

  test("validator: an orphan key (not in produces) is rejected", () => {
    const r = validate({ produces_kinds: { "ghost-doc": ["service"] } });
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.errors.some((e) => e.includes("ghost-doc") && e.includes("not in produces"))).toBe(true);
  });

  test("validator: an unknown kind is rejected", () => {
    const r = validate({ produces_kinds: { "alpha-doc": ["serivce"] } });
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.errors.some((e) => e.includes("unknown kind") && e.includes("serivce"))).toBe(true);
  });

  test("validator: an empty kind list is rejected", () => {
    const r = validate({ produces_kinds: { "alpha-doc": [] } });
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.errors.some((e) => e.includes("non-empty"))).toBe(true);
  });

  test("validator: absent produces_kinds still validates", () => {
    const r = validate({});
    expect(r.valid).toBe(true);
  });

  // ---- an output a plugin adds (in-process) ---------------------------------
  // Every required output mapped, as on functional-design: the stage applies to
  // service, ui and spec Units only.
  const MAP_LINES = "produces_kinds:\n  alpha-doc: [service, ui]\n  beta-doc: [spec]\n";
  const WITH_PLUGIN_OUTPUT = STAGE_WITH_MAP.replace("  - beta-doc\n", "  - beta-doc\n  - plug-doc\n");

  test("applicableUnitKinds: mapped outputs give their kinds, an unmapped one gives every kind", () => {
    const map = { "alpha-doc": ["service", "ui"], "beta-doc": ["spec"] };
    expect([...applicableUnitKinds(["alpha-doc", "beta-doc"], map)]).toEqual(["service", "ui", "spec"]);
    expect(applicableUnitKinds(["alpha-doc", "gamma-doc"], map).size).toBe(5);
  });

  test("addPluginProducesKinds: an added output takes the kinds the stage applies to, and the entry goes with it", () => {
    const added = addPluginProducesKinds(WITH_PLUGIN_OUTPUT, ["plug-doc"]);
    expect(added).toBe(WITH_PLUGIN_OUTPUT.replace(MAP_LINES, `${MAP_LINES}  plug-doc: [service, spec, ui]\n`));
    expect(addPluginProducesKinds(added, ["plug-doc"])).toBe(added);
    expect(removeOrphanProducesKinds(added.replace("  - plug-doc\n", ""), ["plug-doc"])).toBe(STAGE_WITH_MAP);
    // An entry stays while the stage still declares the artifact.
    expect(removeOrphanProducesKinds(added, ["plug-doc"])).toBe(added);
  });

  test("addPluginProducesKinds: no entry where the output would not widen the stage, or is not only the plugin's", () => {
    const cases: Array<[string, string]> = [
      ["a required output with no entry applies to every kind", WITH_PLUGIN_OUTPUT.replace("  beta-doc: [spec]\n", "")],
      ["the mapped outputs cover every kind",
        WITH_PLUGIN_OUTPUT.replace("  beta-doc: [spec]\n", "  beta-doc: [spec, packaging, library]\n")],
      ["the stage maps the output itself", WITH_PLUGIN_OUTPUT.replace(MAP_LINES, `${MAP_LINES}  plug-doc: [ui]\n`)],
      ["the stage also lists the output as optional",
        WITH_PLUGIN_OUTPUT.replace("consumes: []", "optional_produces:\n  - plug-doc\nconsumes: []")],
      ["the stage does not list the output", STAGE_WITH_MAP],
      ["the stage is not per Unit", WITH_PLUGIN_OUTPUT.replace("for_each: unit-of-work\n", "")],
      ["the stage has no map", WITH_PLUGIN_OUTPUT.replace(MAP_LINES, "")],
    ];
    for (const [name, stage] of cases) {
      expect(addPluginProducesKinds(stage, ["plug-doc"]), name).toBe(stage);
    }
  });

  test("addPluginProducesKinds: two plugins on one stage get the same entry, and taking one out leaves the other's", () => {
    const withOther = (content: string) => content.replace("  - plug-doc\n", "  - plug-doc\n  - other-doc\n");
    // Composed one after the other, the second sees the first's output and entry.
    const both = addPluginProducesKinds(withOther(addPluginProducesKinds(WITH_PLUGIN_OUTPUT, ["plug-doc"])), ["other-doc"]);
    expect(addPluginProducesKinds(withOther(WITH_PLUGIN_OUTPUT), ["plug-doc", "other-doc"]), "replayed together").toBe(both);
    const onlyOther = both.replace("  - plug-doc\n", "");
    expect(removeOrphanProducesKinds(onlyOther, ["plug-doc"]))
      .toBe(addPluginProducesKinds(STAGE_WITH_MAP.replace("  - beta-doc\n", "  - beta-doc\n  - other-doc\n"), ["other-doc"]));
    // A stage's optional output another plugin made required does not widen
    // what the stage applies to.
    const optionalMadeRequired = WITH_PLUGIN_OUTPUT
      .replace("  - plug-doc\n", "  - plug-doc\n  - opt-doc\n")
      .replace("consumes: []", "optional_produces:\n  - opt-doc\nconsumes: []");
    expect(parseStageFrontmatter(addPluginProducesKinds(optionalMadeRequired, ["plug-doc"])).produces_kinds)
      .toMatchObject({ "plug-doc": ["service", "spec", "ui"] });
  });

  test("addPluginProducesKinds and removeOrphanProducesKinds edit only the frontmatter block the parser reads", () => {
    // A blank line after the header is the same block to the parser.
    const spaced = addPluginProducesKinds(WITH_PLUGIN_OUTPUT.replace("produces_kinds:\n", "produces_kinds:\n\n"), ["plug-doc"]);
    expect(parseStageFrontmatter(spaced).produces_kinds).toEqual({
      "alpha-doc": ["service", "ui"],
      "beta-doc": ["spec"],
      "plug-doc": ["service", "spec", "ui"],
    });
    // A produces_kinds example in the body is prose.
    const documented = `${STAGE_WITH_MAP.replace(MAP_LINES, "")}\n\nproduces_kinds:\n  plug-doc: [ui]\n`;
    expect(removeOrphanProducesKinds(documented, ["plug-doc"])).toBe(documented);
  });
});
