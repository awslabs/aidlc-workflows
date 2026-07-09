// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report
//
// t206 - optional_produces is exempt from per-unit Construction coverage.
// mechanism = cli.
//
// THE CHANGE: functional-design declares frontend-components under
// optional_produces (not produces), so a unit that legitimately has no UI can
// be COVERED by writing only the three REQUIRED artifacts. Before this, the
// per-unit coverage loop (aidlc-orchestrate.ts unitCovered) demanded every
// produces[] name on disk, so a backend-only unit was re-emitted forever and
// the stage gate was unreachable unless the author wrote an N/A stub.
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/aidlc-orchestrate.ts):
//   - unitCovered: iterates node.produces (REQUIRED set only); optional_produces
//     entries never block coverage.
//   - resolveProduces: unions produces + optional_produces, so directives keep
//     listing the conditional artifact's resolved path.
//   - the handleReport per-unit coverage guard, keyed on unitCovered.
// Behaviour is observable only on the JSON directive the spawned engine emits,
// the SAME process boundary t186 drives; this file reuses t186's
// fixture discipline (clean single-row Construction state, pivot + in-flight
// checkbox, bolt_dag with [alpha, beta], per-unit artifact dirs to control
// coverage).

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
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");

// functional-design declares a reviewer; the §12a gate precondition refuses an
// approve without a terminal REVIEW_COMPLETED. These tests target the coverage
// guard, not the reviewer gate, so record a READY review before approving.
function logReviewReady(proj: string, stage: string, reviewer: string, unit?: string): void {
  const args = [LOG, "review", "--stage", stage, "--reviewer", reviewer, "--iteration", "1", "--verdict", "READY"];
  if (unit) args.push("--unit", unit);
  args.push("--project-dir", proj);
  const res = spawnSync(BUN, args, { encoding: "utf-8" });
  // Keep a log-record failure local, not surfaced later as a confusing gate error.
  expect(res.status).toBe(0);
}

// The record-relative prefix every resolved per-unit path is rooted at.
const RP = `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}`;

// functional-design's REQUIRED produces[] - the coverage set. frontend-components
// is under optional_produces and is deliberately NOT here.
const FD_REQUIRED = ["business-logic-model", "business-rules", "domain-entities"];
const FD_OPTIONAL = "frontend-components";

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

// A clean Construction-phase state, one checkbox row per slug, Current Stage
// pivoted to `current` and marked in-flight ([-]). The Skeleton Stance is
// recorded so functional-design (the feature-scope skeleton-gate stage) resolves
// its gate to a boolean rather than emitting the unresolved sentinel.
function constructionState(current: string, skeletonStance = "on"): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: optional-produces coverage test
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

/** Mark `unit` covered for `slug` by writing each named artifact under the
 *  resolved per-unit dir construction/<unit>/<slug>/. */
function coverUnit(proj: string, unit: string, slug: string, names: string[]): void {
  const dir = join(seededRecordDir(proj), "construction", unit, slug);
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    writeFileSync(join(dir, `${name}.md`), `# ${name} for ${unit}\n`);
  }
}

function seedProject(current: string): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  writeFileSync(seededStateFile(proj), constructionState(current));
  return proj;
}

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

function runReport(proj: string, args: string[]): Directive {
  const r = spawnSync(BUN, [ORCH, "report", ...args, "--project-dir", proj], {
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
      `runReport did not emit parseable JSON. status=${r.status}\n${r.stdout}\n${r.stderr}`,
    );
  }
}

