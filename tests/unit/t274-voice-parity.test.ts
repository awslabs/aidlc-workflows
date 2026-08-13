// covers: voice-layer:contract-parity
//
// t274 — VOICE-LAYER PARITY + JARGON GATE. Mechanism: none (readFileSync over
// authored prose, zero spawn, zero LLM, zero tokens). Technique: deterministic
// closed predicate over the manifest-discovered harness matrix, so a new
// harness cannot escape the gate.
//
// WHY THIS EXISTS: the conductor's chat voice is prose, and prose drifts
// silently. Three failure modes this closes:
//
//   (a) The voice contract lives in ONE place (the stage protocol every harness
//       loads on every stage). If it is deleted or renamed, no other test
//       notices — the framework keeps working and just starts talking like a
//       framework again. §1 pins the section and its substance.
//   (b) The six authored SKILLs are near-copies maintained by hand. The
//       identity paragraph that points at the contract must be present and
//       WORD-IDENTICAL in all five: a partial edit (the t181 failure mode) would
//       leave some harnesses on the old framework-voice identity. §2 extracts the
//       shared core and compares it across the matrix.
//   (c) The retired framework-voice phrases must not creep back into the
//       user-visible surfaces this effort rewrote. §3 is a deny-list scoped to
//       exactly those authored files/sections — machine-facing uses of the same
//       words elsewhere (the engine's own comments, docs/, reference chapters)
//       stay legal by construction, because they are outside the scanned set.
//
// The gate reads the AUTHORED surfaces; dist is their byte-parity-guarded copy
// (t145 / package.ts --check), so gating the authored source covers every tree.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const PROTOCOL_REL = "core/aidlc-common/protocols/stage-protocol.md";

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf-8");
}

