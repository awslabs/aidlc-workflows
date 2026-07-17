// covers: subcommand:aidlc-state:get, subcommand:aidlc-state:set, subcommand:aidlc-state:checkbox, subcommand:aidlc-state:count, subcommand:aidlc-state:advance, subcommand:aidlc-state:lookup, subcommand:aidlc-state:finalize, subcommand:aidlc-state:complete-workflow, subcommand:aidlc-state:resume, subcommand:aidlc-state:gate-start, subcommand:aidlc-state:approve, subcommand:aidlc-state:reject, subcommand:aidlc-state:revise, subcommand:aidlc-state:skip, subcommand:aidlc-state:reuse-artifact, subcommand:aidlc-state:park, subcommand:aidlc-state:unpark, audit:WORKFLOW_PARKED, audit:WORKFLOW_UNPARKED
//
// bun:test port of tests/unit/t17-tool-state.sh (TAP plan 83), mechanism = cli.
// Faithful 1:1 migration of the aidlc-state.ts CLI-contract test — EQUAL fidelity,
// not a rewrite. Every .sh assertion that ran `bun aidlc-state.ts <sub> ... --project-dir <p>`
// is ported to a spawnSync of the REAL CLI, preserving the full process boundary:
// exit code (res.status), stdout (res.stdout), and stderr (res.stderr). The .sh
// folded stdout+stderr with `2>&1`; we reproduce that with a combined() helper so
// `error()`-on-stderr assertions still match.
//
// SPAWN vs IN-PROCESS: the contract under test is entirely the argv-dispatch /
// process boundary of aidlc-state.ts (and, for a handful of setup steps, the
// aidlc-utility.ts init driver) — exit code + emitted JSON on stdout + error text
// on stderr + on-disk mutations to aidlc-docs/aidlc-state.md and aidlc-docs/audit.md.
// There are NO pure-function assertions in t17; every one of the 83 is an
// observable side effect of running the tool. So ALL 124 invocations stay spawns
// (124 in-process = 0). Calling the handlers in-process would forfeit the exit-code
// and stderr halves of the contract, exactly the trap the t72 spike called out.
//
// As a .cli-mechanism file this legitimately credits the 15 aidlc-state subcommand
// units it exercises (get, set, checkbox, count, advance, lookup, finalize,
// complete-workflow, resume, gate-start, approve, reject, revise, skip,
// reuse-artifact). fork / merge / practices-event / practices-promote /
// acknowledge-compaction are NOT exercised by t17 and are therefore NOT claimed.
//
// FIXTURE DISCIPLINE: each case builds a fresh temp project via createTestProject()
// + seedStateFile()/seedAuditFile() (the .ts analogues of fixtures.sh's
// create_test_project / seed_state_file / seed_audit_file), so mutations never bleed
// between cases. Cleanup runs in afterEach. NOTHING is written under tests/fixtures/**.
//
// HARDENING ADDITIONS (beyond .sh parity, in the reject/revise describe):
// reject self-heals a skipped gate — on a [-] stage it backfills the missing
// STAGE_AWAITING_APPROVAL (tagged `Recovered: true`) ahead of GATE_REJECTED +
// STAGE_REVISING; the organic [?] path emits no backfill; revise's re-entry
// gate row is never tagged; a terminal-state slug still rejects. Test 51 now
// uses a [ ] pending slug (reject accepts [?] AND [-]).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  seedAuditFile,
  seededAuditShard,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const TOOLS_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "dist", "claude",
  ".claude",
  "tools",
);
const TOOL = join(TOOLS_DIR, "aidlc-state.ts");
const UTILITY = join(TOOLS_DIR, "aidlc-utility.ts");

interface RunResult {
  rc: number;
  stdout: string;
  stderr: string;
  combined: string;
}

// Run the real aidlc-state CLI. Mirrors `bun "$TOOL" <args> --project-dir "$PROJ"`.
// combined = stdout+stderr (the .sh's `2>&1`). The .sh always appended
// `--project-dir "$PROJ"`, so callers pass everything-but-that and we add it.
function runState(proj: string, args: string[]): RunResult {
  const res = spawnSync(BUN, [TOOL, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    cwd: proj,
    env: {
      ...process.env,
      AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    },
  });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { rc: res.status ?? -1, stdout, stderr, combined: `${stdout}${stderr}` };
}

// `bun aidlc-state.ts lookup ...` with NO --project-dir (Tests 14-18 don't pass one).
function runStateBare(args: string[]): RunResult {
  const res = spawnSync(BUN, [TOOL, ...args], { encoding: "utf-8" });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { rc: res.status ?? -1, stdout, stderr, combined: `${stdout}${stderr}` };
}

// Run the utility init driver. Mirrors
// `bun "$AIDLC_SRC/tools/aidlc-utility.ts" init --scope <s> --project-dir "$PROJ"`.
function runInit(proj: string, scope: string): RunResult {
  const res = spawnSync(BUN, [UTILITY, "intent-birth", "--scope", scope, "--project-dir", proj], {
    encoding: "utf-8",
    cwd: proj,
  });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { rc: res.status ?? -1, stdout, stderr, combined: `${stdout}${stderr}` };
}

