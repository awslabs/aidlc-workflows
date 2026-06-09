// covers: aidlc-graph:loadSensors, aidlc-graph:resolveSensorsForStage,
//         aidlc-graph:compileStageGraph (sensors_applicable resolution),
//         aidlc-graph:canonicalStageGraphJson (FIELD_ORDER pin + determinism),
//         aidlc-graph CLI `compile` / `compile --check` exit-code shell
//         (Bun.spawnSync env-seam — process.exit boundary only)
//
// Bun migration of tests/feature/t89-compile-sensors-applicable.sh (plan 22).
// The .sh spawned `bun aidlc-graph.ts compile` 11 times and inspected the
// written stage-graph.json with jq. This port IMPORTS the tool and calls
// compileStageGraph()/loadSensors()/resolveSensorsForStage() directly, then
// asserts the SAME observable behaviour off the returned { json, stages }.
//
// Surface tested (mirrors the .sh header):
//   - loadSensors() walks AIDLC_SENSORS_DIR, anchored by aidlc-<id>.md.
//   - resolveSensorsForStage looks each stage.sensors[] id up; throws on unknown.
//   - matches is copied verbatim from the manifest into the resolved entry.
//   - Manifests without matches produce entries with no matches field.
//   - matches: "" is dropped at parse time -> manifest behaves as no-matches.
//   - Duplicate manifest ids / id-filename mismatch / kind!=deterministic fail.
//   - Unknown manifest keys tolerated (forward-compat); BOM frontmatter parses.
//   - Empty sensors dir + zero-import stages produce sensors_applicable: [].
//   - Two compiles of the same input produce byte-identical JSON.
//   - compile --check detects sensor-manifest drift (CLI exit-1 shell).
//   - FIELD_ORDER places sensors_applicable directly after rules_in_context.
//
// MECHANISM SEAMS (identical to the .sh):
//   - AIDLC_SENSORS_DIR  points loadSensors() at a fixture dir.
//   - AIDLC_STAGES_DIR   overrides the stage tree (zero-imports case).
//   - AIDLC_STAGE_GRAPH  is the number/name bootstrap source for compile.
// In-process we point AIDLC_STAGE_GRAPH at the REAL committed stage-graph.json
// (read-only — compileStageGraph reads it for {slug,number,name} but does NOT
// write; only the CLI `compile` handler writes). __resetGraphCache() runs
// before every compile so the module-level _graph cache cannot leak a fixture.
//
// PARITY NOTE (verified, not assumed): the .sh comment for case 5 claims
// "schema rejects matches:''". The empty-matches fixture ships ONLY
// aidlc-linter.md; parseSensorManifest drops matches:"" at parse time
// (scalarField returns "" -> `if (matches !== "")` omits it), so the manifest
// validates fine as a no-matches manifest. compile actually fails on the SAME
// unknown-id resolution path as the unknown-id fixture (real stages import
// required-sections/upstream-coverage which aren't present). The .sh only
// asserts the EXIT CODE (1) for case 5, so the behavioural contract preserved
// here is exactly that: compileStageGraph() throws on this fixture. The
// parse-drops-empty-matches fact is pinned explicitly as an extra guard.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetGraphCache,
  compileStageGraph,
  type GraphStage,
  loadSensors,
  resolveSensorsForStage,
} from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { parseSensorManifest } from "../../dist/claude/.claude/tools/aidlc-sensor-schema.ts";

const TOOLS_DIR = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools");
const GRAPH_TS = join(TOOLS_DIR, "aidlc-graph.ts");
const SEED_GRAPH = join(TOOLS_DIR, "data", "stage-graph.json");
const FIXTURES = join(import.meta.dir, "..", "fixtures", "v05-mr7b-sensor-resolution");
const REAL_STAGES = join(
  import.meta.dir, "..", "..", "dist", "claude", ".claude", "aidlc-common", "stages",
);

const BUN = process.execPath; // the bun binary running this test

// --- env-seam harness -------------------------------------------------------
// compileStageGraph() reads AIDLC_SENSORS_DIR (+ optionally AIDLC_STAGES_DIR)
// at call time and AIDLC_STAGE_GRAPH for the number/name bootstrap. Set them,
// reset the cache, call, then restore env. Mirrors the .sh's per-case env
// assignment + fresh-tempfile discipline (here we never write, so the real
// graph is a safe read-only bootstrap).
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
beforeEach(() => {
  __resetGraphCache();
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
  __resetGraphCache();
});

