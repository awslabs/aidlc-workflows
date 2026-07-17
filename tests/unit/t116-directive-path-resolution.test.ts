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
//          - codekb owner: aidlc/spaces/<space>/codekb/<repo>/<name>.md (the
//            isCodekb arm — fires for produces[] AND consumes[] of a codekb stage
//            like reverse-engineering, dropping the per-intent record tail).
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
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  AIDLC_MEMORY_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  resetAidlcEnv,
  seededStateFile,
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

// P9: the engine resolves a directive's produces/consumes RELATIVE to the active
// intent's record dir (relativeRecordDir). The fixtures seed one default intent,
// so the record prefix is deterministic. Every expected directive path below is
// rooted here (was the flat `aidlc-docs/` prefix pre-P9).
const RP = `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}`;

// The reverse-engineering stage's artifacts live in the SPACE-LEVEL codekb store
// (`aidlc/spaces/<space>/codekb/<repo>/`), NOT under any intent's record dir —
// the codekb-determinism placement fix (isCodekb resolver branch). A consume of
// an RE-produced artifact therefore resolves under this prefix keyed by the
// repo NAME, which for these no-repo fixtures is basename(projectDir) (a dynamic
// temp dir name). We assert the SPACE PREFIX + artifact filename rather than the
// full path so the assertion is robust to the per-emit temp basename.
const CODEKB_PREFIX = `aidlc/spaces/${DEFAULT_SPACE}/codekb/`;

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
  lead_agent: string;
  support_agents: string[];
  mode: string;
  inline_context_paths: string[];
  rules_in_context: string[];
  consumes: string[];
  consumes_absent?: Array<{ path: string; expected: boolean }>;
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
function emitForWithProject(
  fixture: string,
  slug: string,
  seedArtifacts?: (proj: string) => void,
): { directive: RunStageDirective; projectDir: string } {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedStateFile(proj, join(FIXTURES_DIR, fixture));
  seedArtifacts?.(proj);
  const state = seededStateFile(proj);
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
  return { directive: dir, projectDir: proj };
}

function emitFor(
  fixture: string,
  slug: string,
  seedArtifacts?: (proj: string) => void,
): RunStageDirective {
  return emitForWithProject(fixture, slug, seedArtifacts).directive;
}

// The union of a directive's PRESENT and ABSENT consume paths. This suite
// asserts path RESOLUTION (which producer dir a consume is keyed under), which
// is orthogonal to the presence split: the bare fixtures seed only
// aidlc-state.md, so every consumed artifact is absent on disk and lands in
// consumes_absent. Resolution assertions run over the union; the split's own
// contract (present vs absent membership) is asserted separately below.
function allConsumePaths(dir: RunStageDirective): string[] {
  return [...dir.consumes, ...(dir.consumes_absent ?? []).map((e) => e.path)];
}