function authoredSkills(): Array<{ name: string; rel: string }> {
  return HARNESS_MATRIX.map((harness) => ({
    name: harness.name,
    rel: `harness/${harness.name}/skills/aidlc/SKILL.md`,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

// =========================================================================
// §1 — The voice contract exists, in the file every harness loads per stage.
// =========================================================================
describe("t272 §1 voice contract lives in the per-stage protocol", () => {
  const protocol = read(PROTOCOL_REL);

  test("the contract section is present as a real heading", () => {
    expect(/^### Talking to the user \(the voice contract\)$/m.test(protocol))
      .toBe(true);
  });

  // The contract is only useful if it still carries the two halves that make it
  // actionable: the reserved-word list, and the "wording not mechanics" bound
  // that keeps a voice edit from being read as permission to change behaviour.
  // Matched against a whitespace-flattened copy: the authored file hard-wraps,
  // so a phrase can straddle a newline without changing what it says.
  const flat = protocol.replace(/\s+/g, " ");
  const SUBSTANCE = [
    "Reserved internal vocabulary",
    "software developer building THEIR project",
    "never for chat narration",
  ] as const;
  for (const token of SUBSTANCE) {
    test(`the contract still carries: "${token}"`, () => {
      expect(flat).toContain(token);
    });
  }

  // Every reserved word must actually be listed, else a rewrite could quietly
  // shrink the deny-list the conductor is told to honour.
  const RESERVED = [
    "engine",
    "directive",
    "dispatch",
    "conductor",
    "harness",
    "scope grid",
    "steering",
    "swarm",
  ] as const;
  test("the reserved-vocabulary sentence names every reserved word", () => {
    const start = flat.indexOf("Reserved internal vocabulary");
    const sentence = flat.slice(start, start + 400);
    const missing = RESERVED.filter((w) => !sentence.includes(w));
    expect(missing).toEqual([]);
  });

  test("the contract states that mechanics are unchanged by it", () => {
    // The behaviour-safety clause: a voice rule must never be read as licence
    // to skip a step, rename an audit event, or paraphrase a tool's own output.
    expect(flat).toContain("governs the WORDS you say");
    expect(flat).toContain("VERBATIM");
  });
});

// =========================================================================
// §2 — All six authored SKILLs point at the contract, identically.
// =========================================================================
describe("t272 §2 the SKILL identity paragraph is shared verbatim", () => {
  const skills = authoredSkills();

  for (const { name, rel } of skills) {
    test(`${name}: SKILL.md points at the voice contract`, () => {
      const body = read(rel);
      expect(body).toContain("Talking to the user");
      expect(body).toContain("protocols/stage-protocol.md");
    });
  }

  test("the identity paragraph is byte-identical across every harness", () => {
    // The paragraph is authored once and copied; extract it by its stable
    // opening and compare. A partial edit shows up as a set with >1 member.
    const MARKER = "**Who you are to the user:";
    const paragraphs = new Map<string, string[]>();
    for (const { name, rel } of skills) {
      const body = read(rel);
      const start = body.indexOf(MARKER);
      expect(start, `${name} lacks the identity paragraph`).toBeGreaterThan(-1);
      const paragraph = body.slice(start).split("\n\n")[0];
      const seen = paragraphs.get(paragraph) ?? [];
      seen.push(name);
      paragraphs.set(paragraph, seen);
    }
    // One distinct paragraph text => every harness agrees.
    expect([...paragraphs.values()].map((v) => v.sort())).toHaveLength(1);
  });
});

// =========================================================================
// §3 — Jargon deny-list, scoped to the rewritten user-visible surfaces.
// =========================================================================
describe("t272 §3 retired framework-voice phrases stay out of user-visible prose", () => {
  // Scoped deliberately: these are the authored files whose PROSE the user
  // reads (skill identity/narration guidance, the per-stage protocol, the
  // onboarding doc + its per-harness fills). Machine-facing prose elsewhere
  // (engine source comments, docs/, reference chapters) is out of scope and may
  // keep using the precise internal names.
  function scannedFiles(): string[] {
    return [
      "core/templates/onboarding.md",
      // The per-stage diary template. Its first line renders inside the Write
      // diff of EVERY stage, which makes it one of the most-seen strings the
      // framework ships; it read "maintained by the orchestrator" until the
      // Construction voice pass. t100 pins its exact new wording, this pins that
      // the retired vocabulary cannot come back.
      "core/knowledge/aidlc-shared/memory-template.md",
      ...HARNESS_MATRIX.map((h) => `harness/${h.name}/onboarding.fills.ts`),
    ].sort();
  }

  // Each phrase is a framework-voice tell the voice layer replaced. They are
  // matched case-insensitively so a capitalised reintroduction cannot slip by.
  // "orchestrator" is scanned as a WORD (not a substring) so "orchestration"
  // elsewhere is not double-counted by the phrase entry above it.
  const DENIED = [
    "orchestration engine",
    "auto-birth",
    "flag-precedence ladder",
    "maintained by the orchestrator",
  ] as const;

  for (const rel of scannedFiles()) {
    test(`${rel} carries no retired framework-voice phrase`, () => {
      const body = read(rel).toLowerCase();
      const hits = DENIED.filter((phrase) => body.includes(phrase.toLowerCase()));
      expect(hits).toEqual([]);
    });
  }

  // The protocol needs its own scan with ONE carve-out: the voice contract
  // quotes the retired phrases on purpose (it is the section that bans them), so
  // scanning it whole would forbid the ban from naming what it bans. Everything
  // AFTER the contract is user-visible template prose and is scanned normally.
  test("the protocol's user-visible templates carry no retired phrase", () => {
    const protocol = read(PROTOCOL_REL);
    const contractStart = protocol.indexOf(
      "### Talking to the user (the voice contract)",
    );
    const contractEnd = protocol.indexOf(
      "### Structured questions (harness-neutral contract)",
    );
    expect(contractStart).toBeGreaterThan(-1);
    expect(contractEnd).toBeGreaterThan(contractStart);
    // Template prose = everything outside the contract section.
    const scanned = (
      protocol.slice(0, contractStart) + protocol.slice(contractEnd)
    ).toLowerCase();
    // "orchestration engine" survives in ONE machine-facing paragraph
    // (per-unit iteration mechanics, not a user-facing template), so this scan
    // covers the two phrases with zero legitimate survivors.
    const hits = ["auto-birth", "flag-precedence ladder"].filter((p) =>
      scanned.includes(p),
    );
    expect(hits).toEqual([]);
  });

  // The 27-file stage boilerplate used to read "The engine owns all lifecycle
  // transitions and advancement" — a line an echoing model would narrate. It is
  // rephrased to instruct-and-do-not-narrate; this pins that it stays gone.
  test("no stage file reintroduces the narratable engine-owns boilerplate", () => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const stagesRoot = join(REPO_ROOT, "core", "aidlc-common", "stages");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry);
        if (statSync(abs).isDirectory()) {
          walk(abs);
        } else if (entry.endsWith(".md")) {
          if (readFileSync(abs, "utf-8").includes(
            "The engine owns all lifecycle transitions and advancement.",
          )) {
            offenders.push(abs.slice(REPO_ROOT.length + 1));
          }
        }
      }
    };
    walk(stagesRoot);
    expect(offenders).toEqual([]);
  });
});

// =========================================================================
// §4 — The Construction-phase voice obligations.
//
// A live end-to-end run held the contract through Ideation and Inception and
// then regressed fourfold inside Construction: the per-unit loop had narration
// moments no authored line covered, so the model filled them with the only
// material in front of it (which pass of the iteration this was, what the gate
// boolean now said, what a produces list resolved to). Three surfaces close
// that, and each is a DELETION risk rather than a drift risk - remove any one
// and the framework keeps working while quietly going back to narrating its own
// loop. So each gets a presence pin.
// =========================================================================
describe("t272 §4 Construction keeps its own voice rules", () => {
  test("the protocol's voice contract covers the per-unit loop's bookkeeping", () => {
    const flat = read(PROTOCOL_REL).replace(/\s+/g, " ");
    expect(flat).toContain("In Construction, the loop's bookkeeping is internal.");
    // The substance, not just the heading: the rule's whole force is that a
    // PLAIN retelling is not an improvement (that is the move the live run
    // showed the model making), and that a re-entry's own narration value is
    // what gets said instead.
    expect(flat).toContain("A plain-language retelling is not an improvement");
    expect(flat).toContain("`narration` value already says exactly that");
  });

  test("every conductor SKILL carries the Construction quiet rule, worded identically", () => {
    // Byte-alignment across the matrix for the same reason t181 pins the
    // narration block that way: authored once, copied six times, so a
    // per-harness reword is drift rather than intent.
    const MARKER = "**Inside Construction.**";
    const paragraphs = new Map<string, string[]>();
    for (const { name, rel } of authoredSkills()) {
      const body = read(rel);
      const start = body.indexOf(MARKER);
      expect(start, `${name} lacks the Construction quiet rule`).toBeGreaterThan(-1);
      const paragraph = body.slice(start).split("\n\n")[0];
      const seen = paragraphs.get(paragraph) ?? [];
      seen.push(name);
      paragraphs.set(paragraph, seen);
    }
    expect([...paragraphs.values()].map((v) => v.sort())).toHaveLength(1);
  });

  test("the load-steering row forbids a substitute progress sentence", () => {
    // The run showed the same substitution six times ("Continuing to the stage
    // directive"): the row already banned a progress message, so the model wrote
    // its own sentence in that slot instead. Every harness must carry the
    // strengthened clause.
    const missing: string[] = [];
    for (const { name, rel } of authoredSkills()) {
      if (!read(rel).includes(
        "do not put a sentence of your own where the progress message would have gone",
      )) {
        missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the engine authors a line for a building per-unit beat and none for the settle beat", () => {
    // The narration constructors are not exported (the tools have zero exports),
    // so this pins the two structural facts at the source: the gate test that
    // separates a building beat from the settle beat, and the placeholder guard
    // that keeps "{unit-name}" from ever being spoken. t-drive coverage of the
    // emitted values lives with the live probe; this is the cheap regression net.
    const engine = read("core/tools/aidlc-orchestrate.ts");
    expect(engine).toContain("function narratePerUnitBeat");
    expect(engine).toContain("if (directive.gate !== false) return null;");
    expect(engine).toContain("unit === UNIT_NAME_PLACEHOLDER");
  });

  test("delivery-planning and practices-discovery require a first-mention gloss", () => {
    const delivery = read(
      "core/aidlc-common/stages/inception/delivery-planning.md",
    ).replace(/\s+/g, " ");
    // The Bolt definition existed already but sat in a block addressed to the
    // model, so it never rendered. What is pinned is the INSTRUCTION that its
    // first user-facing mention carries it.
    expect(delivery).toContain("These definitions are for YOU");
    expect(delivery).toContain("first user-facing mention");
    // Artifacts are user-read documents and get the same bar, per file.
    expect(delivery).toContain("each file stands alone");

    const practices = read(
      "core/aidlc-common/stages/inception/practices-discovery.md",
    ).replace(/\s+/g, " ");
    expect(practices).toContain("Gloss a term of art the first time it appears");
    // The walking-skeleton question text itself, glossed in the question line
    // rather than inside one option.
    expect(practices).toContain("A walking skeleton is a minimal version");
  });

  test("the walking-skeleton question drops the framework's own stance vocabulary", () => {
    // "skeleton ceremony" is LOAD-BEARING in memory/org.md: the conductor's
    // stance classifier matches on that prose (core/aidlc-common/conductor.md),
    // so it is machine-facing by contract and stays. What must not carry it is
    // the QUESTION built from that section.
    const practices = read(
      "core/aidlc-common/stages/inception/practices-discovery.md",
    ).toLowerCase();
    expect(practices).not.toContain("ceremony");
    // The classifier's side of the contract is still intact, so the carve-out
    // above is a real distinction rather than a phrase that vanished everywhere.
    expect(read("core/memory/org.md")).toContain("skeleton ceremony");
    expect(read("core/aidlc-common/conductor.md")).toContain("skeleton ceremony");
  });
});
