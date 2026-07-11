// covers: subcommand:aidlc-state:approve
//
// CLI-contract port of tests/integration/t51-bugfix-event-parity.sh (TAP plan 15),
// mechanism = cli. End-to-end event-parity walk of the bugfix scope on a
// greenfield project, driven entirely by SPAWNING the real binaries via
// node:child_process spawnSync — `aidlc-utility.ts init` to bootstrap, then
// `aidlc-state.ts gate-start` / `aidlc-state.ts approve` per gated stage. The
// covers id pins `subcommand:aidlc-state:approve` because `approve` is the
// load-bearing driver: it owns the end-to-end transition (GATE_APPROVED +
// STAGE_COMPLETED, then delegates to handleAdvance / handleCompleteWorkflow for
// the phase-boundary and workflow-completion events). Every count asserted here
// is produced by the approve auto-advance chain plus the init bootstrap.
//
// MECHANISM: spawn (the .sh shelled out to `bun "$UTIL" init` and `bun "$STATE"
// gate-start|approve`; we reproduce that exact PROCESS boundary). The contract
// under test is the audit.md the tools write across the full walk plus the
// terminal aidlc-state.md, so it stays a spawn — an in-process twin would lose
// the cross-tool init->gate-start->approve sequencing the audit stream encodes.
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + cleanup_test_project):
// the whole walk runs against ONE fresh temp project (createTestProject, which
// toPortablePath-converts on Windows so the audit.md the tools write via
// forward-slash helpers round-trips when read back). The .sh runs a single
// project through the entire walk and asserts on the accumulated audit; we do
// the same in a beforeAll so the expensive multi-process walk runs once. The
// temp dir is cleaned in afterAll. NOTHING is seeded — init bootstraps the
// audit from scratch (the .sh does not seed either), so post-walk counts are
// unambiguous.
//
// PARITY NOTES (every .sh `ok`/`assert_*` line maps to an expect() below; the
// ordering case is STRONGER than the original):
//   - .sh L104 count_event WORKFLOW_STARTED == 1        -> "WORKFLOW_STARTED fires once".
//   - .sh L105 count_event WORKFLOW_COMPLETED == 1       -> "WORKFLOW_COMPLETED fires once".
//   - .sh L106 count_event PHASE_STARTED == 3            -> "PHASE_STARTED fires 3x".
//   - .sh L107 count_event PHASE_COMPLETED == 3          -> "PHASE_COMPLETED fires 3x".
//   - .sh L108 count_event PHASE_VERIFIED == 3           -> "PHASE_VERIFIED fires 3x".
//   - .sh L109 count_event PHASE_SKIPPED == 2            -> "PHASE_SKIPPED fires 2x".
//   - .sh L111 count_event STAGE_STARTED == 6            -> "STAGE_STARTED fires 6x".
//   - .sh L115 count_event STAGE_COMPLETED == 6          -> "STAGE_COMPLETED fires 6x".
//   - .sh L117 count_event STAGE_AWAITING_APPROVAL == 3  -> "STAGE_AWAITING_APPROVAL fires 3x".
//   - .sh L118 count_event GATE_APPROVED == 3            -> "GATE_APPROVED fires 3x".
//   - .sh L123 first event == WORKFLOW_STARTED           -> "WORKFLOW_STARTED is first event".
//   - .sh L127 last event == WORKFLOW_COMPLETED          -> "WORKFLOW_COMPLETED is last event".
//   - .sh L131-138 final-stage GATE_APPROVED line < STAGE_COMPLETED line ->
//       "GATE_APPROVED precedes STAGE_COMPLETED for final stage" (same observable,
//       last-occurrence line ordering) PLUS a STRONGER per-gated-stage check that
//       EVERY GATE_APPROVED precedes its paired STAGE_COMPLETED in the stream.
//   - .sh L142 state Status=Completed                    -> "Status=Completed".
//   - .sh L145 6 stages marked [x]                       -> "6 stages marked [x]".
//
// 15 .sh asserts -> 15 expect()-bearing test() cases (the ordering case adds a
// stronger second expect within the same case; no observable dropped).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const UTIL = join(TOOLS, "aidlc-utility.ts");
const STATE = join(TOOLS, "aidlc-state.ts");