// ============================================================================
// Brownfield application-design — produces resolve under the stage's own dir;
// the conditional_on:brownfield consumes are PRESENT and keyed on their
// producer (reverse-engineering), not on application-design. (.sh tests 1-5)
// ============================================================================
describe("t116 brownfield application-design (migrated from t116-directive-path-resolution.sh, plan 13)", () => {
  let BF: RunStageDirective;
  beforeAll(() => {
    // Seed every consumed artifact on disk so the RESOLUTION assertions below
    // observe all five paths in `consumes`. The presence SPLIT (absent
    // required → consumes_absent, absent optional → dropped) is asserted by
    // its own describe block below; this block tests WHERE paths resolve, so
    // all inputs are made present. The two RE artifacts live in the
    // space-level codekb keyed by repo name = basename(projectDir) (the
    // no-recorded-repos default).
    BF = emitFor("state-brownfield-feature.md", "application-design", (proj) => {
      const rels = [
        `${RP}/inception/requirements-analysis/requirements.md`,
        `${RP}/inception/user-stories/stories.md`,
        `${RP}/inception/practices-discovery/team-practices.md`,
        `aidlc/spaces/${DEFAULT_SPACE}/codekb/${basename(proj)}/architecture.md`,
        `aidlc/spaces/${DEFAULT_SPACE}/codekb/${basename(proj)}/component-inventory.md`,
      ];
      for (const rel of rels) {
        const abs = join(proj, ...rel.split("/"));
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, "# seeded\n", "utf-8");
      }
    });
  });

  // .sh test 1: a bare produces name resolves to the canonical non-per-unit path.
  // STRONGER: assert the exact path is a member, not a substring of stdout.
  test("1: brownfield produces 'components' → inception/application-design/components.md", () => {
    expect(BF.produces).toContain(
      `${RP}/inception/application-design/components.md`,
    );
  });

  // .sh test 2: another produces name resolves under the same stage dir.
  test("2: brownfield produces 'decisions' → inception/application-design/decisions.md", () => {
    expect(BF.produces).toContain(
      `${RP}/inception/application-design/decisions.md`,
    );
  });

  // .sh test 3: the full produces set resolves (5 names). STRONGER than the .sh:
  // assert the EXACT set, not just the count — every produces name maps to a path
  // under application-design's own dir, and there are exactly five.
  test("3: brownfield resolves all 5 produces to inception/application-design/ paths", () => {
    expect(BF.produces).toEqual([
      `${RP}/inception/application-design/components.md`,
      `${RP}/inception/application-design/component-methods.md`,
      `${RP}/inception/application-design/services.md`,
      `${RP}/inception/application-design/component-dependency.md`,
      `${RP}/inception/application-design/decisions.md`,
    ]);
    expect(BF.produces.length).toBe(5);
  });

  // .sh test 4: conditional_on:brownfield consume 'architecture' is PRESENT for a
  // Brownfield project and — because reverse-engineering is its PRODUCER and RE
  // is a codekb stage — resolves under the SPACE-LEVEL codekb store
  // (`aidlc/spaces/<space>/codekb/<repo>/architecture.md`), NOT the per-intent
  // record dir and NOT the consuming application-design dir (the isCodekb
  // resolver branch, codekb-determinism placement fix).
  test("4: brownfield consume 'architecture' → space-level codekb/<repo>/architecture.md (codekb-keyed)", () => {
    const paths = allConsumePaths(BF);
    const hit = paths.find(
      (p) => p.startsWith(CODEKB_PREFIX) && p.endsWith("/architecture.md"),
    );
    expect(hit, `no codekb-resolved architecture.md in ${JSON.stringify(paths)}`).toBeDefined();
    // It must NOT carry the old record-dir RE tail.
    expect(paths).not.toContain(`${RP}/inception/reverse-engineering/architecture.md`);
  });

  // .sh test 5: the second conditional_on:brownfield consume 'component-inventory'
  // is PRESENT for Brownfield and ALSO resolves under the space-level codekb store.
  test("5: brownfield consume 'component-inventory' → space-level codekb/<repo>/component-inventory.md", () => {
    const paths = allConsumePaths(BF);
    const hit = paths.find(
      (p) => p.startsWith(CODEKB_PREFIX) && p.endsWith("/component-inventory.md"),
    );
    expect(hit, `no codekb-resolved component-inventory.md in ${JSON.stringify(paths)}`).toBeDefined();
    expect(paths).not.toContain(`${RP}/inception/reverse-engineering/component-inventory.md`);
  });

  // .sh test 12: the NON-conditional required consume 'requirements' also resolves
  // under its producer (requirements-analysis), proving producer-keying applies to
  // every consume, not just the conditional ones.
  test("12: consume 'requirements' → requirements-analysis/requirements.md (producer-keyed, not conditional)", () => {
    expect(allConsumePaths(BF)).toContain(
      `${RP}/inception/requirements-analysis/requirements.md`,
    );
  });

  // .sh test 13: a consume resolves to a DIFFERENT stage's dir than the consuming
  // stage. Every brownfield consume of application-design is produced by some
  // OTHER stage, so NONE may resolve under application-design's own dir. STRONGER
  // than the .sh's single assert_not_contains: assert the invariant over EVERY
  // consume entry, not the raw joined string.
  test("13: no application-design consume resolves under its own dir — each lives under its producer", () => {
    const selfKeyed = allConsumePaths(BF).filter((p) =>
      p.startsWith(`${RP}/inception/application-design/`),
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
    expect(allConsumePaths(GF).some((p) => p.includes("architecture.md"))).toBe(false);
  });

  // .sh test 7: 'component-inventory' (conditional_on:brownfield) is DROPPED for greenfield.
  test("7: greenfield drops conditional_on:brownfield consume 'component-inventory'", () => {
    expect(allConsumePaths(GF).some((p) => p.includes("component-inventory.md"))).toBe(
      false,
    );
  });

  // .sh test 8: a non-conditional produces name still resolves for greenfield —
  // the filter only touches conditional_on consumes-entries, not produces.
  test("8: greenfield produces 'components' still resolves (filter is consumes-only)", () => {
    expect(GF.produces).toContain(
      `${RP}/inception/application-design/components.md`,
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
      `${RP}/construction/{unit-name}/functional-design/business-logic-model.md`,
    );
  });

  // .sh test 10: code-generation (per-unit) also resolves under
  // construction/{unit-name}/code-generation/. STRONGER: assert at least one
  // produces path begins with the per-unit code-generation prefix (the .sh
  // grepped the joined string for the prefix).
  test("10: per-unit code-generation resolves under construction/{unit-name}/code-generation/", () => {
    expect(
      CG.produces.some((p) =>
        p.startsWith(`${RP}/construction/{unit-name}/code-generation/`),
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

// ============================================================================
// consumes presence split — the directive's `consumes` carries only inputs
// that EXIST on disk; declared-but-missing inputs move to `consumes_absent`
// with an `expected` annotation (producer off the scope path = true, producer
// on the path but file missing = false). Paths still carrying the {unit-name}
// placeholder are exempt from the split (existence unknowable pre-Bolt).
// ============================================================================
describe("t116 consumes presence split (consumes_absent)", () => {
  // application-design (brownfield feature) declares ONE required consume
  // (requirements) and four optional ones (stories, team-practices, and the
  // two brownfield-conditional RE artifacts). Seeding team-practices while
  // leaving the rest unseeded exercises all three split outcomes at once:
  // present-optional → consumes, absent-required → consumes_absent, and
  // absent-optional → dropped from the directive entirely.
  test("14: present optional stays in consumes; absent required lands in consumes_absent; absent optional is dropped", () => {
    const teamPracticesRel = `${RP}/inception/practices-discovery/team-practices.md`;
    const reqRel = `${RP}/inception/requirements-analysis/requirements.md`;
    const dir = emitFor(
      "state-brownfield-feature.md",
      "application-design",
      (proj) => {
        const abs = join(proj, ...teamPracticesRel.split("/"));
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, "# Team Practices\n\nseeded\n", "utf-8");
      },
    );
    // The seeded optional input is PRESENT.
    expect(dir.consumes).toContain(teamPracticesRel);
    // The unseeded REQUIRED input (requirements) is absent — and its
    // producer requirements-analysis is EXECUTE for feature scope, so it is
    // a should-have-existed gap: expected=false. (The optional consumes'
    // producers — user-stories, practices-discovery, reverse-engineering —
    // are also all on the feature path, but optional entries never reach
    // consumes_absent regardless.)
    const absent = dir.consumes_absent ?? [];
    expect(absent).toEqual([{ path: reqRel, expected: false }]);
    // The unseeded OPTIONAL inputs (stories + the two brownfield RE
    // artifacts) appear in NEITHER array — absent optional means dropped.
    const everywhere = [...dir.consumes, ...absent.map((e) => e.path)];
    expect(everywhere.some((p) => p.endsWith("/stories.md"))).toBe(false);
    expect(everywhere.some((p) => p.endsWith("/architecture.md"))).toBe(false);
  });

  test("15: with nothing seeded, consumes is empty and consumes_absent carries only the required consume", () => {
    const dir = emitFor("state-brownfield-feature.md", "application-design");
    expect(dir.consumes).toEqual([]);
    expect(dir.consumes_absent).toEqual([
      {
        path: `${RP}/inception/requirements-analysis/requirements.md`,
        expected: false,
      },
    ]);
  });

  // nfr-requirements consumes business-logic-model/business-rules, produced by
  // the PER-UNIT functional-design — with no Bolt context the resolved consume
  // paths keep the {unit-name} placeholder, so they must stay in `consumes`
  // (existence is unknowable), while the resolvable-but-unseeded requirements
  // consume still splits to consumes_absent.
  test("16: {unit-name}-placeholder consume paths are exempt from the split (stay in consumes)", () => {
    const dir = emitFor("state-construction.md", "nfr-requirements");
    const placeholder = dir.consumes.filter((p) =>
      p.includes("{unit-name}"),
    );
    expect(placeholder.length).toBeGreaterThan(0);
    const absentPlaceholder = (dir.consumes_absent ?? []).filter((e) =>
      e.path.includes("{unit-name}"),
    );
    expect(absentPlaceholder).toEqual([]);
    expect((dir.consumes_absent ?? []).map((e) => e.path)).toContain(
      `${RP}/inception/requirements-analysis/requirements.md`,
    );
  });
});

describe("t116 inline context roster", () => {
  test("17: inline directives enumerate lead, every support, shipped knowledge, and active-space knowledge", () => {
    const customPaths = [
      `aidlc/spaces/${DEFAULT_SPACE}/knowledge/aidlc-shared/team-context.md`,
      `aidlc/spaces/${DEFAULT_SPACE}/knowledge/aidlc-architect-agent/architecture-context.md`,
      `aidlc/spaces/${DEFAULT_SPACE}/knowledge/aidlc-aws-platform-agent/platform-context.md`,
      `aidlc/spaces/${DEFAULT_SPACE}/knowledge/aidlc-design-agent/design-context.md`,
    ];
    const { directive, projectDir } = emitForWithProject(
      "state-construction.md",
      "application-design",
      (proj) => {
        cpSync(AIDLC_MEMORY_SRC, join(proj, "aidlc"), { recursive: true });
        for (const relative of customPaths) {
          const absolute = join(proj, ...relative.split("/"));
          mkdirSync(dirname(absolute), { recursive: true });
          writeFileSync(absolute, "# Custom knowledge\n", "utf-8");
        }
      },
    );

    expect(directive.mode).toBe("inline");
    expect(directive.lead_agent).toBe("aidlc-architect-agent");
    expect(directive.support_agents).toEqual([
      "aidlc-aws-platform-agent",
      "aidlc-design-agent",
    ]);
    expect(directive.rules_in_context).toEqual([
      `aidlc/spaces/${DEFAULT_SPACE}/memory/org.md`,
      `aidlc/spaces/${DEFAULT_SPACE}/memory/team.md`,
      `aidlc/spaces/${DEFAULT_SPACE}/memory/project.md`,
      `aidlc/spaces/${DEFAULT_SPACE}/memory/phases/inception.md`,
    ]);
    for (const path of directive.rules_in_context) {
      expect(existsSync(join(projectDir, ...path.split("/"))), path).toBe(true);
    }
    for (const agent of [
      directive.lead_agent,
      ...directive.support_agents,
    ]) {
      expect(directive.inline_context_paths).toContain(
        `.claude/agents/${agent}.md`,
      );
      expect(
        directive.inline_context_paths.some((path) =>
          path.startsWith(`.claude/knowledge/${agent}/`)
        ),
        `missing shipped knowledge for ${agent}`,
      ).toBe(true);
    }
    expect(
      directive.inline_context_paths.some((path) =>
        path.startsWith(".claude/knowledge/aidlc-shared/")
      ),
    ).toBe(true);
    for (const path of customPaths) {
      expect(directive.inline_context_paths).toContain(path);
    }
    expect(new Set(directive.inline_context_paths).size).toBe(
      directive.inline_context_paths.length,
    );
    for (const path of directive.inline_context_paths) {
      const root = path.startsWith(".claude/")
        ? join(REPO_ROOT, "dist", "claude")
        : projectDir;
      expect(existsSync(join(root, ...path.split("/"))), path).toBe(true);
    }
  });

  test("18: mob directives carry lead-only inline context", () => {
    const directive = emitFor("state-construction.md", "user-stories");
    expect(directive.mode).toBe("mob");
    expect(directive.lead_agent).toBe("aidlc-product-agent");
    expect(directive.inline_context_paths).toContain(
      ".claude/agents/aidlc-product-agent.md",
    );
    expect(
      directive.inline_context_paths.some((path) =>
        path.startsWith(".claude/knowledge/aidlc-product-agent/")
      ),
    ).toBe(true);
    for (const support of directive.support_agents) {
      expect(directive.inline_context_paths).not.toContain(
        `.claude/agents/${support}.md`,
      );
      expect(
        directive.inline_context_paths.some((path) =>
          path.startsWith(`.claude/knowledge/${support}/`)
        ),
      ).toBe(false);
    }
  });

  test("19: fully-dispatched modes carry no inline context", () => {
    const directive = emitFor("state-construction.md", "code-generation");
    expect(directive.mode).toBe("subagent");
    expect(directive.inline_context_paths).toEqual([]);
  });
});
