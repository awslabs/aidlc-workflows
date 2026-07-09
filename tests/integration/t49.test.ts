// covers: subcommand:aidlc-state:approve
//
// CLI-contract port of tests/integration/t49-state-machine-lifecycle.sh (TAP plan
// 14), mechanism = cli. Equal-or-stronger migration: the .sh walks one stage
// through the full state-machine lifecycle —
//   [ ] -> [-] (init) -> [?] (gate-start) -> [R] (reject) -> [?] (revise)
//   -> [x] (approve) -> advance — by SHELLING OUT to `bun aidlc-utility.ts
// init` once and `bun aidlc-state.ts <sub> ...` six times, then grepping the
// aidlc-state.md checkboxes and the audit.md event stream. Every one of those
// invocations is preserved here by SPAWNING the real CLI via
// node:child_process spawnSync (BUN + the tool .ts path), asserting on the
// SAME observables: the [?] / [R] / [x] checkbox markers the tool writes into
// aidlc-state.md, the Current Stage / Revision Count fields it reports back via
// `get`, the audit-event counts + field values + ORDER it appends to audit.md,
// and exit codes. The contract under test is the PROCESS boundary plus those
// file side-effects, so it stays a spawn — an in-process twin would lose the
// approve -> auto-advance delegation chain (handleApprove calls handleAdvance,
// which re-enters the module's projectDir global + console.log JSON ack) the
// .sh's step-5 assertion depends on.
//
// COVERS KEY: this file credits the `aidlc-state approve` subcommand
// (subcommand:aidlc-state:approve) — the keystone of the lifecycle the .sh
// walks (it is the [?] -> [x] transition AND the auto-advance trigger that
// moves Current Stage forward). The other five subcommands the .sh fires
// (gate-start / reject / revise / advance + the utility `init`) are exercised
// here too, in sequence, as the necessary scaffolding for the approve gate;
// their own dedicated covers ids live on their own ports.
//
// SHARED-WALK FIXTURE (mirrors the .sh's single create_test_project + one
// linear walk, NOT a fresh project per assertion): the .sh builds ONE bugfix
// workflow and walks it end-to-end, because the audit-ordering + revision-loop
// assertions only make sense against a single contiguous event stream. We
// replicate that exactly: beforeAll() does the init + 6 transitions ONCE into a
// single temp project (createTestProject — toPortablePath-converts on Windows so
// audit.md / aidlc-state.md, written by the tool via toPosix paths, round-trip
// when read back); every test() then asserts a different observable against that
// one walk. The dir is cleaned in afterAll. The .sh does NOT seed audit-sample.md
// — `init` creates a fresh audit.md — so post-walk counts are unambiguous.
//
// PARITY NOTES (every .sh `ok` line maps to an expect()-bearing test() below;
// several are STRONGER than the original grep / assert_gt):
//   - .sh Test 1  assert_eq Current Stage == requirements-analysis  -> Test 1.
//   - .sh Test 2  assert_grep aidlc-state.md '\[?\] requirements-analysis'
//       (gate-start [-] -> [?])                                     -> Test 2
//       (checkbox marker scan, slug-scoped; allows the trailing " — EXECUTE"
//       suffix the tool writes, same as the .sh's substring grep).
//   - .sh Test 3  assert_grep '\[R\] requirements-analysis' (reject [?] -> [R])
//                                                                   -> Test 3.
//   - .sh Test 4  assert_eq Revision Count == 1                     -> Test 4
//       (STRONGER: exact `get` field value, same as the .sh).
//   - .sh Test 5  assert_grep '\[?\] requirements-analysis' (revise [R] -> [?])
//                                                                   -> Test 5.
//   - .sh Test 6  assert_grep '\[x\] requirements-analysis' (approve [?] -> [x])
//                                                                   -> Test 6
//       PLUS STRONGER: approve's stdout JSON ack carries
//       already_completed/started — the auto-advance fingerprint (the .sh never
//       inspected the ack; this pins the approve contract directly).
//   - .sh Test 7  assert_not_eq Current Stage != requirements-analysis (advance
//       moves forward)                                              -> Test 7
//       PLUS STRONGER: assert the EXACT downstream slug (code-generation) the
//       bugfix scope routes to after approve auto-advanced, not just "different".
//   - .sh Test 8  assert_gt STAGE_AWAITING_APPROVAL count > 1       -> Test 8
//       (gate-start + revise both emit it; STRONGER: exact count === 2).
//   - .sh Test 9  assert_eq GATE_REJECTED count == 1                -> Test 9.
//   - .sh Test 10 assert_eq STAGE_REVISING count == 1               -> Test 10.
//   - .sh Test 11 assert_eq GATE_APPROVED count == 1                -> Test 11
//       PLUS STRONGER: GATE_APPROVED's Stage + User Input fields, proving the
//       approve gate recorded the human decision the .sh only counted.
//   - .sh Test 12 STAGE_COMPLETED blocks with Stage==requirements-analysis == 1
//       (no duplicate from advance — approve emits it once, advance replays)
//                                                                   -> Test 12
//       (block-scoped count: STAGE_COMPLETED block whose Stage field equals
//       requirements-analysis; the init flow emits 3 OTHER STAGE_COMPLETED rows
//       for the initialization stages, so a bare file-wide count would be 4 —
//       this scopes to the slug exactly like the .sh's grep -A 4 | grep -c).
//   - .sh Test 13 ordering: first STAGE_AWAITING_APPROVAL < first GATE_REJECTED
//       < first STAGE_REVISING                                      -> Test 13
//       (line indices of the FIRST occurrence of each event, same comparison).
//   - .sh Test 14 ordering: first GATE_APPROVED > first STAGE_REVISING (the
//       revision loop resolved before approval)                    -> Test 14.
//
// 14 .sh asserts -> 14 expect()-bearing test() cases here, 1:1.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const STATE = join(TOOLS, "aidlc-state.ts");
const UTIL = join(TOOLS, "aidlc-utility.ts");
const LOG = join(TOOLS, "aidlc-log.ts");

