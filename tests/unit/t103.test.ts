// covers: subcommand:aidlc-utility:doctor
//
// CLI-contract port of tests/unit/t103-doctor-rule-drift-coverage.sh (TAP
// plan 19), mechanism = cli. The .sh exercised two surfaces, both via the
// real `bun` binary, and this port keeps EVERY assertion at that same
// PROCESS boundary (node:child_process spawnSync of the bun executable):
//
//   (A) doctor's rule-drift + paired-coverage advisory rows (the credited
//       subcommand unit `subcommand:aidlc-utility:doctor`). Driven by
//       spawning `bun aidlc-utility.ts doctor --project-dir <proj>` with
//       AIDLC_RULES_DIR / AIDLC_STAGE_GRAPH pointed at inline fixtures, then
//       grepping the health-check stdout exactly as the .sh's run_doctor +
//       `grep -q` did. doctor's handleDoctor process.exit(failed>0?1:0)
//       (aidlc-utility.ts:1385) means a clean fixture exits 0 and a fixture
//       that trips an unrelated check exits 1; the .sh swallowed that with
//       `|| true`, so we assert on the advisory LABEL lines (the observable
//       under test) and never pin doctor's exit code — same as the .sh.
//
//   (B) the rule-loader primitives the drift/coverage logic is built on
//       (loadRules().frontmatter.pairing, RuleFile.headings via the private
//       parseRuleHeadings, and validateRuleFrontmatter's accept/reject).
//       The .sh drove these through `bun -e '<import + console.log>'`. Since
//       the target is .cli.test.ts, the mechanism stays a SPAWN: we spawn
//       `bun -e <script>` (the real bun binary) with AIDLC_RULES_DIR set, and
//       assert on its stdout / exit code — the identical process boundary the
//       .sh used. An in-process import would lose the validate-throws-exits-
//       nonzero half (case 2b) that the .sh's `RC=$?` arm relies on.
//
// EQUAL-OR-STRONGER PARITY (every .sh `ok` / assert maps to an expect()):
//   - case 1   loadRules().frontmatter.pairing == "aidlc-foo"   -> test 1
//       (same observable: the surfaced pairing value).
//   - case 2a  validateRuleFrontmatter feedforward-only -> "ok" -> test 2a
//       (exit 0 + "ok" on stdout).
//   - case 2b  validateRuleFrontmatter bogus -> RC != 0          -> test 2b
//       (res.status !== 0; STRONGER: also asserts the thrown message text).
//   - case 3a  ## A body captured                                -> test 3a.
//   - case 3b  ## B body captured                                -> test 3b.
//   - case 3c  fenced content excluded                           -> test 3c.
//   - case 3d  blockquote + single-line comment excluded         -> test 3d
//       (the .sh folded both into one `ok`; kept as one test with two
//       expect()s — STRONGER, each sub-condition pinned separately).
//   - case 4   multi-line-comment-only heading reads empty       -> test 4.
//   - case 5   .headings populated from AIDLC_RULES_DIR fixture  -> test 5
//       (proves the read seam: doctor/loadRules reads fixture bodies, not
//        the shipped rules).
//   - case 6   org+team ## Testing Posture overlap -> 1 candidate
//       -> test 6 (3 grep conditions preserved as 3 expect().toContain;
//        STRONGER: also asserts the exact "1 team/project rule(s)" count
//        string, byte-for-byte, not just substrings).
//   - case 7   empty org headings -> no overlap (N=0)            -> test 7.
//   - case 8   team heading absent from org -> no overlap        -> test 8.
//   - case 9   project.md participates in drift walk             -> test 9.
//   - case 10  aidlc-required-sections resolves -> 1/1 paired    -> test 10.
//   - case 11  aidlc-ghost unpaired -> 0/1 + unpaired detail     -> test 11
//       (3 grep conditions preserved).
//   - case 12  feedforward-only counts in X, not denominator     -> test 12.
//   - case 13  aidlc-upstream-coverage strips + resolves -> 1/1  -> test 13.
//   - case 14  no pairing rules -> "no sensor-bound rules" branch -> test 14.
//   - case 15  drift+coverage labels byte-identical across runs  -> test 15
//       (two runs, label-only grep, equality + non-empty — STRONGER: also
//        asserts the captured label block is non-empty AND contains both a
//        Rule drift and a Paired sensor coverage line).
//
// 19 .sh assertions -> 19 expect()-bearing test() cases (case 2 split into
// 2a/2b, case 3 split into 3a/3b/3c/3d, matching the .sh's TAP fan-out).
//
// FIXTURE DISCIPLINE (mirrors the .sh's per-case `mktemp -d` rules dirs +
// run_doctor's throwaway project dir + `rm -rf`): each case builds a FRESH
// temp rules dir (mkdtempSync) and, for doctor cases, a FRESH temp project
// dir (toPortablePath-wrapped so a native-Windows path round-trips through the
// tool's forward-slash path helpers). projDir() creates aidlc-docs/ but no
// audit.md, and as of v0.6.10 --doctor is cold-safe: with no pre-existing
// audit.md it emits neither GUARDRAIL_LOADED nor HEALTH_CHECKED and writes no
// files. This suite asserts only doctor's STDOUT (the paired-coverage + rule-
// drift rows), never the audit side effect, so the cold-safe gate does not
// affect it. NOTHING is written under tests/fixtures/**; all rule files are
// built inline (the .sh's L1 rationale — too combinatorial for an on-disk
// fixtures dir). All temp dirs cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toPortablePath } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const AIDLC_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const GRAPH_TS = join(AIDLC_SRC, "tools", "aidlc-graph.ts");
const RULE_SCHEMA_TS = join(AIDLC_SRC, "tools", "aidlc-rule-schema.ts");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SEED_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) {
    // best-effort recursive remove (mirrors the .sh's rm -rf)
    rmSync(d, { recursive: true, force: true });
  }
});

