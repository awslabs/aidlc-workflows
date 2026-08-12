// covers: subcommand:aidlc-orchestrate:next
//
// t279 - consumes_absent's `expected` flag now respects a producer's own
// produces_kinds gate. Regression test for the defect reported in #736.
//
// Mechanism: cli. splitConsumesByPresence is unexported, so the contract is
// exercised behaviourally through the JSON run-stage directive the spawned
// engine emits - the same boundary t186/t208 (per-unit iteration/kind
// pruning) drive.
//
// THE DEFECT: splitConsumesByPresence() computed each consumes_absent entry's
// `expected` flag purely from whether a PRODUCING STAGE is on the active
// scope's path - it never checked the current unit's `kind` against that
// producer's own produces_kinds gate. Its sibling function, resolveProduces(),
// already does exactly this filtering on the produces side. Result: a `ui`-kind
// unit that correctly never produces `business-rules.md` (functional-design's
// own produces_kinds gates it to [service, spec, library], excluding `ui`) was
// flagged `expected: false` ("a real gap") on nfr-requirements' own directive,
// because functional-design itself did run - the checker never looked one
// level deeper at whether THIS artifact was legitimately excluded for THIS
// unit's kind.
//
// THE FIX: splitConsumesByPresence now takes unitKind (mirroring
// resolveProduces's existing parameter) and additionally checks the
// producer's own produces_kinds gate via filterProducesByKind before
// computing `expected`.
//
// Fixture discipline mirrors t208: a fresh temp project per case, a clean
// single-row Construction state pivoted directly to nfr-requirements (the
// real consumer in the bug report), and a kind-aware bolt_dag runtime graph.
// No functional-design artifact is ever written for the ui-kind case - the
// absence is the point.

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seededStateFile,
} from "../harness/fixtures.ts";

resetAidlcEnv();

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");

interface Directive {
  stage?: string;
  unit?: string;
  consumes_absent?: Array<{ path: string; expected: boolean }>;
  [k: string]: unknown;
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

function constructionState(current: string): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: consumes_absent kind-gate test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 7
- **Skeleton Stance**: on
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [x] functional-design — EXECUTE
- [-] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE

### INCEPTION PHASE
- [x] application-design — EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${current}
- **Status**: Running
`;
}

function seedProject(current: string): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), constructionState(current));
  return proj;
}

function runNext(proj: string): Directive {
  const e = { ...process.env };
  delete e.AWS_AIDLC_DEFAULT_SCOPE;
  const r = runOrchestrateNext(ORCH, proj, [], { env: e });
  if (r.directive === null) {
    throw new Error(`runNext no JSON. status=${r.status}\n${r.stdout}\n${r.stderr}`);
  }
  return r.directive as Directive;
}

function businessRulesAbsentEntry(d: Directive): { path: string; expected: boolean } | undefined {
  return d.consumes_absent?.find((e) => e.path.endsWith("/business-rules.md"));
}

describe("t279 consumes_absent respects produces_kinds (#736)", () => {
  // 1: a ui-kind unit at nfr-requirements — business-rules.md is genuinely,
  // legitimately never produced (functional-design's own produces_kinds gates
  // it to [service, spec, library]). expected MUST be true — not a real gap.
  test("1: a ui-kind unit's absent business-rules is expected:true, not a false alarm", () => {
    const proj = seedProject("nfr-requirements");
    seedBoltDag(proj, [{ name: "web", kind: "ui" }]);
    const d = runNext(proj);
    expect(d.stage).toBe("nfr-requirements");
    expect(d.unit).toBe("web");
    const entry = businessRulesAbsentEntry(d);
    expect(entry).toBeDefined();
    expect(entry!.expected).toBe(true);
  }, 30000);

  // 2: REGRESSION ANCHOR — a service-kind unit at the same stage, same
  // missing file. business-rules IS in scope for [service, spec, library], so
  // its absence is a genuine gap: expected must stay false, byte-identical to
  // pre-fix behaviour. Proves the fix is a strict narrowing, not a blanket
  // "always true" change.
  test("2: a service-kind unit's absent business-rules is still expected:false (real gap)", () => {
    const proj = seedProject("nfr-requirements");
    seedBoltDag(proj, [{ name: "api", kind: "service" }]);
    const d = runNext(proj);
    expect(d.stage).toBe("nfr-requirements");
    expect(d.unit).toBe("api");
    const entry = businessRulesAbsentEntry(d);
    expect(entry).toBeDefined();
    expect(entry!.expected).toBe(false);
  }, 30000);

  // 3: REGRESSION ANCHOR — an UNTAGGED unit (no kind at all) at the same
  // stage. unitKind is null, so filterProducesByKind is a no-op: behaviour
  // must be byte-identical to today's (expected:false, a real gap).
  test("3: an untagged unit's absent business-rules is still expected:false (unchanged)", () => {
    const proj = seedProject("nfr-requirements");
    seedBoltDag(proj, [{ name: "svc" }]);
    const d = runNext(proj);
    expect(d.stage).toBe("nfr-requirements");
    expect(d.unit).toBe("svc");
    const entry = businessRulesAbsentEntry(d);
    expect(entry).toBeDefined();
    expect(entry!.expected).toBe(false);
  }, 30000);
});
