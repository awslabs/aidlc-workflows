// covers: subcommand:aidlc-utility:scope-change, subcommand:aidlc-utility:set-status, subcommand:aidlc-state:skip, audit:SCOPE_CHANGED, audit:STAGE_SKIPPED
//
// t214 — discovery commit continuation: the engine-differential twin of
// discovery-decision.md Step 8 (the "Continue Into Delivery" verb sequence),
// mechanism = cli. Every step SPAWNS the real tool binaries (aidlc-utility.ts /
// aidlc-orchestrate.ts / aidlc-state.ts) over a seeded COMPLETED discovery
// workflow and asserts on exit codes, stdout JSON, state-file effects, and the
// audit shard — the PROCESS boundary, no model in the loop (t118's pattern).
//
// THE PINNED CONTRACT. The continuation documented in
// core/aidlc-common/stages/ideation/discovery-decision.md Step 8 re-opens a
// COMPLETED workflow via, in order:
//   A. `aidlc-utility.ts scope-change --scope feature`
//   B. `aidlc-orchestrate.ts next` (names the first delivery stage)
//   C. `aidlc-utility.ts set-status --stage <named stage>`
//   D. `aidlc-state.ts skip <slug> --reason "..."` per pending ideation stage
//   E. `next` again (the forwarding loop is alive under the new scope)
// This works ONLY because scope-change and set-status carry NO Completed-status
// guard, while the sibling recompose handler REFUSES when workflow Status is
// not Running (aidlc-utility.ts handleRecompose: `Cannot recompose: workflow
// Status is "...", not Running`). That asymmetry is load-bearing and was
// previously untested. If anyone harmonizes the guards — adds a
// Completed-status refusal to scope-change or set-status — steps A/C here fail
// loudly, and the discovery continuation path in discovery-decision.md Step 8
// must be redesigned WITH the guard (or the guard must exempt this path).
//
// GOLDEN SOURCE: every assertion below transcribes a hand-run of the sequence
// against this exact fixture (2026-07-08, tools at dist/claude/.claude/tools),
// not the prose's promises. Observed: A exits 0 on Status Completed and leaves
// Status Completed (it re-plans the grid but never touches workflow status);
// B names practices-discovery; C flips Completed -> Running; D flips the row to
// [S] and writes the reason to the AUDIT shard (STAGE_SKIPPED Reason field),
// not the state row; E re-emits the current delivery stage.
//
// FIXTURE: state-discovery-completed.md — a COMPLETED discovery-scope state
// (Scope: discovery, all 8 discovery EXECUTE stages [x], Current Stage
// discovery-decision, Status Completed). Authored from the real engine's own
// output: `aidlc-utility.ts init --scope discovery` wrote the shape (field set,
// 0.1-0.3 + 1.1 + 1.8-1.11 EXECUTE plan, SKIP suffixes for the other 28
// stages), then the run was marked complete the way Step 6 of the stage does
// ([x] boxes, Status Completed). Project Type is Greenfield — that pin is what
// makes step B deterministic (see the walk test).
//
// FIXTURE DISCIPLINE (t118's): each test uses a FRESH temp project
// (createTestProject + seedStateFile), nothing is written under
// tests/fixtures/**, all temp dirs cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  FIXTURES_DIR,
  resetAidlcEnv,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const UTILITY = join(TOOLS, "aidlc-utility.ts");
const ORCHESTRATE = join(TOOLS, "aidlc-orchestrate.ts");
const STATE = join(TOOLS, "aidlc-state.ts");
const STAGE_GRAPH = join(TOOLS, "data", "stage-graph.json");

// Clear leaked AWS_AIDLC_DEFAULT_SCOPE so scope resolves from the state file.
resetAidlcEnv();

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr
  stdout: string;
}

function run(tool: string, args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [tool, ...args, "--project-dir", p], {
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

/** Fresh temp project seeded with the COMPLETED discovery state fixture. */
function completedDiscoveryProj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedStateFile(p, join(FIXTURES_DIR, "state-discovery-completed.md"));
  return p;
}

const readState = (p: string): string => readFileSync(seededStateFile(p), "utf-8");

function readAudit(p: string): string {
  const dir = seededAuditDir(p);
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(dir, f), "utf-8"))
    .join("\n");
}

