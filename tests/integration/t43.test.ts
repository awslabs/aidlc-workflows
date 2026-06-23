// covers: function:parseStageFrontmatter
//
// t43 — stage I/O contract chain: every stage declares inputs/outputs and the
// declared output->input edges between adjacent lifecycle stages line up.
// Mechanism: none (pure parse + string checks on returned scalars; zero LLM,
// zero subprocess, zero tokens).
// Technique: example-based (real committed stage .md files are the fixtures).
//
// In-process migration of tests/integration/t43-stage-io-contracts.sh (TAP plan 19).
// The .sh spawned `bun -e` once per stage via two helpers — get_inputs() and
// get_outputs() — each of which imported parseStageFrontmatter, read a stage
// .md file, and printed `obj.inputs` / `obj.outputs` ONLY when that field was a
// string scalar (`typeof obj.inputs === 'string' ? obj.inputs : ''`). Every one
// of the 19 assertions then ran a shell string check (grep -q / grep -qi /
// emptiness test) over that scalar. None touched the CLI shell, argv parsing,
// or process.exit, so all 19 port to a direct parseStageFrontmatter(file) call
// plus an in-process string assertion (.toContain / .toMatch / emptiness).
//
// MECHANISM SPLIT: ALL in-process. The .sh's get_inputs/get_outputs become the
// inp()/out() helpers below — direct field reads that reproduce the SAME
// string-or-empty contract the shell `bun -e` block printed. No Bun.spawnSync
// env-seam case is retained because the .sh exercised no process boundary.
//
// FIXTURE DISCIPLINE: the inputs are the REAL committed stage files under
// dist/claude/.claude/skills/aidlc/stages/<phase>/<slug>.md, read-only —
// exactly the files the .sh's find_stage_file() walked ($AIDLC_SRC/skills/
// aidlc/stages). Nothing is written; nothing under tests/fixtures/** is touched.
// The .sh hard-coded the lifecycle STAGE_ORDER and the per-phase stage lists;
// those lists are reproduced verbatim here so the same stages are asserted.
//
// Sources read for this port:
//   dist/claude/.claude/tools/aidlc-lib.ts:893 parseStageFrontmatter(raw)
//     — returns Record<string, unknown>; inputs/outputs are string scalars in
//     the stage frontmatter (verified against the real intent-capture /
//     reverse-engineering / requirements-analysis files).
//
// Parity mapping (.sh assertion -> test below) is documented inline per block.
// 19 old TAP assertions -> 19 expect-bearing tests.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStageFrontmatter } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// --- Paths --------------------------------------------------------------------
// Mirrors the .sh's STAGES_DIR="$AIDLC_SRC/skills/aidlc/stages".
const STAGES_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "dist", "claude",
  ".claude",
  "aidlc-common",
  "stages",
);

// The .sh's find_stage_file() iterated phase dirs in glob order. The 5 phase
// directories are the closed enum; iterate them to locate a slug's .md file.
const PHASES = [
  "initialization",
  "ideation",
  "inception",
  "construction",
  "operation",
] as const;

// --- Helpers mirroring the .sh's shell helpers, but in-process. ---

/** find_stage_file(slug): first <phase>/<slug>.md that exists, or null. */
function findStageFile(slug: string): string | null {
  for (const phase of PHASES) {
    const f = join(STAGES_DIR, phase, `${slug}.md`);
    if (existsSync(f)) return f;
  }
  return null;
}

/** Read the parsed frontmatter for a slug (helper behind inp/out). */
function frontmatter(slug: string): Record<string, unknown> | null {
  const f = findStageFile(slug);
  if (!f) return null;
  return parseStageFrontmatter(readFileSync(f, "utf8")) as Record<string, unknown>;
}

/** get_inputs(slug): the inputs scalar, or "" when absent/non-string — exactly
 *  the `typeof obj.inputs === 'string' ? obj.inputs : ''` contract the .sh
 *  printed. Returns null only when the stage file itself is missing (the .sh's
 *  `find_stage_file ... || continue`). */
function inp(slug: string): string | null {
  const o = frontmatter(slug);
  if (!o) return null;
  return typeof o.inputs === "string" ? o.inputs : "";
}

/** get_outputs(slug): the outputs scalar, or "" when absent/non-string. */
function out(slug: string): string | null {
  const o = frontmatter(slug);
  if (!o) return null;
  return typeof o.outputs === "string" ? o.outputs : "";
}

