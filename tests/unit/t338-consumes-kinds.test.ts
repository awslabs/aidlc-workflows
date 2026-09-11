// covers: function:parseStageFrontmatter, function:emitStageFrontmatter, function:validateStageFrontmatter, function:consumeAppliesToKind, subcommand:aidlc-orchestrate:next, subcommand:aidlc-sensor:fire
//
// t338 - `consumes[].kinds`: the consumer-side twin of produces_kinds. A
// per-unit stage may mark one consume as applying to some unit kinds only; the
// directive builder drops it for a unit of another kind and the upstream-
// coverage dispatcher stops threading it, so a backend unit is never asked to
// cite a UI mockup it never read. Absent list, or an untagged unit, keeps the
// consume - the same fail-open posture filterProducesByKind has.
//
// Four surfaces, one file: the frontmatter parse/emit round-trip and the schema
// validator (in-process, shipped bytes), then the engine `next` directive and
// the sensor `fire` dispatcher (cli, spawned). Both spawned cases point
// AIDLC_STAGE_GRAPH at a copy of the shipped graph with ONE consume added to
// functional-design - `wireframes` gated to [ui] - since no core stage declares
// `kinds` yet; the stage file is not edited.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
  toPortablePath,
} from "../harness/fixtures.ts";
import {
  consumeAppliesToKind,
  emitStageFrontmatter,
  parseStageFrontmatter,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { validateStageFrontmatter } from "../../dist/claude/.claude/tools/aidlc-stage-schema.ts";

resetAidlcEnv();

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const SENSOR = join(AIDLC_SRC, "tools", "aidlc-sensor.ts");
const SHIPPED_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");
const RP = `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}`;
const WIREFRAMES = `${RP}/ideation/rough-mockups/wireframes.md`;

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) {
      try {
        cleanupTestProject(d);
      } catch {
        rmSync(d, { recursive: true, force: true });
      }
    }
  }
});

// ---------------------------------------------------------------------------
// parse / emit / validate
// ---------------------------------------------------------------------------

const STAGE = [
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
  "consumes:",
  "  - artifact: requirements",
  "    required: true",
  "  - artifact: mockups",
  "    required: false",
  "    kinds: [ui, spec]",
  "requires_stage: []",
  "inputs: x",
  "outputs: y",
  "---",
  "",
  "# Demo",
].join("\n");

function validate(overrides: Record<string, unknown>) {
  const base = {
    slug: "demo-stage",
    phase: "construction",
    execution: "CONDITIONAL",
    condition: "demo",
    lead_agent: "aidlc-architect-agent",
    support_agents: [],
    mode: "inline",
    for_each: "unit-of-work",
    produces: ["alpha-doc"],
    consumes: [],
    requires_stage: [],
    inputs: "x",
    outputs: "y",
  };
  return validateStageFrontmatter({ ...base, ...overrides });
}

