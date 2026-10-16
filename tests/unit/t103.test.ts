// covers: subcommand:aidlc-utility:doctor
//
// Mechanism = cli. Doctor and its rule-loader primitives are both exercised via
// the real `bun` binary, and this file keeps EVERY assertion at the same
// PROCESS boundary (node:child_process spawnSync of the bun executable):
//
//   (A) doctor's rule-drift + paired-coverage advisory rows (the credited
//       subcommand unit `subcommand:aidlc-utility:doctor`). Driven by
//       spawning `bun aidlc-utility.ts doctor --project-dir <proj>` with
//       AIDLC_RULES_DIR / AIDLC_STAGE_GRAPH pointed at inline fixtures, then
//       checking the health-check stdout. doctor's process.exit(failed>0?1:0)
//       (aidlc-utility.ts) means a clean fixture exits 0 and a fixture
//       that trips an unrelated check exits 1; we assert on the advisory LABEL
//       lines (the observable under test) and never pin doctor's exit code.
//
//   (B) the rule-loader primitives the drift/coverage logic is built on
//       (loadRules().frontmatter.pairing, RuleFile.headings via the private
//       parseRuleHeadings, and validateRuleFrontmatter's accept/reject).
//       We spawn `bun -e <script>` (the real bun binary) with AIDLC_RULES_DIR
//       set and assert on its stdout / exit code. An in-process import would
//       lose the validate-throws-exits-nonzero half (case 2b).
//
// FIXTURE DISCIPLINE: each case builds a FRESH temp rules dir (mkdtempSync) and,
// for doctor cases, a FRESH temp project dir (toPortablePath-wrapped so a
// native-Windows path round-trips through the tool's forward-slash path
// helpers). projDir() creates aidlc-docs/ but no audit shard, and doctor is
// cold-safe: with no pre-existing audit shard it emits neither GUARDRAIL_LOADED
// nor HEALTH_CHECKED and writes no files. This suite asserts only doctor's
// STDOUT (the paired-coverage + rule-drift rows), never the audit side effect,
// so the cold-safe gate does not affect it. NOTHING is written under
// tests/fixtures/**; all rule files are built inline (too combinatorial for an
// on-disk fixtures dir). All temp dirs cleaned in afterAll.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toPortablePath } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const AIDLC_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const GRAPH_TS = join(AIDLC_SRC, "tools", "aidlc-graph.ts");
const RULE_SCHEMA_TS = join(AIDLC_SRC, "tools", "aidlc-rule-schema.ts");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SEED_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

function rulesDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-t103-rd-"));
  tempDirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, "utf-8");
  }
  return dir;
}

function projDir(): string {
  const p = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t103-proj-")));
  tempDirs.push(p);
  mkdirSync(join(p, "aidlc-docs"), { recursive: true });
  return p;
}

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr
  stdout: string;
}

/**
 * Spawn the real `bun aidlc-utility.ts doctor --project-dir <proj>` with
 * AIDLC_RULES_DIR + AIDLC_STAGE_GRAPH pointed at the fixture. Returns combined
 * stdout+stderr. doctor's exit code is NOT asserted on; the advisory label lines
 * on stdout are the observable.
 */
