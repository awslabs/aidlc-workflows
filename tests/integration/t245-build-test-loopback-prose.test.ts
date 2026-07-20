// covers: doc:aidlc-common/protocols/stage-protocol.md, doc:aidlc-common/protocols/stage-protocol-recovery.md, file:aidlc-common/stages/construction/build-and-test.md
//
// t245 — Build-and-Test failure loop-back PROSE-PIN (issue #611). t34-style:
// mechanism = none. Every assertion is readFileSync + a string / regex check
// over the real bytes of the shipped documents — no spawn, no LLM, zero
// tokens, no process boundary. The bytes on disk ARE the contract.
//
// SUBJECT: the bounded Build & Test → Code Generation failure loop-back
// (stage-protocol.md §1 "Build-and-Test failure loop-back (3.6 → 3.5)").
// Four surfaces carry the contract:
//   1. dist/claude/.claude/aidlc-common/stages/construction/build-and-test.md
//      — Step 10's 4-rung failure-escalation ladder, the `## Loop-Back Log`
//      artifact shape, and the single-stage (--single) carve-out.
//   2. dist/claude/.claude/aidlc-common/protocols/stage-protocol.md — the §1
//      subsection (sibling of the pinned "Halt-and-ask on failure" block:
//      t34 + t76 pin the pre-existing §1 content; this addition is purely
//      additive), the artifact-ledger paragraph, the ENGINE-routed jump
//      procedure, the swarm cheap path, the priced halt-and-ask template, the
//      NO EMERGENT BEHAVIOR carve-out sentence, the checklist-item-5
//      EXCEPTION sentence, and the Artifact Re-use auto-decision rule.
//   3. dist/claude/.claude/aidlc-common/protocols/stage-protocol-recovery.md
//      — the crash-resume bullet (logged-but-not-jumped detection).
//   4. Every harness conductor SKILL (authored harness/<h>/skills/aidlc/
//      SKILL.md AND its dist copy via the harness matrix) — the parenthetical
//      exception on the "STAGE RITUAL IS ATOMIC" Key Principles bullet.
//
// FIXTURE DISCIPLINE: inputs are the REAL committed shipped files (AIDLC_SRC
// = <repo>/dist/claude/.claude from tests/harness/fixtures.ts) plus the
// authored + dist conductor SKILLs discovered through HARNESS_MATRIX (so a
// new harness cannot escape the gate). NOTHING is written; no temp project,
// no teardown — there is no mutable surface.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const PROTOCOL = readFileSync(
  join(AIDLC_SRC, "aidlc-common", "protocols", "stage-protocol.md"),
  "utf-8",
);
const RECOVERY = readFileSync(
  join(AIDLC_SRC, "aidlc-common", "protocols", "stage-protocol-recovery.md"),
  "utf-8",
);
const STAGE = readFileSync(
  join(AIDLC_SRC, "aidlc-common", "stages", "construction", "build-and-test.md"),
  "utf-8",
);

describe("t245 build-and-test.md — Step 10 failure-escalation ladder", () => {
  test("On-failure block is the ladder, not the old flat retry list", () => {
    expect(STAGE).toContain(
      "**On failure**: If build or tests fail, run the failure-escalation ladder:",
    );
    // The retired flat prose must be gone (replaced, not duplicated).
    expect(STAGE).not.toContain(
      "If unable to fix after 2 attempts, log the failure in test-results.md and present the issue to the user at the approval gate",
    );
  });

  test("rung 1: in-stage fix bounded at 2 attempts, scoped to this stage's remit", () => {
    expect(STAGE).toContain("**In-stage fix (max 2 attempts)**");
    expect(STAGE).toContain("this stage's own\n   remit");
  });

  test("rung 2: classify and price — unpriced write-offs forbidden", () => {
    expect(STAGE).toContain("**Classify and price**");
    expect(STAGE).toContain(
      "an approach chosen at code-generation (library/version,",
    );
    expect(STAGE).toContain("PRICE it — effort, cost, risk");
    expect(STAGE).toContain(
      "Never declare a\n   feasible path out of scope on an UNPRICED effort assumption.",
    );
  });

  test("rung 3: autonomous bounded loop-back keyed to mode + priced fix + ledger bound", () => {
    expect(STAGE).toContain("**Autonomous bounded loop-back**");
    expect(STAGE).toContain("`Construction Autonomy Mode:\n   autonomous` (in aidlc-state.md)");
    expect(STAGE).toContain("a priced fix exists, and fewer than\n   3 entries exist under `## Loop-Back Log` in test-results.md");
    expect(STAGE).toContain('stage-protocol.md §1 "Build-and-Test failure loop-back"');
    expect(STAGE).toContain(
      "Do NOT present this stage's approval gate on the failed run.",
    );
  });

  test("rung 4: halt-and-ask — priced options, giving up is the human's call", () => {
    expect(STAGE).toContain("**Halt-and-ask**");
    expect(STAGE).toContain("listing every\n   candidate fix WITH ITS PRICE");
    expect(STAGE).toContain(
      "Giving up is the human's decision to make,\n   never the agent's.",
    );
  });

  test("artifact list carries the Loop-Back Log shape (append-only, Modify-never-Redo)", () => {
    expect(STAGE).toContain("`## Loop-Back Log` (only when the failure ladder's rung 3 or 4 fires a");
    expect(STAGE).toContain("`### Loop-back N — <ISO timestamp>` entry per attempt");
    expect(STAGE).toContain("Diagnosis / Root-cause stage / Planned fix / Price");
    expect(STAGE).toContain("APPEND-ONLY");
    expect(STAGE).toContain("choose Modify,\n     never Redo, on loop-back re-entry");
  });

  test("single-stage runs stop at rung 2 (no main-workflow position to move)", () => {
    expect(STAGE).toContain("**Single-stage runs**");
    expect(STAGE).toContain("rungs 3-4 never execute a jump");
    expect(STAGE).toContain("no main-workflow position");
    expect(STAGE).toContain("Stop at rung 2");
  });
});