// P4: intent-birth (which runInit triggers) writes state into the born intent's
// per-intent record dir (aidlc/spaces/<space>/intents/<slug>-<id8>/), not the flat
// aidlc-docs/. Resolve the record dir from the active-space + active-intent
// cursors, falling back to the flat layout for a seeded-flat project (the many
// seedStateFile cases never call runInit, so they stay flat).
function recordDirOf(proj: string): string {
  const spaceCursor = join(proj, "aidlc", "active-space");
  const space = existsSync(spaceCursor)
    ? readFileSync(spaceCursor, "utf-8").trim() || "default"
    : "default";
  const intentsDir = join(proj, "aidlc", "spaces", space, "intents");
  const intentCursor = join(intentsDir, "active-intent");
  if (existsSync(intentCursor)) {
    const rec = readFileSync(intentCursor, "utf-8").trim();
    if (rec && existsSync(join(intentsDir, rec, "aidlc-state.md"))) {
      return join(intentsDir, rec);
    }
  }
  return join(proj, "aidlc-docs");
}
const stateMd = (proj: string) => join(recordDirOf(proj), "aidlc-state.md");
// Audit path for appending: a born record has per-clone shards under
// <record>/audit/<host>-<clone-id>.md. The fixture pins a stable clone-id, so a
// spawned tool resolves the DETERMINISTIC shard seededAuditShard() returns — a
// test that pre-seeds a shard header must target that same path so the tool's
// own append lands in it. Prefer an already-present shard (a born record may
// carry one) but default to the deterministic fixture shard.
function auditMd(proj: string): string {
  const auditDir = join(recordDirOf(proj), "audit");
  if (existsSync(auditDir)) {
    const shard = readdirSync(auditDir).find((f) => f.endsWith(".md"));
    if (shard) return join(auditDir, shard);
  }
  // No shard yet — the deterministic fixture shard. Ensure its dir exists so a
  // pre-seed writeFileSync(auditMd(proj), header) has a parent to write into.
  mkdirSync(auditDir, { recursive: true });
  return seededAuditShard(proj);
}
const readState = (proj: string) => readFileSync(stateMd(proj), "utf-8");
// Concatenate every audit shard under the born record's audit/ dir (Stage B);
// fall back to the flat aidlc-docs/audit.md for a seeded-flat / pre-migration
// project. Matches the tool's own readAllAuditShards resolution.
function readAudit(proj: string): string {
  const auditDir = join(recordDirOf(proj), "audit");
  if (existsSync(auditDir)) {
    return readdirSync(auditDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(join(auditDir, f), "utf-8"))
      .join("\n");
  }
  const flat = join(proj, "aidlc-docs", "audit.md");
  return existsSync(flat) ? readFileSync(flat, "utf-8") : "";
}

// Count anchored lines `**Event**: <EVENT>` (the .sh's `grep -c "^\*\*Event\*\*: X"`).
function countEvent(text: string, event: string): number {
  return text
    .split("\n")
    .filter((l) => l.startsWith(`**Event**: ${event}`)).length;
}
// True if any line begins with `**Event**: <EVENT>` (`grep -q "^\*\*Event\*\*: X"`).
function hasEvent(text: string, event: string): boolean {
  return countEvent(text, event) > 0;
}

// Per-case temp project, torn down after each test.
let proj = "";
afterEach(() => {
  resetAidlcEnv();
  cleanupTestProject(proj);
  proj = "";
});

const INIT_DONE = join(FIXTURES_DIR, "state-initialization-done.md");
const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");

// ===========================================================================
// get / set / checkbox / count — Tests 1-11
// ===========================================================================

describe("t17 get/set/checkbox/count", () => {
  test("1: get returns Current Stage value", () => {
    proj = createTestProject();
    seedStateFile(proj, INIT_DONE);
    expect(runState(proj, ["get", "Current Stage"]).combined.trim()).toBe("intent-capture");
  });

  test("2: get returns Scope", () => {
    proj = createTestProject();
    seedStateFile(proj, INIT_DONE);
    expect(runState(proj, ["get", "Scope"]).combined.trim()).toBe("feature");
  });

  test("3: get returns Completed count", () => {
    proj = createTestProject();
    seedStateFile(proj, INIT_DONE);
    expect(runState(proj, ["get", "Completed"]).combined.trim()).toBe("3");
  });

  test("4: get errors on missing field", () => {
    proj = createTestProject();
    seedStateFile(proj, INIT_DONE);
    // .sh: `... || true` then assert_contains "error"
    expect(runState(proj, ["get", "Nonexistent Field"]).combined).toContain("error");
  });

  test("5: set updates a single field", () => {
    proj = createTestProject();
    seedStateFile(proj, INIT_DONE);
    runState(proj, ["set", "Current Stage=market-research"]);
    const firstLine = readState(proj)
      .split("\n")
      .find((l) => l.includes("Current Stage"));
    expect(firstLine).toContain("market-research");
  });

  test("6: set NOW generates ISO timestamp", () => {
    proj = createTestProject();
    seedStateFile(proj, INIT_DONE);
    runState(proj, ["set", "Last Updated=NOW"]);
    const line = readState(proj)
      .split("\n")
      .find((l) => l.includes("Last Updated"));
    expect(line).toMatch(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z/);
  });

  test("7: set +1 increments Completed from 3 to 4", () => {
    proj = createTestProject();
    seedStateFile(proj, INIT_DONE);
    runState(proj, ["set", "Completed=+1"]);
    expect(runState(proj, ["get", "Completed"]).combined.trim()).toBe("4");
  });

  test("8: checkbox marks in-progress", () => {
    proj = createTestProject();
    seedStateFile(proj, INIT_DONE);
    runState(proj, ["checkbox", "intent-capture=in-progress"]);
    expect(readState(proj)).toContain("[-] intent-capture");
  });

  test("9: checkbox marks completed", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["checkbox", "feasibility=completed"]);
    expect(readState(proj)).toContain("[x] feasibility");
  });

  test("10: checkbox marks skipped", () => {
    proj = createTestProject();
    seedStateFile(proj, INIT_DONE);
    runState(proj, ["checkbox", "intent-capture=skipped"]);
    expect(readState(proj)).toContain("[S] intent-capture");
  });

  test("11: count returns 5 completed stages", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    expect(runState(proj, ["count", "completed"]).combined.trim()).toBe("5");
  });
});

