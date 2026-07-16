// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report
//
// t208 - engine PRUNING of the per-unit construction design matrix by unit
// kind. Where t207 pins the static schema/parse/compile/sensor surfaces, this
// file drives the engine: a kind-tagged unit gets a directive whose produces
// carry only the applicable paths; coverage tracks the pruned (not the full)
// required set; a unit whose required set filters to empty is VACUOUSLY covered
// (the all-vacuous approve commits through the state-tool guard's vacuous
// branch); an untagged unit in the same dag still owes the full matrix; and a
// stage with no produces_kinds (code-generation) ignores kinds entirely.
//
// Mechanism = cli: the per-unit iteration core is unexported, observable only on
// the JSON directive the spawned engine emits to stdout - the same boundary
// t186 (per-unit iteration) drives. Fixture discipline mirrors t186: a fresh
// temp project per case, a clean single-row Construction state pivoted to the
// per-unit stage and flipped in-flight, a kind-aware bolt_dag runtime graph, and
// per-unit artifact dirs seeded to control coverage.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  resetAidlcEnv,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

resetAidlcEnv();

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const RP = `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}`;

// nfr-requirements produces[] and their per-kind applicability (verified against
// the stage frontmatter): performance/scalability/reliability are kind-gated;
// security-requirements + tech-stack-decisions are unannotated = all kinds.
const NFR_REQ_ALL = [
  "performance-requirements",
  "security-requirements",
  "scalability-requirements",
  "reliability-requirements",
  "tech-stack-decisions",
];
// A spec unit keeps only the two unannotated ones.
const NFR_REQ_SPEC = ["security-requirements", "tech-stack-decisions"];

const FD_PRODUCES = ["business-logic-model", "business-rules", "domain-entities", "frontend-components"];

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

interface Directive {
  kind?: string;
  stage?: string;
  unit?: string;
  gate?: unknown;
  produces?: string[];
  message?: string;
  [k: string]: unknown;
}

function constructionState(current: string, skeletonStance = "on"): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: unit-kind pruning test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 7
- **Skeleton Stance**: ${skeletonStance}
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design — EXECUTE
- [ ] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE

### INCEPTION PHASE
- [-] application-design — EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${current}
- **Status**: Running
`;
}

function coverUnit(proj: string, unit: string, slug: string, names: string[]): void {
  const dir = join(seededRecordDir(proj), "construction", unit, slug);
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(join(dir, `${name}.md`), `# ${name} for ${unit}\n`);
}

function seedProject(current: string): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  writeFileSync(seededStateFile(proj), constructionState(current));
  return proj;
}

function envNoScope(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  delete e.AWS_AIDLC_DEFAULT_SCOPE;
  return e;
}

function runNext(proj: string): Directive {
  const r = spawnSync(BUN, [ORCH, "next", "--project-dir", proj], { encoding: "utf-8", env: envNoScope() });
  try {
    return JSON.parse((r.stdout ?? "").trim()) as Directive;
  } catch {
    throw new Error(`runNext no JSON. status=${r.status}\n${r.stdout}\n${r.stderr}`);
  }
}

/**
 * report; when `enforceGuard` the ARTIFACT guard alone is re-enabled (its skip
 * var deleted), while the human-presence guard stays disabled so only the
 * artifact-guard behaviour is under test (mirrors t185's per-guard isolation).
 */
function runReport(proj: string, args: string[], enforceGuard = false): Directive {
  const env = envNoScope();
  if (enforceGuard) {
    delete env.AIDLC_SKIP_ARTIFACT_GUARD;
    env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD = "1";
  }
  const r = spawnSync(BUN, [ORCH, "report", ...args, "--project-dir", proj], { encoding: "utf-8", env });
  try {
    return JSON.parse((r.stdout ?? "").trim()) as Directive;
  } catch {
    throw new Error(`runReport no JSON. status=${r.status}\n${r.stdout}\n${r.stderr}`);
  }
}