describe("t206 optional_produces exempt from per-unit coverage", () => {
  // 1: happy path - the conditional artifact is ABSENT and the unit still
  // counts covered, so the loop advances. Cover alpha with ONLY the three
  // required artifacts (no frontend-components.md) -> next emits beta.
  test("1: a unit covered by required-only artifacts advances the iteration", () => {
    const proj = seedProject("functional-design");
    seedBoltDag(proj, ["alpha", "beta"]);
    coverUnit(proj, "alpha", "functional-design", FD_REQUIRED);
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.unit).toBe("beta");
  }, 30000);

  // 2: guard - a MISSING REQUIRED artifact still blocks coverage even when the
  // OPTIONAL one is present. Cover alpha with two required + the optional but
  // NOT domain-entities -> alpha is still uncovered, so next re-emits alpha with
  // the gate suppressed (optional presence cannot substitute for a required one).
  test("2: an optional artifact cannot substitute for a missing required artifact", () => {
    const proj = seedProject("functional-design");
    seedBoltDag(proj, ["alpha", "beta"]);
    coverUnit(proj, "alpha", "functional-design", [
      "business-logic-model",
      "business-rules",
      FD_OPTIONAL,
    ]);
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.unit).toBe("alpha");
    expect(d.gate).toBe(false);
  }, 30000);

  // 3: gate reachable - cover both units with required-only artifacts. next now
  // presents the stage's REAL gate on the last unit (beta), so the human
  // approval is reachable without any frontend-components.md on disk.
  test("3: the stage gate is reachable with required-only coverage on every unit", () => {
    const proj = seedProject("functional-design");
    seedBoltDag(proj, ["alpha", "beta"]);
    coverUnit(proj, "alpha", "functional-design", FD_REQUIRED);
    coverUnit(proj, "beta", "functional-design", FD_REQUIRED);
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.unit).toBe("beta");
    expect(d.gate).toBe(true);
  }, 30000);

  // 4a: report guard passes on required-only coverage - approve commits (done),
  // no N/A stub for the conditional artifact required.
  test("4a: approve commits with required-only coverage on every unit", () => {
    const proj = seedProject("functional-design");
    seedBoltDag(proj, ["alpha", "beta"]);
    coverUnit(proj, "alpha", "functional-design", FD_REQUIRED);
    coverUnit(proj, "beta", "functional-design", FD_REQUIRED);
    // functional-design declares a reviewer and is per-unit; the §12a gate
    // precondition requires one review PER UNIT (this test targets the coverage guard).
    logReviewReady(proj, "functional-design", "aidlc-architecture-reviewer-agent", "alpha");
    logReviewReady(proj, "functional-design", "aidlc-architecture-reviewer-agent", "beta");
    const d = runReport(proj, [
      "--stage",
      "functional-design",
      "--result",
      "approved",
    ]);
    expect(d.kind).toBe("done");
  }, 30000);

  // 4b: report guard still refuses when a REQUIRED artifact is missing, naming
  // the uncovered unit (beta) - the exemption is scoped to optional_produces.
  test("4b: approve is refused when a required artifact is missing, naming the unit", () => {
    const proj = seedProject("functional-design");
    seedBoltDag(proj, ["alpha", "beta"]);
    coverUnit(proj, "alpha", "functional-design", FD_REQUIRED);
    // beta covered by only two required + the optional -> still uncovered.
    coverUnit(proj, "beta", "functional-design", [
      "business-logic-model",
      "business-rules",
      FD_OPTIONAL,
    ]);
    const d = runReport(proj, [
      "--stage",
      "functional-design",
      "--result",
      "approved",
    ]);
    expect(d.kind).toBe("error");
    expect(d.message).toContain("beta");
    expect(d.message).not.toContain("alpha"); // alpha is covered, not named
  }, 30000);

  // 5: directive paths keep the optional artifact. Any per-unit directive's
  // produces[] still includes the resolved frontend-components.md path (the
  // conductor needs it when the unit DOES have a UI), even though the artifact
  // is exempt from coverage.
  test("5: the per-unit directive still lists the optional artifact's resolved path", () => {
    const proj = seedProject("functional-design");
    seedBoltDag(proj, ["alpha", "beta"]);
    const d = runNext(proj);
    expect(d.unit).toBe("alpha");
    expect(d.produces).toContain(
      `${RP}/construction/alpha/functional-design/${FD_OPTIONAL}.md`,
    );
    // and still lists a required one.
    expect(d.produces).toContain(
      `${RP}/construction/alpha/functional-design/business-logic-model.md`,
    );
  }, 30000);
});