/** Compile against a sensors fixture dir, returning { json, stages }. The real
 *  committed stage-graph.json is the number/name bootstrap (read-only). */
function compileWithSensors(fixtureDir: string): {
  json: string;
  stages: GraphStage[];
} {
  setEnv("AIDLC_SENSORS_DIR", fixtureDir);
  setEnv("AIDLC_STAGE_GRAPH", SEED_GRAPH);
  setEnv("AIDLC_STAGES_DIR", undefined); // real stage tree
  __resetGraphCache();
  return compileStageGraph();
}

function stageBySlug(stages: GraphStage[], slug: string): GraphStage {
  const s = stages.find((x) => x.slug === slug);
  if (!s) throw new Error(`test bug: stage "${slug}" not found in compiled graph`);
  return s;
}

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) {
    try {
      rmSync(scratch.pop()!, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// =========================================================================
// In-process cases (call the tool directly).
// =========================================================================

describe("t89 sensors_applicable resolution (in-process compileStageGraph)", () => {
  // Case 1 (.sh:64-66): basic-import — code-generation resolves 2 sensors.
  test("basic-import: code-generation has 2 resolved sensors", () => {
    const { stages } = compileWithSensors(join(FIXTURES, "basic-import"));
    expect(stageBySlug(stages, "code-generation").sensors_applicable).toHaveLength(2);
  });

  // Case 2 (.sh:68-70): resolved entries carry id and .claude/... path.
  test("basic-import: first sensor id+path correct", () => {
    const { stages } = compileWithSensors(join(FIXTURES, "basic-import"));
    const first = stageBySlug(stages, "code-generation").sensors_applicable[0];
    expect(`${first.id}|${first.path}`).toBe("linter|.claude/sensors/aidlc-linter.md");
  });

  // Case 3 (.sh:72-75): matches glob copied verbatim from the manifest.
  test("matches-passthrough: matches copied verbatim", () => {
    const { stages } = compileWithSensors(join(FIXTURES, "matches-passthrough"));
    const linter = stageBySlug(stages, "code-generation").sensors_applicable.find(
      (s) => s.id === "linter",
    );
    expect(linter?.matches).toBe("**/distinctive-glob/**/*.ts");
  });

  // Case 4 (.sh:77-80): manifests with no matches field omit it (not "").
  test("no-matches: matches field omitted (not empty string)", () => {
    const { stages } = compileWithSensors(join(FIXTURES, "no-matches"));
    const linter = stageBySlug(stages, "code-generation").sensors_applicable.find(
      (s) => s.id === "linter",
    );
    expect(linter).toBeDefined();
    expect(Object.hasOwn(linter!, "matches")).toBe(false);
  });

  // Case 5 (.sh:82-89): empty-matches fixture fails compile (exit 1 in .sh).
  // In-process contract: compileStageGraph() throws on this fixture. (See the
  // PARITY NOTE — the failure is the unknown-id resolution path, not a schema
  // rejection, because matches:"" is dropped at parse time.)
  test("empty-matches: compile throws (maps to .sh exit 1)", () => {
    setEnv("AIDLC_SENSORS_DIR", join(FIXTURES, "empty-matches"));
    setEnv("AIDLC_STAGE_GRAPH", SEED_GRAPH);
    __resetGraphCache();
    expect(() => compileStageGraph()).toThrow();
  });

  // Extra guard pinning the verified parse semantic behind case 5: matches:""
  // is dropped at parse time, so the manifest is indistinguishable from a
  // no-matches manifest. This is WHY case 5's failure is the unknown-id path.
  test("empty-matches: parseSensorManifest drops matches:\"\" (no matches key)", () => {
    const raw =
      '---\nid: linter\nkind: deterministic\n' +
      'command: bun .claude/tools/aidlc-sensor.ts fire linter\n' +
      'default_severity: advisory\ndescription: d\nmatches: ""\n---\n';
    const m = parseSensorManifest(raw);
    expect(Object.hasOwn(m, "matches")).toBe(false);
    expect(m.matches).toBeUndefined();
  });

  // Case 6 (.sh:92-96): multi-import — declared order preserved.
  test("multiple-imports: resolution order matches authored order", () => {
    const { stages } = compileWithSensors(join(FIXTURES, "basic-import"));
    const ids = stageBySlug(stages, "functional-design").sensors_applicable.map((s) => s.id);
    expect(ids).toEqual(["required-sections", "upstream-coverage", "linter", "type-check"]);
  });

  // Case 7 (.sh:98-101): every initialization stage (sensors: []) resolves [].
  test("empty imports: every initialization stage has length 0", () => {
    const { stages } = compileWithSensors(join(FIXTURES, "basic-import"));
    const initStages = stages.filter((s) => s.phase === "initialization");
    expect(initStages.length).toBeGreaterThan(0);
    expect(initStages.every((s) => s.sensors_applicable.length === 0)).toBe(true);
  });

  // Case 8 (.sh:103-114): zero-sensors dir + zero-import stages => all [].
  // Override AIDLC_STAGES_DIR with a temp tree holding only the initialization
  // phase (every stage there declares sensors: []) and an empty sensors dir.
  test("zero-sensors + zero-imports: every stage gets sensors_applicable: []", () => {
    const stagesRoot = mkdtempSync(join(tmpdir(), "t89-zero-stages-"));
    const sensorsRoot = mkdtempSync(join(tmpdir(), "t89-zero-sensors-"));
    scratch.push(stagesRoot, sensorsRoot);
    cpSync(join(REAL_STAGES, "initialization"), join(stagesRoot, "initialization"), {
      recursive: true,
    });
    setEnv("AIDLC_STAGES_DIR", stagesRoot);
    setEnv("AIDLC_SENSORS_DIR", sensorsRoot);
    setEnv("AIDLC_STAGE_GRAPH", SEED_GRAPH);
    __resetGraphCache();
    const { stages } = compileStageGraph();
    expect(stages.length).toBeGreaterThan(0);
    expect(stages.every((s) => s.sensors_applicable.length === 0)).toBe(true);
  });

  // Case 9 (.sh:117-128): unknown-id fixture — compile throws and the message
  // names the unknown sensor id. (.sh asserts exit 1 + stderr "unknown sensor id".)
  test("unknown-id: compile throws naming 'unknown sensor id'", () => {
    setEnv("AIDLC_SENSORS_DIR", join(FIXTURES, "unknown-id"));
    setEnv("AIDLC_STAGE_GRAPH", SEED_GRAPH);
    __resetGraphCache();
    expect(() => compileStageGraph()).toThrow(/unknown sensor id/);
  });

  // Case 10 (.sh:131-147): duplicate-id fixture — compile throws; message names
  // either the duplicate-id guard OR the id<->filename cross-check (whichever
  // loud-failure path fires first under filesystem ordering — both name a path).
  test("duplicate-id: compile throws naming a manifest path", () => {
    setEnv("AIDLC_SENSORS_DIR", join(FIXTURES, "duplicate-id"));
    setEnv("AIDLC_STAGE_GRAPH", SEED_GRAPH);
    __resetGraphCache();
    expect(() => compileStageGraph()).toThrow(
      /duplicate sensor id|must match filename stem/,
    );
  });

  // Case 11 (.sh:150-157): id-filename-mismatch — compile throws.
  test("id-filename-mismatch: compile throws", () => {
    setEnv("AIDLC_SENSORS_DIR", join(FIXTURES, "id-filename-mismatch"));
    setEnv("AIDLC_STAGE_GRAPH", SEED_GRAPH);
    __resetGraphCache();
    expect(() => compileStageGraph()).toThrow(/must match filename stem/);
  });

  // Case 12 (.sh:160-167): unknown-kind (kind: llm) — compile throws.
  test("unknown-kind: compile rejects kind != deterministic", () => {
    setEnv("AIDLC_SENSORS_DIR", join(FIXTURES, "unknown-kind"));
    setEnv("AIDLC_STAGE_GRAPH", SEED_GRAPH);
    __resetGraphCache();
    expect(() => compileStageGraph()).toThrow(/kind must be "deterministic"/);
  });

  // Case 13 (.sh:170-173): unknown manifest keys tolerated; sensors still resolve.
  test("unknown-keys-tolerated: compile succeeds; sensors still resolve", () => {
    const { stages } = compileWithSensors(join(FIXTURES, "unknown-keys-tolerated"));
    expect(stageBySlug(stages, "intent-capture").sensors_applicable).toHaveLength(2);
  });

  // Case 14 (.sh:175-178): BOM-prefixed frontmatter parses correctly.
  test("BOM-frontmatter: leading BOM byte does not break the parser", () => {
    const { stages } = compileWithSensors(join(FIXTURES, "bom-frontmatter"));
    expect(stageBySlug(stages, "intent-capture").sensors_applicable).toHaveLength(2);
  });

  // Case 15 (.sh:180-187): round-trip determinism — same input, identical JSON.
  test("round-trip: same fixture produces byte-identical compile output", () => {
    const a = compileWithSensors(join(FIXTURES, "basic-import")).json;
    const b = compileWithSensors(join(FIXTURES, "basic-import")).json;
    expect(a).toBe(b);
  });

  // Case 17 (.sh:206-221): compile-snapshot semantics. A compiled JSON is a
  // point-in-time snapshot — matches is copied verbatim at compile and editing
  // the manifest afterward does NOT retroactively mutate an already-emitted
  // snapshot; the new value only appears on the NEXT compile. The .sh proved
  // this by writing the graph, editing the manifest, and re-reading the file
  // (no recompile) to show the value frozen. In-process the snapshot is the
  // returned json string (immutable); we assert (a) the pre-edit snapshot
  // carries the pre-edit glob, and (b) a recompile after the edit picks up the
  // new glob — which is exactly the "frozen until next compile" contract.
  test("compile-snapshot: matches frozen in emitted JSON; recompile picks up edit", () => {
    const dir = mkdtempSync(join(tmpdir(), "t89-snapshot-"));
    scratch.push(dir);
    for (const f of readdirSync(join(FIXTURES, "basic-import"))) {
      copyFileSync(join(FIXTURES, "basic-import", f), join(dir, f));
    }

    const linterPath = join(dir, "aidlc-linter.md");
    const before = compileWithSensors(dir);
    const beforeGlob = stageBySlug(before.stages, "code-generation").sensors_applicable.find(
      (s) => s.id === "linter",
    )?.matches;
    expect(beforeGlob).toBe("**/*.{ts,js}");

    // Mutate the manifest on disk AFTER the first compile.
    const orig = readFileSync(linterPath, "utf-8");
    writeFileSync(linterPath, orig.replace('"**/*.{ts,js}"', '"**/post-edit/*.ts"'));

    // The already-emitted snapshot string is unchanged (it is a value, not a
    // live view) — its serialized glob is still the pre-edit value.
    expect(before.json).toContain('"**/*.{ts,js}"');
    expect(before.json).not.toContain('"**/post-edit/*.ts"');

    // A fresh compile reflects the edit — proving the snapshot is frozen only
    // until the next compile, never re-read retroactively.
    const after = compileWithSensors(dir);
    const afterGlob = stageBySlug(after.stages, "code-generation").sensors_applicable.find(
      (s) => s.id === "linter",
    )?.matches;
    expect(afterGlob).toBe("**/post-edit/*.ts");
  });

  // Case 18 (.sh:224-228): FIELD_ORDER — sensors_applicable follows rules_in_context.
  test("FIELD_ORDER: sensors_applicable follows rules_in_context", () => {
    const { json } = compileWithSensors(join(FIXTURES, "basic-import"));
    const first = JSON.parse(json)[0] as Record<string, unknown>;
    const keys = Object.keys(first);
    const idx = keys.indexOf("rules_in_context");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(keys[idx + 1]).toBe("sensors_applicable");
  });

  // Case 19 (.sh:230-241): per-stage matrix — code-generation=2, build-and-test=3,
  // workspace-scaffold=0, functional-design=4.
  test("per-stage matrix: CG=2, BT=3, WS=0, FD=4", () => {
    const { stages } = compileWithSensors(join(FIXTURES, "basic-import"));
    expect(stageBySlug(stages, "code-generation").sensors_applicable.length).toBe(2);
    expect(stageBySlug(stages, "build-and-test").sensors_applicable.length).toBe(3);
    expect(stageBySlug(stages, "workspace-scaffold").sensors_applicable.length).toBe(0);
    expect(stageBySlug(stages, "functional-design").sensors_applicable.length).toBe(4);
  });

  // Direct-unit reinforcement (not a distinct .sh case, but pins the units the
  // .sh exercised only transitively through compile): loadSensors() keys by id;
  // resolveSensorsForStage preserves declared order and throws on unknown ids.
  test("loadSensors + resolveSensorsForStage: order preserved, unknown id throws", () => {
    setEnv("AIDLC_SENSORS_DIR", join(FIXTURES, "basic-import"));
    __resetGraphCache();
    const byId = loadSensors();
    expect([...byId.keys()].sort()).toEqual([
      "linter",
      "required-sections",
      "type-check",
      "upstream-coverage",
    ]);
    const fakeStage = { slug: "x", sensors: ["type-check", "linter"] } as unknown as GraphStage;
    const resolved = resolveSensorsForStage(fakeStage, byId);
    expect(resolved.map((s) => s.id)).toEqual(["type-check", "linter"]);
    const bad = { slug: "y", sensors: ["nope"] } as unknown as GraphStage;
    expect(() => resolveSensorsForStage(bad, byId)).toThrow(/unknown sensor id "nope"/);
  });
});

// =========================================================================
// CLI exit-code shell cases — kept as Bun.spawnSync env-seam tests because
// they assert the process.exit boundary, not the resolution logic:
//   - Case 5/9/10/11/12 assert the CLI maps a thrown compile -> exit 1. The
//     logic is covered in-process above; this proves the shell wiring once.
//   - Case 16 (compile --check) calls runCompileCheck(), which is NOT exported
//     and does process.exit(1) directly after an on-disk byte-compare. There
//     is no in-process seam for it, so it stays a spawn case.
// =========================================================================

describe("t89 CLI exit-code shell (Bun.spawnSync env-seam)", () => {
  /** Seed a fresh tempfile from the real graph, run the CLI against a fixture. */
  function runCompile(sensorsDir: string, extraArgs: string[] = []): { code: number } {
    const out = mkdtempSync(join(tmpdir(), "t89-cli-"));
    scratch.push(out);
    const graph = join(out, "stage-graph.json");
    copyFileSync(SEED_GRAPH, graph);
    const res = spawnSync(BUN, [GRAPH_TS, "compile", ...extraArgs], {
      env: { ...process.env, AIDLC_SENSORS_DIR: sensorsDir, AIDLC_STAGE_GRAPH: graph },
      encoding: "utf8",
    });
    return { code: res.status ?? -1 };
  }

  // Case 5 (.sh:82-89): empty-matches — CLI exits 1.
  test("empty-matches: compile exits 1", () => {
    expect(runCompile(join(FIXTURES, "empty-matches")).code).toBe(1);
  });

  // Case 9/10/11/12 representative: unknown-id — CLI exits 1.
  test("unknown-id: compile exits 1", () => {
    expect(runCompile(join(FIXTURES, "unknown-id")).code).toBe(1);
  });

  // Case 16 (.sh:189-204): compile --check detects sensor-manifest drift.
  // Compile once to seed the on-disk graph, edit the linter matches glob, then
  // `compile --check` against the same graph must exit 1 (runCompileCheck's
  // process.exit boundary — no in-process seam exists).
  test("--check: detects sensor-manifest drift after edit", () => {
    const dir = mkdtempSync(join(tmpdir(), "t89-check-"));
    const out = mkdtempSync(join(tmpdir(), "t89-check-graph-"));
    scratch.push(dir, out);
    const graph = join(out, "stage-graph.json");
    copyFileSync(SEED_GRAPH, graph);
    for (const f of readdirSync(join(FIXTURES, "basic-import"))) {
      copyFileSync(join(FIXTURES, "basic-import", f), join(dir, f));
    }
    const env = { ...process.env, AIDLC_SENSORS_DIR: dir, AIDLC_STAGE_GRAPH: graph };

    const seed = spawnSync(BUN, [GRAPH_TS, "compile"], { env, encoding: "utf8" });
    expect(seed.status).toBe(0);

    // Edit the linter manifest's matches glob; --check should now fail.
    const linterPath = join(dir, "aidlc-linter.md");
    const orig = readFileSync(linterPath, "utf-8");
    writeFileSync(linterPath, orig.replace('"**/*.{ts,js}"', '"**/*.{ts,js,jsx}"'));

    const check = spawnSync(BUN, [GRAPH_TS, "compile", "--check"], { env, encoding: "utf8" });
    expect(check.status).toBe(1);
  });
});
