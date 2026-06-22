// covers: doc:aidlc-common/protocols/stage-protocol-recovery.md
//
// t35 — Stage protocol recovery & change-handling structural validation.
// Migrated from tests/integration/t35-stage-protocol-recovery.sh (TAP plan 34).
// The .sh had no `# covers:` header; its subject is the shipped doc
//   dist/claude/.claude/aidlc-common/protocols/stage-protocol-recovery.md
// so the covers id is `doc:<relative-path>`.
//
// Mechanism: none. This is a pure structural check of a shipped markdown file:
// the .sh ran a battery of `assert_grep RECOVERY <pattern>` against the bytes
// on disk. The TS twin reads those same bytes ONCE in-process and asserts the
// same patterns — zero spawn, zero LLM, zero tokens, no process boundary to
// cross. There is no tool/function under test; the artefact IS the contract.
//
// Source under test (read verbatim, byte cites against the file as shipped):
//   dist/claude/.claude/aidlc-common/protocols/stage-protocol-recovery.md
//     :8   "## 6. Error Recovery"            (§6 top-level section)
//     :164 "## 7. Change Handling"           (§7 top-level section)
//     :4   "supplement to `stage-protocol.md`" (parent-protocol reference)
//     :42  "### Session resume"              (line is EXACTLY this — not the
//          "### Session resume context loading" subsection below it at :50)
//     :50  "### Session resume context loading"
//     :53-99 the five phase resume-context headings (INITIALIZATION … OPERATION)
//     :59,74,101 the ideation/inception/operation artefact-dir cites
//     :117 "### Corrupted state file recovery"
//     :119 "aidlc-state.md.bak" backup-before-recovery
//     :121 "Rebuild `aidlc-state.md` from artifact evidence"
//     :129 "### Missing artifact recovery"
//     :138 "### Error Severity Levels"
//     :144-147 the Critical/High/Medium/Low severity rows (High/Medium/Low are
//          bold **…** in the table; Critical appears as plain text)
//     :149 "**Escalation guidelines:**"
//     :111 "### Context compaction"
//     :112 "PreCompact hook"
//     :115 ".aidlc-recovery.md" recovery breadcrumb
//     :197,201,207,213 the Minor/Major/Scope/Archive change-handling subsections
//     :168 "### New reference material supplied mid-stage"
//     :171 "evidence/input for the current stage, never a routing"
//     :176 "Stay on the current stage"
//     :186 "Routing changes only on an explicit user action"
//
// Old TAP -> new test parity (1:1 — every one of the 34 `assert_grep` lines
// maps to a named test(); several are STRONGER, asserting a line EQUALS the
// pattern rather than merely CONTAINS it, e.g. `### Session resume` is matched
// against a whole-line equality so it cannot be satisfied by the longer
// "### Session resume context loading" subsection):
//   .sh  1 (§6 Error Recovery)            -> "§6 Error Recovery section heading exists"
//   .sh  2 (§7 Change Handling)           -> "§7 Change Handling section heading exists"
//   .sh  3 (supplement to parent)         -> "references stage-protocol.md as parent"
//   .sh  4 (### Session resume$)          -> "Session resume subsection exists (exact heading)"
//   .sh  5 (### Session resume context …) -> "Session resume context loading subsection exists"
//   .sh  6 (resume: INITIALIZATION)       -> "resume context covers INITIALIZATION"
//   .sh  7 (resume: IDEATION)             -> "resume context covers IDEATION"
//   .sh  8 (resume: INCEPTION)            -> "resume context covers INCEPTION"
//   .sh  9 (resume: CONSTRUCTION)         -> "resume context covers CONSTRUCTION"
//   .sh 10 (resume: OPERATION)            -> "resume context covers OPERATION"
//   .sh 11 (ideation artifacts dir)       -> "resume references <record>/ideation/"
//   .sh 12 (inception artifacts dir)      -> "resume references <record>/inception/"
//   .sh 13 (operation artifacts dir)      -> "resume references <record>/operation/"
//   .sh 14 (### Corrupted state recovery) -> "corrupted state file recovery subsection exists"
//   .sh 15 (aidlc-state.md.bak)           -> "creates aidlc-state.md.bak backup before recovery"
//   .sh 16 (Rebuild...artifact evidence)  -> "rebuilds state from artifact evidence"
//   .sh 17 (### Missing artifact recovery)-> "missing artifact recovery subsection exists"
//   .sh 18 (### Error Severity Levels)    -> "error severity levels subsection exists"
//   .sh 19 (Critical)                     -> "severity level Critical present"
//   .sh 20 (**High**)                     -> "severity level High present (bold)"
//   .sh 21 (**Medium**)                   -> "severity level Medium present (bold)"
//   .sh 22 (**Low**)                      -> "severity level Low present (bold)"
//   .sh 23 (Escalation guidelines)        -> "escalation guidelines defined"
//   .sh 24 (### Context compaction)       -> "context compaction subsection exists"
//   .sh 25 (PreCompact hook)              -> "references the PreCompact hook"
//   .sh 26 (.aidlc-recovery.md)           -> "references the .aidlc-recovery.md breadcrumb"
//   .sh 27 (### Minor changes)            -> "change handling: minor changes subsection"
//   .sh 28 (### Major changes)            -> "change handling: major changes subsection"
//   .sh 29 (### Scope changes)            -> "change handling: scope changes subsection"
//   .sh 30 (### Archive before change)    -> "change handling: archive before change subsection"
//   .sh 31 (### New reference material …) -> "change handling: new reference material subsection"
//   .sh 32 (evidence/input … never routing)-> "reference material is evidence, never a routing instruction"
//   .sh 33 (Stay on the current stage)    -> "reference material: stay on the current stage"
//   .sh 34 (Routing changes only …)       -> "reference material: routing changes only on explicit user action"

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const RECOVERY_PATH = join(
  AIDLC_SRC,
  "aidlc-common",
  "protocols",
  "stage-protocol-recovery.md",
);