// P4: init births a per-intent record (aidlc/spaces/<space>/intents/<slug>-<id8>/);
// state lands at <record>/aidlc-state.md and audit in per-clone shards under
// <record>/audit/<host>-<pid>.md, NOT the flat aidlc-docs/. The active-intent
// cursor follows the born record, so the whole gate-start/approve walk resolves
// to it. Fall back to flat for a not-yet-born project. The event stream + final
// checkbox state are unchanged — only the LOCATION moved.
function recordDirOf(p: string): string {
  const spaceCursor = join(p, "aidlc", "active-space");
  const space = existsSync(spaceCursor)
    ? readFileSync(spaceCursor, "utf-8").trim() || "default"
    : "default";
  const intentsDir = join(p, "aidlc", "spaces", space, "intents");
  const intentCursor = join(intentsDir, "active-intent");
  if (existsSync(intentCursor)) {
    const rec = readFileSync(intentCursor, "utf-8").trim();
    if (rec && existsSync(join(intentsDir, rec, "aidlc-state.md"))) {
      return join(intentsDir, rec);
    }
  }
  return join(p, "aidlc-docs");
}
const statePath = (p: string): string => join(recordDirOf(p), "aidlc-state.md");
// Audit is sharded under <record>/audit/<host>-<pid>.md; concat every shard for
// a content read, falling back to the flat audit.md for a not-yet-born project.
function readAudit(p: string): string {
  const auditDir = join(recordDirOf(p), "audit");
  if (existsSync(auditDir)) {
    return readdirSync(auditDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(join(auditDir, f), "utf-8"))
      .join("\n");
  }
  const flat = join(p, "aidlc-docs", "audit.md");
  return existsSync(flat) ? readFileSync(flat, "utf-8") : "";
}

/** init --scope bugfix (mirrors the .sh bootstrap, L78-79). */
function runInit(proj: string): void {
  const res = spawnSync(BUN, [UTIL, "intent-birth", "--scope", "bugfix", "--project-dir", proj], {
    encoding: "utf-8",
    env: { ...process.env, AIDLC_WORKFLOW_INTENT: "bugfix parity test" },
  });
  if ((res.status ?? -1) !== 0) {
    throw new Error(`init failed (status ${res.status}): ${res.stdout ?? ""}${res.stderr ?? ""}`);
  }
}

/** gate-start <slug> then approve <slug> (mirrors the .sh walk_stage helper, L88-92). */
function walkStage(proj: string, slug: string): void {
  const gs = spawnSync(BUN, [STATE, "gate-start", slug, "--project-dir", proj], { encoding: "utf-8" });
  if ((gs.status ?? -1) !== 0) {
    throw new Error(`gate-start ${slug} failed (status ${gs.status}): ${gs.stdout ?? ""}${gs.stderr ?? ""}`);
  }
  const ap = spawnSync(BUN, [STATE, "approve", slug, "--user-input", "approve", "--project-dir", proj], {
    encoding: "utf-8",
  });
  if ((ap.status ?? -1) !== 0) {
    throw new Error(`approve ${slug} failed (status ${ap.status}): ${ap.stdout ?? ""}${ap.stderr ?? ""}`);
  }
}

/** Count audit blocks with `**Event**: <ev>` in audit CONTENT (shard-concat). Mirrors the .sh count_event grep (L99-101). */
function countEvent(content: string, ev: string): number {
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return content.split("\n").filter((l) => re.test(l)).length;
}

/** Ordered list of event names as they appear in audit CONTENT (header `**Event**: X` rows). */
function eventStream(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split("\n")) {
    if (line.startsWith("**Event**: ")) out.push(line.slice("**Event**: ".length));
  }
  return out;
}

// One project, walked once — the multi-process bugfix walk is expensive, and
// the .sh asserts on the single accumulated audit, so we share it.
let PROJ: string;

beforeAll(() => {
  PROJ = createTestProject();
  // Bootstrap via init (emits WORKFLOW_STARTED + init phase + 2x PHASE_SKIPPED,
  // and init pre-completes the 3 init stages: workspace-scaffold,
  // workspace-detection, state-init). The first post-init EXECUTE stage for
  // bugfix-on-greenfield is requirements-analysis (reverse-engineering is
  // SKIP-greenfield). Walk the 3 gated EXECUTE stages; approve auto-advances /
  // auto-completes.
  runInit(PROJ);
  walkStage(PROJ, "requirements-analysis");
  walkStage(PROJ, "code-generation");
  walkStage(PROJ, "build-and-test");
}, 60000);

afterAll(() => {
  cleanupTestProject(PROJ);
});

