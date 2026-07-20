// covers: file:skills/aidlc/SKILL.md, file:tools/aidlc-audit.ts, file:knowledge/aidlc-shared/audit-format.md, file:knowledge/aidlc-shared/state-template.md, file:aidlc-common/protocols/stage-protocol.md, file:aidlc-common/stages/construction/code-generation.md
//
// In-process port of tests/integration/t47-construction-bolts.sh (TAP plan 12),
// mechanism = none. The .sh is a Construction Bolt-by-Bolt vocabulary check: it
// greps the SHIPPED implementation files for the durable anchors of the Bolt
// vocabulary that survived the engine cutover — the retired "Construction Phase
// N" sub-step labels (must be GONE from SKILL.md), the four Bolt audit events
// registered in aidlc-audit.ts, the BOLT_STARTED row in audit-format.md, the
// Construction Autonomy Mode state field in state-template.md, the stage-protocol
// Glossary entry tying a Bolt to stages 3.1-3.5 (with 3.6/3.7 once at the end),
// and the orchestrator-managed gating note in code-generation.md.
//
// The .sh carried NO `# covers:` header, so it joined to zero enumerated registry
// units — and none of the seven enumerated unit classes
// (function/audit/scope/stage/hook/subcommand/render-surface) models the presence
// or absence of a literal string inside a shipped markdown / tool file. The
// `file:` covers ids above name the six files under test honestly; they parse
// through gen-coverage-registry's parseCoversHeader and (like the .sh) join to no
// enumerated unit. No coverage guarantee is lost: the .sh contributed none.
//
// MECHANISM = none. The .sh shelled out to `grep` over file content and never
// touched a function, a CLI tool, argv, exit codes, or a process boundary.
// gen-coverage-registry derives mechanism from the DRIVERS a test body calls
// (milestone 3): this twin calls NO driver (no driveAidlc, no tui-drive.ts, no spawn of
// an aidlc-*.ts tool or run-tests.sh), so its derived set is the deterministic
// `none` floor — matching the t34 / t14 / t43 / t44 content-structure family.
// Every assertion is readFileSync + a string / regex check on the real bytes of
// the shipped files, the same observable the .sh's grep asserted.
//
// FIXTURE DISCIPLINE: the inputs are the REAL committed shipped files under
// dist/claude/.claude/, read-only, resolved through AIDLC_SRC from
// tests/harness/fixtures.ts (the same anchor the .sh's $AIDLC_SRC pointed at —
// fixtures resolves AIDLC_SRC to <repo>/dist/claude/.claude). NOTHING is written;
// no temp project, no teardown — there is no mutable surface.
//
// Source under test (read fresh each run):
//   dist/claude/.claude/skills/aidlc/SKILL.md                                (SKILL_MD)
//   dist/claude/.claude/tools/aidlc-audit.ts                                 (AUDIT_TS)
//     :68-71 VALID_EVENT_TYPES registers BOLT_STARTED / BOLT_COMPLETED /
//            BOLT_FAILED / AUTONOMY_MODE_SET
//   dist/claude/.claude/knowledge/aidlc-shared/audit-format.md               (AUDIT_FORMAT)
//     :109 documents the BOLT_STARTED row
//   dist/claude/.claude/knowledge/aidlc-shared/state-template.md             (STATE_TEMPLATE)
//     :93 **Construction Autonomy Mode**: [unset/autonomous/gated]
//   dist/claude/.claude/aidlc-common/protocols/stage-protocol.md             (STAGE_PROTOCOL)
//     :716 Glossary **Bolt** row: stages 3.1-3.5; 3.6 & 3.7 run once after all Bolts
//   dist/claude/.claude/aidlc-common/stages/construction/code-generation.md  (CODE_GEN)
//     :176 "orchestrator-managed gating" / "suppressed by the orchestrator" note
//
// Old TAP -> new test parity (1:1; the .sh's plan was 12):
//   .sh tests 1-4  ("Construction Phase N" absent for N=1..4)  -> 4 tests,
//                   one per N, each asserting SKILL.md does NOT contain the label
//                   (the failure-event half of this guard: the label being
//                    REINTRODUCED must make the test go red).
//   .sh tests 5-8  (aidlc-audit.ts registers the 4 Bolt events)-> 4 tests, one
//                   per event, each asserting the quoted event literal is present.
//                   STRONGER: assert it lands in the VALID_EVENT_TYPES array, not
//                   merely anywhere in the file.
//   .sh test 9     (audit-format.md documents BOLT_STARTED)     -> "audit-format.md documents BOLT_STARTED"
//   .sh test 10    (state-template.md has Construction Autonomy Mode) -> "state-template.md exposes Construction Autonomy Mode"
//   .sh test 11    (stage-protocol Glossary ties Bolt to 3.1-3.5 + 3.6/3.7 once) -> "stage-protocol.md Glossary ..."
//   .sh test 12    (code-generation.md notes orchestrator-managed gating) -> "code-generation.md notes orchestrator-managed gating"

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// The six shipped files the .sh's path vars pointed at.
const SKILL_MD = readFileSync(
  join(AIDLC_SRC, "skills", "aidlc", "SKILL.md"),
  "utf-8",
);
const AUDIT_TS = readFileSync(
  join(AIDLC_SRC, "tools", "aidlc-audit.ts"),
  "utf-8",
);
const AUDIT_FORMAT = readFileSync(
  join(AIDLC_SRC, "knowledge", "aidlc-shared", "audit-format.md"),
  "utf-8",
);
const STATE_TEMPLATE = readFileSync(
  join(AIDLC_SRC, "knowledge", "aidlc-shared", "state-template.md"),
  "utf-8",
);
const STAGE_PROTOCOL = readFileSync(
  join(AIDLC_SRC, "aidlc-common", "protocols", "stage-protocol.md"),
  "utf-8",
);
const CODE_GEN = readFileSync(
  join(
    AIDLC_SRC,
    "aidlc-common",
    "stages",
    "construction",
    "code-generation.md",
  ),
  "utf-8",
);