// Lifecycle stage order — verbatim from the .sh's STAGE_ORDER array.
const STAGE_ORDER = [
  "workspace-scaffold",
  "workspace-detection",
  "state-init",
  "intent-capture",
  "market-research",
  "feasibility",
  "scope-definition",
  "team-formation",
  "rough-mockups",
  "approval-handoff",
  "reverse-engineering",
  "requirements-analysis",
  "user-stories",
  "refined-mockups",
  "application-design",
  "units-generation",
  "delivery-planning",
  "functional-design",
  "nfr-requirements",
  "nfr-design",
  "infrastructure-design",
  "code-generation",
  "build-and-test",
  "ci-pipeline",
  "deployment-pipeline",
  "environment-provisioning",
  "deployment-execution",
  "observability-setup",
  "incident-response",
  "performance-validation",
  "feedback-optimization",
] as const;

// ============================================================
// Test 1: Every stage file has an Inputs line (.sh:55-62)
// The .sh counted stages whose get_inputs() returned empty and asserted the
// count is 0. Here: for every stage that exists, inp(slug) is a non-empty
// string. Stronger fidelity — names the offenders if any.
// ============================================================
describe("every stage declares inputs", () => {
  test("all stage files have a non-empty Inputs scalar", () => {
    const missing: string[] = [];
    for (const slug of STAGE_ORDER) {
      const v = inp(slug);
      if (v === null) continue; // .sh: find_stage_file ... || continue
      if (v === "") missing.push(slug);
    }
    expect(missing).toEqual([]);
  });
});

// ============================================================
// Test 2: Every stage file has an Outputs line (.sh:64-71)
// ============================================================
describe("every stage declares outputs", () => {
  test("all stage files have a non-empty Outputs scalar", () => {
    const missing: string[] = [];
    for (const slug of STAGE_ORDER) {
      const v = out(slug);
      if (v === null) continue;
      if (v === "") missing.push(slug);
    }
    expect(missing).toEqual([]);
  });
});

// ============================================================
// Test 3: Every non-init stage references stage-protocol (.sh:73-82)
// The .sh skipped the first 3 init stages (STAGE_ORDER[@]:3) and grep -qi
// "stage-protocol" each remaining stage's full file body.
// ============================================================
describe("non-init stages reference stage-protocol", () => {
  test("all non-init stages mention stage-protocol", () => {
    const missing: string[] = [];
    for (const slug of STAGE_ORDER.slice(3)) {
      const f = findStageFile(slug);
      if (!f) continue;
      if (!/stage-protocol/i.test(readFileSync(f, "utf8"))) missing.push(slug);
    }
    expect(missing).toEqual([]);
  });
});

// ============================================================
// Test 4: reverse-engineering has CONDITIONAL + brownfield (.sh:84-94)
// The .sh grep -qi "CONDITIONAL" AND grep -qi "brownfield" the RE file body.
// ============================================================
describe("reverse-engineering conditional execution", () => {
  test("reverse-engineering file mentions CONDITIONAL and brownfield", () => {
    const f = findStageFile("reverse-engineering");
    expect(f).not.toBeNull();
    const body = readFileSync(f!, "utf8");
    expect(body).toMatch(/CONDITIONAL/i);
    expect(body).toMatch(/brownfield/i);
  });
});

// ============================================================
// Tests 5-8: Ideation outputs declare their per-intent record dir (.sh:96-105)
// The flat aidlc-docs/ideation/ root was rerooted to the active intent's
// per-intent <record>/<phase>/<stage>/ tree, and the `outputs:` frontmatter was
// rewritten to RELATIVE artifact names plus the engine-resolution clause
// "(under this stage's record dir, engine-resolved)" — the path root no longer
// lives in `outputs:`. One assertion per slug, preserving the original intent
// (every ideation stage declares its output location) repointed to the new
// canonical declaration.
// ============================================================
describe("ideation stages declare their per-intent record dir in outputs", () => {
  for (const slug of ["intent-capture", "market-research", "feasibility", "scope-definition"]) {
    test(`${slug} outputs declare "under this stage's record dir, engine-resolved"`, () => {
      const v = out(slug);
      expect(v).not.toBeNull();
      expect(v!).toContain("under this stage's record dir, engine-resolved");
    });
  }
});

