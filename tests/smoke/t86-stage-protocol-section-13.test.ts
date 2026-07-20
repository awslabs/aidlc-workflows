// covers: doc:aidlc-common/protocols/stage-protocol.md(section-13), doc:knowledge/aidlc-shared/audit-format.md(MEMORY_EMPTY), doc:docs/reference/12-state-machine.md(MEMORY_EMPTY), data:aidlc-audit.ts(VALID_EVENT_TYPES), doc:skills/aidlc/SKILL.md(run-stage-gate-branch), function:appendAuditEntry
//
// t86 — pins stage-protocol §13 (Learnings Ritual) prose + the MEMORY_EMPTY
// audit-event registration + the SKILL.md run-stage-gate-branch wiring that
// makes the orchestrator actually CALL the §13 gate (surface/persist). Migrated
// from tests/smoke/t86-stage-protocol-section-13.sh (TAP plan 7, pure bash +
// grep, no bun/claude — L1).
//
// MECHANISM = mixed. The subject is FOUR shipped prose/data files plus the
// audit tool's event-type registry:
//   * stage-protocol.md / audit-format.md / 12-state-machine.md / SKILL.md ->
//     read the real bytes in-process and assert the literal contract
//     (mechanism none — a structural/prose check, the same surface grep hit).
//   * the MEMORY_EMPTY registration in aidlc-audit.ts is STRENGTHENED beyond the
//     .sh's `grep '"MEMORY_EMPTY"'`: the tool's `VALID_EVENT_TYPES` Set is a
//     module-private const (NOT exported, aidlc-audit.ts:19), so we exercise the
//     real validity gate by SPAWNING the CLI `append MEMORY_EMPTY` and proving it
//     is ACCEPTED (exit 0, appended:true) rather than rejected. That spawn proves
//     the literal IS registered in the live Set, not merely present as source
//     text — equal-or-stronger. (mechanism cli for that one case.)
//
// Source under test (paths resolved from AIDLC_SRC / REPO_ROOT, fixtures.ts):
//   dist/claude/.claude/aidlc-common/protocols/stage-protocol.md
//     :848  `## 13. Learnings Ritual`
//     :872-875 four canonical memory.md headings (**Interpretations**,
//             **Deviations**, **Tradeoffs**, **Open questions**)
//     :860-861,921 two-surface learnings routing + `sensors: frontmatter` +
//             `matches:` capability glob; the `applies_to` fossil is GONE
//     :935  `### Why stage files stay immutable`
//   dist/claude/.claude/tools/aidlc-audit.ts
//     :19,:101  VALID_EVENT_TYPES Set contains "MEMORY_EMPTY"
//     :214  appendAuditEntry(eventType, fields, projectDir) — throws on an
//           event NOT in VALID_EVENT_TYPES (the in-proc validity proof for the
//           well-known control event we append alongside)
//   dist/claude/.claude/knowledge/aidlc-shared/audit-format.md
//     :167,:171  `MEMORY_EMPTY` registry rows
//   docs/reference/12-state-machine.md
//     :314,:318  `MEMORY_EMPTY` taxonomy rows
//   dist/claude/.claude/skills/aidlc/SKILL.md
//     :65  `### Branching a \`run-stage\` on its gate` (the wiring's new home
//          after the engine cutover; the old `## Stage Advancement` section's
//          transition prose is now the engine's `report` job)
//     the gated run-stage branch calls `aidlc-learnings.ts surface` AND
//          `persist` unconditionally (the "Unless in test-run mode" guard and
//          the Test-Run block were removed per #369).
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1 (§13 H2 heading)                     -> "stage-protocol.md carries the '## 13. Learnings Ritual' H2"
//   .sh test 2 (four canonical headings)            -> "§13 documents all four canonical memory.md headings (bolded)"
//   .sh test 3 (two-surface routing, no applies_to) -> "§13 routes via two-surface learnings + sensors: frontmatter bind, applies_to fossil gone"
//   .sh test 4 (MEMORY_EMPTY in three sources)      -> "MEMORY_EMPTY registered in audit-format.md + 12-state-machine.md (prose)"
//                                                      + STRONGER "aidlc-audit CLI accepts MEMORY_EMPTY (registered in the live VALID_EVENT_TYPES Set)"
//   .sh test 5 ('Why stage files stay immutable')   -> "§13 carries the 'Why stage files stay immutable' invariant H3"
//   .sh test 6 (SKILL.md wires the §13 gate)        -> "SKILL.md run-stage gate branch wires the §13 gate (surface + persist, unconditional)"
//   .sh test 7 (Test-Run block declares skip) was dropped per #369: the SKILL.md
//              Test-Run block was removed and the §13 ritual is now unconditional.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createTestProject, REPO_ROOT, seededAuditDir, seedStateFile } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const AUDIT_TOOL = join(AIDLC_SRC, "tools", "aidlc-audit.ts");