// P4: init births a per-intent record (aidlc/spaces/<space>/intents/<slug>-<id8>/);
// state lands at <record>/aidlc-state.md and audit in per-clone shards under
// <record>/audit/<host>-<pid>.md, NOT the flat aidlc-docs/. The active-intent
// cursor follows the born record, so every subsequent gate-start/reject/revise/
// approve/advance default-resolves to it. Fall back to flat for a not-yet-born
// project. The checkbox markers + audit event stream are unchanged — only the
// LOCATION moved.
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
const statePath = (p: string): string =>
  join(recordDirOf(p), "aidlc-state.md");
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

interface CliResult {
  status: number;
  stdout: string;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/** Spawn `bun <tool> <args...> --project-dir <p>`. Mirrors `bun "$TOOL" ... --project-dir "$PROJ"`. */
function run(tool: string, args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [tool, ...args, "--project-dir", p], {
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    },
  });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    stdout,
    out: `${stdout}${res.stderr ?? ""}`,
  };
}

/** `get <field>` -> trimmed stdout (mirrors `bun "$STATE" get "<field>"`). */
function get(p: string, field: string): string {
  return run(STATE, ["get", field], p).stdout.trim();
}

/**
 * Read a `- **<field>**: <value>` line out of state-file CONTENT. Mirrors the
 * tool's getField against a snapshot string, so a transient mid-walk field
 * value (e.g. Revision Count at the reject step) can be asserted at the moment
 * the .sh read it via `bun "$STATE" get "<field>"`.
 */
function getFieldFromContent(content: string, field: string): string {
  for (const line of content.split("\n")) {
    const m = line.match(/^- \*\*([^*]+)\*\*:\s*(.*)$/);
    if (m && m[1] === field) return m[2].trim();
  }
  return "";
}

/** Count audit blocks with a bare `**Event**: <ev>` line in audit CONTENT (shard-concat). Mirrors `grep -c "^\*\*Event\*\*: <ev>"`. */
function auditEventCount(content: string, ev: string): number {
  return content.split("\n").filter((l) => l === `**Event**: ${ev}`).length;
}

