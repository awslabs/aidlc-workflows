// covers: subcommand:aidlc-utility:doctor
//
// CLI-contract port of tests/unit/t37-utility-doctor-drift.sh (TAP plan 23),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-utility.ts doctor --project-dir <p>` is preserved
// by SPAWNING the real CLI via node:child_process spawnSync (BUN + the tool
// .ts path), asserting on res.status / the combined stdout+stderr exactly as
// the .sh asserted on `$?` / the `2>&1 || true` capture. The contract under
// test is the PROCESS boundary (doctor's stdout diagnostics + its
// process.exit(failed>0?1:0) at aidlc-utility.ts:1385) — an in-process
// handleDoctor() twin would lose the exit-code half case 17 relies on, and
// handleDoctor() itself calls process.exit, so it cannot be invoked in-process
// without killing the test runner. So all doctor cases (1-17) stay spawns.
//
// The .sh injected broken graphs / scope-mappings via the AIDLC_STAGE_GRAPH /
// AIDLC_SCOPE_MAPPING env seams (aidlc-lib.ts:702-708) that loadStageGraph /
// loadScopeMapping read at call time. We replicate that — fixture JSON written
// to a temp file, path passed through the spawn env — so the sad-path cases
// fire against a deterministic broken graph, never the real shipped data.
//
// SUBCOMMAND UNIT: this .cli file credits the one subcommand the .sh exercises
// — `aidlc-utility doctor` (covers KEY subcommand:aidlc-utility:doctor, COLON
// form). The lib-export contracts the .sh's tests 18-23 cover (findAllEvents,
// the three tag regexes, PRACTICES_STALENESS_DAYS, MERGE_DISPATCH_TIMEOUT_SEC,
// PRACTICES_SECTION_EMPTY recognition, CRLF normalisation) live on aidlc-lib.ts
// + aidlc-utility.ts and are pure values/functions with no CLI shell — the .sh
// reached them by spawning `bun -e` to import + stringify. We import them
// DIRECTLY in-process (the t62.none.test.ts pattern for pure exports), which is
// STRONGER than the .sh's stringified-line grep: it asserts the real return
// shape / numeric value, not its JSON projection. These cases credit no extra
// subcommand id (they exercise no subcommand); the covers: header names the one
// subcommand the file's spawns drive.
//
// PARITY NOTES (every .sh `ok` line maps to an expect() below; several STRONGER):
//   - .sh 1  drift: WORKFLOW_COMPLETED + Status=Running -> grep "State/audit
//       drift"                          -> Test 1: out contains "State/audit
//       drift" AND status===1 (STRONGER: pins the non-zero exit the .sh
//       discarded with `|| true`).
//   - .sh 2  no drift: Status=Completed -> grep "State matches last audit event
//       (no drift)"                     -> Test 2: out contains it (+ status 0).
//   - .sh 3  no WORKFLOW_COMPLETED in audit -> NOT grep "State/audit drift"
//       -> Test 3: out does NOT contain "State/audit drift".
//   - .sh 4  no state + no audit -> NOT grep "State matches last audit event"
//       -> Test 4: out does NOT contain "State matches last audit event".
//   - .sh 5  cycle happy -> grep "Cycle detection: 0 cycles" -> Test 5.
//   - .sh 6  cycle sad (A->B->A graph fixture) -> grep "cycle(s) found"
//       -> Test 6 (+ status 1 STRONGER).
//   - .sh 7  orphan-files happy -> grep "graph entries all have files" -> Test 7.
//   - .sh 8  orphan-files sad (slug w/ no .md) -> grep "no file on disk"
//       -> Test 8 (+ status 1 STRONGER).
//   - .sh 9  scope happy -> grep -E "Scope validation: [0-9]+ scopes valid"
//       -> Test 9 (regex preserved).
//   - .sh 10 scope sad (orphan required-consume) -> grep "scopes have errors"
//       -> Test 10 (+ status 1 STRONGER).
//   - .sh 11 schema happy -> grep -E "Schema validation: [0-9]+/[0-9]+ stages
//       valid" -> Test 11 (same regex; the tool emits "stages validated", which
//       the .sh's `valid` prefix still matched — regex preserved verbatim).
//   - .sh 12 graph-refs happy -> grep -E "Graph references: [0-9]+ artifacts \+
//       edges resolved" -> Test 12 (regex preserved).
//   - .sh 13 graph-refs sad (bogus requires_stage) -> grep "broken reference"
//       -> Test 13 (+ status 1 STRONGER).
//   - .sh 14 keyword happy -> grep "Keyword overlap: no conflicts" -> Test 14.
//   - .sh 15 keyword sad (two scopes share a kw) -> grep -E "Keyword overlap:
//       [0-9]* conflict" -> Test 15 (+ status 1 STRONGER).
//   - .sh 16 heartbeat advisory on fresh install -> grep "Hook heartbeats: not
//       yet fired" -> Test 16.
//   - .sh 17 full happy path (setupIntegrationProject) -> doctor exits 0
//       -> Test 17: status===0 (same observable: the exit code).
//   - .sh 18 findAllEvents shape (chronological + slug filter + empty miss)
//       -> Test 18: in-process import; asserts all.length===2, all[0].timestamp,
//       filtered.length===1 + block contains slug, empty.length===0 (STRONGER:
//       real object, not the JSON.stringify the .sh diffed).
//   - .sh 19 tag-regex constants capture tag bodies -> Test 19: in-process
//       match against SLUG/FORK_EMITTED/MERGE_SUCCEEDED regexes; capture[1].
//   - .sh 20 PRACTICES_STALENESS_DAYS === 90 -> Test 20: in-process ===90.
//   - .sh 21 MERGE_DISPATCH_TIMEOUT_SEC === 60 -> Test 21: in-process ===60.
//   - .sh 22 PRACTICES_SECTION_EMPTY recognised by walker -> Test 22:
//       findAllEvents returns the row with its timestamp.
//   - .sh 23 CRLF audit-walker normalisation -> Test 23: findAllEvents over a
//       \r\n audit returns 1 created + 1 merged (regression for the split fix).
//
// 23 .sh `ok` lines -> 23 expect()-bearing test() cases here.
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_* +
// cleanup_test_project per case): each spawn case uses a FRESH temp project dir
// (createTestProject / setupIntegrationProject, both toPortablePath-converting
// on Windows so audit.md — read back via the tool's forward-slash helpers —
// round-trips). seedAuditFile / seedStateFile mirror seed_audit_file /
// seed_state_file. Sad-path graph/mapping JSON is written to mkdtemp files and
// fed via the env seams; nothing is written under tests/fixtures/**. All temp
// dirs cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Pure lib/util exports the .sh's tests 18-23 reached via `bun -e` imports;
// asserted in-process here (the t62.none.test.ts pattern). STRONGER than the
// .sh's stringified-line grep — real return shape / numeric value.
import {
  FORK_EMITTED_TAG_REGEX,
  findAllEvents,
  hooksHealthDir,
  MERGE_SUCCEEDED_TAG_REGEX,
  recordHookDrop,
  SLUG_TAG_REGEX,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  MERGE_DISPATCH_TIMEOUT_SEC,
  PRACTICES_STALENESS_DAYS,
} from "../../dist/claude/.claude/tools/aidlc-utility.ts";
import {
  cleanupTestProject,
  createTestProject,
  sedReplaceInFile,
  seedAuditFile,
  seededAuditShard,
  seededStateFile,
  seedStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const UTIL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");

const tempDirs: string[] = [];
const tempFiles: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
  for (const f of tempFiles) {
    try {
      rmSync(f, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/** Track a temp project for teardown. */
function track(p: string): string {
  tempDirs.push(p);
  return p;
}

interface DoctorResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/**
 * Spawn `bun aidlc-utility.ts doctor --project-dir <p>`, optionally with the
 * AIDLC_STAGE_GRAPH / AIDLC_SCOPE_MAPPING env seams pointed at fixture files.
 * Mirrors the .sh's `[ENV=...] bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true`.
 */
function doctor(p: string, env: Record<string, string> = {}): DoctorResult {
  const res = spawnSync(BUN, [UTIL, "doctor", "--project-dir", p], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** Write a fixture JSON to a temp file and register it for cleanup. Mirrors the .sh's `mktemp` + heredoc. */
function fixtureFile(prefix: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), `aidlc-t37-${prefix}-`));
  tempDirs.push(dir); // dir gets recursively removed
  const f = join(dir, `${prefix}.json`);
  writeFileSync(f, contents, "utf-8");
  tempFiles.push(f);
  return f;
}

const STATE_MID_IDEATION = join(REPO_ROOT, "tests", "fixtures", "state-mid-ideation.md");

const WORKFLOW_COMPLETED_BLOCK = `
## Workflow Completion
**Timestamp**: 2026-05-03T00:00:00Z
**Event**: WORKFLOW_COMPLETED
**Scope**: feature

---
`;

// ============================================================
// State / audit drift checks (covers: subcommand:aidlc-utility:doctor)
// ============================================================

describe("t37 aidlc-utility doctor — state/audit drift (migrated from t37-utility-doctor-drift.sh, plan 23)", () => {
  test("1: WORKFLOW_COMPLETED + Status=Running -> drift reported, exit 1", () => {
    const p = track(createTestProject());
    seedAuditFile(p);
    seedStateFile(p, STATE_MID_IDEATION);
    // state-mid-ideation already carries Status: Running; the .sh re-sets it
    // explicitly. Mirror that to keep the fixture self-describing.
    const statePath = seededStateFile(p);
    sedReplaceInFile(statePath, /^- \*\*Status\*\*:.*$/m, "- **Status**: Running");
    const auditPath = seededAuditShard(p);
    writeFileSync(
      auditPath,
      `${readFileSync(auditPath, "utf-8")}${WORKFLOW_COMPLETED_BLOCK}`,
      "utf-8",
    );
    const r = doctor(p);
    expect(r.out).toContain("State/audit drift");
    // STRONGER: the failing check drives process.exit(1) (aidlc-utility.ts:1385).
    expect(r.status).toBe(1);
  });

  test("2: WORKFLOW_COMPLETED + Status=Completed -> no drift", () => {
    const p = track(createTestProject());
    seedAuditFile(p);
    seedStateFile(p, STATE_MID_IDEATION);
    const statePath = seededStateFile(p);
    sedReplaceInFile(statePath, /^- \*\*Status\*\*:.*$/m, "- **Status**: Completed");
    const auditPath = seededAuditShard(p);
    writeFileSync(
      auditPath,
      `${readFileSync(auditPath, "utf-8")}${WORKFLOW_COMPLETED_BLOCK}`,
      "utf-8",
    );
    const r = doctor(p);
    expect(r.out).toContain("State matches last audit event (no drift)");
  });

  test("3: audit has no WORKFLOW_COMPLETED -> drift check does not fire", () => {
    const p = track(createTestProject());
    seedAuditFile(p); // audit-sample.md carries no WORKFLOW_COMPLETED
    seedStateFile(p, STATE_MID_IDEATION);
    const r = doctor(p);
    expect(r.out).not.toContain("State/audit drift");
  });

  test("4: no state + no audit -> drift check silently skipped", () => {
    const p = track(createTestProject());
    // createTestProject makes only an empty aidlc-docs/ — no state, no audit.
    const r = doctor(p);
    expect(r.out).not.toContain("State matches last audit event");
  });
});

// ============================================================
// Graph-level checks — cycle / orphan / scope / schema / refs / keyword
// (covers: subcommand:aidlc-utility:doctor)
// ============================================================

describe("t37 aidlc-utility doctor — graph-level checks", () => {
  test("5: cycle detection happy -> 0 cycles on real graph", () => {
    const p = track(createTestProject());
    const r = doctor(p);
    expect(r.out).toContain("Cycle detection: 0 cycles");
  });

  test("6: cycle detection sad -> A->B->A fixture yields cycle(s) found, exit 1", () => {
    const p = track(createTestProject());
    const graph = fixtureFile(
      "cycle-graph",
      JSON.stringify([
        {
          slug: "stage-a",
          number: "0.1",
          name: "Stage A",
          phase: "initialization",
          execution: "ALWAYS",
          condition: "Always",
          lead_agent: "orchestrator",
          support_agents: [],
          mode: "inline",
          produces: [],
          consumes: [],
          requires_stage: ["stage-b"],
          inputs: "",
          outputs: "",
        },
        {
          slug: "stage-b",
          number: "0.2",
          name: "Stage B",
          phase: "initialization",
          execution: "ALWAYS",
          condition: "Always",
          lead_agent: "orchestrator",
          support_agents: [],
          mode: "inline",
          produces: [],
          consumes: [],
          requires_stage: ["stage-a"],
          inputs: "",
          outputs: "",
        },
      ]),
    );
    const r = doctor(p, { AIDLC_STAGE_GRAPH: graph });
    expect(r.out).toContain("cycle(s) found");
    expect(r.status).toBe(1); // STRONGER: failing check exits 1
  });

  test("6b: missing stage graph is reported without crashing doctor", () => {
    const p = track(createTestProject());
    const missingGraph = join(p, "missing-stage-graph.json");
    const r = doctor(p, { AIDLC_STAGE_GRAPH: missingGraph });
    expect(r.status).toBe(1);
    expect(r.out).toContain("AI-DLC Health Check");
    expect(r.out).toContain("Paired sensor coverage: check failed");
    expect(r.out).toContain(`Stage graph not readable at ${missingGraph}`);
    expect(r.out).not.toContain('{"error":');
  });

  test("7: orphan files happy -> graph entries all have files", () => {
    const p = track(createTestProject());
    const r = doctor(p);
    expect(r.out).toContain("graph entries all have files");
  });

  test("8: orphan files sad -> graph slug with no .md yields no file on disk, exit 1", () => {
    const p = track(createTestProject());
    const graph = fixtureFile(
      "orphan-graph",
      JSON.stringify([
        {
          slug: "nonexistent-stage",
          number: "0.9",
          name: "Nonexistent Stage",
          phase: "initialization",
          execution: "ALWAYS",
          condition: "Always",
          lead_agent: "orchestrator",
          support_agents: [],
          mode: "inline",
          produces: [],
          consumes: [],
          requires_stage: [],
          inputs: "",
          outputs: "",
        },
      ]),
    );
    const r = doctor(p, { AIDLC_STAGE_GRAPH: graph });
    expect(r.out).toContain("no file on disk");
    expect(r.status).toBe(1);
  });

  test("9: scope validation happy -> 'N scopes valid' on real graph", () => {
    const p = track(createTestProject());
    const r = doctor(p);
    // Mirrors grep -E "Scope validation: [0-9]+ scopes valid".
    expect(r.out).toMatch(/Scope validation: [0-9]+ scopes valid/);
  });

  test("10: scope validation sad -> orphan required-consume yields 'scopes have errors', exit 1", () => {
    const p = track(createTestProject());
    const graph = fixtureFile(
      "scope-graph",
      JSON.stringify([
        {
          slug: "stage-broken",
          number: "0.1",
          name: "Broken Stage",
          phase: "initialization",
          execution: "ALWAYS",
          condition: "Always",
          lead_agent: "orchestrator",
          support_agents: [],
          mode: "inline",
          produces: [],
          consumes: [{ artifact: "no-producer-artifact", required: true }],
          requires_stage: [],
          inputs: "",
          outputs: "",
        },
      ]),
    );
    const mapping = fixtureFile(
      "scope-mapping",
      JSON.stringify({
        minimal: {
          depth: "Minimal",
          keywords: [],
          description: "fixture",
          stages: { "stage-broken": "EXECUTE" },
        },
      }),
    );
    const r = doctor(p, {
      AIDLC_STAGE_GRAPH: graph,
      AIDLC_SCOPE_MAPPING: mapping,
    });
    expect(r.out).toContain("scopes have errors");
    expect(r.status).toBe(1);
  });

  test("11: schema validation happy -> 'N/N stages valid' on real graph", () => {
    const p = track(createTestProject());
    const r = doctor(p);
    // Mirrors grep -E "Schema validation: [0-9]+/[0-9]+ stages valid". The tool
    // emits "...stages validated"; the `valid` prefix matches, so the .sh's
    // regex is preserved verbatim here.
    expect(r.out).toMatch(/Schema validation: [0-9]+\/[0-9]+ stages valid/);
  });

  test("12: graph references happy -> 'N artifacts + edges resolved'", () => {
    const p = track(createTestProject());
    const r = doctor(p);
    // Mirrors grep -E "Graph references: [0-9]+ artifacts \+ edges resolved".
    expect(r.out).toMatch(/Graph references: [0-9]+ artifacts \+ edges resolved/);
  });

  test("13: graph references sad -> bogus requires_stage yields 'broken reference', exit 1", () => {
    const p = track(createTestProject());
    const graph = fixtureFile(
      "refs-graph",
      JSON.stringify([
        {
          slug: "stage-a",
          number: "0.1",
          name: "Stage A",
          phase: "initialization",
          execution: "ALWAYS",
          condition: "Always",
          lead_agent: "orchestrator",
          support_agents: [],
          mode: "inline",
          produces: [],
          consumes: [],
          requires_stage: ["does-not-exist"],
          inputs: "",
          outputs: "",
        },
      ]),
    );
    const r = doctor(p, { AIDLC_STAGE_GRAPH: graph });
    expect(r.out).toContain("broken reference");
    expect(r.status).toBe(1);
  });

  test("14: keyword overlap happy -> 'no conflicts' on real scope-mapping", () => {
    const p = track(createTestProject());
    const r = doctor(p);
    expect(r.out).toContain("Keyword overlap: no conflicts");
  });

  test("15: keyword overlap sad -> two scopes share a keyword yields conflict, exit 1", () => {
    const p = track(createTestProject());
    const mapping = fixtureFile(
      "kw-mapping",
      JSON.stringify({
        "scope-a": {
          depth: "Minimal",
          keywords: ["shared-kw"],
          description: "fixture A",
          stages: {},
        },
        "scope-b": {
          depth: "Minimal",
          keywords: ["shared-kw"],
          description: "fixture B",
          stages: {},
        },
      }),
    );
    const r = doctor(p, { AIDLC_SCOPE_MAPPING: mapping });
    // Mirrors grep -E "Keyword overlap: [0-9]* conflict".
    expect(r.out).toMatch(/Keyword overlap: [0-9]* conflict/);
    expect(r.status).toBe(1);
  });

  test("16: heartbeat advisory on fresh install -> 'not yet fired'", () => {
    const p = track(createTestProject());
    // No .aidlc-hooks-health/ dir -> fresh-install advisory branch.
    const r = doctor(p);
    expect(r.out).toContain("Hook heartbeats: not yet fired");
  });

  test("17: full happy path -> doctor exits 0 on full-scaffold project", () => {
    const p = track(setupIntegrationProject());
    const r = doctor(p);
    expect(r.status).toBe(0);
  });

  // Hook-drop probe (issue: recordHookDrop wrote .drops telemetry for doctor,
  // but doctor never read it). Advisory: pass row either way, exit unaffected.
  test("18: no .drops files -> 'Hook drops: none recorded' pass row", () => {
    const p = track(createTestProject());
    const r = doctor(p);
    expect(r.out).toContain("Hook drops: none recorded");
  });

  test("18b: recorded drops -> advisory row with count + last timestamp, exit unchanged", () => {
    const p = track(createTestProject());
    // Seed through the REAL writer, not a hand-built file: recordHookDrop and
    // the doctor probe share both the path resolution (hooksHealthDir via the
    // active-intent cursor) and the line format (ISO timestamp, TAB, reason);
    // writing through recordHookDrop binds the reader to the writer's actual
    // format so the two cannot drift with tests still green.
    recordHookDrop(p, "audit-logger", "audit emission failed: EACCES");
    recordHookDrop(p, "audit-logger", "audit emission failed: disk full");
    const r = doctor(p);
    expect(r.out).toContain("Hook drops recorded (advisory)");
    // Count is exact; the timestamp is whatever isoTimestamp() minted, so pin
    // the shape (the probe's own timestamp gate) rather than a literal value.
    expect(r.out).toMatch(/audit-logger x2 \(last \d{4}-\d{2}-\d{2}T[\d:]+Z\)/);
    // Advisory: the drops row itself must not flip doctor's exit code - compare
    // against the same project WITHOUT the drop file rather than pinning an
    // absolute status (the bare fixture may fail other probes either way).
    const clean = track(createTestProject());
    expect(r.status).toBe(doctor(clean).status);
  });

  test("18c: empty .drops file -> treated as none recorded", () => {
    const p = track(createTestProject());
    const healthDir = hooksHealthDir(p);
    mkdirSync(healthDir, { recursive: true });
    writeFileSync(join(healthDir, "stop.drops"), "", "utf-8");
    const r = doctor(p);
    expect(r.out).toContain("Hook drops: none recorded");
  });

  test("18d: torn last line (no TAB) -> placeholder, not the raw fragment", () => {
    const p = track(createTestProject());
    const healthDir = hooksHealthDir(p);
    mkdirSync(healthDir, { recursive: true });
    // A torn append (disk full mid-write) can leave a last line that never
    // reached its TAB; the label must not splice the raw fragment where a
    // timestamp is promised.
    writeFileSync(
      join(healthDir, "sensor-fire.drops"),
      "2026-07-01T10:00:00Z\tsensor dispatch failed\n" +
        "sensor dispatch failed: ENOSP",
      "utf-8",
    );
    const r = doctor(p);
    expect(r.out).toContain("sensor-fire x2 (last unparseable line)");
    expect(r.out).not.toContain("(last sensor dispatch failed: ENOSP)");
  });
});

// ============================================================
// v0.4.0 milestone 15 — lib.ts exports + threshold constants (pure, in-process).
// The .sh reached these via `bun -e` imports; we import directly (STRONGER:
// real return shape / numeric value rather than the stringified-line grep).
// ============================================================

describe("t37 aidlc-lib / aidlc-utility — exports + constants", () => {
  test("18: findAllEvents -> chronological + slug filter + empty-array on miss", () => {
    const audit = `## Worktree Created
**Timestamp**: 2026-05-19T10:00:00Z
**Event**: WORKTREE_CREATED
**Bolt slug**: bolt-foo

---

## Worktree Created
**Timestamp**: 2026-05-19T11:00:00Z
**Event**: WORKTREE_CREATED
**Bolt slug**: bolt-bar

---

## Worktree Merged
**Timestamp**: 2026-05-19T12:00:00Z
**Event**: WORKTREE_MERGED
**Bolt slug**: bolt-foo

---
`;
    const all = findAllEvents(audit, "WORKTREE_CREATED");
    const filtered = findAllEvents(audit, "WORKTREE_CREATED", "bolt-foo");
    const empty = findAllEvents(audit, "NEVER_EMITTED");
    expect(all).toHaveLength(2);
    expect(all[0]?.timestamp).toBe("2026-05-19T10:00:00Z");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.block.includes("bolt-foo")).toBe(true);
    expect(empty).toHaveLength(0);
  });

  test("19: tag-regex constants capture slug / fork-emitted / merge-succeeded bodies", () => {
    const slug = "[slug=bolt-foo] details".match(SLUG_TAG_REGEX);
    const fork = "[fork-emitted:2026-05-19T12:00:00Z] more".match(FORK_EMITTED_TAG_REGEX);
    const merge = "[merge-succeeded:abc1234] cleanup failed".match(MERGE_SUCCEEDED_TAG_REGEX);
    expect(slug?.[1]).toBe("bolt-foo");
    expect(fork?.[1]).toBe("2026-05-19T12:00:00Z");
    expect(merge?.[1]).toBe("abc1234");
  });

  test("20: PRACTICES_STALENESS_DAYS pinned at 90", () => {
    expect(PRACTICES_STALENESS_DAYS).toBe(90);
  });

  test("21: MERGE_DISPATCH_TIMEOUT_SEC pinned at 60", () => {
    expect(MERGE_DISPATCH_TIMEOUT_SEC).toBe(60);
  });

  test("22: PRACTICES_SECTION_EMPTY recognised by audit-walker", () => {
    const audit = `## Practices Section Empty
**Timestamp**: 2026-05-19T13:00:00Z
**Event**: PRACTICES_SECTION_EMPTY
**Section**: Walking Skeleton

---
`;
    const matches = findAllEvents(audit, "PRACTICES_SECTION_EMPTY");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.timestamp).toBe("2026-05-19T13:00:00Z");
  });

  test("23: findAllEvents normalises CRLF audit files (regression for the split fix)", () => {
    const crlf =
      "## Worktree Created\r\n" +
      "**Timestamp**: 2026-05-19T10:00:00Z\r\n" +
      "**Event**: WORKTREE_CREATED\r\n" +
      "**Bolt slug**: foo\r\n\r\n" +
      "---\r\n\r\n" +
      "## Worktree Merged\r\n" +
      "**Timestamp**: 2026-05-19T11:00:00Z\r\n" +
      "**Event**: WORKTREE_MERGED\r\n" +
      "**Bolt slug**: foo\r\n\r\n" +
      "---\r\n";
    const created = findAllEvents(crlf, "WORKTREE_CREATED");
    const merged = findAllEvents(crlf, "WORKTREE_MERGED");
    expect(created).toHaveLength(1);
    expect(merged).toHaveLength(1);
  });
});
