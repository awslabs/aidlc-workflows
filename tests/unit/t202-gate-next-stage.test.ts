// covers: subcommand:aidlc-orchestrate:next
//
// t202 - the engine computes the gate's next-stage name. mechanism = cli.
//
// THE BUG: during Construction the approval gate's Approve option always read
// "Continue to Code Generation" regardless of the real next stage, because the
// "[next stage]" text was an LLM-filled placeholder the conductor guessed at and
// the run-stage directive carried no next-stage field. THE FIX: the engine
// attaches `next_stage` (aidlc-directive.ts) to every run-stage directive - the
// DISPLAY NAME of the next in-scope stage after the one being run, computed via
// nextInScopeStage (the same scope+state walk the post-approval advance uses),
// or null on the final in-scope stage. The conductor renders that value verbatim
// ("Continue to <next_stage>" / "Complete workflow"), never inferring it.
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/aidlc-orchestrate.ts):
//   - buildRunStageDirective, the single run-stage build site: after building the
//     directive it computes nextInScopeStage(node.slug, scope, stateContent) and
//     sets directive.next_stage = next ? next.name : null.
//   - aidlc-directive.ts, the optional-nullable `next_stage` field on
//     RunStageDirective + its checkOptionalNullableString validation.
// The engine has zero exports, so the behaviour is observable only on the JSON
// directive the spawned engine emits to stdout - mechanism = cli: SPAWN
// `bun aidlc-orchestrate.ts next` and assert on the parsed directive, the SAME
// process boundary t116 (emit/parse) and t186 (per-unit iteration) drive.
//
// FIXTURE DISCIPLINE (mirrors t186's seedProject): each case uses a FRESH temp
// project (createTestProject) with a CLEAN single-row-per-slug state covering
// every stage in graph order (NOT the synthetic duplicate-row
// state-construction.md fixture), so the graph walk nextInScopeStage runs and the
// state checkboxes stay consistent. Current Stage pivots to the stage under test,
// marked in-flight ([-]). The `Skeleton Stance` field is recorded so
// functional-design (the feature-scope skeleton-gate stage) resolves its gate to
// a boolean and iterates rather than emitting the unresolved sentinel, isolating
// the next_stage behaviour. For feature scope every stage is EXECUTE, so the next
// in-scope stage after functional-design is nfr-requirements ("NFR Requirements")
// - exactly the label the issue expects. All temp dirs are cleaned in afterEach.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seededStateFile,
} from "../harness/fixtures.ts";

resetAidlcEnv();

const BUN = process.execPath; // the bun running this test
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");

// The checkbox-row separator the state format uses (parseCheckboxes /
// parseStateStageSuffixes match on the U+2014 em dash). Built from its code
// point so this source carries no literal non-keyboard character.
const SEP = String.fromCharCode(0x2014);

// Every stage slug in compiled graph order. A row per slug keeps the state
// checkboxes and nextInScopeStage's graph walk fully consistent.
const ALL_SLUGS = [
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
  "practices-discovery",
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
];

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

interface Directive {
  kind?: string;
  stage?: string;
  next_stage?: string | null;
  gate?: unknown;
  [k: string]: unknown;
}

/**
 * A CLEAN state file with one checkbox row per slug in graph order. Current
 * Stage pivots to `current` (marked [-] in-flight); every slug BEFORE it in the
 * list is [x] completed; `skipped` slugs are stamped [S] with a SKIP suffix
 * override; the rest are pending. A recorded Skeleton Stance keeps
 * functional-design's gate a boolean so it iterates.
 */
function stateFile(
  current: string,
  opts: { skipped?: string[] } = {},
): string {
  const skipped = new Set(opts.skipped ?? []);
  const currentIdx = ALL_SLUGS.indexOf(current);
  const row = (slug: string, i: number): string => {
    const marker = slug === current
      ? "-"
      : skipped.has(slug)
        ? "S"
        : i < currentIdx
          ? "x"
          : " ";
    const action = skipped.has(slug) ? "SKIP" : "EXECUTE";
    return `- [${marker}] ${slug} ${SEP} ${action}`;
  };
  const rows = ALL_SLUGS.map(row).join("\n");
  return `# AI-DLC State Tracking

## Project Information
- **Project**: gate next-stage test
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

### STAGES
${rows}

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${current}
- **Status**: Running
`;
}

/** Seed a fresh project pivoted to `current`. Returns the proj dir. */
function seedProject(
  current: string,
  opts: { skipped?: string[] } = {},
): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  writeFileSync(seededStateFile(proj), stateFile(current, opts));
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

describe("t202 gate next-stage name (issue: approval option always said Code Generation)", () => {
  // 1: the headline case. functional-design in-flight, feature scope (every
  // stage EXECUTE) -> the gated directive names its true next EXECUTE stage,
  // NFR Requirements, NOT a guessed "Code Generation".
  test("1: functional-design carries next_stage = NFR Requirements (the real next EXECUTE stage)", () => {
    const proj = seedProject("functional-design");
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("functional-design");
    expect(d.next_stage).toBe("NFR Requirements");
    // The old bug: this was always "Code Generation".
    expect(d.next_stage).not.toBe("Code Generation");
  }, 30000);

  // 2: a SKIP-stamped next stage is walked over. With nfr-requirements SKIP for
  // this workflow, functional-design's next EXECUTE stage becomes NFR Design.
  test("2: a SKIP-stamped next stage is skipped over in next_stage", () => {
    const proj = seedProject("functional-design", { skipped: ["nfr-requirements"] });
    const d = runNext(proj);
    expect(d.stage).toBe("functional-design");
    expect(d.next_stage).toBe("NFR Design");
  }, 30000);

  // 3: the final in-scope stage carries next_stage = null. feedback-optimization
  // is the last stage in the graph, so no EXECUTE stage follows it regardless of
  // scope -> the conductor renders "Complete workflow".
  test("3: the final in-scope stage carries next_stage null", () => {
    const proj = seedProject("feedback-optimization");
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("feedback-optimization");
    expect(d.next_stage).toBeNull();
  }, 30000);

  // 4: the advance path also carries next_stage. When the current stage is
  // COMPLETE, `next` walks to the next EXECUTE stage and emits IT; that emitted
  // directive names the stage after it. functional-design [x] (its next
  // nfr-requirements is current) -> emit nfr-requirements, next_stage NFR Design.
  test("4: the advance-path directive names the stage after the one it emits", () => {
    const proj = seedProject("nfr-requirements");
    const d = runNext(proj);
    expect(d.stage).toBe("nfr-requirements");
    expect(d.next_stage).toBe("NFR Design");
  }, 30000);
});
