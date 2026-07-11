// covers: cli:aidlc-state(gate-start,reject,revise,approve), function:handleGateStart, function:handleReject, function:handleRevise, function:handleApprove
//
// t45 — revision-loop on a gated stage. Migrated from
// tests/integration/t45-revision-loop.sh (TAP plan 10).
//
// Mechanism: cli. The subject is the gate -> reject -> revise -> gate cycle
// driven end-to-end across multiple `aidlc-state.ts` subcommand invocations,
// asserted against (a) the checkbox / Revision Count fields it writes to
// aidlc-state.md and (b) the cumulative audit trail it appends to audit.md.
// Each transition is a CLI subcommand that terminates with process.exit on a
// state-machine guard failure (validateSlugInState, aidlc-state.ts:661) and
// writes its event row via the audit lock — a PROCESS boundary. An in-process
// twin would lose the multi-invocation accumulation seam (each transition
// re-reads state + appends one locked audit block) and the exit-code contract
// the .sh's `set -e` relied on. So we SPAWN the real tool via the BUN runtime
// against the .ts path (spawnSync(BUN, [STATE, ...])), exactly as the .sh did.
//
// Source under test (dist/claude/.claude/tools/aidlc-state.ts):
//   :677 handleGateStart(slug) — [-] -> [?]; emits STAGE_AWAITING_APPROVAL
//   :811 handleReject(slug, --feedback) — [?] -> [R]; increments Revision Count
//          (:825-828); emits GATE_REJECTED + STAGE_REVISING (:837-842)
//   :852 handleRevise(slug) — [R] -> [?]; emits STAGE_AWAITING_APPROVAL
//          ("Re-entering gate after revision", :868-871)
//   :717 handleApprove(slug, --user-input) — [?] -> [x]; emits GATE_APPROVED +
//          STAGE_COMPLETED, then auto-advances (delegates handleAdvance, :775).
//          For bugfix scope, requirements-analysis is NOT the final EXECUTE
//          stage (code-generation + build-and-test follow), so the final
//          approve emits GATE_APPROVED exactly once and lands [x].
//
// State + audit contract (verified against a live cycle on bugfix scope):
//   - bugfix `init` leaves requirements-analysis at `[-] ... — EXECUTE`.
//     The checkbox line carries the trailing ` — EXECUTE` suffix, so checkbox
//     assertions match the `- [X] requirements-analysis` PREFIX (the .sh used
//     anchored regex `^- \[X\] requirements-analysis`, prefix-equivalent).
//   - Revision Count is the `- **Revision Count**: N` field line.
//   - audit.md event rows carry the RAW event type on the `**Event**: <TYPE>`
//     line (the multi-word EVENT_HEADINGS value goes on the `## ` heading,
//     aidlc-audit.ts:117-139,254); count_event greps the **Event** line.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test):
//   .sh assert 1  (Revision Count=1 after first reject)        -> "cycle 1: reject increments Revision Count to 1"
//   .sh assert 2  (checkbox becomes [R] after reject)          -> "cycle 1: reject flips checkbox to [R]"
//   .sh assert 3  (checkbox flips back to [?] after revise)    -> "cycle 2: revise flips checkbox back to [?]"
//   .sh assert 4  (Revision Count=2 after second reject)       -> "cycle 2: second reject increments Revision Count to 2"
//   .sh assert 5  (Revision Count=3 after third reject)        -> "cycle 3: third reject increments Revision Count to 3"
//   .sh assert 6  (final approve lands [x])                    -> "final: approve after 3 rejections lands [x]"
//   .sh assert 7  (GATE_REJECTED fires 3x)                     -> "audit: GATE_REJECTED fires exactly 3x"
//   .sh assert 8  (STAGE_REVISING fires 3x)                    -> "audit: STAGE_REVISING fires exactly 3x"
//   .sh assert 9  (STAGE_AWAITING_APPROVAL fires 4x)           -> "audit: STAGE_AWAITING_APPROVAL fires 4x (1 gate-start + 3 revise)"
//   .sh assert 10 (GATE_APPROVED fires once)                   -> "audit: GATE_APPROVED fires exactly once"
//
// STRONGER than the .sh: a single full cycle is driven in beforeAll and the
// per-assertion intermediate Revision Count / checkbox states are captured at
// the moment they were written (snapshots taken between transitions), so the
// twin proves the field had the expected value AT THAT STEP, not merely at the
// end. Each transition's exit code is also asserted 0 (the .sh leaned on
// `set -e` to abort the run on any non-zero; here we assert it explicitly).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");

const SLUG = "requirements-analysis";

let proj: string;

// P4: intent-birth writes state into the born intent's per-intent record dir
// (aidlc/spaces/<space>/intents/<slug>-<id8>/), not the flat aidlc-docs/. After
// the init the active-intent cursor points at the born record, so every later
// gate-start/reject/revise/approve (default-resolving the active intent)
// reads/writes THAT record — recordDirOf follows the cursor and resolves it for
// both the init output and the state-machine writes. Falls back to the flat
// layout for a not-yet-born / seeded-flat project.
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

