// covers: subcommand:aidlc-orchestrate:next
//
// CLI-contract port of tests/unit/t116-directive-path-resolution.sh (TAP plan
// 13), mechanism = cli. The .sh exercises the engine's run-stage directive
// builder's artifact-path RESOLUTION: it resolves the graph node's artifact
// VOCABULARY NAMES (produces = bare names; consumes = {artifact, required,
// conditional_on} objects) into canonical aidlc-docs/... paths at emit time,
// and drops conditional_on consumes-entries against the workflow's Project Type.
//   - produces resolve under the directive's OWN stage (the node IS the producer).
//   - consumes resolve under their PRODUCING stage (a consumed artifact lives in
//     the dir of the one stage that produces it — docs/reference/
//     16-artifact-vocabulary.md:20-24, 44-48 — not the consuming stage's dir).
//   - per-unit Construction stages (for_each: unit-of-work) inject a {unit-name}
//     segment, applied to whichever stage OWNS the file.
//
// Source under test (dist/claude/.claude/tools/aidlc-orchestrate.ts):
//   :619 resolveArtifactPath(name, owner, unit)
//          - non-per-unit: aidlc-docs/<owner.phase>/<owner.slug>/<name>.md
//          - per-unit:     aidlc-docs/construction/<unit>/<owner.slug>/<name>.md
//   :639 resolveConsumePath(name, node, unit) — keys on producersOf(name)[0],
//          NOT the consuming node (1:1 producer rule); orphan fallback to node.
//   :651 projectTypeFrom(stateContent) — reads "Project Type", lowercased to
//          "brownfield" | "greenfield" | null.
//   :670 resolveConsumes(consumes, node, projectType, unit) — drops a consume
//          whose conditional_on != projectType (when projectType is non-null).
//   :692 resolveProduces(node, unit) — every produces name resolves (no filter).
//   :742 buildRunStageDirective(...) — assembles the directive with the resolved
//          consumes[]/produces[] arrays.
// NONE of these are exported (the tool has zero `export`s — verified), so the
// resolution is only observable on the directive the spawned engine emits to
// stdout. MECHANISM = cli: SPAWN the real `bun aidlc-orchestrate.ts next` via
// node:child_process spawnSync (BUN + the .ts path) and assert on the parsed
// JSON directive's produces[]/consumes[] arrays — the same process boundary the
// .sh drove (`bun "$TOOL" next ... 2>&1` then python-parsed the JSON). An
// in-process twin is IMPOSSIBLE here: the functions are unreachable from TS.
//
// VEHICLE (mirrors the .sh's emit_for, t116:51-63): a WITH-STATE jump now emits
// a `print` naming aidlc-jump.ts execute (NOT a run-stage; pinned by t114/t117/
// t118), so the path-resolution behaviour is reached via the Branch-10 happy
// path — seed a fixture, pivot Current Stage to the target slug AND mark its
// checkbox in-flight ([-]), then run bare `next`. That emits a run-stage for the
// in-flight stage with produces/consumes resolved. Scope MUST be one where the
// target EXECUTEs (feature scope does for application-design/functional-design/
// code-generation). Project Type drives the conditional_on filter and is read
// from the fixture:
//   brownfield = state-brownfield-feature.md (Brownfield, feature)
//   greenfield = state-construction.md       (Greenfield, feature)
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test();
// several STRONGER via exact path equality, exact produces COUNT, and the
// no-self-key directive-wide invariant rather than a single substring grep):
//   .sh test 1  (BF produces 'components' path)             -> "1: brownfield ..."
//   .sh test 2  (BF produces 'decisions' path)              -> "2: brownfield ..."
//   .sh test 3  (BF resolves all 5 produces)                -> "3: brownfield ..."
//   .sh test 4  (BF consume 'architecture' under producer)  -> "4: brownfield ..."
//   .sh test 5  (BF consume 'component-inventory' under prod)-> "5: brownfield ..."
//   .sh test 6  (GF drops conditional 'architecture')        -> "6: greenfield ..."
//   .sh test 7  (GF drops conditional 'component-inventory')-> "7: greenfield ..."
//   .sh test 8  (GF non-conditional produces still resolves)-> "8: greenfield ..."
//   .sh test 9  (per-unit functional-design {unit-name})    -> "9: per-unit ..."
//   .sh test 10 (per-unit code-generation {unit-name})      -> "10: per-unit ..."
//   .sh test 11 (non-per-unit app-design NO {unit-name})    -> "11: non-per-unit ..."
//   .sh test 12 (consume 'requirements' under its producer) -> "12: ..."
//   .sh test 13 (NO consume under app-design's own dir)     -> "13: ..."
//
// FIXTURE DISCIPLINE (mirrors create_test_project + seed_state_file + the in-place
// sed pivots + cleanup_test_project per emit): each emit uses a FRESH temp project
// dir (createTestProject, toPortablePath on Windows so any path the tool
// round-trips through JSON survives). seedStateFile copies the named fixture to
// aidlc-docs/aidlc-state.md, then sedReplaceInFile pivots Current Stage to the
// target and flips its checkbox to [-]. All temp dirs cleaned in afterAll.
// resetAidlcEnv() clears AWS_AIDLC_DEFAULT_SCOPE so a developer's exported value
// can't shadow the fixture scope. Each fixture is emitted ONCE and the directive
// reused across its tests (the .sh emitted BF/GF/FD/CG once each too).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seedStateFile,
  sedReplaceInFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const ORCH = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-orchestrate.ts",
);
const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures");