describe("t245 stage-protocol.md §1 — Build-and-Test failure loop-back subsection", () => {
  test('the "### Build-and-Test failure loop-back (3.6 → 3.5)" heading exists (anchored H3)', () => {
    expect(/^### Build-and-Test failure loop-back \(3\.6 → 3\.5\)$/m.test(PROTOCOL)).toBe(true);
  });

  test("the subsection is a SIBLING of the pinned Halt-and-ask block (both H3s under §1, loop-back after)", () => {
    const haltIdx = PROTOCOL.indexOf("**Halt-and-ask on failure**");
    const loopIdx = PROTOCOL.indexOf("### Build-and-Test failure loop-back (3.6 → 3.5)");
    const section2Idx = PROTOCOL.indexOf("\n## 2. Completion Messages");
    expect(haltIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(haltIdx);
    expect(section2Idx).toBeGreaterThan(loopIdx); // still inside §1
  });

  test("sanctioned-exception sentence on the NO EMERGENT BEHAVIOR RULE paragraph", () => {
    expect(PROTOCOL).toContain(
      "Two sanctioned carve-outs exist: the revision loop escape hatch (below) and the Build-and-Test failure loop-back (§1, \"Build-and-Test failure loop-back\").",
    );
  });

  test("EXCEPTION sentence on Critical-checklist item 5 (stage ritual atomic)", () => {
    expect(PROTOCOL).toContain(
      "EXCEPTION: the Build-and-Test failure loop-back (§1) jumps back from a deliberately in-flight failed stage; its §13 learnings ritual defers to the eventual passing run.",
    );
  });

  test("ledger paragraph: artifact ledger beats counting STAGE_JUMPED rows", () => {
    expect(PROTOCOL).toContain("the count of `### Loop-back N` entries IS the bound (max 3 per intent)");
    expect(PROTOCOL).toContain("survives the backward jump (jumps reset checkboxes, never artifacts)");
    expect(PROTOCOL).toContain("colocated with the diagnosis");
    expect(PROTOCOL).toContain("readable at the\nfinal gate");
    expect(PROTOCOL).toContain("STAGE_JUMPED rows the jump tool emits remain the\ndeterministic audit cross-check");
    expect(PROTOCOL).toContain("The log is append-only.");
    expect(PROTOCOL).toContain(
      "A human-directed\nbackward jump does not count against the bound",
    );
  });

  test("autonomous procedure routes the jump through the ENGINE, not a hand-composed execute", () => {
    // Step 2 names the engine invocation…
    expect(PROTOCOL).toContain("tools/aidlc-orchestrate.ts next --stage code-generation`");
    // …which answers with the validated jump print the conductor runs verbatim.
    expect(PROTOCOL).toContain("`aidlc-jump.ts execute --target code-generation --direction\n   backward --scope <scope>`");
    expect(PROTOCOL).toContain("run that printed command verbatim");
    expect(PROTOCOL).toContain(
      "Never compose the `execute` call by hand — the engine's print is the\n   validated form.",
    );
  });

  test("procedure step 1 appends the ledger entry AND a Deviations note in memory.md", () => {
    expect(PROTOCOL).toContain(
      "Append the `### Loop-back N — <ISO timestamp>` entry (Diagnosis /\n   Root-cause stage / Planned fix / Price) to test-results.md and a matching\n   Deviations entry to this stage's memory.md.",
    );
  });

  test("the standing autonomy grant covers the replayed code-generation gate (explicit marker)", () => {
    expect(PROTOCOL).toContain(
      '`--user-input "Autonomous loop-back N per stage-protocol §1"`',
    );
    expect(PROTOCOL).toContain("not a new autonomy inference (checklist item 6)");
  });

  test("replay ends with Modify at build-and-test's own re-use prompt + fresh Step 10", () => {
    expect(PROTOCOL).toContain("choose Modify\n   at its own Artifact Re-use prompt");
    expect(PROTOCOL).toContain("re-execute Step 10 fresh");
  });

  test("swarm interaction: fresh STAGE_STARTED floors the ledger; check-first cheap path", () => {
    expect(PROTOCOL).toContain(
      "the jump's fresh `STAGE_STARTED` floors the convergence\nledger",
    );
    expect(PROTOCOL).toContain("all units re-dispatch by\ndefault");
    expect(PROTOCOL).toContain("after `prepare`, run\n`check <unit> --check-cmd");
    expect(PROTOCOL).toContain("claimed at `finalize` without any worker turn");
    expect(PROTOCOL).toContain(
      "dispatch\nworkers only for the unit(s) the Loop-Back Log's planned fix targets or that\nfail the check",
    );
  });

  test("halt-and-ask question template: 3 priced options, bound surfaced", () => {
    expect(PROTOCOL).toContain(
      'prompt: "Build and Test failed: [short error]. Root cause: [diagnosis]. Candidate fix: [fix] — estimated price: [effort/cost/risk]. Loop-backs used: [N]/3. How would you like to proceed?"',
    );
    const lines = PROTOCOL.split("\n");
    const retryIdx = lines.findIndex((l) => /^\s*- label: Retry with fix$/.test(l));
    expect(retryIdx).toBeGreaterThan(-1);
    expect(lines[retryIdx + 1]).toContain("apply [fix] ([price]), re-run");
    const acceptIdx = lines.findIndex((l) => /^\s*- label: Accept failure$/.test(l));
    expect(acceptIdx).toBeGreaterThan(-1);
    expect(lines[acceptIdx + 1]).toContain("proceed to this stage's approval gate");
  });

  test("unpriced give-up option is a protocol violation; human retry counts + may override bound", () => {
    expect(PROTOCOL).toContain(
      "presenting an unpriced give-up option is a\nprotocol violation",
    );
    expect(PROTOCOL).toContain(
      "a\nhuman-approved retry does count an entry in the Loop-Back Log, and the human\nmay override the bound explicitly",
    );
  });

  test("Artifact Re-use tail: deterministic auto-decision, Redo forbidden, still audited", () => {
    const tailIdx = PROTOCOL.indexOf("### Artifact Re-use (backward jump / redo)");
    expect(tailIdx).toBeGreaterThan(-1);
    const tail = PROTOCOL.slice(tailIdx);
    expect(tail).toContain("**Autonomous failure loop-back**");
    expect(tail).toContain("the 3-option question is NOT presented");
    expect(tail).toContain("**Modify** for the unit(s) the fix targets");
    expect(tail).toContain("**Keep** for all other units");
    expect(tail).toContain("**Modify** for build-and-test itself");
    expect(tail).toContain("Redo is forbidden there — it would erase the Loop-Back Log");
    expect(tail).toContain("aidlc-state.ts reuse-artifact --decision");
  });
});

describe("t245 stage-protocol-recovery.md — crash-resume bullet", () => {
  test("logged-but-not-jumped detection re-executes the jump instead of re-diagnosing", () => {
    expect(RECOVERY).toContain(
      "`## Loop-Back Log` whose latest entry has a planned fix but the audit shows no matching `STAGE_JUMPED` (Target: code-generation) after it",
    );
    expect(RECOVERY).toContain("the session died between logging and jumping");
    expect(RECOVERY).toContain(
      're-execute the jump per stage-protocol.md §1 "Build-and-Test failure loop-back" rather than re-diagnosing',
    );
  });

  test("on any resume the loop-back count is the ledger's entry count, never zero", () => {
    expect(RECOVERY).toContain(
      "On any resume, the loop-back count is the ledger's entry count, never zero.",
    );
  });
});

describe("t245 conductor SKILLs — STAGE RITUAL IS ATOMIC exception (authored + dist, every harness)", () => {
  const EXCEPTION_SENTENCE =
    "(One exception: the Build-and-Test failure loop-back — stage-protocol.md §1 — jumps back to code-generation from a deliberately in-flight failed stage; its learnings ritual fires on the eventual passing run.)";

  test("every authored conductor SKILL carries the exception on the atomic-ritual bullet", () => {
    const missing: string[] = [];
    for (const harness of HARNESS_MATRIX) {
      const rel = `harness/${harness.name}/skills/aidlc/SKILL.md`;
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      const bullet = body
        .split("\n")
        .find((l) => l.includes("**STAGE RITUAL IS ATOMIC**"));
      if (!bullet) {
        missing.push(`${rel}  missing the STAGE RITUAL IS ATOMIC bullet`);
      } else if (!bullet.includes(EXCEPTION_SENTENCE)) {
        // Same-line co-location: the exception is part of the bullet itself,
        // not merely present somewhere in the file.
        missing.push(`${rel}  bullet lacks the loop-back exception sentence`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every dist conductor SKILL copy carries the same exception (byte-parity spot check)", () => {
    const missing: string[] = [];
    for (const harness of HARNESS_MATRIX) {
      const path = join(harness.skillsRoot, "aidlc", "SKILL.md");
      const bullet = readFileSync(path, "utf-8")
        .split("\n")
        .find((l) => l.includes("**STAGE RITUAL IS ATOMIC**"));
      if (!bullet?.includes(EXCEPTION_SENTENCE)) {
        missing.push(`dist ${harness.name}: ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
