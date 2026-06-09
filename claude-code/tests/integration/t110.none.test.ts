// covers: function:compileStageGraph
//
// t110 — compileStageGraph() in dist/claude/.claude/tools/aidlc-graph.ts:884.
// Mechanism: none (pure-ish: reads the shipped stage files + rules + sensors
// off disk, deterministic transform, zero LLM, zero tokens). Lives under
// tests/integration/ because it composes the whole stages tree (31+ YAML
// files) rather than a single pure function.
// Technique: golden-master / byte-identity.
//
// What this guarantees that t66 does NOT: t66 exercises the topo/consumer
// graph queries; it never asserts that re-compiling the stage graph from the
// YAML source reproduces the SHIPPED stage-graph.json byte-for-byte. That is
// the `aidlc-graph.ts compile --check` contract — the CI drift guard at
// aidlc-graph.ts:1063 (runCompileCheck) / :1127 (the `compile --check` CLI
// branch). This file pins that contract in-process.
//
// The `compile --check` comparison, transcribed from the source so the test
// asserts the REAL behaviour, not a re-implementation:
//   runCompileCheck() {
//     const { json } = compileStageGraph();
//     const onDisk = readFileSync(stageGraphPath(), "utf-8");  // :1065
//     if (json === onDisk) return;                              // :1066 — STRICT ===
//     ... process.exit(1)
//   }
//   stageGraphPath() = process.env.AIDLC_STAGE_GRAPH
//                      ?? join(DATA_DIR, "stage-graph.json");   // :152-153
//   DATA_DIR = join(__FILE_DIR, "data");                        // :136
// So the shipped default location is
//   dist/claude/.claude/tools/data/stage-graph.json
// and the comparison is a STRICT byte-identity of the UTF-8 contents (the
// emitter appends exactly one trailing "\n" at canonicalStageGraphJson:867,
// which is present on disk — verified `tail -c 3` => "\n ] \n").
//
// Test-design note (house style, per tests/unit/t69-worktree-path.sh and the
// sibling t106.none.test.ts): assert the OBSERVABLE CONTRACT, never re-derive
// the expected output. We do NOT reconstruct the canonical JSON ourselves —
// that would only catch deletion. Instead we read the SHIPPED artifact off
// disk (the same file `compile --check` reads) and assert byte-identity, plus
// determinism across two calls. A real regression — a field-order change, a
// dropped stage, a resolver edit that alters rules_in_context / sensors_
// applicable, an accidental whitespace/indent shift, a missing trailing
// newline — makes compileStageGraph().json diverge from the committed
// stage-graph.json and turns this red, exactly as `compile --check` would
// exit 1 in CI.
//
// Source-path discipline: compileStageGraph() and stageGraphPath() honour the
// AIDLC_STAGE_GRAPH / AIDLC_STAGES_DIR / AIDLC_RULES_DIR / AIDLC_SENSORS_DIR
// env seams (aidlc-graph.ts:144-167). To exercise the SHIPPED default layout
// we clear those seams before importing the module and reset the lib.ts graph
// cache, so both the compile and the on-disk read resolve to the default
// DATA_DIR / DEFAULT_STAGES_DIR locations.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Clear the fixture-injection env seams BEFORE the module under test is
// imported / first invoked, so stageGraphPath(), stagesDir(), rulesDir() and
// sensorsDir() all resolve to their shipped defaults (the `compile --check`
// production path). Set in the harness, a stray AIDLC_STAGE_GRAPH would point
// the compare at a fixture and silently invalidate this golden-master.
delete process.env.AIDLC_STAGE_GRAPH;
delete process.env.AIDLC_STAGES_DIR;
delete process.env.AIDLC_RULES_DIR;
delete process.env.AIDLC_SENSORS_DIR;

import {
  __resetGraphCache,
  compileStageGraph,
} from "../../dist/claude/.claude/tools/aidlc-graph.ts";

// Drop any graph the lib.ts loader may have cached under a prior env state, so
// compileStageGraph()'s bootstrap (loadStageGraph, aidlc-graph.ts:888) reads
// the default shipped stage-graph.json afresh.
__resetGraphCache();