const STAGE_PROTOCOL = join(
  AIDLC_SRC,
  "aidlc-common",
  "protocols",
  "stage-protocol.md",
);
const AUDIT_TS = join(AIDLC_SRC, "tools", "aidlc-audit.ts");
const AUDIT_MD = join(AIDLC_SRC, "knowledge", "aidlc-shared", "audit-format.md");
const STATE_MACHINE = join(REPO_ROOT, "docs", "reference", "12-state-machine.md");
const SKILL = join(AIDLC_SRC, "skills", "aidlc", "SKILL.md");
const STAGES = join(AIDLC_SRC, "aidlc-common", "stages");

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

/**
 * Extract the SKILL.md run-stage-gate-branch span the .sh's awk captured:
 * from the `### Branching a \`run-stage\` on its gate` heading up to (but not
 * including) the NEXT H2/H3. Mirrors:
 *   awk '/^### Branching a .run-stage. on its gate/{p=1;print;next} p && /^#{2,3} /{exit} p'
 */
function gateBranchSpan(text: string): string {
  const out: string[] = [];
  let inSpan = false;
  for (const line of text.split("\n")) {
    if (/^### Branching a .run-stage. on its gate/.test(line)) {
      inSpan = true;
      out.push(line);
      continue;
    }
    if (inSpan) {
      if (/^#{2,3} /.test(line)) break;
      out.push(line);
    }
  }
  return out.join("\n");
}

describe("t86 stage-protocol §13 + MEMORY_EMPTY + SKILL.md gate wiring (migrated from t86-stage-protocol-section-13.sh, plan 7)", () => {
  // --- .sh test 1 ----------------------------------------------------------
  test("stage-protocol.md carries the '## 13. Learnings Ritual' H2 [.sh test 1]", () => {
    const body = read(STAGE_PROTOCOL);
    expect(/^## 13\. Learnings Ritual$/m.test(body)).toBe(true);
  });

  // --- .sh test 2 ----------------------------------------------------------
  test("§13 documents all four canonical memory.md headings (bolded) [.sh test 2]", () => {
    const body = read(STAGE_PROTOCOL);
    // Each heading is a bolded list item. Drift on any breaks milestone 8's
    // parseMemoryHeadings() and milestone 12's destination-from-heading mapper.
    for (const h of ["Interpretations", "Deviations", "Tradeoffs", "Open questions"]) {
      expect(body.includes(`**${h}**`)).toBe(true);
    }
  });

  // --- .sh test 3 ----------------------------------------------------------
  test("§13 routes a learning as a practice into project.md/team.md + sensors: frontmatter bind, applies_to fossil gone [.sh test 3]", () => {
    const body = read(STAGE_PROTOCOL);
    // P6 collapsed the two parallel `*-learnings.md` surfaces into the method
    // files (a learning IS a practice, vision §6): a confirmed learning lands as
    // a practice line under the routed heading in project.md (default) / team.md.
    expect(body.includes("project.md")).toBe(true);
    expect(body.includes("team.md")).toBe(true);
    expect(body.includes("sensors: frontmatter")).toBe(true);
    expect(body.includes("matches:")).toBe(true);
    // The applies_to routing fossil must be fully gone from the protocol.
    expect(body.includes("applies_to")).toBe(false);
    // The parallel dated-log surface is gone — no `*-learnings.md` destination.
    expect(body.includes("aidlc-project-learnings.md")).toBe(false);
    expect(body.includes("aidlc-team-learnings.md")).toBe(false);
  });

  // --- .sh test 5 (declared before 4's CLI half for prose grouping) --------
  test("§13 carries the 'Why stage files stay immutable' invariant H3 [.sh test 5]", () => {
    const body = read(STAGE_PROTOCOL);
    // The core architectural rule the learning loop relies on — without it a
    // future contributor might edit stage files in a §13 write.
    expect(/^### Why stage files stay immutable$/m.test(body)).toBe(true);
  });

  test("§13 requires a valid two-option free-text learning question", () => {
    const body = read(STAGE_PROTOCOL);
    expect(body.includes("Every stage that reaches a human approval gate")).toBe(true);
    expect(body.includes("auto-proceeding bootstrap initialization stages")).toBe(true);
    expect(body.includes("at least two explicit choices")).toBe(true);
    expect(body.includes("**Nothing to add**")).toBe(true);
    expect(body.includes("**Add a note**")).toBe(true);
    expect(body.includes("Never emit a one-option structured question")).toBe(true);
    expect(body.includes("mandatory even when `surface` returned zero candidates")).toBe(true);
    expect(body.includes("do not infer or self-select **Nothing to add**")).toBe(true);
  });

  test("every gated stage keeps the zero-candidate path behind the human learning question", () => {
    const stale: string[] = [];
    const missing: string[] = [];
    const bootstrapContradictions: string[] = [];
    const bootstrapMissingException: string[] = [];
    for (const phase of readdirSync(STAGES)) {
      const phaseDir = join(STAGES, phase);
      for (const name of readdirSync(phaseDir).filter((file) => file.endsWith(".md"))) {
        const rel = `${phase}/${name}`;
        const body = read(join(phaseDir, name));
        if (phase === "initialization") {
          if (body.includes('still ask the mandatory "Anything to add for next time?"')) {
            bootstrapContradictions.push(rel);
          }
          if (!body.includes("auto-proceeding bootstrap stage (`gate: false`)")) {
            bootstrapMissingException.push(rel);
          }
          continue;
        }
        if (body.includes("If nothing surfaces or the user skips all, proceed to the gate")) {
          stale.push(rel);
        }
        if (!body.includes('still ask the mandatory "Anything to add for next time?"')) {
          missing.push(rel);
        }
      }
    }
    expect(stale).toEqual([]);
    expect(missing).toEqual([]);
    expect(bootstrapContradictions).toEqual([]);
    expect(bootstrapMissingException).toEqual([]);
  });

  test("guided and chat summaries require an answerable structured confirmation", () => {
    const body = read(STAGE_PROTOCOL);
    expect(body.includes('label: Looks correct')).toBe(true);
    expect(body.includes('label: Request changes')).toBe(true);
    expect(body.includes("**Consolidated Summary Confirmation**")).toBe(true);
    expect(body.includes("blank `[Answer]:` tag")).toBe(true);
    expect(body.includes("Fill that tag only after the user responds")).toBe(true);
    expect(body.includes("Never ask for this confirmation as bare prose")).toBe(true);
    expect(
      body.includes(
        "same **Looks correct / Request changes** structured confirmation from Step 3a",
      ),
    ).toBe(true);
  });

  // --- .sh test 4 (prose half: two of the three registration sources) ------
  test("MEMORY_EMPTY registered in audit-format.md + 12-state-machine.md (prose) [.sh test 4 — doc half]", () => {
    // The .sh grepped the literal `MEMORY_EMPTY` in backticks in both docs.
    expect(read(AUDIT_MD).includes("`MEMORY_EMPTY`")).toBe(true);
    expect(read(STATE_MACHINE).includes("`MEMORY_EMPTY`")).toBe(true);
    // Source-text presence in aidlc-audit.ts too (the .sh's third grep); the
    // CLI case below proves it is actually live in the runtime Set.
    expect(read(AUDIT_TS).includes('"MEMORY_EMPTY"')).toBe(true);
  });

  // --- .sh test 4 (data half: STRONGER than the .sh's source grep) ---------
  test("aidlc-audit CLI accepts MEMORY_EMPTY (registered in the live VALID_EVENT_TYPES Set) [.sh test 4 — data half, STRONGER]", () => {
    // VALID_EVENT_TYPES is a module-private const (aidlc-audit.ts:19), so we
    // exercise the real validity gate: an event NOT in the Set causes
    // appendAuditEntry to throw and the CLI to exit non-zero with an error JSON
    // (the t18 contract). MEMORY_EMPTY MUST be accepted — exit 0, appended:true.
    // createTestProject seeds the per-intent record + active-intent cursor;
    // seedStateFile writes the record's aidlc-state.md so the cursor RESOLVES
    // (the active-intent cursor only binds a record that has state). Then a bare
    // `aidlc-audit append` lands in <record>/audit/<host>-<clone>.md (P9 — no flat
    // aidlc-docs/audit.md). Read the appended event back off the shard dir.
    const proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
    try {
      const ok = spawnSync(
        BUN,
        [AUDIT_TOOL, "append", "MEMORY_EMPTY", "--field", "Stage=intent-capture", "--project-dir", proj],
        { encoding: "utf-8" },
      );
      expect(ok.status).toBe(0);
      expect(`${ok.stdout ?? ""}`.includes('"appended":true')).toBe(true);
      const auditDir = seededAuditDir(proj);
      const body = readdirSync(auditDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => read(join(auditDir, f)))
        .join("\n");
      expect(body.includes("**Event**: MEMORY_EMPTY")).toBe(true);

      // Negative control: an unregistered event is REJECTED, proving the gate
      // is real and MEMORY_EMPTY's acceptance above is meaningful (not vacuous).
      const bad = spawnSync(
        BUN,
        [AUDIT_TOOL, "append", "MEMORY_NOT_A_REAL_EVENT", "--project-dir", proj],
        { encoding: "utf-8" },
      );
      expect(bad.status).not.toBe(0);
    } finally {
      cleanupTestProject(proj);
    }
  });

  // --- .sh test 6 ----------------------------------------------------------
  test("SKILL.md run-stage gate branch wires the §13 gate (surface + persist, unconditional) [.sh test 6]", () => {
    // §13's prose (tests 1-5) and the aidlc-learnings.ts tool can both be
    // perfect while the orchestrator never CALLS the gate. This pins the one
    // place that makes it run — deleting it would be a silent feature-death.
    const span = gateBranchSpan(read(SKILL));
    expect(span.length).toBeGreaterThan(0); // the heading must exist
    expect(/aidlc-learnings\.ts surface/.test(span)).toBe(true);
    expect(/aidlc-learnings\.ts persist/.test(span)).toBe(true);
    // The ritual is now UNCONDITIONAL: the test-run guard was removed per #369.
  });

  // .sh test 7 (SKILL.md Test-Run block declares the §13 learnings ritual
  // skipped) was dropped per #369: the SKILL.md Test-Run block was removed and
  // the §13 ritual is now unconditional.
});