// ===========================================================================
// advance + counter sync — Tests 12-13, 19-20
// ===========================================================================

describe("t17 advance + counter sync", () => {
  test("12: advance returns completed slug and marks [x]", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    const r = runState(proj, ["advance", "feasibility", "scope-definition"]);
    expect(r.combined).toContain('"completed":"feasibility"');
    expect(readState(proj)).toContain("[x] feasibility");
  });

  test("13: advance updates Current Stage", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["advance", "feasibility", "scope-definition"]);
    expect(runState(proj, ["get", "Current Stage"]).combined.trim()).toBe("scope-definition");
  });

  test("19: checkbox syncs Completed counter (5->6)", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    // feasibility is [-], mark completed -> Completed 5 -> 6
    runState(proj, ["checkbox", "feasibility=completed"]);
    expect(runState(proj, ["get", "Completed"]).combined.trim()).toBe("6");
  });

  test("20: advance uses countCheckboxes (count=6 not 5+1)", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["advance", "feasibility", "scope-definition"]);
    expect(runState(proj, ["get", "Completed"]).combined.trim()).toBe("6");
  });
});

// ===========================================================================
// lookup — Tests 14-18 (no --project-dir)
// ===========================================================================

describe("t17 lookup", () => {
  test("14: lookup validate-stage code-generation is valid", () => {
    expect(runStateBare(["lookup", "validate-stage", "code-generation"]).combined).toContain(
      '"valid":true',
    );
  });

  test("15: lookup validate-stage 3.5 resolves to code-generation", () => {
    expect(runStateBare(["lookup", "validate-stage", "3.5"]).combined).toContain(
      '"slug":"code-generation"',
    );
  });

  test("16: lookup validate-stage rejects invalid slug", () => {
    expect(runStateBare(["lookup", "validate-stage", "nonexistent"]).combined).toContain(
      '"valid":false',
    );
  });

  test("17: lookup next-stage intent-capture feature = market-research", () => {
    expect(runStateBare(["lookup", "next-stage", "intent-capture", "feature"]).combined.trim()).toBe(
      "market-research",
    );
  });

  test("18: lookup stages-in-scope bugfix has SKIP stages", () => {
    expect(runStateBare(["lookup", "stages-in-scope", "bugfix"]).combined).toContain(
      '"action":"SKIP"',
    );
  });
});

// ===========================================================================
// finalize — Tests 21-25
// ===========================================================================

describe("t17 finalize", () => {
  test("21: finalize marks completed [x]", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["finalize", "feasibility"]);
    expect(readState(proj)).toContain("[x] feasibility");
  });

  test("22: finalize syncs Completed counter", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["finalize", "feasibility"]);
    expect(runState(proj, ["get", "Completed"]).combined.trim()).toBe("6");
  });

  test("23: finalize advances Current Stage to next", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["finalize", "feasibility"]);
    expect(runState(proj, ["get", "Current Stage"]).combined.trim()).toBe("scope-definition");
  });

  test("24: finalize does NOT mark next stage [-]", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["finalize", "feasibility"]);
    expect(readState(proj)).toContain("[ ] scope-definition");
  });

  test("25: finalize returns next_stage in JSON", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    expect(runState(proj, ["finalize", "feasibility"]).combined).toContain(
      '"next_stage":"scope-definition"',
    );
  });
});

// ===========================================================================
// advance atomic emission + complete-workflow — Tests 26-27
// ===========================================================================