// Read the shipped bytes ONCE (the .sh's $RECOVERY). All assertions below run
// against this snapshot — same source of truth, no re-read per test.
const recovery = readFileSync(RECOVERY_PATH, "utf-8");
const lines = recovery.split("\n");

/** True iff some line EQUALS the given literal (stronger than substring). */
function hasExactLine(literal: string): boolean {
  return lines.includes(literal);
}

describe("t35 stage-protocol-recovery.md — top-level structure (none, migrated from t35-stage-protocol-recovery.sh plan 34)", () => {
  test("§6 Error Recovery section heading exists [.sh 1]", () => {
    // .sh: assert_grep "^## 6\. Error Recovery" — stronger: exact line.
    expect(hasExactLine("## 6. Error Recovery")).toBe(true);
  });

  test("§7 Change Handling section heading exists [.sh 2]", () => {
    // .sh: assert_grep "^## 7\. Change Handling" — stronger: exact line.
    expect(hasExactLine("## 7. Change Handling")).toBe(true);
  });

  test("references stage-protocol.md as parent [.sh 3]", () => {
    // .sh: assert_grep "supplement to .stage-protocol.md" (the `.` is the
    // regex any-char around the backtick); assert the real backticked literal.
    expect(recovery).toContain("supplement to `stage-protocol.md`");
  });
});

describe("§6 Error Recovery — session resume + context loading", () => {
  test("Session resume subsection exists (exact heading) [.sh 4]", () => {
    // .sh used `### Session resume$` (anchored end) so it would NOT match the
    // longer "### Session resume context loading". Mirror that precisely with
    // a whole-line equality — STRONGER than a substring contains().
    expect(hasExactLine("### Session resume")).toBe(true);
  });

  test("Session resume context loading subsection exists [.sh 5]", () => {
    expect(recovery).toContain("### Session resume context loading");
  });

  test("resume context covers INITIALIZATION [.sh 6]", () => {
    expect(recovery).toContain("INITIALIZATION stages");
  });

  test("resume context covers IDEATION [.sh 7]", () => {
    expect(recovery).toContain("IDEATION stages");
  });

  test("resume context covers INCEPTION [.sh 8]", () => {
    expect(recovery).toContain("INCEPTION");
  });

  test("resume context covers CONSTRUCTION [.sh 9]", () => {
    expect(recovery).toContain("CONSTRUCTION");
  });

  test("resume context covers OPERATION [.sh 10]", () => {
    expect(recovery).toContain("OPERATION stages");
  });

  test("resume references <record>/ideation/ [.sh 11]", () => {
    // Rerooted: flat aidlc-docs/<phase>/ -> per-intent <record>/<phase>/. The
    // resume prose now loads `<record>/ideation/` artifacts (recovery.md:61).
    expect(recovery).toContain("<record>/ideation/");
  });

  test("resume references <record>/inception/ [.sh 12]", () => {
    // recovery.md:65,76,81 — `<record>/inception/...` resume-context loads.
    expect(recovery).toContain("<record>/inception/");
  });

  test("resume references <record>/operation/ [.sh 13]", () => {
    // recovery.md:103 — `<record>/operation/` artifacts completed so far.
    expect(recovery).toContain("<record>/operation/");
  });
});