// reset_aidlc_env (t116 sources fixtures.sh): clear AWS_AIDLC_DEFAULT_SCOPE so
// the fixture's own scope drives stages-in-scope, not a leaked shell export.
resetAidlcEnv();

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

interface RunStageDirective {
  kind: string;
  stage: string;
  consumes: string[];
  produces: string[];
}

/**
 * emit_for (t116:51-63): seed a state fixture into a fresh temp project, pivot
 * Current Stage to the target slug, mark the target's checkbox in-flight ([-]),
 * then run bare `next` and return the parsed run-stage directive.
 *
 * The .sh sed-pivots `Current Stage` and flips `[ ]/[x]/...` to `[-]` for the
 * target line; we replicate both edits via sedReplaceInFile (the TS port of
 * sed_i). The bare `next` lands on Branch 10 and emits the run-stage for the
 * in-flight stage with produces/consumes RESOLVED.
 */
function emitFor(fixture: string, slug: string): RunStageDirective {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedStateFile(proj, join(FIXTURES_DIR, fixture));
  const state = join(proj, "aidlc-docs", "aidlc-state.md");
  // Pivot Current Stage to the target (matches any current value).
  sedReplaceInFile(
    state,
    /^- \*\*Current Stage\*\*:.*$/m,
    `- **Current Stage**: ${slug}`,
  );
  // Flip the target's checkbox to in-flight [-] (matches [ ]/[x]/[-]/[S]/etc.).
  sedReplaceInFile(
    state,
    new RegExp(`^- \\[.\\] ${slug} — EXECUTE`, "m"),
    `- [-] ${slug} — EXECUTE`,
  );
  const res = spawnSync(BUN, [ORCH, "next", "--project-dir", proj], {
    encoding: "utf-8",
    env: (() => {
      const e = { ...process.env };
      delete e.AWS_AIDLC_DEFAULT_SCOPE;
      return e;
    })(),
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  let dir: RunStageDirective;
  try {
    dir = JSON.parse((res.stdout ?? "").trim());
  } catch {
    throw new Error(
      `emitFor(${fixture}, ${slug}) did not emit parseable JSON. status=${res.status}\n${out}`,
    );
  }
  // Sanity: the vehicle must land a run-stage for the target (else the path
  // arrays below assert against the wrong directive kind — fail loudly).
  expect(dir.kind).toBe("run-stage");
  expect(dir.stage).toBe(slug);
  return dir;
}

// ============================================================================
// Brownfield application-design — produces resolve under the stage's own dir;
// the conditional_on:brownfield consumes are PRESENT and keyed on their
// producer (reverse-engineering), not on application-design. (.sh tests 1-5)
// ============================================================================
describe("t116 brownfield application-design (migrated from t116-directive-path-resolution.sh, plan 13)", () => {
  let BF: RunStageDirective;
  beforeAll(() => {
    BF = emitFor("state-brownfield-feature.md", "application-design");
  });

  // .sh test 1: a bare produces name resolves to the canonical non-per-unit path.
  // STRONGER: assert the exact path is a member, not a substring of stdout.
  test("1: brownfield produces 'components' → inception/application-design/components.md", () => {
    expect(BF.produces).toContain(
      "aidlc-docs/inception/application-design/components.md",
    );
  });

  // .sh test 2: another produces name resolves under the same stage dir.
  test("2: brownfield produces 'decisions' → inception/application-design/decisions.md", () => {
    expect(BF.produces).toContain(
      "aidlc-docs/inception/application-design/decisions.md",
    );
  });

  // .sh test 3: the full produces set resolves (5 names). STRONGER than the .sh:
  // assert the EXACT set, not just the count — every produces name maps to a path
  // under application-design's own dir, and there are exactly five.
  test("3: brownfield resolves all 5 produces to inception/application-design/ paths", () => {
    expect(BF.produces).toEqual([
      "aidlc-docs/inception/application-design/components.md",
      "aidlc-docs/inception/application-design/component-methods.md",
      "aidlc-docs/inception/application-design/services.md",
      "aidlc-docs/inception/application-design/component-dependency.md",
      "aidlc-docs/inception/application-design/decisions.md",
    ]);
    expect(BF.produces.length).toBe(5);
  });

  // .sh test 4: conditional_on:brownfield consume 'architecture' is PRESENT for a
  // Brownfield project and resolves UNDER ITS PRODUCER reverse-engineering — NOT
  // the consuming application-design dir.
  test("4: brownfield consume 'architecture' → reverse-engineering/architecture.md (producer-keyed)", () => {
    expect(BF.consumes).toContain(
      "aidlc-docs/inception/reverse-engineering/architecture.md",
    );
  });

  // .sh test 5: the second conditional_on:brownfield consume 'component-inventory'
  // is PRESENT for Brownfield and ALSO resolves under its producer.
  test("5: brownfield consume 'component-inventory' → reverse-engineering/component-inventory.md", () => {
    expect(BF.consumes).toContain(
      "aidlc-docs/inception/reverse-engineering/component-inventory.md",
    );
  });

  // .sh test 12: the NON-conditional required consume 'requirements' also resolves
  // under its producer (requirements-analysis), proving producer-keying applies to
  // every consume, not just the conditional ones.
  test("12: consume 'requirements' → requirements-analysis/requirements.md (producer-keyed, not conditional)", () => {
    expect(BF.consumes).toContain(
      "aidlc-docs/inception/requirements-analysis/requirements.md",
    );
  });

  // .sh test 13: a consume resolves to a DIFFERENT stage's dir than the consuming
  // stage. Every brownfield consume of application-design is produced by some
  // OTHER stage, so NONE may resolve under application-design's own dir. STRONGER
  // than the .sh's single assert_not_contains: assert the invariant over EVERY
  // consume entry, not the raw joined string.
  test("13: no application-design consume resolves under its own dir — each lives under its producer", () => {
    const selfKeyed = BF.consumes.filter((p) =>
      p.startsWith("aidlc-docs/inception/application-design/"),
    );
    expect(selfKeyed).toEqual([]);
  });
});

// ============================================================================
// Greenfield application-design — the brownfield-conditional consumes DROP;
// non-conditional produces still resolve (the filter is consumes-only). (.sh 6-8)
// ============================================================================
describe("t116 greenfield application-design — conditional_on drop", () => {
  let GF: RunStageDirective;
  beforeAll(() => {
    GF = emitFor("state-construction.md", "application-design");
  });

  // .sh test 6: 'architecture' (conditional_on:brownfield) is DROPPED for greenfield.
  // STRONGER: assert NO consume path contains architecture.md (over the array).
  test("6: greenfield drops conditional_on:brownfield consume 'architecture'", () => {
    expect(GF.consumes.some((p) => p.includes("architecture.md"))).toBe(false);
  });

  // .sh test 7: 'component-inventory' (conditional_on:brownfield) is DROPPED for greenfield.
  test("7: greenfield drops conditional_on:brownfield consume 'component-inventory'", () => {
    expect(GF.consumes.some((p) => p.includes("component-inventory.md"))).toBe(
      false,
    );
  });

  // .sh test 8: a non-conditional produces name still resolves for greenfield —
  // the filter only touches conditional_on consumes-entries, not produces.
  test("8: greenfield produces 'components' still resolves (filter is consumes-only)", () => {
    expect(GF.produces).toContain(
      "aidlc-docs/inception/application-design/components.md",
    );
  });
});

// ============================================================================
// Per-unit Construction stages (for_each: unit-of-work) inject {unit-name}.
// (.sh tests 9-11)
// ============================================================================
describe("t116 per-unit {unit-name} injection", () => {
  let FD: RunStageDirective;
  let CG: RunStageDirective;
  let AD: RunStageDirective;
  beforeAll(() => {
    FD = emitFor("state-construction.md", "functional-design");
    CG = emitFor("state-construction.md", "code-generation");
    // application-design here is only used for the test-11 negative; greenfield
    // fixture so it EXECUTEs and is non-per-unit (inception phase).
    AD = emitFor("state-construction.md", "application-design");
  });

  // .sh test 9: functional-design (per-unit) resolves a produces name to the
  // per-unit shape construction/{unit-name}/functional-design/<name>.md.
  test("9: per-unit functional-design injects {unit-name}: construction/{unit-name}/functional-design/business-logic-model.md", () => {
    expect(FD.produces).toContain(
      "aidlc-docs/construction/{unit-name}/functional-design/business-logic-model.md",
    );
  });

  // .sh test 10: code-generation (per-unit) also resolves under
  // construction/{unit-name}/code-generation/. STRONGER: assert at least one
  // produces path begins with the per-unit code-generation prefix (the .sh
  // grepped the joined string for the prefix).
  test("10: per-unit code-generation resolves under construction/{unit-name}/code-generation/", () => {
    expect(
      CG.produces.some((p) =>
        p.startsWith("aidlc-docs/construction/{unit-name}/code-generation/"),
      ),
    ).toBe(true);
  });

  // .sh test 11 (negative): a non-per-unit stage (application-design) does NOT
  // get the construction/{unit-name}/ prefix — its produces stay under inception/.
  // STRONGER: assert the invariant over EVERY produces entry.
  test("11: non-per-unit application-design produces NEVER carry construction/{unit-name}/", () => {
    const perUnit = AD.produces.filter((p) =>
      p.includes("construction/{unit-name}/"),
    );
    expect(perUnit).toEqual([]);
  });
});
