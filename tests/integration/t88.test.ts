// covers: function:compileStageGraph
//
// In-process port of tests/integration/t88-compile-rules-in-context.sh (TAP plan
// 11), mechanism = none. The .sh exercised the rules_in_context resolution
// half of `aidlc-graph compile` by SHELLING OUT to `bun aidlc-graph.ts
// compile` (discarding stdout) and then reading the rules_in_context arrays
// back out of the written stage-graph.json with jq. The contract under test
// is the PURE function compileStageGraph() — it has no process.exit shell of
// its own (the CLI `compile` handler wraps it; runCompileCheck() likewise
// just compares its json output to disk). compileStageGraph is exported
// (aidlc-graph.ts) and reads its inputs through the documented env-var
// seams (AIDLC_RULES_DIR -> rulesDir, AIDLC_STAGE_GRAPH -> bootstrap source),
// so every behavioural contract migrates to a direct in-process call. This
// is the .none mechanism: import the pure function, drive it via the env
// seams the .sh already used, assert on the returned { json, stages } object
// instead of on the jq projection of the file the CLI wrote — same
// observable (the materialised rules_in_context field values), expressed
// against the real return shape. Zero subprocess, zero LLM, zero tokens.
//
// MECHANISM CHOICE (.none vs .cli): the .sh ran `bun ... compile` because
// bash cannot call a TS function; the test is about the resolution output,
// not about the CLI's exit-code shell. compileStageGraph itself is the unit
// — its rules_in_context resolution is what the .sh's jq probes measured.
// The two cases that depended on the CLI's exit code (case 9 `--check` drift,
// case 10 bad-pairing fail) are NOT CLI-arg-parsing behaviour: `--check`'s
// drift signal is exactly `compileStageGraph().json !== <on-disk graph>`
// (runCompileCheck, aidlc-graph.ts) - reproduced here by comparing
// the function output to a temp graph file we wrote a prior compile to; and
// the bad-pairing "exit 1" is a `throw` out of loadRules ->
// validateRuleFrontmatter (aidlc-rule-schema.ts) that compileStageGraph
// propagates — asserted here with expect(...).toThrow. Both observables
// (drift detected / compile rejects) are preserved without a subprocess.
//
// EQUAL-OR-STRONGER PARITY (each .sh `assert_eq`/`ok` -> an expect() below;
// several STRONGER than the original jq scalar projection):
//   - .sh C1  org-only len==1                 -> Test 1:  exact length 1
//       (STRONGER: also asserts it's the ONLY rule across the whole graph by
//        checking every stage has length 1).
//   - .sh C1  org-only scope[0]=="org"        -> Test 2:  scope === "org".
//   - .sh C2  org-team-project order o,t,p    -> Test 3:  map(scope) deep-
//       equals ["org","team","project"] (STRONGER: exact array, plus every
//        stage carries the same triple, not just stage[0]).
//   - .sh C3  all-four construction len==4    -> Test 4:  every construction
//        stage length 4 AND scope tuple is exactly org,team,project,phase
//        (STRONGER: pins the phase entry's position + scope value).
//   - .sh C3  all-four init len==3 (no phase) -> Test 5:  every initialization
//        stage length 3, scopes org,team,project, NO phase entry (STRONGER:
//        asserts phase absence explicitly).
//   - .sh C7  pairing-feedforward-only len==1 -> Test 6:  schema-valid (no
//        throw) AND length 1, scope org (STRONGER: the .sh only checked len).
//   - .sh C8  zero-rules all len==0           -> Test 7:  every stage's
//        rules_in_context is [] (empty rules dir).
//   - .sh C9  --check detects drift           -> Test 8:  compile A -> json,
//        write to disk; add a team rule; recompile -> json !== on-disk
//        (the exact drift predicate runCompileCheck uses to exit 1) AND the
//        re-resolved chain length grew org->org+team (STRONGER: pins WHY it
//        drifted, not just THAT it drifted).
//   - .sh C10 round-trip byte-identical       -> Test 9:  two compiles of the
//        same fixture produce byte-identical json.
//   - .sh C8(bad pairing) invalid fails       -> Test 10: compileStageGraph
//        throws, message names the file path AND the pairing diagnostic
//        (STRONGER: the .sh only checked exit 1).
//   - .sh C12 BOM construction has phase      -> Test 11: every construction
//        stage's scope set contains "phase" (BOM stripped, frontmatter parsed)
//        AND length 4 (STRONGER: full chain attaches, not just the phase tag).
//
// 11 .sh asserts -> 11 expect()-bearing migrated cases here, one observable per
// case, matching the .sh's 11 `ok` lines, plus lifecycle compile rejection
// coverage.
//
// FIXTURE DISCIPLINE: the resolution fixtures live on disk at
// tests/fixtures/v05-mr7a-rule-resolution/<case>/ (the .sh's $FIXTURES) —
// READ ONLY, never mutated. AIDLC_RULES_DIR is pointed at each in turn.
// AIDLC_STAGE_GRAPH is pointed at the real shipped stage-graph.json (the
// bootstrap source the .sh copied byte-for-byte into a tempfile so the
// number/name harvest succeeds — identical contents, so no copy is needed
// for a read-only bootstrap). The cases that need a WRITABLE rules dir
// (case 8's drift edit, case 10's bad-pairing file, lifecycle validation) and the empty-dir case
// (case 7) build throwaway temp dirs under tmpdir(), cleaned in afterAll —
// nothing is written under tests/fixtures/**. __resetGraphCache() is called
// before each compile (the documented test seam, aidlc-graph.ts) because
// loadStageGraph caches per-process; loadRules itself is uncached and re-walks
// AIDLC_RULES_DIR every call, so the fixture swap is always honoured.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetGraphCache,
  compileStageGraph,
  type GraphStage,
} from "../../dist/claude/.claude/tools/aidlc-graph.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const FIXTURES = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "v05-mr7a-rule-resolution",
);
// The bootstrap source: compileStageGraph harvests {number, name} from the
// existing stage-graph.json. For a read-only bootstrap pointing the seam
// straight at the shipped file is safe (compile never writes to it -
// the CLI `compile` handler does the writeFileAtomic, not the function).
const SEED_GRAPH = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "data",
  "stage-graph.json",
);