describe("t51 bugfix event parity — CLI contract (migrated from t51-bugfix-event-parity.sh, plan 15)", () => {
  // ============================================================
  // Event counts (.sh L104-118)
  // ============================================================

  test("1: WORKFLOW_STARTED fires once", () => {
    expect(countEvent(readAudit(PROJ), "WORKFLOW_STARTED")).toBe(1);
  });

  test("2: WORKFLOW_COMPLETED fires once", () => {
    expect(countEvent(readAudit(PROJ), "WORKFLOW_COMPLETED")).toBe(1);
  });

  test("3: PHASE_STARTED fires 3x (initialization, inception, construction)", () => {
    expect(countEvent(readAudit(PROJ), "PHASE_STARTED")).toBe(3);
  });

  test("4: PHASE_COMPLETED fires 3x", () => {
    expect(countEvent(readAudit(PROJ), "PHASE_COMPLETED")).toBe(3);
  });

  test("5: PHASE_VERIFIED fires 3x", () => {
    expect(countEvent(readAudit(PROJ), "PHASE_VERIFIED")).toBe(3);
  });

  test("6: PHASE_SKIPPED fires 2x (ideation, operation)", () => {
    expect(countEvent(readAudit(PROJ), "PHASE_SKIPPED")).toBe(2);
  });

  test("7: STAGE_STARTED fires 6x (3 init + 3 gated)", () => {
    expect(countEvent(readAudit(PROJ), "STAGE_STARTED")).toBe(6);
  });

  test("8: STAGE_COMPLETED fires 6x", () => {
    // 3 init + 3 approve. On the final stage, approve delegates to
    // complete-workflow, whose alreadyMarkedCompleted guard suppresses the
    // duplicate STAGE_COMPLETED — so the count stays 6, not 7.
    expect(countEvent(readAudit(PROJ), "STAGE_COMPLETED")).toBe(6);
  });

  test("9: STAGE_AWAITING_APPROVAL fires 3x", () => {
    expect(countEvent(readAudit(PROJ), "STAGE_AWAITING_APPROVAL")).toBe(3);
  });

  test("10: GATE_APPROVED fires 3x", () => {
    expect(countEvent(readAudit(PROJ), "GATE_APPROVED")).toBe(3);
  });

  // ============================================================
  // Ordering (.sh L120-138)
  // ============================================================

  test("11: WORKFLOW_STARTED is first event", () => {
    const stream = eventStream(readAudit(PROJ));
    expect(stream[0]).toBe("WORKFLOW_STARTED");
  });

  test("12: WORKFLOW_COMPLETED is last event", () => {
    const stream = eventStream(readAudit(PROJ));
    expect(stream[stream.length - 1]).toBe("WORKFLOW_COMPLETED");
  });

  test("13: GATE_APPROVED precedes STAGE_COMPLETED for final stage", () => {
    const stream = eventStream(readAudit(PROJ));
    // Same observable as the .sh: the LAST GATE_APPROVED occurs before the LAST
    // STAGE_COMPLETED in the audit stream.
    const lastGate = stream.lastIndexOf("GATE_APPROVED");
    const lastCompleted = stream.lastIndexOf("STAGE_COMPLETED");
    expect(lastGate).toBeGreaterThanOrEqual(0);
    expect(lastCompleted).toBeGreaterThanOrEqual(0);
    expect(lastGate).toBeLessThan(lastCompleted);

    // STRONGER than the .sh (which only checked the final stage): every
    // GATE_APPROVED must be immediately followed by a STAGE_COMPLETED — the
    // approve invariant (GATE_APPROVED then STAGE_COMPLETED, audit-first) holds
    // for ALL 3 gated stages, not just the last.
    for (let i = 0; i < stream.length; i++) {
      if (stream[i] === "GATE_APPROVED") {
        expect(stream[i + 1]).toBe("STAGE_COMPLETED");
      }
    }
  });

  // ============================================================
  // Terminal state (.sh L140-145)
  // ============================================================

  test("14: Status=Completed", () => {
    const content = readFileSync(statePath(PROJ), "utf-8");
    expect(content.split("\n").some((l) => /^- \*\*Status\*\*: Completed/.test(l))).toBe(true);
  });

  test("15: 6 stages marked [x] in final state", () => {
    const content = readFileSync(statePath(PROJ), "utf-8");
    const completed = content.split("\n").filter((l) => /^- \[x\] [a-z-]+/.test(l)).length;
    expect(completed).toBe(6);
  });
});