describe("§6 Error Recovery — corrupted state + missing artifact recovery", () => {
  test("corrupted state file recovery subsection exists [.sh 14]", () => {
    expect(recovery).toContain("### Corrupted state file recovery");
  });

  test("creates aidlc-state.md.bak backup before recovery [.sh 15]", () => {
    expect(recovery).toContain("aidlc-state.md.bak");
  });

  test("rebuilds state from artifact evidence [.sh 16]", () => {
    // .sh: assert_grep "Rebuild.*from artifact evidence" — same regex shape.
    expect(/Rebuild.*from artifact evidence/.test(recovery)).toBe(true);
  });

  test("missing artifact recovery subsection exists [.sh 17]", () => {
    expect(recovery).toContain("### Missing artifact recovery");
  });
});

describe("§6 Error Recovery — error severity table + escalation", () => {
  test("error severity levels subsection exists [.sh 18]", () => {
    expect(recovery).toContain("### Error Severity Levels");
  });

  test("severity level Critical present [.sh 19]", () => {
    expect(recovery).toContain("Critical");
  });

  test("severity level High present (bold) [.sh 20]", () => {
    // .sh: assert_grep "\*\*High\*\*" — the literal bold marker, not bare "High".
    expect(recovery).toContain("**High**");
  });

  test("severity level Medium present (bold) [.sh 21]", () => {
    expect(recovery).toContain("**Medium**");
  });

  test("severity level Low present (bold) [.sh 22]", () => {
    expect(recovery).toContain("**Low**");
  });

  test("escalation guidelines defined [.sh 23]", () => {
    expect(recovery).toContain("Escalation guidelines");
  });
});

describe("§6 Error Recovery — context compaction", () => {
  test("context compaction subsection exists [.sh 24]", () => {
    expect(recovery).toContain("### Context compaction");
  });

  test("references the PreCompact hook [.sh 25]", () => {
    expect(recovery).toContain("PreCompact hook");
  });

  test("references the .aidlc-recovery.md breadcrumb [.sh 26]", () => {
    expect(recovery).toContain(".aidlc-recovery.md");
  });
});

describe("§7 Change Handling — change categories", () => {
  test("change handling: minor changes subsection [.sh 27]", () => {
    expect(recovery).toContain("### Minor changes");
  });

  test("change handling: major changes subsection [.sh 28]", () => {
    expect(recovery).toContain("### Major changes");
  });

  test("change handling: scope changes subsection [.sh 29]", () => {
    expect(recovery).toContain("### Scope changes");
  });

  test("change handling: archive before change subsection [.sh 30]", () => {
    expect(recovery).toContain("### Archive before change");
  });
});

describe("§7 Change Handling — new reference material is evidence, not routing", () => {
  test("change handling: new reference material subsection [.sh 31]", () => {
    expect(recovery).toContain("### New reference material supplied mid-stage");
  });

  test("reference material is evidence, never a routing instruction [.sh 32]", () => {
    expect(recovery).toContain(
      "evidence/input for the current stage, never a routing",
    );
  });

  test("reference material: stay on the current stage [.sh 33]", () => {
    expect(recovery).toContain("Stay on the current stage");
  });

  test("reference material: routing changes only on explicit user action [.sh 34]", () => {
    expect(recovery).toContain(
      "Routing changes only on an explicit user action",
    );
  });
});