describe("t47 Construction Bolt vocabulary (migrated from t47-construction-bolts.sh, plan 12)", () => {
  // =========================================================================
  // Tests 1-4 — the retired "Construction Phase N" sub-step labels are GONE
  // from SKILL.md (engine cutover moved per-Bolt orchestration prose out of
  // SKILL.md). This is the failure-event half of the guard: if any of these
  // labels is REINTRODUCED, the corresponding test goes red — same direction
  // as the .sh's not_ok branch.
  // =========================================================================
  for (const n of [1, 2, 3, 4] as const) {
    test(`SKILL.md no longer labels sub-steps "Construction Phase ${n}"`, () => {
      expect(SKILL_MD.includes(`Construction Phase ${n}`)).toBe(false);
    });
  }

  // =========================================================================
  // Tests 5-8 — the four Bolt audit events are registered in aidlc-audit.ts.
  // The .sh grepped for the quoted event literal `"<EVENT>"`. STRONGER here:
  // assert each event literal lands inside the VALID_EVENT_TYPES array (the
  // registry the validator gates on), not merely anywhere in the file.
  // =========================================================================
  // Slice the VALID_EVENT_TYPES array literal out of the source (computed at
  // describe scope, asserted inside each test). The validator gates appended
  // events against this array, so membership here is the real contract.
  function validEventTypesBlock(): string {
    const start = AUDIT_TS.indexOf("VALID_EVENT_TYPES");
    const close = AUDIT_TS.indexOf("]", start);
    return start >= 0 && close > start ? AUDIT_TS.slice(start, close + 1) : "";
  }

  for (const event of [
    "BOLT_STARTED",
    "BOLT_COMPLETED",
    "BOLT_FAILED",
    "AUTONOMY_MODE_SET",
  ] as const) {
    test(`aidlc-audit.ts registers ${event} in VALID_EVENT_TYPES`, () => {
      // .sh: grep -q "\"<EVENT>\"" — the quoted literal is present.
      expect(AUDIT_TS.includes(`"${event}"`)).toBe(true);
      // STRONGER: it is a member of the VALID_EVENT_TYPES array specifically.
      expect(validEventTypesBlock().includes(`"${event}"`)).toBe(true);
    });
  }

  // =========================================================================
  // Test 9 — audit-format.md documents BOLT_STARTED (.sh assert_grep).
  // =========================================================================
  test("audit-format.md documents BOLT_STARTED", () => {
    expect(AUDIT_FORMAT.includes("BOLT_STARTED")).toBe(true);
  });

  // =========================================================================
  // Test 10 — state-template.md exposes the Construction Autonomy Mode field
  // (.sh assert_grep).
  // =========================================================================
  test("state-template.md exposes Construction Autonomy Mode", () => {
    expect(STATE_TEMPLATE.includes("Construction Autonomy Mode")).toBe(true);
  });

  // =========================================================================
  // Test 11 — stage-protocol.md Glossary ties a Bolt to stages 3.1-3.5, with
  // 3.6/3.7 run once at the end. The .sh required BOTH greps to hit on the same
  // file:
  //   grep -q  "3\.1.*3\.5"           (the `.` matches the en-dash in "3.1-3.5")
  //   grep -qi "3\.6.*3\.7.*once"
  // Reproduce both as regex tests against the shipped bytes. STRONGER: assert
  // both on a SINGLE line (the Glossary **Bolt** row), so a split across
  // unrelated lines can't satisfy the guard.
  // =========================================================================
  test("stage-protocol.md Glossary ties Bolt to 3.1-3.5 with 3.6/3.7 once at end", () => {
    // .sh grep half 1: "3.1<anything>3.5" — the literal `.` is any-char, which
    // is how the .sh matched the en-dash form "3.1-3.5".
    expect(/3.1.*3.5/.test(STAGE_PROTOCOL)).toBe(true);
    // .sh grep half 2 (case-insensitive): "3.6<...>3.7<...>once".
    expect(/3.6.*3.7.*once/i.test(STAGE_PROTOCOL)).toBe(true);
    // STRONGER: both halves co-located on one Glossary row. Find the line that
    // carries the 3.1-3.5 span and assert the 3.6/3.7-once clause is on it too.
    const boltRow = STAGE_PROTOCOL.split("\n").find((l) =>
      /3.1.*3.5/.test(l),
    );
    expect(boltRow).toBeDefined();
    expect(/3.6.*3.7.*once/i.test(boltRow ?? "")).toBe(true);
  });

  // =========================================================================
  // Test 12 — only Code Generation's completion gate is orchestrator-managed.
  // The pre-generation plan approval remains a mandatory human hard stop in
  // Bolt flow; broad "the approval gate is suppressed" prose regresses that
  // safety boundary.
  // =========================================================================
  test("code-generation.md notes orchestrator-managed gating in Bolt flow", () => {
    expect(
      /orchestrator-managed completion gating/i.test(
        CODE_GEN,
      ),
    ).toBe(true);
    expect(CODE_GEN).toContain(
      "Step 3 Plan Approval is a mandatory hard stop in every execution mode",
    );
    expect(CODE_GEN).toContain(
      "Only the Step 7 completion approval gate is suppressed",
    );
  });
});
