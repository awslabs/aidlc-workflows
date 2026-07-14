// covers: subcommand:aidlc-orchestrate:next
//
// CLI-contract test for the DEFAULT (off) and non-activating values of the
// construction-iteration knob. mechanism = cli.
//
// THE INVARIANT: only the exact value `unit-major` activates the unit-major walk
// (readConstructionIteration is a strict read). An ABSENT field, the explicit
// value `stage-major`, and any JUNK value (e.g. `unit-majorish`) all read as
// stage-major, and stage-major is byte-identical to today's behaviour: a design
// stage runs for every unit, then the next stage. This file proves the knob is
// zero-risk for existing users (no field, no behaviour change) by deep-equal
// comparison of the emitted directive across (absent, stage-major, junk) at
// several coverage states, and against the known stage-major shapes (the t186
// expectations: functional-design/alpha, then functional-design/beta, then the
// real gate on the last unit).
//
// It also proves the swarm keeps first refusal: an autonomous code-generation
// fixture with `Construction Iteration: unit-major` ALSO set still emits
// invoke-swarm for batch 1: the mode:inline filter excludes the subagent stage
// from the unit-major walk, and tryEmitSwarm runs before emitForSlug.
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/aidlc-orchestrate.ts):
//   - readConstructionIteration (strict read) + the emitForSlug routing branch.
//   - tryEmitSwarm's first-refusal ordering (unchanged).
// MECHANISM = cli: SPAWN `bun aidlc-orchestrate.ts next` and assert on the parsed
// directive, the SAME process boundary t186 / t135 drive.
//
// FIXTURE DISCIPLINE (mirrors t186 + t135): fresh temp project per case, a CLEAN
// single-row-per-slug Construction state, `Skeleton Stance` recorded, a bolt_dag
// with units [alpha, beta]. All temp dirs cleaned in afterEach.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

resetAidlcEnv();

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");

const FD_PRODUCES = [
  "business-logic-model",
  "business-rules",
  "domain-entities",
  "frontend-components",
];

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

interface Directive {
  kind?: string;
  stage?: string;
  unit?: string;
  gate?: unknown;
  units?: string[];
  [k: string]: unknown;
}

/**
 * A CLEAN Construction-phase state file pivoted to `current`, in-flight.
 * `iteration`, when set, writes the `Construction Iteration` field under a
 * `## Runtime State` section. `autonomy`, when set, adds the autonomy grant.
 */
function constructionState(opts: {
  current: string;
  iteration?: string;
  autonomy?: string;
}): string {
  const runtimeSection = opts.iteration
    ? `\n## Runtime State\n- **Construction Iteration**: ${opts.iteration}\n`
    : "";
  const autonomyLine = opts.autonomy
    ? `- **Construction Autonomy Mode**: ${opts.autonomy}\n`
    : "";
  return `# AI-DLC State Tracking

## Project Information
- **Project**: iteration knob default test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 7
- **Skeleton Stance**: on
${autonomyLine}## Scope Configuration
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
- **Current Stage**: ${opts.current}
- **Status**: Running
${runtimeSection}`;
}

/** Write a single-batch bolt_dag runtime graph into the record. */
function seedBoltDag(proj: string, units: string[]): void {
  writeFileSync(
    join(seededRecordDir(proj), "runtime-graph.json"),
    JSON.stringify(
      {
        bolt_dag: {
          units: units.map((name) => ({ name, depends_on: [] })),
          batches: [units],
        },
      },
      null,
      2,
    ),
  );
}

/** Write a MULTI-batch bolt_dag (each inner array is one topological batch). */
function seedMultiBatchDag(proj: string, batches: string[][]): void {
  const names = batches.flat();
  writeFileSync(
    join(seededRecordDir(proj), "runtime-graph.json"),
    JSON.stringify(
      {
        bolt_dag: {
          units: names.map((name) => ({ name, depends_on: [] })),
          batches,
        },
      },
      null,
      2,
    ),
  );
}

/** Mark `unit` COVERED for `slug` by writing each artifact in `producesNames`. */
function coverUnit(
  proj: string,
  unit: string,
  slug: string,
  producesNames: string[],
): void {
  const dir = join(seededRecordDir(proj), "construction", unit, slug);
  mkdirSync(dir, { recursive: true });
  for (const name of producesNames) {
    writeFileSync(join(dir, `${name}.md`), `# ${name} for ${unit}\n`);
  }
}

/** Seed a fresh Construction project. Returns the proj dir. */
function seedProject(opts: {
  current?: string;
  iteration?: string;
  autonomy?: string;
}): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  writeFileSync(
    seededStateFile(proj),
    constructionState({ current: opts.current ?? "functional-design", ...opts }),
  );
  return proj;
}

/** Run `aidlc-orchestrate.ts next` and parse the emitted directive. */
function runNext(proj: string): Directive {
  const r = spawnSync(BUN, [ORCH, "next", "--project-dir", proj], {
    encoding: "utf-8",
    env: (() => {
      const e = { ...process.env };
      delete e.AWS_AIDLC_DEFAULT_SCOPE;
      return e;
    })(),
  });
  try {
    return JSON.parse((r.stdout ?? "").trim()) as Directive;
  } catch {
    throw new Error(
      `runNext did not emit parseable JSON. status=${r.status}\n${r.stdout}\n${r.stderr}`,
    );
  }
}