/** Run an aidlc-state.ts subcommand against the project; assert exit 0. */
function state(args: string[]): void {
  const r = spawnSync(BUN, [STATE, ...args, "--project-dir", proj], {
    encoding: "utf-8",
  });
  expect(
    r.status,
    `aidlc-state ${args.join(" ")} should exit 0; stderr=${r.stderr ?? ""}`,
  ).toBe(0);
}

function readState(): string {
  return readFileSync(join(recordDirOf(proj), "aidlc-state.md"), "utf-8");
}

/** The Revision Count field value (`- **Revision Count**: N`). */
function revisionCount(content: string): string | null {
  const m = content.match(/^- \*\*Revision Count\*\*: (.+)$/m);
  return m ? m[1].trim() : null;
}

/** The checkbox marker for requirements-analysis (the `X` in `- [X] slug...`). */
function checkboxMarker(content: string): string | null {
  const m = content.match(
    new RegExp(`^- \\[(.)\\] ${SLUG}\\b`, "m"),
  );
  return m ? m[1] : null;
}

/** count_event (t45:62-64): rows whose `**Event**: <TYPE>` line is exactly TYPE. */
function countEvent(event: string): number {
  return readAudit(proj)
    .split("\n")
    .filter((l) => l === `**Event**: ${event}`).length;
}

// Snapshots captured between transitions so each .sh assertion checks the
// value AT THE STEP IT WAS ASSERTED, not just the terminal state.
const snap: {
  rc1?: string | null;
  cb1?: string | null;
  cb2?: string | null;
  rc2?: string | null;
  rc3?: string | null;
  cbFinal?: string | null;
} = {};

beforeAll(() => {
  resetAidlcEnv();
  proj = createTestProject();

  // Init bugfix scope — leaves requirements-analysis in [-] ready to gate.
  const init = spawnSync(
    BUN,
    [UTIL, "intent-birth", "--scope", "bugfix", "--project-dir", proj],
    { encoding: "utf-8", env: { ...process.env, AIDLC_WORKFLOW_INTENT: "revision loop test" } },
  );
  expect(init.status, `init stderr=${init.stderr ?? ""}`).toBe(0);

  // --- Cycle 1: gate-start -> reject ---
  state(["gate-start", SLUG]);
  state(["reject", SLUG, "--feedback", "needs more detail"]);
  const afterReject1 = readState();
  snap.rc1 = revisionCount(afterReject1);
  snap.cb1 = checkboxMarker(afterReject1);

  // --- Cycle 2: revise -> gate (from [R]) -> reject ---
  state(["revise", SLUG]);
  snap.cb2 = checkboxMarker(readState());
  state(["reject", SLUG, "--feedback", "still not enough"]);
  snap.rc2 = revisionCount(readState());

  // --- Cycle 3: revise -> reject ---
  state(["revise", SLUG]);
  state(["reject", SLUG, "--feedback", "one more round"]);
  snap.rc3 = revisionCount(readState());

  // --- Final: revise -> approve (lands [x]) ---
  state(["revise", SLUG]);
  state(["approve", SLUG, "--user-input", "accept as-is"]);
  snap.cbFinal = checkboxMarker(readState());
});

afterAll(() => {
  cleanupTestProject(proj);
});

describe("t45 revision-loop on a gated stage (migrated from t45-revision-loop.sh, plan 10)", () => {
  test("cycle 1: reject increments Revision Count to 1 [.sh assert 1]", () => {
    expect(snap.rc1).toBe("1");
  });

  test("cycle 1: reject flips checkbox to [R] [.sh assert 2]", () => {
    expect(snap.cb1).toBe("R");
  });

  test("cycle 2: revise flips checkbox back to [?] [.sh assert 3]", () => {
    expect(snap.cb2).toBe("?");
  });

  test("cycle 2: second reject increments Revision Count to 2 [.sh assert 4]", () => {
    expect(snap.rc2).toBe("2");
  });

  test("cycle 3: third reject increments Revision Count to 3 [.sh assert 5]", () => {
    expect(snap.rc3).toBe("3");
  });

  test("final: approve after 3 rejections lands [x] [.sh assert 6]", () => {
    expect(snap.cbFinal).toBe("x");
  });

  test("audit: GATE_REJECTED fires exactly 3x [.sh assert 7]", () => {
    expect(countEvent("GATE_REJECTED")).toBe(3);
  });

  test("audit: STAGE_REVISING fires exactly 3x [.sh assert 8]", () => {
    expect(countEvent("STAGE_REVISING")).toBe(3);
  });

  test("audit: STAGE_AWAITING_APPROVAL fires 4x (1 gate-start + 3 revise) [.sh assert 9]", () => {
    // 1 from the initial gate-start + 3 from revise re-entries.
    expect(countEvent("STAGE_AWAITING_APPROVAL")).toBe(4);
  });

  test("audit: GATE_APPROVED fires exactly once [.sh assert 10]", () => {
    expect(countEvent("GATE_APPROVED")).toBe(1);
  });
});