describe("t17 advance emission + complete-workflow", () => {
  test("26: advance auto-logs STAGE_COMPLETED + STAGE_STARTED atomically", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    // Ensure audit.md exists but is empty (just header).
    writeFileSync(auditMd(proj), "# AI-DLC Audit Log\n", "utf-8");
    runState(proj, ["advance", "feasibility", "scope-definition"]);
    const audit = readAudit(proj);
    expect(hasEvent(audit, "STAGE_COMPLETED")).toBe(true);
    expect(hasEvent(audit, "STAGE_STARTED")).toBe(true);
  });

  test("27: complete-workflow sets Status=Completed", () => {
    // .sh reuses the SAME $PROJ from Test 26 (no fresh create), then re-seeds the
    // state file before complete-workflow. Mirror that: seed mid-ideation fresh.
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    expect(runState(proj, ["complete-workflow", "scope-definition"]).combined).toContain(
      '"status":"Completed"',
    );
  });

  test("75: single-stage synthetic STAGE_COMPLETED never satisfies advance's dedup check", () => {
    // hasStageAuditEvent (the already-audited half of advance's dedup) must
    // skip rows tagged `**Workflow**: single-stage:<slug>` — a `--single`
    // stage-runner pair for the SAME slug must not suppress the main
    // workflow's own STAGE_COMPLETED emission. Seed: feasibility [x] in state
    // but audited ONLY via a synthetic pair (field shapes copied from
    // handleSingleReport: STAGE_STARTED has Stage+Agent+Workflow;
    // STAGE_COMPLETED has Stage+Details+Workflow).
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["checkbox", "feasibility=completed"]);
    writeFileSync(
      auditMd(proj),
      `# AI-DLC Audit Log

## Workflow Start
**Timestamp**: 2026-05-27T10:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: feature

---

## Stage Start
**Timestamp**: 2026-05-27T10:20:00Z
**Event**: STAGE_STARTED
**Stage**: feasibility
**Agent**: aidlc-architect-agent
**Workflow**: single-stage:feasibility

---

## Stage Completion
**Timestamp**: 2026-05-27T10:25:00Z
**Event**: STAGE_COMPLETED
**Stage**: feasibility
**Details**: Single-stage run of feasibility completed
**Workflow**: single-stage:feasibility

---
`,
      "utf-8",
    );
    const r = runState(proj, ["advance", "feasibility", "scope-definition"]);
    expect(r.rc).toBe(0);
    const audit = readAudit(proj);
    // Main workflow emits its OWN STAGE_COMPLETED (synthetic + main = 2)…
    expect(countEvent(audit, "STAGE_COMPLETED")).toBe(2);
    // …and the new row is a main-workflow row: a feasibility STAGE_COMPLETED
    // block WITHOUT a Workflow field.
    const mainCompleted = audit
      .split("\n---\n")
      .filter(
        (b) => b.includes("**Event**: STAGE_COMPLETED") && !b.includes("**Workflow**:"),
      );
    expect(mainCompleted).toHaveLength(1);
    expect(mainCompleted[0]).toContain("**Stage**: feasibility");
  });
});

// ===========================================================================
// advance validation / preconditions — Tests 28-35
// ===========================================================================

describe("t17 advance validation", () => {
  test("28: advance wrong slug exits 1 with clear error", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    const r = runState(proj, ["advance", "code-generation"]);
    expect(r.rc).toBe(1);
    expect(r.combined).toContain("Cannot advance");
  });

  test("29: advance with missing Scope exits 1 and says so", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    const current = runState(proj, ["get", "Current Stage"]).combined.trim();
    // Nuke the Scope field — `sed -i '/^- \*\*Scope\*\*:/d'`
    const stripped = readState(proj)
      .split("\n")
      .filter((l) => !l.startsWith("- **Scope**:"))
      .join("\n");
    writeFileSync(stateMd(proj), stripped, "utf-8");
    const r = runState(proj, ["advance", current]);
    expect(r.rc).toBe(1);
    expect(r.combined).toContain("no Scope field");
  });

  test("30: advance with invalid Scope exits 1 and says so", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    const current = runState(proj, ["get", "Current Stage"]).combined.trim();
    runState(proj, ["set", "Scope=bogus"]);
    const r = runState(proj, ["advance", current]);
    expect(r.rc).toBe(1);
    expect(r.combined).toContain("invalid Scope");
  });

  test("31: replay of advance does not double-emit STAGE_STARTED", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    writeFileSync(auditMd(proj), "# Audit\n", "utf-8");
    runState(proj, ["advance", "feasibility"]);
    runState(proj, ["advance", "feasibility"]);
    expect(countEvent(readAudit(proj), "STAGE_STARTED")).toBe(1);
  });

  test("32: 2-arg advance rejects SKIP-stamped next slug", () => {
    proj = createTestProject();
    // Init a bugfix workflow — user-stories stamped SKIP (bugfix excludes it).
    runInit(proj, "bugfix");
    const r = runState(proj, ["advance", "requirements-analysis", "user-stories"]);
    expect(r.rc).toBe(1);
    expect(r.combined).toContain("SKIP");
  });

  test("33: init emits PHASE_COMPLETED + PHASE_VERIFIED + PHASE_STARTED(inception)", () => {
    proj = createTestProject();
    runInit(proj, "bugfix");
    const audit = readAudit(proj);
    expect(hasEvent(audit, "PHASE_COMPLETED")).toBe(true);
    expect(hasEvent(audit, "PHASE_VERIFIED")).toBe(true);
    // .sh: grep -q "^\*\*Phase\*\*: inception"
    expect(audit.split("\n").some((l) => l.startsWith("**Phase**: inception"))).toBe(true);
  });

  test("34: advance past last in-scope stage exits 1, mentions complete-workflow", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["set", "Scope=bugfix"]);
    // bugfix's last in-scope stage is build-and-test.
    const r = runState(proj, ["advance", "build-and-test"]);
    expect(r.rc).toBe(1);
    expect(r.combined).toContain("complete-workflow");
  });

  test("35: Greenfield bugfix lands on requirements-analysis (RE was SKIP)", () => {
    proj = createTestProject();
    runInit(proj, "bugfix");
    expect(runState(proj, ["get", "Current Stage"]).combined.trim()).toBe(
      "requirements-analysis",
    );
  });
});