// ============================================================
// Tests 9-11: Inception outputs declare their per-intent record dir (.sh:107-116)
// Same reroot as the ideation block: the flat aidlc-docs/inception/ root moved
// to the per-intent <record>/inception/<stage>/ tree, and `outputs:` now carries
// relative artifact names plus the "(under this stage's record dir,
// engine-resolved)" clause.
// ============================================================
describe("inception stages declare their per-intent record dir in outputs", () => {
  // reverse-engineering was PROMOTED out of the inception artifact tree to the
  // durable per-repo code knowledge base (P0 codekb promotion), which the
  // codekb-determinism placement fix then made SPACE-scoped
  // (aidlc/spaces/<active-space>/codekb/<repo>/), so it is asserted separately
  // below; the other inception stages declare their own artifacts under the
  // engine-resolved record dir.
  for (const slug of ["requirements-analysis", "application-design"]) {
    test(`${slug} outputs declare "under this stage's record dir, engine-resolved"`, () => {
      const v = out(slug);
      expect(v).not.toBeNull();
      expect(v!).toContain("under this stage's record dir, engine-resolved");
    });
  }

  test("reverse-engineering outputs to the space-level per-repo codekb (aidlc/spaces/<active-space>/codekb/<repo>/), not the inception record dir", () => {
    const v = out("reverse-engineering");
    expect(v).not.toBeNull();
    // The codekb-determinism placement fix made the per-repo codekb store
    // SPACE-scoped (a sibling of intents/), the dir `codekb-path` resolves.
    expect(v!).toContain("aidlc/spaces/<active-space>/codekb/<repo>/");
    // Post-reroot the inception artifact tree is the per-intent <record>/inception/;
    // RE must NOT write there (it lives in the durable codekb instead).
    expect(v!).not.toContain("<record>/inception/");
  });
});

// ============================================================
// Test 12: Most per-unit Construction stages reference {unit-name} (.sh:118-128)
// The .sh counted the 5 per-unit stages whose outputs contain "{unit-name}" and
// asserted assert_gt COUNT 3 (i.e. >3 -> at least 4 of 5).
//
// REROOT: with the flat aidlc-docs/ tree retired, the `{unit-name}` per-unit key
// no longer lives in the `outputs:` frontmatter — that line now carries relative
// artifact names plus "(under this stage's per-unit record dir, engine-resolved)".
// The literal `{unit-name}` segment moved into the BODY prose, where each stage
// writes to `<record>/construction/{unit-name}/<stage>/`. The test's intent —
// per-unit construction stages anchor their output location to {unit-name} — is
// preserved by counting stages whose BODY cites that per-unit path. All 5 do
// (4-8 occurrences each), so the original ">3 of 5" threshold still holds.
// ============================================================
describe("per-unit construction stages reference {unit-name}", () => {
  test("more than 3 of the 5 per-unit stages key their output path to {unit-name}", () => {
    const unitStages = [
      "functional-design",
      "nfr-requirements",
      "nfr-design",
      "infrastructure-design",
      "code-generation",
    ];
    const count = unitStages.filter((s) => {
      const f = findStageFile(s);
      return f !== null && readFileSync(f, "utf8").includes("<record>/construction/{unit-name}/");
    }).length;
    expect(count).toBeGreaterThan(3);
  });
});

// ============================================================
// Test 13: intent-capture outputs -> market-research inputs (.sh:130-144)
// The .sh: ic_outputs grep -qi "intent-statement" AND mr_inputs grep -qi "intent".
// ============================================================
describe("intent-capture -> market-research edge", () => {
  test("intent-capture produces intent-statement; market-research consumes intent", () => {
    const icOut = out("intent-capture");
    const mrIn = inp("market-research");
    expect(icOut).not.toBeNull();
    expect(mrIn).not.toBeNull();
    expect(icOut!).toMatch(/intent-statement/i);
    expect(mrIn!).toMatch(/intent/i);
  });
});

// ============================================================
// Test 14: reverse-engineering outputs -> requirements-analysis inputs (.sh:146-160)
// The .sh: re_outputs grep -qi "reverse-engineering" AND ra_inputs grep -qi "RE\|reverse".
// ============================================================
describe("reverse-engineering -> requirements-analysis edge", () => {
  test("RE outputs name reverse-engineering; requirements-analysis inputs cite RE/reverse", () => {
    const reOut = out("reverse-engineering");
    const raIn = inp("requirements-analysis");
    expect(reOut).not.toBeNull();
    expect(raIn).not.toBeNull();
    expect(reOut!).toMatch(/reverse-engineering/i);
    expect(raIn!).toMatch(/RE|reverse/i);
  });
});