/**
 * Count STAGE_COMPLETED audit blocks in CONTENT whose `**Stage**:` field equals
 * <slug>. Mirrors the .sh's `grep -A 4 "^\*\*Event\*\*: STAGE_COMPLETED" | grep
 * -c "\*\*Stage\*\*: <slug>"` — block-scoped so the 3 initialization-stage
 * STAGE_COMPLETED rows (workspace-scaffold/detection/state-init) don't inflate
 * the count for the requirements-analysis row.
 */
function stageCompletedCountFor(content: string, slug: string): number {
  const lines = content.split("\n");
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "**Event**: STAGE_COMPLETED") {
      // Scan the block (the tool writes Stage on the very next line).
      for (let j = i + 1; j < lines.length && j <= i + 4; j++) {
        if (lines[j] === "---") break;
        if (lines[j] === `**Stage**: ${slug}`) {
          count++;
          break;
        }
      }
    }
  }
  return count;
}

/** 1-based line number of the FIRST `**Event**: <ev>` line in CONTENT, or -1. Mirrors `grep -n ... | head -1 | cut -d: -f1`. */
function firstEventLine(content: string, ev: string): number {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === `**Event**: ${ev}`) return i + 1;
  }
  return -1;
}

/**
 * Value of <key> from the FIRST audit block in CONTENT whose `**Event**:`
 * matches <ev>. Resets at `## ` headings and `---` separators; splits
 * `**label**: value` on the literal `**: ` separator. Returns "" when absent.
 */
function auditField(content: string, ev: string, key: string): string {
  let matched = false;
  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      matched = false;
      continue;
    }
    if (line === "---") {
      matched = false;
      continue;
    }
    if (line.startsWith("**Event**: ")) {
      matched = line === `**Event**: ${ev}`;
      continue;
    }
    if (matched && line.startsWith("**")) {
      const stripped = line.replace(/^\*\*/, "");
      const pos = stripped.indexOf("**: ");
      if (pos > 0) {
        const label = stripped.slice(0, pos);
        const value = stripped.slice(pos + 4);
        if (label === key) return value;
      }
    }
  }
  return "";
}

/**
 * True if state-file CONTENT has a checkbox line for <slug> in the given marker
 * state. Mirrors the .sh's `assert_grep '\[<m>\] <slug>'` — the tool writes
 * `- [<m>] <slug> — EXECUTE`, so we match a line that contains the marker
 * immediately followed by the slug (substring, allowing the trailing suffix).
 * Takes content (not a path) so transient mid-walk markers can be asserted
 * against the snapshot captured at the matching step.
 */
function hasCheckbox(content: string, marker: string, slug: string): boolean {
  const needle = `[${marker}] ${slug}`;
  return content.split("\n").some((l) => l.includes(needle));
}

// --- One shared lifecycle walk (mirrors the .sh's single create_test_project +
//     linear walk). The .sh asserted the [?] / [R] / [?] / [x] checkbox markers
//     AT THE MOMENT of each transition — those markers are transient (the next
//     command overwrites them), so we SNAPSHOT the state-file content right
//     after each step rather than reading the post-walk file. This is faithful
//     to the .sh's mid-walk grep, against the same observable (the marker line
//     the tool wrote into aidlc-state.md at that step). Also captures the
//     approve + advance JSON acks. ---

let proj: string;
let approveAck: CliResult;
let advanceAck: CliResult;
// State-file content snapshots, captured immediately after each transition.
let stateAfterInit: string;
let stateAfterGateStart: string;
let stateAfterReject: string;
let stateAfterRevise: string;
let stateAfterApprove: string;

