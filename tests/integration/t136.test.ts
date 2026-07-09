// covers: audit:GATE_REJECTED, audit:STAGE_REVISING
//
// CLI-contract port of tests/integration/t122-revision-loop.sh (renumbered to t136 for milestone 2; TAP plan 10),
// mechanism = cli. The .sh exercises the gate → reject → revise → gate cycle
// end-to-end on a real bugfix workflow by SHELLING OUT to `bun aidlc-state.ts
// gate-start|reject|revise|approve ...`. This port preserves that PROCESS
// boundary: every transition is the real `aidlc-state.ts` subprocess spawned
// via node:child_process spawnSync (BUN + the tool .ts), and the observables
// are read back off the same aidlc-state.md / audit.md the tool writes. An
// in-process twin would lose the multi-tool cumulative-audit-trail contract
// the .sh is built to verify (Revision Count incrementing across N reject
// calls; the GATE_REJECTED + STAGE_REVISING emit-as-a-pair invariant; the
// STAGE_AWAITING_APPROVAL re-entry count) — the whole point is that the
// transitions compose correctly across independent process invocations.
//
// COVERS HEADER — colon form, audit ids. The .sh's load-bearing audit
// assertions are the GATE_REJECTED ×3 and STAGE_REVISING ×3 pair-emission
// counts (the reject handler's two-event critical section, aidlc-state.ts
// handleReject:792-803). Those two events are the covered observables;
// STAGE_AWAITING_APPROVAL and GATE_APPROVED are also asserted below as
// equal-parity counterparts to the .sh, but the credited ids are the two
// the reject cycle is the sole emitter of in this test.
//
// SHARED-PROJECT DISCIPLINE (mirrors the .sh exactly): the .sh runs ONE
// create_test_project + ONE `init --scope bugfix`, then mutates
// that single project through an ordered sequence of state-tool calls. The
// observables are inherently positional (Revision Count after the 1st/2nd/3rd
// reject; the checkbox glyph after each transition). So this port also uses a
// SINGLE project, built once in beforeAll, driven through the same ordered
// cycle, with each test() asserting the observable at the point the .sh did.
// Test ordering within a describe is sequential in bun:test, matching the
// .sh's straight-line script. createTestProject (fixtures.ts) is the TS twin
// of create_test_project and toPortablePath-converts on Windows so the
// audit.md the tool writes via forward-slash helpers round-trips when read
// back. The init emits NONE of the four asserted events (probe-verified:
// init bugfix audit = WORKFLOW_STARTED/WORKSPACE_*/PHASE_*/STAGE_STARTED/
// STAGE_COMPLETED only), so every post-cycle count is unambiguous — exactly
// the .sh's clean-baseline assumption.
//
// PARITY NOTES (every .sh `ok` line maps to an expect() below; several are
// STRONGER than the original grep):
//   - .sh L42 assert_grep '^- **Revision Count**: 1'  -> test 1: stateField
//       "Revision Count" === "1" (STRONGER: exact field-value parse, not a
//       line-anchored substring grep) + reject JSON ack revision_count===1.
//   - .sh L43 assert_grep '^- [R] requirements-analysis' -> test 2:
//       checkboxGlyph === "R" (exact glyph, scoped to the slug's line).
//   - .sh L47 assert_grep '^- [?] requirements-analysis' -> test 3:
//       checkboxGlyph === "?" after revise (exact glyph).
//   - .sh L49 assert_grep '^- **Revision Count**: 2'  -> test 4: exact "2".
//   - .sh L54 assert_grep '^- **Revision Count**: 3'  -> test 5: exact "3".
//   - .sh L59 assert_grep '^- [x] requirements-analysis' -> test 6:
//       checkboxGlyph === "x" after final approve (exact glyph).
//   - .sh L66 assert_eq 3 count_event GATE_REJECTED   -> test 7: exact count 3.
//   - .sh L67 assert_eq 3 count_event STAGE_REVISING  -> test 8: exact count 3.
//   - .sh L69 assert_eq 4 count_event STAGE_AWAITING_APPROVAL -> test 9:
//       exact count 4 (1 gate-start + 3 revise).
//   - .sh L70 assert_eq 1 count_event GATE_APPROVED   -> test 10: exact count 1.
//
// STRONGER ADDITIONS (beyond the .sh's 10 asserts; each is a real observable
// the .sh's shell-outs already produced but discarded):
//   - S1: every state-tool spawn is asserted rc===0 (the .sh discarded $?
//     under `>/dev/null 2>&1`; a non-zero exit on any cycle step would have
//     silently corrupted the sequence the .sh then asserted on).
//   - S2: reject's GATE_REJECTED + STAGE_REVISING are asserted to emit
//     TOGETHER and carry the Feedback the reject call supplied (the
//     handleReject pair-emission invariant — the literal reason this test
//     covers those two ids; the .sh only counted them in aggregate at the end).
//   - S3: the STAGE_REVISING block carries `**Revision count**: N` matching
//     the Revision Count the same cycle set (cross-checks the audit field
//     against the state field — the .sh checked the two independently).
//
// 10 .sh asserts -> 10 expect()-bearing test() cases here, plus the S1..S3
// inline strengtheners on the cases that drive the spawns.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const STATE_TS = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-state.ts",
);
const UTIL_TS = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-utility.ts",
);
const LOG_TS = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-log.ts",
);