// ===========================================================================
// resume — Tests 36-39
// ===========================================================================

describe("t17 resume", () => {
  test("36: resume returns structured JSON snapshot", () => {
    proj = createTestProject();
    runInit(proj, "bugfix");
    const out = runState(proj, ["resume"]).combined;
    expect(out).toContain('"resumed":true');
    expect(out).toContain('"current_stage":"requirements-analysis"');
    expect(out).toContain('"gate_state":"in-progress"');
    expect(out).toContain('"compaction_pending":false');
  });

  test("37: resume detects pending compaction", () => {
    proj = createTestProject();
    runInit(proj, "bugfix");
    appendFileSync(
      auditMd(proj),
      "\n## Session Compacted\n" +
        "**Timestamp**: 2026-05-02T12:00:00Z\n" +
        "**Event**: SESSION_COMPACTED\n" +
        "**Current Stage**: requirements-analysis\n\n---\n",
      "utf-8",
    );
    expect(runState(proj, ["resume"]).combined).toContain('"compaction_pending":true');
  });

  test("38: resume compaction_pending=false after stage activity", () => {
    proj = createTestProject();
    runInit(proj, "bugfix");
    appendFileSync(
      auditMd(proj),
      "\n## Session Compacted\n" +
        "**Timestamp**: 2026-05-02T12:00:00Z\n" +
        "**Event**: SESSION_COMPACTED\n\n---\n\n" +
        "## Stage Start\n" +
        "**Timestamp**: 2026-05-02T12:01:00Z\n" +
        "**Event**: STAGE_STARTED\n" +
        "**Stage**: requirements-analysis\n\n---\n",
      "utf-8",
    );
    expect(runState(proj, ["resume"]).combined).toContain('"compaction_pending":false');
  });

  test("39: resume reports awaiting-approval gate_state", () => {
    proj = createTestProject();
    runInit(proj, "bugfix");
    runState(proj, ["gate-start", "requirements-analysis"]);
    expect(runState(proj, ["resume"]).combined).toContain('"gate_state":"awaiting-approval"');
  });
});

// ===========================================================================
// gate-start — Tests 40-42, 66
// ===========================================================================

describe("t17 gate-start", () => {
  test("40: gate-start marks [?]", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["gate-start", "feasibility"]);
    expect(readState(proj)).toContain("[?] feasibility");
  });

  test("41: gate-start emits STAGE_AWAITING_APPROVAL", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    runState(proj, ["gate-start", "feasibility"]);
    expect(hasEvent(readAudit(proj), "STAGE_AWAITING_APPROVAL")).toBe(true);
  });

  test("42: gate-start rejects slug not [-]", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    // intent-capture is [x] in this fixture, not [-]
    expect(runState(proj, ["gate-start", "intent-capture"]).rc).toBe(1);
  });

  test("66: gate-start --artifacts recorded", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    runState(proj, [
      "gate-start",
      "feasibility",
      "--artifacts",
      "feasibility-report.md,risks.md",
    ]);
    expect(readAudit(proj)).toContain("**Artifacts**: feasibility-report.md,risks.md");
  });
});

// ===========================================================================
// approve — Tests 43-47, 64-65, 67-71
// ===========================================================================