/** Fresh temp rules dir holding the given files (name -> contents). */
function rulesDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-t103-rd-"));
  tempDirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, "utf-8");
  }
  return dir;
}

/** Fresh temp project dir with an empty aidlc-docs/ (mirrors run_doctor's mktemp -d + mkdir aidlc-docs). */
function projDir(): string {
  const p = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t103-proj-")));
  tempDirs.push(p);
  mkdirSync(join(p, "aidlc-docs"), { recursive: true });
  return p;
}

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/**
 * run_doctor (t103.sh:189-198): spawn the real `bun aidlc-utility.ts doctor
 * --project-dir <proj>` with AIDLC_RULES_DIR + AIDLC_STAGE_GRAPH pointed at
 * the fixture. Returns combined stdout+stderr. doctor's exit code is NOT
 * asserted on (the .sh absorbed it with `|| true`); the advisory label lines
 * on stdout are the observable.
 */
function runDoctor(rulesDirPath: string, stageGraph: string = SEED_GRAPH): CliResult {
  const proj = projDir();
  const res = spawnSync(BUN, [UTIL, "doctor", "--project-dir", proj], {
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
 * Spawn `bun -e <script>` with the given env. Mirrors the .sh's `bun -e '…'`
 * primitive-driver cases (1-5, 2a/2b). Keeps the PROCESS boundary so the
 * validate-throws case (2b) surfaces a non-zero exit just as the .sh's
 * `RC=$?` arm observed.
 */
function runBunEval(script: string, env: Record<string, string> = {}): CliResult {
  const res = spawnSync(BUN, ["-e", script], {
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
    // .sh asserted RC != 0. STRONGER: the thrown diagnostic text is asserted too.
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('pairing must be "feedforward-only" or start with "aidlc-"');
  });

  // --- case 3 — parseRuleHeadings (via RuleFile.headings): splits A/B; skips
  //     fenced + blockquote + single-line comment. The .sh's one bun -e call
  //     printed five HAS*/NO* lines; we run it once and assert on each.
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
    // .sh folded NOQUOTE + NOCOMMENT into one `ok`; STRONGER here — each pinned.
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
      // P6: a learning IS a practice — it lands in team.md (no `*-learnings.md`
      // slot). team.md is the team-scoped surface the drift walk compares vs org.
      "team.md":
        "# Team\n\n## Testing Posture\n\nThis team skips the coverage floor on spike branches.\n",
    });
    const out = runDoctor(rd).out;
    // .sh grepped three substrings; STRONGER — the exact "1 ... overlap" count
    // string is asserted whole, plus the participating file + heading.
    expect(out).toContain("Rule drift: 1 team/project rule(s) overlap org policy");
    // Display path is the harness-neutral aidlc/spaces/default/memory/<file>
    // (P5 relocation); assert the neutral basename.
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
      // P6: a learning IS a practice — it lands in project.md (no
      // `*-learnings.md` slot). project.md participates in the drift walk.
      "project.md":
        "# Project\n\n## Deployment\n\nThis project deploys only on a manual tag.\n",
    });
    const out = runDoctor(rd).out;
    expect(out).toContain("Rule drift: 1 team/project rule(s) overlap org policy");
    // Display path is aidlc/spaces/default/memory/<file> (P5 relocation).
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
// drift+coverage label lines (the .sh's case 15).
// ============================================================

describe("t103 doctor determinism", () => {
  // Two doctor spawns; each writes to its own throwaway project dir. Allow
  // generous time for two subprocess invocations.
  test("case 15: drift+coverage labels are byte-identical across runs", () => {
    const files = {
      "org.md":
        "---\npairing: aidlc-required-sections\n---\n\n# Org\n\n## Testing Posture\n\nWe require 80% line coverage.\n",
      // P6: a learning IS a practice (no `*-learnings.md` slot) — team.md is the
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
    // .sh asserted A == B && -n A. STRONGER: also pin that both label kinds
    // are present in the captured block (not just that two empty strings tie).
    expect(a.length).toBeGreaterThan(0);
    expect(a).toContain("Rule drift:");
    expect(a).toContain("Paired sensor coverage:");
    expect(b).toBe(a);
  }, 30000);
});