beforeAll(() => {
  proj = createTestProject();

  // init --scope bugfix (the .sh's `bun "$UTIL" init --scope bugfix`).
  const init = run(UTIL, ["intent-birth", "--scope", "bugfix"], proj);
  expect(init.status).toBe(0);
  // P4: resolve the state path only AFTER init — birth creates the per-intent
  // record + active-intent cursor that statePath/recordDirOf follow. Computing
  // it pre-init would resolve the flat aidlc-docs/ fallback (which never exists
  // for a born project).
  const sp = statePath(proj);
  stateAfterInit = readFileSync(sp, "utf-8");

  // Step 1: gate-start [-] -> [?]
  expect(run(STATE, ["gate-start", "requirements-analysis"], proj).status).toBe(0);
  stateAfterGateStart = readFileSync(sp, "utf-8");
  // Step 2: reject [?] -> [R], increments Revision Count
  expect(
    run(
      STATE,
      ["reject", "requirements-analysis", "--feedback", "needs acceptance criteria"],
      proj,
    ).status,
  ).toBe(0);
  stateAfterReject = readFileSync(sp, "utf-8");
  // Step 3: revise [R] -> [?]
  expect(run(STATE, ["revise", "requirements-analysis"], proj).status).toBe(0);
  stateAfterRevise = readFileSync(sp, "utf-8");
  // requirements-analysis declares a reviewer; record a fresh terminal review
  // (after the revise) so the §12a gate precondition passes. This test targets
  // the reject/revise transition trail, not the reviewer gate.
  run(LOG, ["review", "--stage", "requirements-analysis", "--reviewer", "aidlc-product-lead-agent", "--iteration", "1", "--verdict", "READY"], proj);
  // Step 4: approve [?] -> [x] (auto-advances to the next in-scope stage).
  approveAck = run(
    STATE,
    ["approve", "requirements-analysis", "--user-input", "Accepted with changes"],
    proj,
  );
  expect(approveAck.status).toBe(0);
  stateAfterApprove = readFileSync(sp, "utf-8");
  // Step 5: advance — approve already auto-advanced, so this replays cleanly.
  advanceAck = run(STATE, ["advance", "requirements-analysis"], proj);
  expect(advanceAck.status).toBe(0);
});

afterAll(() => {
  cleanupTestProject(proj);
});