describe("t338 consumes[].kinds - parse, emit, validate", () => {
  test("parseStageFrontmatter: an inline kinds list parses onto the consume", () => {
    const parsed = parseStageFrontmatter(STAGE);
    expect(parsed.consumes).toEqual([
      { artifact: "requirements", required: true },
      { artifact: "mockups", required: false, kinds: ["ui", "spec"] },
    ]);
  });

  test("parse -> emit -> parse round-trips kinds and emits the inline form", () => {
    const parsed = parseStageFrontmatter(STAGE);
    const emitted = emitStageFrontmatter(parsed);
    expect(emitted).toContain("  - artifact: mockups\n    required: false\n    kinds: [ui, spec]\n");
    expect(parseStageFrontmatter(emitted).consumes).toEqual(parsed.consumes);
  });

  test("validator: kinds on a per-unit stage passes", () => {
    const r = validate({ consumes: [{ artifact: "mockups", required: false, kinds: ["ui"] }] });
    expect(r.valid).toBe(true);
  });

  test("validator: kinds on a non-per-unit stage is rejected", () => {
    const r = validate({
      for_each: undefined,
      consumes: [{ artifact: "mockups", required: false, kinds: ["ui"] }],
    });
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.errors.some((e) => e.includes("consumes[0].kinds requires for_each: unit-of-work"))).toBe(true);
  });

  test("validator: an unknown kind is rejected", () => {
    const r = validate({ consumes: [{ artifact: "mockups", required: false, kinds: ["frontend"] }] });
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.errors.some((e) => e.includes('consumes[0].kinds lists unknown kind "frontend"'))).toBe(true);
  });

  test("validator: an empty kinds list is rejected", () => {
    const r = validate({ consumes: [{ artifact: "mockups", required: false, kinds: [] }] });
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.errors.some((e) => e.includes("consumes[0].kinds must be a non-empty list"))).toBe(true);
  });

  test("consumeAppliesToKind: listed kind applies, other kind does not, no list / untagged keep", () => {
    const gated = { kinds: ["ui"] };
    expect(consumeAppliesToKind(gated, "ui")).toBe(true);
    expect(consumeAppliesToKind(gated, "service")).toBe(false);
    expect(consumeAppliesToKind(gated, null)).toBe(true);
    expect(consumeAppliesToKind({}, "service")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// engine + sensor, against a graph where functional-design consumes
// `wireframes` for ui units only
// ---------------------------------------------------------------------------

function constructionState(): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: consumes kinds test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
- **Change Control**: strict (from scope feature)

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design — EXECUTE
- [ ] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE

### INCEPTION PHASE
- [-] domain-design — EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`;
}

function gatedGraph(): string {
  const graph = JSON.parse(readFileSync(SHIPPED_GRAPH, "utf-8")) as Array<{
    slug: string;
    consumes: Array<Record<string, unknown>>;
  }>;
  const fd = graph.find((s) => s.slug === "functional-design");
  if (!fd) throw new Error("functional-design missing from the shipped graph");
  fd.consumes.push({ artifact: "wireframes", required: false, kinds: ["ui"] });
  const dir = mkdtempSync(join(tmpdir(), "t338-graph-"));
  tempDirs.push(dir);
  const path = join(dir, "stage-graph.json");
  writeFileSync(path, JSON.stringify(graph));
  return path;
}

function seedProject(units: Array<{ name: string; kind?: string }>): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), constructionState());
  seedBoltDag(proj, units);
  const wf = join(proj, WIREFRAMES);
  mkdirSync(join(wf, ".."), { recursive: true });
  writeFileSync(wf, "# Wireframes\n\n+---+\n| x |\n+---+\n");
  return proj;
}

function envWith(graph: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, AIDLC_STAGE_GRAPH: graph };
  delete e.AWS_AIDLC_DEFAULT_SCOPE;
  return e;
}

function runNext(proj: string, graph: string): Record<string, unknown> {
  const r = runOrchestrateNext(ORCH, proj, [], { env: envWith(graph) });
  if (r.directive === null) {
    throw new Error(`next emitted no JSON. status=${r.status}\n${r.stdout}\n${r.stderr}`);
  }
  return r.directive;
}

function consumesOf(d: Record<string, unknown>): string[] {
  return Array.isArray(d.consumes) ? (d.consumes as string[]) : [];
}

describe("t338 consumes[].kinds - directive resolution", () => {
  test("a ui unit's directive carries the kinds-gated consume", () => {
    const graph = gatedGraph();
    const d = runNext(seedProject([{ name: "web", kind: "ui" }]), graph);
    expect(d.stage).toBe("functional-design");
    expect(d.unit).toBe("web");
    expect(consumesOf(d)).toContain(WIREFRAMES);
  }, 30000);

  test("a service unit's directive omits it", () => {
    const graph = gatedGraph();
    const d = runNext(seedProject([{ name: "api", kind: "service" }]), graph);
    expect(d.unit).toBe("api");
    expect(consumesOf(d)).not.toContain(WIREFRAMES);
  }, 30000);

  test("an untagged unit keeps it (fail-open, like produces_kinds)", () => {
    const graph = gatedGraph();
    const d = runNext(seedProject([{ name: "svc" }]), graph);
    expect(d.unit).toBe("svc");
    expect(consumesOf(d)).toContain(WIREFRAMES);
  }, 30000);
});

// The dispatcher threads `--consumes` to upstream-coverage from the stage's
// consumes filtered to files on disk. With only wireframes on disk, a ui
// unit's fire must demand a citation of it (FAILED when absent) and a service
// unit's fire must not (PASSED with the same uncited deliverable).
function fireUpstreamCoverage(
  proj: string,
  graph: string,
  unit: string,
): { result: string; detail: string } {
  const dir = join(seededRecordDir(proj), "construction", unit, "functional-design");
  mkdirSync(dir, { recursive: true });
  const spec = join(dir, "functional-spec.md");
  writeFileSync(spec, `# Functional spec for ${unit}\n\nNo upstream cited here.\n`);
  const res = spawnSync(
    BUN,
    [SENSOR, "fire", "upstream-coverage", "--stage", "functional-design", "--output-path", spec],
    { encoding: "utf-8", cwd: proj, env: { ...envWith(graph), CLAUDE_PROJECT_DIR: toPortablePath(proj) } },
  );
  const line = (res.stdout ?? "").trim().split("\n").pop() ?? "";
  let verdict: { result?: string; detail_path?: string | null } = {};
  try {
    verdict = JSON.parse(line);
  } catch {
    throw new Error(`fire emitted no verdict. status=${res.status}\n${res.stdout}\n${res.stderr}`);
  }
  const detail = verdict.detail_path ? readFileSync(join(proj, verdict.detail_path), "utf-8") : "";
  return { result: verdict.result ?? "", detail };
}

describe("t338 consumes[].kinds - upstream-coverage threading", () => {
  test("a ui unit's fire demands the wireframes citation", () => {
    const graph = gatedGraph();
    const proj = seedProject([{ name: "web", kind: "ui" }]);
    const { result, detail } = fireUpstreamCoverage(proj, graph, "web");
    expect(result).toBe("failed");
    expect(detail).toContain("wireframes");
  }, 30000);

  test("a service unit's fire never threads wireframes, so the same deliverable passes", () => {
    const graph = gatedGraph();
    const proj = seedProject([{ name: "api", kind: "service" }]);
    const { result } = fireUpstreamCoverage(proj, graph, "api");
    expect(result).toBe("passed");
  }, 30000);
});