describe("t17 approve", () => {
  test("43: approve marks [x]", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["approve", "feasibility"]);
    expect(readState(proj)).toContain("[x] feasibility");
  });

  test("44: approve emits GATE_APPROVED + STAGE_COMPLETED atomically", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["approve", "feasibility"]);
    const audit = readAudit(proj);
    expect(hasEvent(audit, "GATE_APPROVED")).toBe(true);
    expect(hasEvent(audit, "STAGE_COMPLETED")).toBe(true);
  });

  test("45: approve --user-input recorded", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["approve", "feasibility", "--user-input", "Looks good, proceed"]);
    expect(readAudit(proj)).toContain("**User Input**: Looks good, proceed");
  });

  test("47: approve rejects slug not in [?]", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    // feasibility is [-] in fixture, not [?]
    expect(runState(proj, ["approve", "feasibility"]).rc).toBe(1);
  });

  test("64: approve --user-input with missing value errors cleanly", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["gate-start", "feasibility"]);
    // --user-input without a value followed by another flag token (--reason):
    // must error, not silently consume the following flag as the input value.
    expect(runState(proj, ["approve", "feasibility", "--user-input", "--reason"]).rc).toBe(1);
  });

  test("65: approve is audit-first (state unchanged when audit write fails)", () => {
    // Sabotage audit.md by replacing the file with a DIRECTORY — appendFileSync
    // throws EISDIR for ALL uids (kernel type error, not a permission check), so
    // approve must error before writeStateFile runs and state stays [?].
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    runState(proj, ["gate-start", "feasibility"]);
    const audit = auditMd(proj);
    rmSync(audit, { force: true });
    mkdirSync(audit);
    const r = runState(proj, ["approve", "feasibility"]);
    // Restore audit.md to a normal file before assertions / cleanup.
    rmSync(audit, { recursive: true, force: true });
    writeFileSync(audit, "", "utf-8");
    expect(r.rc).not.toBe(0);
    expect(readState(proj)).toContain("[?] feasibility");
  });

  test("67: approve updates Completed counter via countCheckboxes", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["approve", "feasibility"]);
    expect(runState(proj, ["get", "Completed"]).combined.trim()).toBe("6");
  });

  test("68: approve sets Last Completed Stage", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["approve", "feasibility"]);
    expect(runState(proj, ["get", "Last Completed Stage"]).combined.trim()).toBe("feasibility");
  });

  test("69: resume reports advanced current_stage post-approve", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["approve", "feasibility"]);
    expect(runState(proj, ["resume"]).combined).toContain(
      '"current_stage":"scope-definition"',
    );
  });

  test("70: advance after approve does not double-emit STAGE_COMPLETED", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    writeFileSync(auditMd(proj), "# Audit\n", "utf-8");
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["approve", "feasibility"]);
    runState(proj, ["advance", "feasibility"]);
    expect(countEvent(readAudit(proj), "STAGE_COMPLETED")).toBe(1);
  });

  test("71: approve rejects unknown slug", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    expect(runState(proj, ["approve", "nonexistent-slug"]).rc).toBe(1);
  });

  test("73: advance after approve moves Current Stage forward", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["approve", "feasibility"]);
    runState(proj, ["advance", "feasibility"]);
    expect(runState(proj, ["get", "Current Stage"]).combined.trim()).toBe("scope-definition");
  });
});

// ===========================================================================
// reject / revise — Tests 48-54, 59-60
// ===========================================================================

describe("t17 reject/revise", () => {
  test("48: reject marks [R]", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["reject", "feasibility", "--feedback", "needs more detail"]);
    expect(readState(proj)).toContain("[R] feasibility");
  });

  test("49: reject emits GATE_REJECTED + STAGE_REVISING", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["reject", "feasibility", "--feedback", "x"]);
    const audit = readAudit(proj);
    expect(hasEvent(audit, "GATE_REJECTED")).toBe(true);
    expect(hasEvent(audit, "STAGE_REVISING")).toBe(true);
  });

  test("50: reject increments Revision Count 0->1", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["reject", "feasibility", "--feedback", "x"]);
    expect(runState(proj, ["get", "Revision Count"]).combined.trim()).toBe("1");
  });

  test("51: reject rejects slug not in [?] or [-]", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    // scope-definition is [ ] pending — reject accepts [?] (organic gate) and
    // [-] (self-heal backfill), never an unstarted stage.
    expect(runState(proj, ["reject", "scope-definition", "--feedback", "x"]).rc).toBe(1);
  });

  test("52: revise returns to [?]", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["reject", "feasibility", "--feedback", "x"]);
    runState(proj, ["revise", "feasibility"]);
    expect(readState(proj)).toContain("[?] feasibility");
  });

  test("53: revise emits fresh STAGE_AWAITING_APPROVAL", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["reject", "feasibility", "--feedback", "x"]);
    const before = countEvent(readAudit(proj), "STAGE_AWAITING_APPROVAL");
    runState(proj, ["revise", "feasibility"]);
    const after = countEvent(readAudit(proj), "STAGE_AWAITING_APPROVAL");
    expect(after).toBeGreaterThan(before);
  });

  test("54: revise rejects slug not in [R]", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    expect(runState(proj, ["revise", "feasibility"]).rc).toBe(1);
  });

  test("59: revision loop ends at [x]", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["reject", "feasibility", "--feedback", "round 1"]);
    runState(proj, ["revise", "feasibility"]);
    runState(proj, ["approve", "feasibility"]);
    expect(readState(proj)).toContain("[x] feasibility");
  });

  test("60: Revision Count reaches 3 after 3 rejections", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["reject", "feasibility", "--feedback", "r1"]);
    runState(proj, ["revise", "feasibility"]);
    runState(proj, ["reject", "feasibility", "--feedback", "r2"]);
    runState(proj, ["revise", "feasibility"]);
    runState(proj, ["reject", "feasibility", "--feedback", "r3"]);
    expect(runState(proj, ["get", "Revision Count"]).combined.trim()).toBe("3");
  });

  // gate-start is OPTIONAL before the human prompt (stage-protocol Part 0
  // step 1), so a rejection can arrive while the stage is still [-]. reject
  // self-heals: it backfills the missing STAGE_AWAITING_APPROVAL (tagged
  // Recovered=true) ahead of GATE_REJECTED + STAGE_REVISING — mirroring the
  // approve-side backfill report performs.
  test("reject on [-] (gate-start skipped) self-heals: [R], count 1, backfilled gate row first", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    // NO gate-start — feasibility is [-] straight from the fixture.
    const r = runState(proj, ["reject", "feasibility", "--feedback", "narrow it"]);
    expect(r.rc).toBe(0);
    expect(readState(proj)).toContain("[R] feasibility");
    expect(runState(proj, ["get", "Revision Count"]).combined.trim()).toBe("1");

    const audit = readAudit(proj);
    // The backfilled gate row carries the Recovered tag.
    const gateBlock = audit
      .split("\n---\n")
      .find((b) => b.includes("**Event**: STAGE_AWAITING_APPROVAL"));
    expect(gateBlock).toBeDefined();
    expect(gateBlock).toContain("**Recovered**: true");
    // Audit order: STAGE_AWAITING_APPROVAL -> GATE_REJECTED -> STAGE_REVISING.
    const gateIdx = audit.indexOf("**Event**: STAGE_AWAITING_APPROVAL");
    const rejectedIdx = audit.indexOf("**Event**: GATE_REJECTED");
    const revisingIdx = audit.indexOf("**Event**: STAGE_REVISING");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(rejectedIdx).toBeGreaterThan(gateIdx);
    expect(revisingIdx).toBeGreaterThan(rejectedIdx);
  });

  test("reject on [?] (organic gate) does NOT backfill: exactly one untagged gate row", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["reject", "feasibility", "--feedback", "x"]);
    const gateRows = readAudit(proj)
      .split("\n---\n")
      .filter((b) => b.includes("**Event**: STAGE_AWAITING_APPROVAL"));
    expect(gateRows.length).toBe(1); // the organic gate-start; no backfill
    expect(gateRows[0]).not.toContain("**Recovered**");
  });

  test("revise's re-entry STAGE_AWAITING_APPROVAL carries no Recovered tag", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["reject", "feasibility", "--feedback", "x"]);
    runState(proj, ["revise", "feasibility"]);
    const gateRows = readAudit(proj)
      .split("\n---\n")
      .filter((b) => b.includes("**Event**: STAGE_AWAITING_APPROVAL"));
    expect(gateRows.length).toBe(2); // organic gate-start + revise re-entry
    for (const row of gateRows) {
      expect(row).not.toContain("**Recovered**");
    }
  });

  test("reject still rejects a slug in a terminal state ([x])", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    // intent-capture is [x] — neither awaiting-approval nor in-progress.
    expect(runState(proj, ["reject", "intent-capture", "--feedback", "x"]).rc).toBe(1);
  });
});

