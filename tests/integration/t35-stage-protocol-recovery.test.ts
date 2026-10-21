// covers: doc:aidlc-common/protocols/stage-protocol-recovery.md
//
// t35 — Stage protocol recovery & change-handling structural validation.
// The subject is the shipped doc
//   dist/claude/.claude/aidlc-common/protocols/stage-protocol-recovery.md
// so the covers id is `doc:<relative-path>`.
//
// Mechanism: none. This is a pure structural check of a shipped markdown file:
// the test reads the bytes on disk ONCE in-process and asserts patterns against
// them - zero spawn, zero LLM, zero tokens, no process boundary to cross. There
// is no tool/function under test; the artefact IS the contract.
//
// `### Session resume` is matched against a whole-line equality so it cannot be
// satisfied by the longer "### Session resume context loading" subsection.

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

const recovery = readFileSync(RECOVERY_PATH, "utf-8");
const lines = recovery.split("\n");

function hasExactLine(literal: string): boolean {
  return lines.includes(literal);
}

describe("t35 stage-protocol-recovery.md — top-level structure (none, migrated from t35-stage-protocol-recovery.sh plan 34)", () => {
  test("§6 Error Recovery section heading exists [.sh 1]", () => {
    expect(hasExactLine("## 6. Error Recovery")).toBe(true);
  });

  test("§7 Change Handling section heading exists [.sh 2]", () => {
    expect(hasExactLine("## 7. Change Handling")).toBe(true);
  });

  test("references stage-protocol.md as parent [.sh 3]", () => {
    expect(recovery).toContain("supplement to `stage-protocol.md`");
  });
});

describe("§6 Error Recovery — session resume + context loading", () => {
  test("Session resume subsection exists (exact heading) [.sh 4]", () => {
    // Whole-line equality so it will NOT match the longer
    // "### Session resume context loading" subsection.
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
    expect(recovery).toContain("<record>/ideation/");
  });

  test("resume references <record>/inception/ [.sh 12]", () => {
    expect(recovery).toContain("<record>/inception/");
  });

  test("resume references <record>/operation/ [.sh 13]", () => {
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