describe("t49 aidlc-state lifecycle — approve gate (migrated from t49-state-machine-lifecycle.sh, plan 14)", () => {
  // .sh Test 1 — init lands on requirements-analysis (Current Stage read from
  // the post-init snapshot, before any transition moved the pointer — same as
  // the .sh's `bun "$STATE" get "Current Stage"` immediately after init).
  test("1: init lands on requirements-analysis", () => {
    const cur = getFieldFromContent(stateAfterInit, "Current Stage");
    expect(cur).toBe("requirements-analysis");
  });

  // .sh Test 2 — gate-start [-] -> [?] (asserted against the post-gate-start
  // snapshot, mirroring the .sh's mid-walk grep '\[?\] requirements-analysis').
  test("2: gate-start marks [?] requirements-analysis", () => {
    expect(hasCheckbox(stateAfterGateStart, "?", "requirements-analysis")).toBe(
      true,
    );
  });

  // .sh Test 3 — reject [?] -> [R] (post-reject snapshot, mirrors grep '\[R\]
  // requirements-analysis').
  test("3: reject marks [R] requirements-analysis", () => {
    expect(hasCheckbox(stateAfterReject, "R", "requirements-analysis")).toBe(true);
  });

  // .sh Test 4 — Revision Count incremented to 1 (post-reject snapshot, same
  // moment the .sh read it).
  test("4: Revision Count incremented to 1", () => {
    expect(getFieldFromContent(stateAfterReject, "Revision Count")).toBe("1");
  });

  // .sh Test 5 — revise [R] -> [?] re-enter gate (post-revise snapshot, mirrors
  // grep '\[?\] requirements-analysis').
  test("5: revise marks [?] requirements-analysis", () => {
    expect(hasCheckbox(stateAfterRevise, "?", "requirements-analysis")).toBe(true);
  });

  // .sh Test 6 — approve [?] -> [x]
  test("6: approve marks [x] requirements-analysis + ack shows auto-advance", () => {
    expect(hasCheckbox(stateAfterApprove, "x", "requirements-analysis")).toBe(true);
    // STRONGER: approve's JSON ack proves the [?] -> [x] + auto-advance contract
    // (handleApprove delegates to handleAdvance because a next stage exists).
    const ack = JSON.parse(approveAck.stdout);
    expect(ack.completed).toBe("requirements-analysis");
    expect(ack.already_completed).toBe(true); // advance saw the slug already [x]
    expect(ack.started).toBe("code-generation"); // the bugfix next-in-scope stage
  });

  // .sh Test 7 — advance moves Current Stage forward
  test("7: Current Stage advanced past requirements-analysis", () => {
    const current = get(proj, "Current Stage");
    expect(current).not.toBe("requirements-analysis"); // .sh assert_not_eq
    // STRONGER: pin the exact downstream slug the bugfix scope routes to.
    expect(current).toBe("code-generation");
    // advance after approve is a clean replay (no second advance side-effects).
    expect(JSON.parse(advanceAck.stdout).replay).toBe(true);
  });

  // .sh Test 8 — STAGE_AWAITING_APPROVAL emitted for gate-start AND revise (> 1)
  test("8: STAGE_AWAITING_APPROVAL emitted twice (gate-start + revise)", () => {
    const c = auditEventCount(readAudit(proj), "STAGE_AWAITING_APPROVAL");
    expect(c).toBeGreaterThan(1); // .sh assert_gt "$AWAIT_COUNT" 1
    expect(c).toBe(2); // STRONGER: exact count
  });

  // .sh Test 9 — exactly one GATE_REJECTED
  test("9: exactly one GATE_REJECTED", () => {
    expect(auditEventCount(readAudit(proj), "GATE_REJECTED")).toBe(1);
  });

  // .sh Test 10 — exactly one STAGE_REVISING
  test("10: exactly one STAGE_REVISING", () => {
    expect(auditEventCount(readAudit(proj), "STAGE_REVISING")).toBe(1);
  });

  // .sh Test 11 — exactly one GATE_APPROVED for this stage
  test("11: exactly one GATE_APPROVED + records the gate decision", () => {
    const audit = readAudit(proj);
    expect(auditEventCount(audit, "GATE_APPROVED")).toBe(1);
    // STRONGER: the approve subcommand recorded the human decision fields.
    expect(auditField(audit, "GATE_APPROVED", "Stage")).toBe("requirements-analysis");
    expect(auditField(audit, "GATE_APPROVED", "User Input")).toBe("Accepted with changes");
  });

  // .sh Test 12 — exactly one STAGE_COMPLETED for requirements-analysis
  // (approve emits it once; advance replays without re-emitting).
  test("12: exactly one STAGE_COMPLETED for requirements-analysis (no duplicate from advance)", () => {
    expect(stageCompletedCountFor(readAudit(proj), "requirements-analysis")).toBe(1);
  });

  // .sh Test 13 — ordering: AWAITING_APPROVAL -> GATE_REJECTED -> STAGE_REVISING
  test("13: ordering STAGE_AWAITING_APPROVAL -> GATE_REJECTED -> STAGE_REVISING", () => {
    const f = readAudit(proj);
    const await1 = firstEventLine(f, "STAGE_AWAITING_APPROVAL");
    const reject1 = firstEventLine(f, "GATE_REJECTED");
    const revising1 = firstEventLine(f, "STAGE_REVISING");
    expect(await1).toBeGreaterThan(0);
    expect(reject1).toBeGreaterThan(0);
    expect(revising1).toBeGreaterThan(0);
    expect(await1).toBeLessThan(reject1);
    expect(reject1).toBeLessThan(revising1);
  });

  // .sh Test 14 — ordering: GATE_APPROVED follows STAGE_REVISING (loop resolved)
  test("14: ordering GATE_APPROVED follows STAGE_REVISING (revision loop resolved)", () => {
    const f = readAudit(proj);
    const approved1 = firstEventLine(f, "GATE_APPROVED");
    const revising1 = firstEventLine(f, "STAGE_REVISING");
    expect(approved1).toBeGreaterThan(0);
    expect(revising1).toBeGreaterThan(0);
    expect(approved1).toBeGreaterThan(revising1);
  });
});