const tempDirs: string[] = [];

function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// Restore the env between cases so a leaked AIDLC_RULES_DIR / AIDLC_STAGE_GRAPH
// from one test can't shadow the next.
let savedRulesDir: string | undefined;
let savedStageGraph: string | undefined;

beforeEach(() => {
  savedRulesDir = process.env.AIDLC_RULES_DIR;
  savedStageGraph = process.env.AIDLC_STAGE_GRAPH;
  process.env.AIDLC_STAGE_GRAPH = SEED_GRAPH;
});

afterEach(() => {
  if (savedRulesDir === undefined) delete process.env.AIDLC_RULES_DIR;
  else process.env.AIDLC_RULES_DIR = savedRulesDir;
  if (savedStageGraph === undefined) delete process.env.AIDLC_STAGE_GRAPH;
  else process.env.AIDLC_STAGE_GRAPH = savedStageGraph;
  __resetGraphCache();
});

function compileWithRulesDir(dir: string): {
  json: string;
  stages: GraphStage[];
} {
  process.env.AIDLC_RULES_DIR = dir;
  __resetGraphCache();
  return compileStageGraph();
}

/** scopes of a stage's rules_in_context, in resolution order. */
const scopesOf = (s: GraphStage): string[] =>
  s.rules_in_context.map((r) => r.scope);