const SLUG = "requirements-analysis";

// P4: intent-birth writes state into the born intent's per-intent record dir
// (aidlc/spaces/<space>/intents/<slug>-<id8>/), not the flat aidlc-docs/. After
// the init in beforeAll the active-intent cursor points at the born record, so
// every later gate-start/reject/revise/approve (which default-resolve the active
// intent) reads/writes THAT record — recordDirOf follows the cursor and resolves
// it for both the init output and the state-machine writes. Falls back to the
// flat layout for a not-yet-born / seeded-flat project.
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

// Audit is written as per-clone shards under <record>/audit/<host>-<pid>.md
// (Stage B). Concatenate every shard for a content read; fall back to the flat
// aidlc-docs/audit.md for a seeded-flat / pre-migration project.
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

/** Spawn `bun aidlc-state.ts <args...> --project-dir <p>`. Mirrors `bun "$STATE" ...`. */
function state(p: string, ...args: string[]): CliResult {
  const res = spawnSync(BUN, [STATE_TS, ...args, "--project-dir", p], {
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

/**
 * Value of a `- **<field>**: <value>` line in aidlc-state.md. Mirrors the
 * .sh's `^- **Revision Count**: N` line grep, but returns the exact value
 * (STRONGER). Returns "" when absent.
 */
function stateField(p: string, field: string): string {
  const re = new RegExp(`^- \\*\\*${field}\\*\\*: (.*)$`);
  for (const line of readFileSync(statePath(p), "utf-8").split("\n")) {
    const m = line.match(re);
    if (m) return m[1].trim();
  }
  return "";
}

/**
 * The checkbox glyph for a stage slug — the char inside `- [X] <slug>`.
 * Mirrors the .sh's `^- [R] requirements-analysis` / `[?]` / `[x]` greps but
 * returns the glyph itself so each test asserts the exact transition state.
 * Returns "" when the slug line is absent.
 */
function checkboxGlyph(p: string, slug: string): string {
  const re = new RegExp(`^- \\[(.)\\] ${slug}(\\b| )`);
  for (const line of readFileSync(statePath(p), "utf-8").split("\n")) {
    const m = line.match(re);
    if (m) return m[1];
  }
  return "";
}

/**
 * Count audit blocks with `**Event**: <ev>`. Mirrors the .sh's count_event
 * (`grep -cE '^\*\*Event\*\*: <ev>$'`).
 */
function auditEventCount(p: string, ev: string): number {
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return readAudit(p)
    .split("\n")
    .filter((l) => re.test(l)).length;
}

/**
 * Return the audit blocks (heading..`---`) whose `**Event**:` matches <ev>,
 * each as the array of its lines. Used by S2/S3 to assert pair-emission and
 * per-block field values for the two covered events.
 */
function auditBlocks(p: string, ev: string): string[][] {
  const blocks: string[][] = [];
  let cur: string[] = [];
  let matched = false;
  for (const line of readAudit(p).split("\n")) {
    if (line === "---") {
      if (matched) blocks.push(cur);
      cur = [];
      matched = false;
      continue;
    }
    cur.push(line);
    if (line === `**Event**: ${ev}`) matched = true;
  }
  if (matched) blocks.push(cur);
  return blocks;
}

let proj: string;

beforeAll(() => {
  // create_test_project + `init --scope bugfix` (t122.sh:30-34).
  proj = createTestProject();
  const init = spawnSync(
    BUN,
    [
      UTIL_TS,
      "intent-birth",
      "--scope",
      "bugfix",
      "--project-dir",
      proj,
    ],
    {
      encoding: "utf-8",
      env: { ...process.env, AIDLC_WORKFLOW_INTENT: "revision loop test" },
    },
  );
  if ((init.status ?? -1) !== 0) {
    throw new Error(
      `init --scope bugfix failed (rc=${init.status}): ${init.stderr}`,
    );
  }
  // Sanity: init leaves requirements-analysis [-] ready to gate (probe-verified).
  if (checkboxGlyph(proj, SLUG) !== "-") {
    throw new Error(
      `expected ${SLUG} to start [-] after init, saw [${checkboxGlyph(proj, SLUG)}]`,
    );
  }
});

afterAll(() => {
  cleanupTestProject(proj); // cleanup_test_project (t122.sh:72)
});

describe("t136 revision-loop — aidlc-state gate/reject/revise/approve cumulative trail (migrated from t122-revision-loop.sh, plan 10)", () => {
  // --- Cycle 1: gate-start -> reject (t122.sh:40-43) ---
  test("1: first reject increments Revision Count to 1", () => {
    expect(state(proj, "gate-start", SLUG).status).toBe(0); // S1
    const r = state(proj, "reject", SLUG, "--feedback", "needs more detail");
    expect(r.status).toBe(0); // S1
    expect(stateField(proj, "Revision Count")).toBe("1");
    // S1: reject's JSON ack pins the same count it wrote to state.
    expect(r.stdout).toContain('"revision_count":1');
  });

  test("2: checkbox becomes [R] after first reject", () => {
    expect(checkboxGlyph(proj, SLUG)).toBe("R");
  });

  // --- Cycle 2: revise -> gate (from [R]) -> reject (t122.sh:46-49) ---
  test("3: checkbox flips back to [?] after revise", () => {
    expect(state(proj, "revise", SLUG).status).toBe(0); // S1
    expect(checkboxGlyph(proj, SLUG)).toBe("?");
  });

  test("4: second reject increments Revision Count to 2", () => {
    const r = state(proj, "reject", SLUG, "--feedback", "still not enough");
    expect(r.status).toBe(0); // S1
    expect(stateField(proj, "Revision Count")).toBe("2");
  });

  // --- Cycle 3: revise -> reject (t122.sh:52-54) ---
  test("5: third reject increments Revision Count to 3", () => {
    expect(state(proj, "revise", SLUG).status).toBe(0); // S1
    const r = state(proj, "reject", SLUG, "--feedback", "one more round");
    expect(r.status).toBe(0); // S1
    expect(stateField(proj, "Revision Count")).toBe("3");
  });

  // --- Final: revise -> approve lands [x] (t122.sh:57-59) ---
  test("6: final approve lands the stage at [x]", () => {
    expect(state(proj, "revise", SLUG).status).toBe(0); // S1
    // requirements-analysis declares a reviewer; record a fresh terminal review
    // (after the revise) so the §12a gate precondition passes.
    spawnSync(BUN, [LOG_TS, "review", "--stage", SLUG, "--reviewer", "aidlc-product-lead-agent", "--iteration", "1", "--verdict", "READY", "--project-dir", proj], { encoding: "utf-8" });
    expect(state(proj, "approve", SLUG, "--user-input", "accept as-is").status).toBe(0); // S1
    expect(checkboxGlyph(proj, SLUG)).toBe("x");
  });

  // --- Audit assertions (t122.sh:66-70) — asserted after the full cycle ---
  test("7: GATE_REJECTED fires 3x (covered)", () => {
    expect(auditEventCount(proj, "GATE_REJECTED")).toBe(3);
  });

  test("8: STAGE_REVISING fires 3x (covered)", () => {
    expect(auditEventCount(proj, "STAGE_REVISING")).toBe(3);
  });

  test("9: STAGE_AWAITING_APPROVAL fires 4x (1 gate-start + 3 revise)", () => {
    expect(auditEventCount(proj, "STAGE_AWAITING_APPROVAL")).toBe(4);
  });

  test("10: GATE_APPROVED fires once (final approval)", () => {
    expect(auditEventCount(proj, "GATE_APPROVED")).toBe(1);
  });

  // --- S2/S3: pair-emission + field correctness for the two covered events ---
  test("S2: GATE_REJECTED + STAGE_REVISING emit as a pair, each carrying Feedback", () => {
    const rejected = auditBlocks(proj, "GATE_REJECTED");
    const revising = auditBlocks(proj, "STAGE_REVISING");
    // Pair invariant: same count, and both carry the feedback the reject
    // call supplied (handleReject:792-803).
    expect(rejected).toHaveLength(3);
    expect(revising).toHaveLength(3);
    const feedbacks = ["needs more detail", "still not enough", "one more round"];
    for (let i = 0; i < 3; i++) {
      const rejLines = rejected[i];
      const revLines = revising[i];
      expect(rejLines.some((l) => l === `**Stage**: ${SLUG}`)).toBe(true);
      expect(rejLines.some((l) => l === `**Feedback**: ${feedbacks[i]}`)).toBe(true);
      expect(revLines.some((l) => l === `**Stage**: ${SLUG}`)).toBe(true);
      expect(revLines.some((l) => l === `**Feedback**: ${feedbacks[i]}`)).toBe(true);
    }
  });

  test("S3: each STAGE_REVISING block records the matching Revision count (1,2,3)", () => {
    const revising = auditBlocks(proj, "STAGE_REVISING");
    expect(revising).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(
        revising[i].some((l) => l === `**Revision count**: ${i + 1}`),
      ).toBe(true);
    }
  });
});