// ============================================================
// Test 15: requirements-analysis outputs -> user-stories inputs (.sh:162-175)
// The .sh: ra_outputs grep -qi "requirements" AND us_inputs grep -qi "requirements".
// ============================================================
describe("requirements-analysis -> user-stories edge", () => {
  test("requirements-analysis outputs and user-stories inputs both cite requirements", () => {
    const raOut = out("requirements-analysis");
    const usIn = inp("user-stories");
    expect(raOut).not.toBeNull();
    expect(usIn).not.toBeNull();
    expect(raOut!).toMatch(/requirements/i);
    expect(usIn!).toMatch(/requirements/i);
  });
});

// ============================================================
// Test 16: scope-definition outputs -> team-formation inputs (.sh:177-190)
// The .sh: sd_outputs grep -qi "scope" AND tf_inputs grep -qi "scope\|intent".
// ============================================================
describe("scope-definition -> team-formation edge", () => {
  test("scope-definition outputs cite scope; team-formation inputs cite scope/intent", () => {
    const sdOut = out("scope-definition");
    const tfIn = inp("team-formation");
    expect(sdOut).not.toBeNull();
    expect(tfIn).not.toBeNull();
    expect(sdOut!).toMatch(/scope/i);
    expect(tfIn!).toMatch(/scope|intent/i);
  });
});

// ============================================================
// Test 17: application-design outputs -> units-generation inputs (.sh:192-205)
// The .sh: ad_outputs grep -qi "application-design" AND ug_inputs grep -qi
// "application-design\|design".
//
// REROOT: the old `outputs:` carried the path root
// aidlc-docs/inception/application-design/..., so the literal "application-design"
// appeared in the output scalar. With the reroot the path root left `outputs:` —
// application-design's outputs now name the design artifacts directly
// (components.md, component-methods.md, services.md, component-dependency.md,
// decisions.md ... engine-resolved). The downstream consumer still cites the
// producer by name: units-generation `inputs:` reads
// `<record>/inception/application-design/ (all design artifacts)`. So the
// edge-citation intent (producer emits the design artifacts, consumer reads
// application-design's design output) is preserved: assert the producer names a
// design artifact (components.md is the keystone, also pinned by t44 test 5) and
// the consumer cites application-design/design.
// ============================================================
describe("application-design -> units-generation edge", () => {
  test("application-design outputs name the design artifacts; units-generation inputs cite the design", () => {
    const adOut = out("application-design");
    const ugIn = inp("units-generation");
    expect(adOut).not.toBeNull();
    expect(ugIn).not.toBeNull();
    expect(adOut!).toMatch(/components|design/i);
    expect(ugIn!).toMatch(/application-design|design/i);
  });
});

// ============================================================
// Test 18: Operation phase outputs declare their per-intent record dir (.sh:207-217)
// The .sh counted the 4 checked operation stages whose outputs contain
// "aidlc-docs/operation/" and asserted the count == 4. Post-reroot the flat
// aidlc-docs/operation/ root moved to the per-intent <record>/operation/ tree and
// `outputs:` carries the "(under this stage's record dir, engine-resolved)"
// clause instead of the path root. Same intent (all 4 declare their output
// location), repointed to the new canonical declaration; still an all-4 check.
// ============================================================
describe("operation stages declare their per-intent record dir in outputs", () => {
  test("all 4 checked operation stages declare their engine-resolved record dir", () => {
    const opStages = [
      "deployment-pipeline",
      "environment-provisioning",
      "deployment-execution",
      "observability-setup",
    ];
    const offenders = opStages.filter(
      (s) => !(out(s) ?? "").includes("under this stage's record dir, engine-resolved"),
    );
    expect(offenders).toEqual([]);
  });
});

// ============================================================
// Test 19: state-init inputs reference workspace classification (.sh:219-230)
// The .sh: si_inputs grep -qi "workspace\|classification".
// ============================================================
describe("state-init -> workspace classification edge", () => {
  test("state-init inputs cite workspace or classification", () => {
    const siIn = inp("state-init");
    expect(siIn).not.toBeNull();
    expect(siIn!).toMatch(/workspace|classification/i);
  });
});