describe("t88 compileStageGraph rules_in_context resolution (migrated from t88-compile-rules-in-context.sh, plan 11)", () => {
  // --- Case 1: org-only ----------------------------------------------------
  test("1: org-only -> rules_in_context length is 1 on every stage", () => {
    const { stages } = compileWithRulesDir(join(FIXTURES, "org-only"));
    expect(stages[0].rules_in_context).toHaveLength(1);
    // The single org rule attaches to EVERY stage (universal-default tier), so
    // all stages are length 1.
    expect(stages.every((s) => s.rules_in_context.length === 1)).toBe(true);
  });

  test("2: org-only -> the single entry has scope=org", () => {
    const { stages } = compileWithRulesDir(join(FIXTURES, "org-only"));
    expect(stages[0].rules_in_context[0].scope).toBe("org");
  });

  // --- Case 2: org-team-project --------------------------------------------
  test("3: org-team-project -> precedence order org,team,project", () => {
    const { stages } = compileWithRulesDir(join(FIXTURES, "org-team-project"));
    expect(scopesOf(stages[0])).toEqual(["org", "team", "project"]);
    expect(
      stages.every(
        (s) =>
          s.rules_in_context.length === 3 &&
          scopesOf(s).join(",") === "org,team,project",
      ),
    ).toBe(true);
  });

  // --- Case 3: all-four (cross-phase) --------------------------------------
  test("4: all-four -> every construction stage has length 4 (org,team,project,phase)", () => {
    const { stages } = compileWithRulesDir(join(FIXTURES, "all-four"));
    const construction = stages.filter((s) => s.phase === "construction");
    expect(construction.length).toBeGreaterThan(0);
    expect(construction.every((s) => s.rules_in_context.length === 4)).toBe(
      true,
    );
    expect(
      construction.every(
        (s) => scopesOf(s).join(",") === "org,team,project,phase",
      ),
    ).toBe(true);
  });

  test("5: all-four -> every initialization stage has length 3 (no phase rule)", () => {
    const { stages } = compileWithRulesDir(join(FIXTURES, "all-four"));
    const init = stages.filter((s) => s.phase === "initialization");
    expect(init.length).toBeGreaterThan(0);
    expect(init.every((s) => s.rules_in_context.length === 3)).toBe(true);
    // The phase rule (phases/construction.md) must NOT attach to initialization
    // stages - assert phase scope is absent.
    expect(init.every((s) => !scopesOf(s).includes("phase"))).toBe(true);
  });

  test("6: pairing-feedforward-only -> schema-valid; rule still resolves (length 1, org)", () => {
    const fixture = join(FIXTURES, "pairing-feedforward-only");
    // Schema-valid pairing: feedforward-only must NOT throw.
    expect(() => compileWithRulesDir(fixture)).not.toThrow();
    const { stages } = compileWithRulesDir(fixture);
    expect(stages[0].rules_in_context).toHaveLength(1);
    expect(stages[0].rules_in_context[0].scope).toBe("org");
  });

  test("7: zero-rules -> every stage gets rules_in_context []", () => {
    // Empty temp dir == no rule files == loadRules returns [].
    const empty = mkTemp("aidlc-t88-zero-");
    const { stages } = compileWithRulesDir(empty);
    expect(stages.every((s) => s.rules_in_context.length === 0)).toBe(true);
  });

  // --- Case 9: --check round-trip detects rule-file edits ------------------
  test("8: --check semantics -> adding a rule after compile produces drift", () => {
    // Reproduces runCompileCheck's graph comparison (aidlc-graph.ts): drift == the
    // freshly-compiled json differs from the on-disk graph. Compile org-only,
    // write that json to a temp graph file (stands in for stage-graph.json on
    // disk), then add a team rule to a WRITABLE rules dir and recompile.
    const rulesDir = mkTemp("aidlc-t88-check-rules-");
    cpSync(join(FIXTURES, "org-only", "org.md"), join(rulesDir, "org.md"));

    const first = compileWithRulesDir(rulesDir);
    const onDisk = first.json;
    expect(first.stages[0].rules_in_context.map((r) => r.scope)).toEqual(["org"]);

    writeFileSync(
      join(rulesDir, "team.md"),
      "# team rule added after compile\n",
      "utf-8",
    );
    const second = compileWithRulesDir(rulesDir);
    // runCompileCheck's graph-drift predicate is json !== onDisk.
    expect(second.json).not.toBe(onDisk);
    // Pin WHY it drifted - the chain grew org -> org+team.
    expect(second.stages[0].rules_in_context.map((r) => r.scope)).toEqual([
      "org",
      "team",
    ]);
  });

  test("9: round-trip -> same fixture produces byte-identical compile output", () => {
    const a = compileWithRulesDir(join(FIXTURES, "all-four")).json;
    const b = compileWithRulesDir(join(FIXTURES, "all-four")).json;
    expect(b).toBe(a);
  });

  // --- Case 8 (bad pairing): schema rejection ------------------------------
  test("10: invalid pairing value fails compile (throws, names file + diagnostic)", () => {
    // pairing must be "feedforward-only" or start with "aidlc-". A bare
    // "garbage" token fails validateRuleFrontmatter (aidlc-rule-schema.ts),
    // and the throw propagates out of compileStageGraph -> loadRules.
    const badRules = mkTemp("aidlc-t88-bad-pairing-");
    writeFileSync(
      join(badRules, "org.md"),
      "---\npairing: garbage\n---\n\n# Org rule with invalid pairing\n",
      "utf-8",
    );
    process.env.AIDLC_RULES_DIR = badRules;
    __resetGraphCache();
    expect(() => compileStageGraph()).toThrow(/pairing must be/);
    expect(() => compileStageGraph()).toThrow(/org\.md/);
  });

  test("blank and block-scalar lifecycle declarations fail compile", () => {
    const cases = [
      ["blank status", "status:\n", /team\.md: status must be one of/],
      [
        "blank stale_after",
        "stale_after:\n",
        /team\.md: stale_after must be a real calendar date/,
      ],
      ["block status", "status: >\n  deprecated\n", /team\.md: status must be one of/],
      [
        "block stale_after",
        "stale_after: |\n  2026-01-01\n",
        /team\.md: stale_after must be a real calendar date/,
      ],
    ] as const;

    for (const [name, declaration, diagnostic] of cases) {
      const badRules = mkTemp("aidlc-t88-bad-lifecycle-");
      writeFileSync(
        join(badRules, "team.md"),
        `---\n${declaration}---\n\n# Team rule with invalid lifecycle metadata\n`,
        "utf-8",
      );
      process.env.AIDLC_RULES_DIR = badRules;
      __resetGraphCache();
      expect(() => compileStageGraph(), name).toThrow(diagnostic);
    }
  });

  test("11: BOM-prefixed frontmatter parses; phase rule attaches to all construction stages", () => {
    const { stages } = compileWithRulesDir(join(FIXTURES, "bom-frontmatter"));
    const construction = stages.filter((s) => s.phase === "construction");
    expect(construction.length).toBeGreaterThan(0);
    // BOM (EF BB BF) on phases/construction.md must be stripped so its
    // frontmatter parses and the phase rule attaches to every construction
    // stage.
    expect(
      construction.every((s) => scopesOf(s).includes("phase")),
    ).toBe(true);
    expect(construction.every((s) => s.rules_in_context.length === 4)).toBe(
      true,
    );
  });
});
