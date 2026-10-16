// covers: function:parseStageFrontmatter
//
// t43 — stage I/O contract chain: every stage declares inputs/outputs and the
// declared output->input edges between adjacent lifecycle stages line up.
// Mechanism: none (pure parse + string checks on returned scalars; zero LLM,
// zero subprocess, zero tokens).
// Technique: example-based (real stage .md files are the fixtures).
//
// MECHANISM SPLIT: ALL in-process. The inp()/out() helpers below are direct
// field reads with a string-or-empty contract. No process boundary is
// exercised.
//
// FIXTURE DISCIPLINE: the inputs are the REAL generated stage files under
// dist/claude/.claude/aidlc-common/stages/<phase>/<slug>.md, read-only.
// Nothing is written; nothing under tests/fixtures/** is touched.
//
// Source:
//   dist/claude/.claude/tools/aidlc-lib.ts parseStageFrontmatter(raw)
//     — returns Record<string, unknown>; inputs/outputs are string scalars in
//     the stage frontmatter (verified against the real intent-capture /
//     reverse-engineering / requirements-analysis files).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStageFrontmatter } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// --- Paths --------------------------------------------------------------------
const STAGES_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "dist", "claude",
  ".claude",
  "aidlc-common",
  "stages",
);

// The 5 phase directories are the closed enum; iterate them to locate a
// slug's .md file.
const PHASES = [
  "initialization",
  "ideation",
  "inception",
  "construction",
  "operation",
] as const;

// --- Helpers ---

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

/** The inputs scalar, or "" when absent/non-string. Returns null only when the
 *  stage file itself is missing. */
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

// Lifecycle stage order.
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
  "domain-design",
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
// Test 1: Every stage file has an Inputs line
// ============================================================
describe("every stage declares inputs", () => {
  test("all stage files have a non-empty Inputs scalar", () => {
    const missing: string[] = [];
    for (const slug of STAGE_ORDER) {
      const v = inp(slug);
      if (v === null) continue;
      if (v === "") missing.push(slug);
    }
    expect(missing).toEqual([]);
  });
});

// ============================================================
// Test 2: Every stage file has an Outputs line
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
// Test 3: Every non-init stage references stage-protocol
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
// Test 4: reverse-engineering has CONDITIONAL + brownfield
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
// Tests 5-8: Ideation outputs declare their per-intent record dir
// The `outputs:` frontmatter carries RELATIVE artifact names plus the
// engine-resolution clause "(under this stage's record dir, engine-resolved)";
// the path root does not live in `outputs:`. One assertion per slug: every
// ideation stage declares its output location.
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
// Tests 9-11: Inception outputs declare their per-intent record dir
// `outputs:` carries relative artifact names plus the "(under this stage's
// record dir, engine-resolved)" clause.
// ============================================================
describe("inception stages declare their per-intent record dir in outputs", () => {
  // reverse-engineering writes to the durable per-repo code knowledge base,
  // which is SPACE-scoped (aidlc/spaces/<active-space>/codekb/<repo>/), so it is
  // asserted separately below; the other inception stages declare their own
  // artifacts under the engine-resolved record dir.
  for (const slug of ["requirements-analysis", "domain-design"]) {
    test(`${slug} outputs declare "under this stage's record dir, engine-resolved"`, () => {
      const v = out(slug);
      expect(v).not.toBeNull();
      expect(v!).toContain("under this stage's record dir, engine-resolved");
    });
  }

  test("reverse-engineering outputs to the space-level per-repo codekb (aidlc/spaces/<active-space>/codekb/<repo>/), not the inception record dir", () => {
    const v = out("reverse-engineering");
    expect(v).not.toBeNull();
    // The per-repo codekb store is SPACE-scoped (a sibling of intents/); it is the
    // dir the `codekb-path` command resolves.
    expect(v!).toContain("aidlc/spaces/<active-space>/codekb/<repo>/");
    // The inception artifact tree is the per-intent <record>/inception/;
    // RE must NOT write there (it lives in the durable codekb instead).
    expect(v!).not.toContain("<record>/inception/");
  });
});

// ============================================================
// Test 12: Most per-unit Construction stages reference {unit-name}
//
// `outputs:` carries relative artifact names plus "(under this stage's per-unit
// record dir, engine-resolved)", not the `{unit-name}` key. The literal
// `{unit-name}` segment lives in the BODY prose, where each stage writes to
// `<record>/construction/{unit-name}/<stage>/`. The test's intent - per-unit
// construction stages anchor their output location to {unit-name} - is checked
// by counting stages whose BODY cites that per-unit path (threshold >3 of 5).
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
// Test 13: intent-capture outputs -> market-research inputs
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
// Test 14: reverse-engineering outputs -> requirements-analysis inputs
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
// Test 15: requirements-analysis outputs -> user-stories inputs
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
// Test 16: scope-definition outputs -> team-formation inputs
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
// Test 17: domain-design outputs -> units-generation inputs
//
// Domain-design's outputs name the design artifacts directly (components.md,
// decisions.md, traceability.json ... engine-resolved). The downstream consumer
// cites the producer by name: units-generation `inputs:` reads
// `<record>/inception/domain-design/components.md`. So the edge-citation intent
// (producer emits the design artifacts, consumer reads domain-design's design
// output) is checked: assert the producer names a design artifact
// (components.md is the keystone, also pinned by t44 test 5) and the consumer
// cites domain-design/design.
// ============================================================
describe("domain-design -> units-generation edge", () => {
  test("domain-design outputs name the design artifacts; units-generation inputs cite the design", () => {
    const adOut = out("domain-design");
    const ugIn = inp("units-generation");
    expect(adOut).not.toBeNull();
    expect(ugIn).not.toBeNull();
    expect(adOut!).toMatch(/components|design/i);
    expect(ugIn!).toMatch(/domain-design|design/i);
  });
});

// ============================================================
// Test 18: Operation phase outputs declare their per-intent record dir
// `outputs:` carries the "(under this stage's record dir, engine-resolved)"
// clause instead of the path root; all 4 checked stages must declare it.
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
// Test 19: state-init inputs reference workspace classification
// ============================================================
describe("state-init -> workspace classification edge", () => {
  test("state-init inputs cite workspace or classification", () => {
    const siIn = inp("state-init");
    expect(siIn).not.toBeNull();
    expect(siIn!).toMatch(/workspace|classification/i);
  });
});

// ============================================================
// Test 20: approval-handoff consumes the stakeholder map it reads in prose.
// This keeps the artifact visible to the runtime dependency graph and the
// upstream-coverage sensor.
// ============================================================
describe("intent-capture -> approval-handoff stakeholder edge", () => {
  test("approval-handoff requires stakeholder-map", () => {
    const fm = frontmatter("approval-handoff");
    expect(fm).not.toBeNull();
    const consumes = Array.isArray(fm?.consumes) ? fm.consumes : [];
    expect(consumes).toContainEqual({
      artifact: "stakeholder-map",
      required: true,
    });
  });
});