describe("t208 engine unit-kind pruning", () => {
  // 1: a spec unit's nfr-requirements directive carries only the unannotated
  // (all-kinds) artifacts; the three service-gated ones are pruned out.
  test("1: a spec unit's directive prunes the kind-gated produces paths", () => {
    const proj = seedProject("nfr-requirements");
    seedBoltDag(proj, [{ name: "api", kind: "spec" }]);
    const d = runNext(proj);
    expect(d.stage).toBe("nfr-requirements");
    expect(d.unit).toBe("api");
    for (const keep of NFR_REQ_SPEC) {
      expect(d.produces).toContain(`${RP}/construction/api/nfr-requirements/${keep}.md`);
    }
    for (const gone of ["performance-requirements", "scalability-requirements", "reliability-requirements"]) {
      expect(d.produces?.some((p) => p.includes(`/${gone}.md`))).toBe(false);
    }
  }, 30000);

  // 2: coverage tracks the PRUNED set. Writing ONLY the spec unit's two
  // applicable artifacts advances iteration past it (to the untagged unit).
  test("2: covering only the pruned set advances iteration off the spec unit", () => {
    const proj = seedProject("nfr-requirements");
    seedBoltDag(proj, [{ name: "api", kind: "spec" }, { name: "svc" }]);
    coverUnit(proj, "api", "nfr-requirements", NFR_REQ_SPEC);
    const d = runNext(proj);
    // api is covered by its two-artifact pruned set; the engine moves to svc.
    expect(d.unit).toBe("svc");
  }, 30000);

  // 3: an untagged unit in the SAME dag still owes the FULL matrix (per-unit
  // conservatism). svc (no kind) must still produce all five paths.
  test("3: an untagged unit still requires the full matrix", () => {
    const proj = seedProject("nfr-requirements");
    seedBoltDag(proj, [{ name: "svc" }]);
    const d = runNext(proj);
    expect(d.unit).toBe("svc");
    for (const name of NFR_REQ_ALL) {
      expect(d.produces).toContain(`${RP}/construction/svc/nfr-requirements/${name}.md`);
    }
  }, 30000);

  // 4: vacuous coverage. A packaging unit on functional-design owes ZERO
  // artifacts (none of the four apply to packaging), so with no files on disk it
  // is already covered and `next` presents the real gate on the last unit.
  test("4: a packaging unit on functional-design is vacuously covered", () => {
    const proj = seedProject("functional-design");
    seedBoltDag(proj, [{ name: "pack", kind: "packaging" }]);
    const d = runNext(proj);
    expect(d.stage).toBe("functional-design");
    // pack owes nothing; every unit is covered -> the all-covered re-entry
    // presents the real gate (true) on the last unit with an empty produces set.
    expect(d.gate).toBe(true);
    expect(d.produces).toEqual([]);
  }, 30000);

  // 5: the all-vacuous approve COMMITS through the state-tool guard's vacuous
  // branch. A dag of only packaging units on functional-design wrote no per-unit
  // dir; without the vacuous branch the artifact guard refuses ("none of its
  // declared artifacts exist"). The guard is re-enabled for this case.
  test("5: an all-vacuous per-unit stage approves (guard's vacuous branch)", () => {
    const proj = seedProject("functional-design");
    seedBoltDag(proj, [{ name: "pack1", kind: "packaging" }, { name: "pack2", kind: "packaging" }]);
    const d = runReport(proj, ["--stage", "functional-design", "--result", "approved"], true);
    expect(d.kind).toBe("done");
  }, 30000);

  // 5b: NEGATIVE control - with the SAME guard enabled but a NON-vacuous unit
  // (a service unit owes the full functional-design matrix) and NO artifacts on
  // disk, the guard still refuses. Proves case 5's pass is the vacuous branch,
  // not a blanket bypass.
  test("5b: a non-vacuous unit with no artifacts is still refused (guard enabled)", () => {
    const proj = seedProject("functional-design");
    seedBoltDag(proj, [{ name: "svc", kind: "service" }]);
    const d = runReport(proj, ["--stage", "functional-design", "--result", "approved"], true);
    // Either the per-unit coverage guard (svc uncovered) or the artifact guard
    // refuses; the point is the approval does NOT commit.
    expect(d.kind).not.toBe("done");
  }, 30000);

  // 6: a stage with NO produces_kinds (code-generation) ignores kinds entirely -
  // even a spec unit gets the full produces set.
  test("6: a stage without produces_kinds ignores kinds (full produces)", () => {
    const proj = seedProject("code-generation");
    seedBoltDag(proj, [{ name: "api", kind: "spec" }]);
    const d = runNext(proj);
    expect(d.stage).toBe("code-generation");
    expect(d.unit).toBe("api");
    expect(d.produces).toContain(`${RP}/construction/api/code-generation/code-generation-plan.md`);
    expect(d.produces).toContain(`${RP}/construction/api/code-generation/code-summary.md`);
  }, 30000);

  // 7: a kindless dag (today's shape) is byte-identical behaviour to t186 - the
  // full matrix, gate suppressed on a non-last unit. Regression anchor.
  test("7: a kindless dag keeps today's full-matrix behaviour", () => {
    const proj = seedProject("functional-design");
    seedBoltDag(proj, [{ name: "alpha" }, { name: "beta" }]);
    const d = runNext(proj);
    expect(d.unit).toBe("alpha");
    expect(d.gate).toBe(false);
    for (const name of FD_PRODUCES) {
      expect(d.produces).toContain(`${RP}/construction/alpha/functional-design/${name}.md`);
    }
  }, 30000);

  // 8: composition with optional_produces. frontend-components lives in
  // functional-design's optional_produces AND is kind-mapped [ui]: a ui unit's
  // directive must carry its path (the kind filter runs over the produces +
  // optional_produces union, not produces alone), a service unit's must not.
  test("8: a ui unit's directive carries frontend-components; a service unit's omits it", () => {
    const proj = seedProject("functional-design");
    seedBoltDag(proj, [{ name: "web", kind: "ui" }]);
    const d = runNext(proj);
    expect(d.unit).toBe("web");
    expect(d.produces).toContain(`${RP}/construction/web/functional-design/frontend-components.md`);
    // ui's REQUIRED set is business-logic-model only (business-rules and
    // domain-entities are mapped [service, spec, library]).
    expect(d.produces).toContain(`${RP}/construction/web/functional-design/business-logic-model.md`);
    expect(d.produces?.some((p) => p.includes("/business-rules.md"))).toBe(false);

    const proj2 = seedProject("functional-design");
    seedBoltDag(proj2, [{ name: "api", kind: "service" }]);
    const d2 = runNext(proj2);
    expect(d2.unit).toBe("api");
    expect(d2.produces?.some((p) => p.includes("/frontend-components.md"))).toBe(false);
    for (const name of ["business-logic-model", "business-rules", "domain-entities"]) {
      expect(d2.produces).toContain(`${RP}/construction/api/functional-design/${name}.md`);
    }
  }, 30000);

  // 8b: optional stays coverage-EXEMPT even for the kind it applies to. A ui
  // unit that wrote only its required artifact (business-logic-model) is
  // covered without frontend-components on disk - the per-unit iteration
  // advances to the next unit.
  test("8b: a ui unit is covered without its optional artifact on disk", () => {
    const proj = seedProject("functional-design");
    seedBoltDag(proj, [{ name: "web", kind: "ui" }, { name: "svc" }]);
    coverUnit(proj, "web", "functional-design", ["business-logic-model"]);
    const d = runNext(proj);
    expect(d.unit).toBe("svc");
  }, 30000);
});