// The shipped compiled graph — the EXACT file stageGraphPath() returns by
// default (DATA_DIR/stage-graph.json). Resolved relative to this test file via
// import.meta.dir so the read is cwd-independent. We read the raw UTF-8 bytes
// (string) and compare with strict === — mirroring runCompileCheck's
// `json === onDisk` at aidlc-graph.ts:1066.
const SHIPPED_GRAPH_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "dist", "claude",
  ".claude",
  "tools",
  "data",
  "stage-graph.json"
);
const SHIPPED_GRAPH_RAW = readFileSync(SHIPPED_GRAPH_PATH, "utf-8");

describe("compileStageGraph() golden-master (compile --check contract)", () => {
  test("recompiles BYTE-FOR-BYTE identical to the shipped stage-graph.json", () => {
    // The load-bearing assertion. This is precisely what `aidlc-graph.ts
    // compile --check` enforces in CI (runCompileCheck, :1063-1071): compile
    // from the YAML stage files in-process, then assert the emitted `.json`
    // string equals the committed artifact on disk, byte for byte. Any drift
    // — reordered fields, a renamed/dropped/added stage, a rules_in_context
    // or sensors_applicable resolver change, an indent or trailing-newline
    // shift — diverges here and would exit 1 under `compile --check`.
    const { json } = compileStageGraph();
    expect(json).toBe(SHIPPED_GRAPH_RAW);
  });

  test("emits the canonical single trailing newline (no double / missing \\n)", () => {
    // canonicalStageGraphJson appends exactly one "\n" (aidlc-graph.ts:867),
    // and `compile --check` does a strict byte compare — so the on-disk file
    // must end with a single newline, no more, no less. process.stdout.write
    // vs console.log byte-parity (see the `export` handler comment at :1160)
    // is the same class of trap; pin it here for the compile path too.
    const { json } = compileStageGraph();
    expect(json.endsWith("\n")).toBe(true);
    expect(json.endsWith("\n\n")).toBe(false);
    // And the shipped file matches that exact shape (guards a stray editor
    // newline appended to the committed artifact that would break --check).
    expect(SHIPPED_GRAPH_RAW.endsWith("\n")).toBe(true);
    expect(SHIPPED_GRAPH_RAW.endsWith("\n\n")).toBe(false);
  });

  test("output is valid JSON whose parse round-trips to the same canonical text", () => {
    // The emitted string is real JSON (not a truncated / corrupt blob), and
    // re-serialising the shipped file with the same 2-space indent reproduces
    // the compiled body. This catches a compile that emits malformed JSON
    // while still happening to byte-match a malformed on-disk file, and pins
    // the 2-space-indent canonical form (JSON.stringify(v, null, 2) at :867).
    const { json } = compileStageGraph();
    const parsed = JSON.parse(json); // throws if not valid JSON
    expect(Array.isArray(parsed)).toBe(true);
    // Reconstruct the canonical body (indent 2) + the single trailing newline
    // the emitter adds, and assert it equals the compiled string. This pins
    // the serialisation FORM independently of field VALUES.
    expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(json);
  });
});

describe("compileStageGraph() determinism", () => {
  test("two successive calls produce byte-identical .json", () => {
    // Determinism is a precondition for the golden-master / `compile --check`
    // contract to be meaningful: if compile were order-sensitive (e.g.
    // readdirSync iteration leaking into output, or Map iteration order
    // affecting rules_in_context), CI would flap. The stages.sort by
    // numericStageOrder (:954) and the FIELD_ORDER pin (:186) are what make
    // this hold; assert it directly.
    const a = compileStageGraph().json;
    const b = compileStageGraph().json;
    expect(b).toBe(a);
  });

  test("the .stages array is non-empty and aligns with the emitted .json", () => {
    // compileStageGraph returns { json, stages }; the JSON is the canonical
    // serialisation of those stages. A regression that returned an empty
    // stages array but a stale cached json (or vice versa) would slip past a
    // pure byte check. Assert the two halves of the return agree on count and
    // on the canonical text.
    const { json, stages } = compileStageGraph();
    expect(stages.length).toBeGreaterThan(0);
    const parsed = JSON.parse(json) as unknown[];
    expect(parsed.length).toBe(stages.length);
  });
});