// ===========================================================================
// skip — Tests 55-58, 72
// ===========================================================================

describe("t17 skip", () => {
  test("55: skip marks [S]", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    // scope-definition is [ ] in fixture
    runState(proj, ["skip", "scope-definition", "--reason", "not needed for this feature"]);
    expect(readState(proj)).toContain("[S] scope-definition");
  });

  test("56: skip emits STAGE_SKIPPED with Reason", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    runState(proj, ["skip", "scope-definition", "--reason", "not needed"]);
    const audit = readAudit(proj);
    expect(hasEvent(audit, "STAGE_SKIPPED")).toBe(true);
    expect(audit).toContain("**Reason**: not needed");
  });

  test("57: skip accepts [-] -> [S]", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    // feasibility is [-]
    runState(proj, ["skip", "feasibility", "--reason", "cut from scope"]);
    expect(readState(proj)).toContain("[S] feasibility");
  });

  test("58: skip rejects slug already [x]", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    // intent-capture is [x]
    expect(runState(proj, ["skip", "intent-capture", "--reason", "x"]).rc).toBe(1);
  });

  test("72: skip accepts [R] -> [S]", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    runState(proj, ["gate-start", "feasibility"]);
    runState(proj, ["reject", "feasibility", "--feedback", "x"]);
    // Now [R] — skip should be allowed
    runState(proj, ["skip", "feasibility", "--reason", "cut from scope"]);
    expect(readState(proj)).toContain("[S] feasibility");
  });
});

// ===========================================================================
// reuse-artifact — Tests 61-63
// ===========================================================================

describe("t17 reuse-artifact", () => {
  test("61: reuse-artifact emits ARTIFACT_REUSED", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    runState(proj, [
      "reuse-artifact",
      "feasibility",
      "--decision",
      "keep",
      "--artifacts",
      "feasibility-report.md",
    ]);
    expect(hasEvent(readAudit(proj), "ARTIFACT_REUSED")).toBe(true);
  });

  test("62: reuse-artifact records Decision", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    runState(proj, [
      "reuse-artifact",
      "feasibility",
      "--decision",
      "modify",
      "--artifacts",
      "a.md,b.md",
    ]);
    expect(readAudit(proj)).toContain("**Decision**: modify");
  });

  test("63: reuse-artifact rejects invalid decision", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    expect(
      runState(proj, ["reuse-artifact", "feasibility", "--decision", "bogus", "--artifacts", "x"])
        .rc,
    ).toBe(1);
  });
});

// ===========================================================================
// cross-phase-boundary idempotency — Test 74
// ===========================================================================