function runDoctor(rulesDirPath: string, stageGraph: string = SEED_GRAPH): CliResult {
  const proj = projDir();
  const res = spawnSync(BUN, [UTIL, "doctor", "--verbose", "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_RULES_DIR: rulesDirPath,
      AIDLC_STAGE_GRAPH: stageGraph,
    },
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

/**
 * Spawn `bun -e <script>` with the given env. Keeps the PROCESS boundary so the
 * validate-throws case (2b) surfaces a non-zero exit.
 */
function runBunEval(script: string, env: Record<string, string> = {}): CliResult {
  const res = spawnSync(BUN, ["-e", script], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

// JS-string literal of an absolute path for safe embedding into a `bun -e` script.
const lit = (p: string): string => JSON.stringify(p);

// ============================================================
// (B) rule-loader primitives — the seams doctor's drift/coverage build on.
// Driven via `bun -e` spawn (the real binary), AIDLC_RULES_DIR-isolated.
// ============================================================

describe("t103 loader primitives (migrated from t103-doctor-rule-drift-coverage.sh, plan 19)", () => {
  test("case 1: loadRules() surfaces frontmatter.pairing", () => {
    const rd = rulesDir({
      "org.md": "---\npairing: aidlc-foo\n---\n\n# Org rule\n",
    });
    const r = runBunEval(
      `import { loadRules } from ${lit(GRAPH_TS)};\n` +
        `const r = loadRules().find(x => x.scope === "org");\n` +
        `console.log(r.frontmatter.pairing);`,
      { AIDLC_RULES_DIR: rd },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n").pop()).toBe("aidlc-foo");
  });

  test("case 2a: feedforward-only passes validation (exit 0, ok)", () => {
    const r = runBunEval(
      `import { validateRuleFrontmatter } from ${lit(RULE_SCHEMA_TS)};\n` +
        `validateRuleFrontmatter({ pairing: "feedforward-only" }, "x");\n` +
        `console.log("ok");`,
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n").pop()).toBe("ok");
  });

  test("case 2b: bogus pairing rejected loud (non-zero exit)", () => {
    const r = runBunEval(
      `import { validateRuleFrontmatter } from ${lit(RULE_SCHEMA_TS)};\n` +
        `validateRuleFrontmatter({ pairing: "bogus" }, "x");`,
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('pairing must be "feedforward-only" or start with "aidlc-"');
  });

  test("lifecycle scalars parse and all valid statuses pass validation", () => {
    const r = runBunEval(
      `import { parseRuleFrontmatter, validateRuleFrontmatter } from ${lit(RULE_SCHEMA_TS)};\n` +
        `const fm = parseRuleFrontmatter("---\\nstatus: active\\nstale_after: 2099-12-31\\nunknown: retained-for-forward-compat\\n---\\n");\n` +
        `for (const status of ["active", "deprecated", "draft"]) validateRuleFrontmatter({ status }, "valid.md");\n` +
        `validateRuleFrontmatter(fm, "parsed.md");\n` +
        `console.log(JSON.stringify(fm));`,
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}")).toEqual({
      status: "active",
      stale_after: "2099-12-31",
    });
  });

  test("invalid status throws and names the file", () => {
    const r = runBunEval(
      `import { validateRuleFrontmatter } from ${lit(RULE_SCHEMA_TS)};\n` +
        `validateRuleFrontmatter({ status: "retired" }, "rules/team.md");`,
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("rules/team.md: status must be one of");
  });

  test("malformed stale_after throws and names the file", () => {
    const r = runBunEval(
      `import { validateRuleFrontmatter } from ${lit(RULE_SCHEMA_TS)};\n` +
        `validateRuleFrontmatter({ stale_after: "2099-1-01" }, "rules/project.md");`,
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("rules/project.md: stale_after must be a real calendar date");
  });

  test("impossible stale_after throws", () => {
    const r = runBunEval(
      `import { validateRuleFrontmatter } from ${lit(RULE_SCHEMA_TS)};\n` +
        `validateRuleFrontmatter({ stale_after: "2026-02-30" }, "rules/org.md");`,
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("rules/org.md: stale_after must be a real calendar date");
  });

  test("blank and block-scalar lifecycle declarations fail through loadRules", () => {
    const cases = [
      ["blank status", "status:\n", "status must be one of"],
      ["blank stale_after", "stale_after:\n", "stale_after must be a real calendar date"],
      ["block status", "status: >\n  deprecated\n", "status must be one of"],
      [
        "block stale_after",
        "stale_after: |\n  2026-01-01\n",
        "stale_after must be a real calendar date",
      ],
    ] as const;

    for (const [name, declaration, diagnostic] of cases) {
      const rd = rulesDir({
        "team.md": `---\n${declaration}---\n\n# Team\n`,
      });
      const r = runBunEval(
        `import { loadRules } from ${lit(GRAPH_TS)};\nloadRules();`,
        { AIDLC_RULES_DIR: rd },
      );
      expect(r.status, name).not.toBe(0);
      expect(r.out, name).toContain("team.md");
      expect(r.out, name).toContain(diagnostic);
    }
  });

  test("unknown keys remain tolerated and frontmatter-less files remain empty", () => {
    const r = runBunEval(
      `import { parseRuleFrontmatter, validateRuleFrontmatter } from ${lit(RULE_SCHEMA_TS)};\n` +
        `const unknown = parseRuleFrontmatter("---\\nfuture_key: future-value\\n---\\n# Rule\\n");\n` +
        `const absent = parseRuleFrontmatter("# Rule without frontmatter\\n");\n` +
        `validateRuleFrontmatter(unknown, "unknown.md");\n` +
        `validateRuleFrontmatter(absent, "absent.md");\n` +
        `console.log(JSON.stringify({ unknown, absent }));`,
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}")).toEqual({
      unknown: {},
      absent: {},
    });
  });

  test("isRuleStale follows deprecated, date, and boundary semantics", () => {
    const r = runBunEval(
      `import { isRuleStale } from ${lit(RULE_SCHEMA_TS)};\n` +
        `console.log(JSON.stringify({\n` +
        `deprecated: isRuleStale({ status: "deprecated" }, "2050-01-01"),\n` +
        `active: isRuleStale({ status: "active" }, "2050-01-01"),\n` +
        `draft: isRuleStale({ status: "draft" }, "2050-01-01"),\n` +
        `past: isRuleStale({ stale_after: "2000-01-01" }, "2050-01-01"),\n` +
        `future: isRuleStale({ stale_after: "2099-12-31" }, "2050-01-01"),\n` +
        `boundary: isRuleStale({ stale_after: "2050-01-01" }, "2050-01-01")\n` +
        `}));`,
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}")).toEqual({
      deprecated: true,
      active: false,
      draft: false,
      past: true,
      future: false,
      boundary: false,
    });
  });

  // --- case 3 — parseRuleHeadings (via RuleFile.headings): splits A/B; skips
  //     fenced + blockquote + single-line comment.
  function headingsProbe(): CliResult {
    const rd = rulesDir({
      "org.md":
        "# Org\n\n## A\n\nBody of A.\n\n> a blockquote line\n" +
        "<!-- a single-line comment -->\n\n```\nfenced content under A\n```\n\n## B\n\nBody of B.\n",
    });
    return runBunEval(
      `import { loadRules } from ${lit(GRAPH_TS)};\n` +
        `const r = loadRules().find(x => x.scope === "org");\n` +
        `const a = r.headings.get("A") ?? "";\n` +
        `const b = r.headings.get("B") ?? "";\n` +
        `console.log("HASA=" + (a.includes("Body of A") ? "1" : "0"));\n` +
        `console.log("HASB=" + (b.includes("Body of B") ? "1" : "0"));\n` +
        `console.log("NOFENCE=" + (a.includes("fenced content") ? "0" : "1"));\n` +
        `console.log("NOQUOTE=" + (a.includes("blockquote") ? "0" : "1"));\n` +
        `console.log("NOCOMMENT=" + (a.includes("single-line comment") ? "0" : "1"));`,
      { AIDLC_RULES_DIR: rd },
    );
  }

  test("case 3a: ## A body captured", () => {
    expect(headingsProbe().out).toContain("HASA=1");
  });

  test("case 3b: ## B body captured", () => {
    expect(headingsProbe().out).toContain("HASB=1");
  });

  test("case 3c: fenced content excluded", () => {
    expect(headingsProbe().out).toContain("NOFENCE=1");
  });

  test("case 3d: blockquote + single-line comment lines excluded", () => {
    const out = headingsProbe().out;
    expect(out).toContain("NOQUOTE=1");
    expect(out).toContain("NOCOMMENT=1");
  });

  test("case 4: multi-line-comment-only heading reads as empty", () => {
    const rd = rulesDir({
      "org.md":
        "# Org\n\n## Corrections\n\n<!-- Self-learning loop appends here. -->\n" +
        "<!-- Use aidlc-team.md to record team-wide overrides; aidlc-project.md\n" +
        "     to record project-specific deviations. The loaders merge org -> team\n" +
        "     -> project at session start. -->\n",
    });
    const r = runBunEval(
      `import { loadRules } from ${lit(GRAPH_TS)};\n` +
        `const r = loadRules().find(x => x.scope === "org");\n` +
        `const c = (r.headings.get("Corrections") ?? "").trim();\n` +
        `console.log("EMPTY=" + (c === "" ? "1" : "0"));`,
      { AIDLC_RULES_DIR: rd },
    );
    expect(r.out).toContain("EMPTY=1");
  });

  test("case 5: .headings populated from AIDLC_RULES_DIR fixture (read seam)", () => {
    const rd = rulesDir({
      "org.md":
        "# Org\n\n## Testing Posture\n\nA unique fixture sentence that does not appear in shipped rules.\n",
    });
    const r = runBunEval(
      `import { loadRules } from ${lit(GRAPH_TS)};\n` +
        `const r = loadRules().find(x => x.scope === "org");\n` +
        `const tp = r.headings.get("Testing Posture") ?? "";\n` +
        `console.log(tp.includes("unique fixture sentence") ? "FIXTURE=1" : "FIXTURE=0");`,
      { AIDLC_RULES_DIR: rd },
    );
    expect(r.out).toContain("FIXTURE=1");
  });
});

// ============================================================
// (A) doctor rule-drift detection — spawned `bun aidlc-utility.ts doctor`.
// ============================================================

describe("t103 doctor rule-drift (migrated from t103-doctor-rule-drift-coverage.sh, plan 19)", () => {
  test("case 6: org+team ## Testing Posture overlap -> 1 candidate", () => {
    const rd = rulesDir({
      "org.md":
        "# Org\n\n## Testing Posture\n\nWe require 80% line coverage on every Bolt.\n",
      // A learning IS a practice - it lands in team.md (no `*-learnings.md`
      // slot). team.md is the team-scoped surface the drift walk compares vs org.
      "team.md":
        "# Team\n\n## Testing Posture\n\nThis team skips the coverage floor on spike branches.\n",
    });
    const out = runDoctor(rd).out;
    expect(out).toContain("Rule drift: 1 team/project rule(s) overlap org policy");
    // Display path is the harness-neutral aidlc/spaces/default/memory/<file>;
    // assert the neutral basename.
    expect(out).toContain("team.md");
    expect(out).toContain("Testing Posture");
  });

  test("case 7: empty org headings produce no overlap (N=0)", () => {
    const rd = rulesDir({
      "org.md":
        "# Org\n\n## Forbidden\n\n<!-- Things agents must never do -->\n\n" +
        "## Corrections\n\n<!-- Self-learning loop appends here. -->\n" +
        "<!-- multi-line comment continues\n     across more than one line. -->\n",
      "team.md":
        "# Team\n\n## Forbidden\n\nNever push directly to main.\n\n" +
        "## Corrections\n\nAlways squash-merge.\n",
    });
    expect(runDoctor(rd).out).toContain(
      "Rule drift: no team/project rule overlaps org policy",
    );
  });

  test("case 8: team heading absent from org -> no overlap", () => {
    const rd = rulesDir({
      "org.md": "# Org\n\n## Way of Working\n\nWe use trunk-based development.\n",
      "team.md": "# Team\n\n## Code Style\n\nWe prefer tabs over spaces.\n",
    });
    expect(runDoctor(rd).out).toContain(
      "Rule drift: no team/project rule overlaps org policy",
    );
  });

  test("case 9: project.md participates in the drift walk", () => {
    const rd = rulesDir({
      "org.md": "# Org\n\n## Deployment\n\nWe deploy on merge to staging.\n",
      // A learning IS a practice - it lands in project.md (no
      // `*-learnings.md` slot). project.md participates in the drift walk.
      "project.md":
        "# Project\n\n## Deployment\n\nThis project deploys only on a manual tag.\n",
    });
    const out = runDoctor(rd).out;
    expect(out).toContain("Rule drift: 1 team/project rule(s) overlap org policy");
    // Display path is aidlc/spaces/default/memory/<file>.
    expect(out).toContain("project.md");
  });
});

// ============================================================
// (A) doctor paired-coverage detection — spawned `bun aidlc-utility.ts doctor`.
// ============================================================

describe("t103 doctor paired-coverage (migrated from t103-doctor-rule-drift-coverage.sh, plan 19)", () => {
  test("case 10: aidlc-required-sections resolves -> 1/1 paired", () => {
    const rd = rulesDir({
      "org.md":
        "---\npairing: aidlc-required-sections\n---\n\n# Org rule with a sensor binding\n",
    });
    expect(runDoctor(rd).out).toContain(
      "Paired sensor coverage: 1/1 guardrails paired (0 feedforward-only)",
    );
  });

  test("case 11: aidlc-ghost unpaired -> 0/1 + unpaired detail", () => {
    const rd = rulesDir({
      "org.md":
        "---\npairing: aidlc-ghost\n---\n\n# Org rule binding a non-existent sensor\n",
    });
    const out = runDoctor(rd).out;
    expect(out).toContain(
      "Paired sensor coverage: 0/1 guardrails paired (0 feedforward-only)",
    );
    expect(out).toContain("unpaired:");
    expect(out).toContain("aidlc-ghost (no stage binds it)");
  });

  test("case 12: feedforward-only counts in X, not in the M-X denominator", () => {
    const rd = rulesDir({
      "org.md":
        "---\npairing: aidlc-required-sections\n---\n\n# Org rule with a sensor binding\n",
      "team.md":
        "---\npairing: feedforward-only\n---\n\n# Team rule that needs no sensor\n",
    });
    expect(runDoctor(rd).out).toContain(
      "Paired sensor coverage: 1/1 guardrails paired (1 feedforward-only)",
    );
  });

  test("case 13: aidlc-upstream-coverage strips to bare id and resolves", () => {
    const rd = rulesDir({
      "org.md":
        "---\npairing: aidlc-upstream-coverage\n---\n\n# Org rule binding the upstream-coverage sensor by aidlc- prefixed name\n",
    });
    expect(runDoctor(rd).out).toContain(
      "Paired sensor coverage: 1/1 guardrails paired (0 feedforward-only)",
    );
  });

  test("case 14: no pairing rules -> M-X=0 branch label", () => {
    const rd = rulesDir({
      "org.md": "# Org rule, no pairing\n",
    });
    expect(runDoctor(rd).out).toContain(
      "Paired sensor coverage: no sensor-bound rules (0 feedforward-only)",
    );
  });
});

// ============================================================
// Determinism — two runs over the same fixture produce byte-identical
// drift+coverage label lines.
// ============================================================

describe("t103 doctor determinism", () => {
  // Two doctor spawns; each writes to its own throwaway project dir. Allow
  // generous time for two subprocess invocations.
  test("case 15: drift+coverage labels are byte-identical across runs", () => {
    const files = {
      "org.md":
        "---\npairing: aidlc-required-sections\n---\n\n# Org\n\n## Testing Posture\n\nWe require 80% line coverage.\n",
      // A learning IS a practice (no `*-learnings.md` slot) - team.md is the
      // team-scoped surface the drift walk reads.
      "team.md":
        "# Team\n\n## Testing Posture\n\nThis team waives the floor on spikes.\n",
    };
    const rdA = rulesDir(files);
    const rdB = rulesDir(files);

    const grabLabels = (rd: string): string =>
      runDoctor(rd)
        .stdout.split("\n")
        .filter((l) => /Rule drift:|Paired sensor coverage:/.test(l))
        .join("\n");

    const a = grabLabels(rdA);
    const b = grabLabels(rdB);
    // Pin that both label kinds are present in the captured block (not just that
    // two empty strings tie).
    expect(a.length).toBeGreaterThan(0);
    expect(a).toContain("Rule drift:");
    expect(a).toContain("Paired sensor coverage:");
    expect(b).toBe(a);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