// Cover alpha's functional-design produces before `next`, to reach the
// stage-major "advance to beta" shape.
function coverAlphaFd(proj: string): void {
  coverUnit(proj, "alpha", "functional-design", FD_PRODUCES);
}

// Cover both units' functional-design produces, to reach the all-covered gate.
function coverBothFd(proj: string): void {
  coverUnit(proj, "alpha", "functional-design", FD_PRODUCES);
  coverUnit(proj, "beta", "functional-design", FD_PRODUCES);
}

// Drive `next` for a given knob value at a given coverage state and return the
// directive. `cover` seeds artifacts before the run.
function directiveFor(
  iteration: string | undefined,
  cover: (p: string) => void,
): Directive {
  const proj = seedProject({ iteration });
  seedBoltDag(proj, ["alpha", "beta"]);
  cover(proj);
  return runNext(proj);
}

describe("t210 construction-iteration knob default (off / non-activating)", () => {
  // The three coverage states and their known stage-major expectations (t186
  // shapes): empty -> functional-design/alpha; alpha-fd-covered ->
  // functional-design/beta; both-fd-covered -> functional-design gate on beta.
  const STATES: Array<{
    name: string;
    cover: (p: string) => void;
    expected: { stage: string; unit: string; gate: boolean };
  }> = [
    {
      name: "empty coverage",
      cover: () => {},
      expected: { stage: "functional-design", unit: "alpha", gate: false },
    },
    {
      name: "alpha functional-design covered",
      cover: coverAlphaFd,
      expected: { stage: "functional-design", unit: "beta", gate: false },
    },
    {
      name: "both functional-design covered",
      cover: coverBothFd,
      expected: { stage: "functional-design", unit: "beta", gate: true },
    },
  ];

  for (const st of STATES) {
    // 1: field ABSENT and explicit stage-major produce the SAME directive, AND it
    // matches the known stage-major shape. Deep-equal proves byte-identical
    // behaviour off the knob.
    test(`1[${st.name}]: absent field == stage-major == known stage-major shape`, () => {
      const absent = directiveFor(undefined, st.cover);
      const stageMajor = directiveFor("stage-major", st.cover);
      expect(absent).toEqual(stageMajor);
      expect(absent.stage).toBe(st.expected.stage);
      expect(absent.unit).toBe(st.expected.unit);
      expect(absent.gate).toBe(st.expected.gate);
    }, 30000);

    // 2: a JUNK value also reads as stage-major (strict read: only exactly
    // "unit-major" activates). Deep-equal to the absent-field directive.
    test(`2[${st.name}]: junk value "unit-majorish" reads as stage-major`, () => {
      const absent = directiveFor(undefined, st.cover);
      const junk = directiveFor("unit-majorish", st.cover);
      expect(junk).toEqual(absent);
    }, 30000);
  }

  // 3: the pivotal ordering difference is REAL: at alpha-fd-covered, stage-major
  // emits functional-design/beta while unit-major emits nfr-requirements/alpha.
  // This is the negative control proving the deep-equals above are meaningful.
  test("3: unit-major diverges from stage-major at the same coverage state", () => {
    const stageMajor = directiveFor("stage-major", coverAlphaFd);
    const unitMajor = directiveFor("unit-major", coverAlphaFd);
    expect(stageMajor.stage).toBe("functional-design");
    expect(stageMajor.unit).toBe("beta");
    expect(unitMajor.stage).toBe("nfr-requirements");
    expect(unitMajor.unit).toBe("alpha");
  }, 30000);

  // 4: swarm untouched. An autonomous code-generation fixture with a multi-batch
  // DAG AND `Construction Iteration: unit-major` still emits invoke-swarm for
  // batch 1: the unit-major walk only covers mode:inline design stages, and
  // tryEmitSwarm has first refusal before emitForSlug is reached.
  test("4: autonomous code-generation with unit-major set still swarms batch 1", () => {
    const proj = seedProject({
      current: "code-generation",
      iteration: "unit-major",
      autonomy: "autonomous",
    });
    // code-generation is not the skeleton-gate stage for feature scope, so no
    // stance is needed for it to swarm; mark the upstream design stages [x] and
    // code-generation [-] so the run lands cleanly on the construction stage.
    const statePath = seededStateFile(proj);
    let state = readFileSync(statePath, "utf-8");
    for (const s of [
      "functional-design",
      "nfr-requirements",
      "nfr-design",
      "infrastructure-design",
    ]) {
      state = state.replace(`- [-] ${s} — EXECUTE`, `- [x] ${s} — EXECUTE`)
        .replace(`- [ ] ${s} — EXECUTE`, `- [x] ${s} — EXECUTE`);
    }
    state = state.replace(
      "- [ ] code-generation — EXECUTE",
      "- [-] code-generation — EXECUTE",
    );
    writeFileSync(statePath, state);
    seedMultiBatchDag(proj, [["alpha"], ["beta"]]);
    const d = runNext(proj);
    expect(d.kind).toBe("invoke-swarm");
    expect(d.units).toEqual(["alpha"]);
  }, 30000);
});