describe("t17 cross-phase advance idempotency", () => {
  test("74: advance replay does not double-emit PHASE_* events", () => {
    proj = createTestProject();
    runInit(proj, "bugfix");
    // After init, Current Stage is requirements-analysis. Walk it, then replay
    // advance and assert no double PHASE_COMPLETED / PHASE_VERIFIED / PHASE_STARTED.
    runState(proj, ["gate-start", "requirements-analysis"]);
    runState(proj, ["approve", "requirements-analysis"]);
    runState(proj, ["advance", "requirements-analysis"]);
    const audit1 = readAudit(proj);
    const completedBefore = countEvent(audit1, "PHASE_COMPLETED");
    const verifiedBefore = countEvent(audit1, "PHASE_VERIFIED");
    const startedBefore = countEvent(audit1, "PHASE_STARTED");
    // Replay the SAME advance — should be a no-op.
    runState(proj, ["advance", "requirements-analysis"]);
    const audit2 = readAudit(proj);
    expect(countEvent(audit2, "PHASE_COMPLETED")).toBe(completedBefore);
    expect(countEvent(audit2, "PHASE_VERIFIED")).toBe(verifiedBefore);
    expect(countEvent(audit2, "PHASE_STARTED")).toBe(startedBefore);
  });
});

// ===========================================================================
// park / unpark (#365, #367) + the autonomy guard.
// ===========================================================================
describe("t17 park/unpark", () => {
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION); // Current Stage: feasibility
    seedAuditFile(proj);
  });
  afterEach(() => cleanupTestProject(proj));

  test("park writes Parked + Parked At Stage and emits WORKFLOW_PARKED", () => {
    const r = runState(proj, ["park"]);
    expect(r.rc).toBe(0);
    const s = readState(proj);
    expect(s).toContain("- **Parked**:");
    expect(s).toContain("- **Parked At Stage**: feasibility");
    expect(countEvent(readAudit(proj), "WORKFLOW_PARKED")).toBe(1);
    // park does NOT advance the pointer or flip any checkbox.
    expect(runState(proj, ["get", "Current Stage"]).combined.trim()).toBe("feasibility");
  });

  test("unpark clears the markers and emits WORKFLOW_UNPARKED", () => {
    runState(proj, ["park"]);
    const r = runState(proj, ["unpark"]);
    expect(r.rc).toBe(0);
    const s = readState(proj);
    expect(s).not.toContain("- **Parked**:");
    expect(s).not.toContain("- **Parked At Stage**:");
    expect(countEvent(readAudit(proj), "WORKFLOW_UNPARKED")).toBe(1);
  });

  test("unpark is idempotent (no-op + was_parked:false when not parked)", () => {
    const r = runState(proj, ["unpark"]);
    expect(r.rc).toBe(0);
    expect(r.combined).toContain('"was_parked":false');
    expect(countEvent(readAudit(proj), "WORKFLOW_UNPARKED")).toBe(0);
  });

  test("park REFUSES under Construction Autonomy Mode=autonomous", () => {
    // `set` only replaces an existing bullet (no insert), and the fixture has no
    // autonomy line, so inject the field directly under ## Runtime State.
    const path = stateMd(proj);
    const injected = readFileSync(path, "utf-8").replace(
      "## Runtime State",
      "## Runtime State\n- **Construction Autonomy Mode**: autonomous",
    );
    writeFileSync(path, injected, "utf-8");
    const r = runState(proj, ["park"]);
    expect(r.rc).not.toBe(0);
    expect(r.combined).toContain("autonomous");
    // State untouched: no Parked marker written.
    expect(readState(proj)).not.toContain("- **Parked**:");
  });
});

// ===========================================================================
// approve artifact verification (#366) - the rubber-stamp guard refuses an
// artifact-less approve. (Full coverage of per-unit + workspace_requires +
// bypasses lives in t185; this pins the approve wording change here.)
// ===========================================================================
describe("t17 approve artifact guard (#366)", () => {
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION); // Current Stage: feasibility
    seedAuditFile(proj);
  });
  afterEach(() => cleanupTestProject(proj));

  // Drive with the artifact guard ENABLED (the rest of this file rubber-stamps
  // bare fixtures under the suite-wide AIDLC_SKIP_ARTIFACT_GUARD=1, so clear it
  // here to exercise the real refusal - same pattern as t185's guarded()).
  function guarded(args: string[]): RunResult {
    const env = { ...process.env };
    delete env.AIDLC_SKIP_ARTIFACT_GUARD;
    env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS = "1";
    const res = spawnSync(BUN, [TOOL, ...args, "--project-dir", proj], {
      encoding: "utf-8",
      cwd: proj,
      env,
    });
    const stdout = res.stdout ?? "";
    const stderr = res.stderr ?? "";
    return { rc: res.status ?? -1, stdout, stderr, combined: `${stdout}${stderr}` };
  }

  test("approve REFUSES feasibility with no produced artifacts", () => {
    runState(proj, ["checkbox", "feasibility=in-progress"]);
    runState(proj, ["gate-start", "feasibility"]);
    const r = guarded(["approve", "feasibility", "--user-input", "ok"]);
    expect(r.rc).not.toBe(0);
    expect(r.combined).toContain("Refusing to complete");
    // State untouched: not marked [x].
    expect(readState(proj)).not.toContain("[x] feasibility");
  });
});