// Parse the single directive JSON the engine emits on stdout.
// biome-ignore lint/suspicious/noExplicitAny: directives are a typed union; the test reads scalar fields
function directive(r: CliResult): any {
  return JSON.parse(r.stdout.trim());
}

// The four discovery-only ideation stages (1.8-1.11). A delivery directive
// must never name one of these after the scope change.
const DISCOVERY_STAGES = [
  "discovery-current-state",
  "discovery-future-state",
  "discovery-experimentation",
  "discovery-decision",
] as const;

// Step A, verbatim from discovery-decision.md Step 8 item 1 (feature is the
// documented default delivery scope).
const scopeChange = (p: string): CliResult =>
  run(UTILITY, ["scope-change", "--scope", "feature"], p);

describe("t214 discovery commit continuation (verb sequence, engine differential)", () => {
  // ============================================================
  // Step A — scope-change on a COMPLETED workflow. THE PINNED CONTRACT: this
  // exits 0 BECAUSE the scope-change handler has no Completed-status guard
  // (unlike recompose — see the contrast test below). If a guard is ever added,
  // this test fails and discovery-decision.md Step 8 must be redesigned with it.
  // ============================================================
  test("Step A: scope-change --scope feature succeeds on Status Completed and re-plans the grid (no status guard — the pinned contract)", () => {
    const p = completedDiscoveryProj();
    expect(readState(p)).toContain("- **Status**: Completed"); // the precondition is real
    const r = scopeChange(p);
    // Exit 0 on a Completed workflow — the absence of a status guard, observed.
    expect(r.status).toBe(0);
    expect(r.out).toContain("Scope changed: discovery → feature");
    // The completed count is re-derived over the NEW plan: only 0.1-0.3 + 1.1
    // still count as completed EXECUTE stages (the four discovery [x] rows
    // moved to SKIP), and the greenfield feature plan is 31 stages.
    expect(r.out).toContain("Completed: 4/31");

    const state = readState(p);
    // Scope flipped; the grid re-planned.
    expect(state).toContain("- **Scope**: feature");
    // The finished discovery stages KEEP their [x] check AND carry the SKIP
    // suffix under the feature scope — the state file's honest rendering the
    // stage prose warns about ("completed check-boxes beside SKIP annotations").
    for (const slug of DISCOVERY_STAGES) {
      expect(state).toContain(`- [x] ${slug} — SKIP`);
    }
    // The ideation questionnaire stages the feature scope expects are back to
    // pending EXECUTE (these are what Step D's honest skips then annotate).
    expect(state).toContain("- [ ] market-research — EXECUTE");
    expect(state).toContain("- [ ] feasibility — EXECUTE");
    // scope-change re-plans but NEVER touches workflow status: still Completed
    // (set-status, step C, owns that flip).
    expect(state).toContain("- **Status**: Completed");
    // The verb is audited: SCOPE_CHANGED landed in the shard.
    expect(readAudit(p)).toContain("**Event**: SCOPE_CHANGED");
  });

  // ============================================================
  // Steps A→E — the full continuation walk, exactly as discovery-decision.md
  // Step 8 relays it. One project, verbs in documented order.
  // ============================================================
  test("Steps B-E: next names the delivery stage, set-status re-opens the Completed workflow, skip annotates, the loop is alive", () => {
    const p = completedDiscoveryProj();
    expect(scopeChange(p).status).toBe(0); // Step A (pinned above)

    // Step B: next names the first delivery stage under the new scope. PINNED
    // to practices-discovery: the hand-run showed this is deterministic for
    // THIS fixture — Project Type Greenfield means scope-change marked 2.1
    // (reverse-engineering — greenfield) SKIP, so the first EXECUTE stage
    // after discovery-decision (1.11) is 2.2 practices-discovery. A brownfield
    // state would name reverse-engineering instead; the fixture pins the type.
    const b = run(ORCHESTRATE, ["next"], p);
    expect(b.status).toBe(0);
    const dirB = directive(b);
    expect(dirB.kind).toBe("run-stage");
    expect(dirB.stage).toBe("practices-discovery");
    expect(dirB.phase).toBe("inception");
    // Structural guards (survive a re-plan of the delivery path): the named
    // stage is a real slug in the compiled graph and NOT a discovery stage.
    const graphSlugs = new Set(
      (JSON.parse(readFileSync(STAGE_GRAPH, "utf-8")) as Array<{ slug: string }>).map(
        (s) => s.slug,
      ),
    );
    expect(graphSlugs.has(dirB.stage)).toBe(true);
    expect(DISCOVERY_STAGES).not.toContain(dirB.stage);

    // Between B and C the workflow is STILL Completed (next is read-only) —
    // so step C's success is set-status's HALF of the pinned no-guard
    // contract: it runs on a Completed workflow and re-opens it.
    expect(readState(p)).toContain("- **Status**: Completed");

    // Step C: set-status at the stage B named.
    const c = run(UTILITY, ["set-status", "--stage", dirB.stage], p);
    expect(c.status).toBe(0);
    const ack = JSON.parse(c.stdout.trim());
    expect(ack.updated).toBe(true);
    expect(ack.stage).toBe("practices-discovery");
    const afterC = readState(p);
    expect(afterC).toContain("- **Status**: Running");
    expect(afterC).toContain("- **Current Stage**: practices-discovery");
    expect(afterC).toContain("- **Lifecycle Phase**: INCEPTION");

    // Step D: honest skip of a genuinely pending ideation stage under the new
    // scope (market-research is [ ] EXECUTE after A — asserted above). The
    // reason lands in the AUDIT shard (STAGE_SKIPPED's Reason field), NOT in
    // the state row — the row flips to [S]. Observed, not guessed.
    const reason =
      "covered by the discovery run: see the decision pack and handoff contract";
    const d = run(STATE, ["skip", "market-research", "--reason", reason], p);
    expect(d.status).toBe(0);
    const skipAck = JSON.parse(d.stdout.trim());
    expect(skipAck.slug).toBe("market-research");
    expect(skipAck.new_state).toBe("skipped");
    expect(readState(p)).toContain("- [S] market-research — EXECUTE");
    const audit = readAudit(p);
    expect(audit).toContain("**Event**: STAGE_SKIPPED");
    expect(audit).toContain("**Stage**: market-research");
    expect(audit).toContain(`**Reason**: ${reason}`);

    // Step E: next again — the forwarding loop is alive under the new scope.
    // It re-emits the SAME delivery stage (practices-discovery is now the
    // Running current stage with an unopened gate), never a discovery stage.
    const e = run(ORCHESTRATE, ["next"], p);
    expect(e.status).toBe(0);
    const dirE = directive(e);
    expect(dirE.kind).toBe("run-stage");
    expect(dirE.stage).toBe("practices-discovery");
    expect(DISCOVERY_STAGES).not.toContain(dirE.stage);
  }, 30000);

  // ============================================================
  // The CONTRAST control — the guard the continuation verbs lack EXISTS in the
  // same tool: recompose refuses the very same Completed state. This is what
  // makes the differential a designed asymmetry rather than an accident, and
  // it fails if the recompose guard is ever removed (the other way the
  // asymmetry could silently collapse).
  // ============================================================
  test("contrast: recompose REFUSES the same Completed workflow (the guard scope-change/set-status deliberately lack)", () => {
    const p = completedDiscoveryProj();
    const r = run(UTILITY, ["recompose", "--add", "market-research"], p);
    expect(r.status).toBe(1);
    // The refusal arrives as a JSON error object on stderr.
    const err = JSON.parse(r.out.trim()) as { error: string };
    expect(err.error).toContain(
      'Cannot recompose: workflow Status is "Completed", not Running.',
    );
    // And the refused verb wrote nothing: the state is untouched.
    expect(readState(p)).toContain("- **Status**: Completed");
    expect(readState(p)).toContain("- **Scope**: discovery");
  });

  // ============================================================
  // The DELIVERY-WIRING differential — the decision pack's optional-consume
  // contract. requirements-analysis declares `decision-pack` as `required:
  // false` in its consumes frontmatter (core/aidlc-common/stages/inception/
  // requirements-analysis.md), and the orchestrator threads only inputs that
  // exist on disk (splitConsumesByPresence, aidlc-orchestrate.ts: an optional
  // missing input "is not an input — it is dropped from the directive
  // entirely, never flagged as a gap"; consumes_absent is added only when a
  // REQUIRED input is missing). So the SAME verb route must emit a
  // requirements-analysis directive WITH the pack's path when the pack file
  // exists and with NO TRACE of it when it does not. Both directions below
  // transcribe a hand-run against this fixture (2026-07-08, tools at
  // dist/claude/.claude/tools) — observed output, not the prose's promises.
  //
  // Route to the directive (the cheapest honest one, reusing the pinned
  // no-guard contract above): scope-change --scope feature re-plans the grid
  // so requirements-analysis is EXECUTE, set-status --stage
  // requirements-analysis re-opens the Completed workflow AT that stage, and
  // next re-emits the Running current stage as a run-stage directive (the
  // Step E behaviour) — deterministic, no model in the loop.
  // ============================================================

  // The workspace-relative pack path the directive carries (forward slashes —
  // the orchestrator's canonical resolved-path form), rooted at the seeded
  // default record: <record>/ideation/discovery-decision/decision-pack.md.
  // discovery-decision is the pack's PRODUCER in the compiled graph, so the
  // consume resolves under ITS stage dir, not the consuming stage's.
  const PACK_REL = `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}/ideation/discovery-decision/decision-pack.md`;

  /** scope-change → set-status --stage requirements-analysis → next; returns
   *  the run-stage directive plus the raw stdout JSON (for whole-payload
   *  assertions). Asserts the route's own exit codes so a failure points at
   *  the failing verb, not a JSON parse error. */
  // biome-ignore lint/suspicious/noExplicitAny: directives are a typed union; the test reads scalar fields
  function requirementsAnalysisDirective(p: string): { dir: any; raw: string } {
    expect(scopeChange(p).status).toBe(0);
    const c = run(UTILITY, ["set-status", "--stage", "requirements-analysis"], p);
    expect(c.status).toBe(0);
    const n = run(ORCHESTRATE, ["next"], p);
    expect(n.status).toBe(0);
    const dir = directive(n);
    expect(dir.kind).toBe("run-stage");
    expect(dir.stage).toBe("requirements-analysis");
    expect(dir.phase).toBe("inception");
    return { dir, raw: n.stdout };
  }

  test("delivery wiring, pack PRESENT: the requirements-analysis directive's consumes carries the decision pack's path", () => {
    const p = completedDiscoveryProj();
    // The discovery run left its decision pack in the record, exactly where
    // the graph resolves the producer's artifact.
    const packDir = join(seededRecordDir(p), "ideation", "discovery-decision");
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, "decision-pack.md"), "# Decision Pack\n\nProceed.\n");

    const { dir } = requirementsAnalysisDirective(p);
    // The pack is threaded into consumes — AND it is the ONLY entry: every
    // other declared consume of requirements-analysis is optional and absent
    // in this fixture (the brownfield conditionals are dropped for the
    // Greenfield project type; the absent optionals are dropped by the
    // presence split). Observed verbatim in the hand-run. This exact-list pin
    // is the mechanism itself: present-on-disk optional IN, everything else
    // silently OUT.
    expect(dir.consumes).toEqual([PACK_REL]);
    // No required input is missing, so the consumes_absent field is not
    // emitted at all (it appears only for REQUIRED absences).
    expect(dir.consumes_absent).toBeUndefined();
  }, 30000);

  test("delivery wiring, pack ABSENT: the requirements-analysis directive carries no trace of the decision pack", () => {
    const p = completedDiscoveryProj();
    // Same route, NO pack file on disk.
    const { dir, raw } = requirementsAnalysisDirective(p);
    // Every declared consume is optional and absent: the list is EMPTY, and
    // consumes_absent does not exist (absent OPTIONAL inputs are silently
    // dropped, never listed — the run-stage contract in the harness
    // SKILL.md). Observed: {"consumes":[]} with no consumes_absent key.
    expect(dir.consumes).toEqual([]);
    expect(dir.consumes_absent).toBeUndefined();
    // The strongest form of "no trace": the raw directive JSON never mentions
    // the artifact at all — not in consumes, not in consumes_absent, not in
    // any other field.
    expect(raw).not.toContain("decision-pack");
  }, 30000);
});
