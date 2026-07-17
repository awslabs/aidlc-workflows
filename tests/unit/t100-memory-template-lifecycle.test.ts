// covers: function:parseMemoryHeadings, file:knowledge/aidlc-shared/memory-template.md, subcommand:aidlc-state:advance, subcommand:aidlc-state:approve
//
// t100 — Per-stage memory.md template structure + parser-safety +
// aidlc-state.ts advance/approve `memory_path` JSON key (v0.5.0 milestone 13).
// Migrated from tests/unit/t100-memory-template-lifecycle.sh (TAP plan 19).
//
// Mechanism: MIXED.
//   - Cases 1-13 prove the SHIPPED template FILE structure and the behaviour
//     of parseMemoryHeadings against it. The template is read off disk (the
//     exact bytes that ship); parseMemoryHeadings is imported and called
//     IN-PROCESS (zero LLM, zero tokens) — mechanism none. These hard-code the
//     expected literals independently of the parser source.
//   - Cases 14-16 prove the advance/approve stdout-JSON `memory_path` key. That
//     key is only observable on the CLI's process.stdout (handleAdvance writes
//     JSON.stringify(...) to console.log, aidlc-state.ts:483-495), and approve
//     inherits it via handleAdvance delegation (aidlc-state.ts:775). The
//     process boundary is the contract, so these SPAWN the real tool via the
//     bun runtime — mechanism cli. An in-process twin would lose the
//     console.log/stdout seam the .sh's `jq -r '.memory_path'` reads.
//
// Source under test:
//   - Template file:
//       dist/claude/.claude/knowledge/aidlc-shared/memory-template.md
//     The four canonical `## ` H2 headings must be the EXACT HEADING_TO_KEY
//     strings (lowercase-q "## Open questions"), column 0, no leading/trailing
//     whitespace; seed examples must be SINGLE-LINE HTML comments; the
//     ownership header is a verbatim blockquote.
//   - parseMemoryHeadings(raw) (aidlc-lib.ts:1072) — counts non-blank,
//     non-excluded lines under each of the four canonical headings; blockquote
//     lines (:1125), single-line HTML comments (:1126), and blank lines (:1124)
//     are excluded; raw-line exact heading match (:1112) means whitespace-padded
//     variants count nothing. HEADING_TO_KEY at :1092-1097.
//   - aidlc-state.ts handleAdvance (:317) emits `memory_path:
//     aidlc-docs/${nextStage.phase}/${nextStage.slug}/memory.md` (:492);
//     handleApprove (:717) auto-advances by delegating to handleAdvance (:775),
//     so approve's stdout carries the same key.
//
// Generic parser behaviour (empty input, fence/blockquote/comment exclusion,
// CRLF/BOM, exact-match strictness) is the authority of
// tests/unit/t88-parse-memory-headings.sh — this twin covers the TEMPLATE FILE
// specifically and does not re-prove generic parser behaviour, exactly as the
// .sh scoped itself.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh 1  (template exists)                          -> none "template file exists at the canonical path"
//   .sh 2  (## Interpretations H2)                     -> none "template has the '## Interpretations' H2 (exact line)"
//   .sh 3  (## Deviations H2)                          -> none "template has the '## Deviations' H2 (exact line)"
//   .sh 4  (## Tradeoffs H2)                           -> none "template has the '## Tradeoffs' H2 (exact line)"
//   .sh 5  (## Open questions H2)                      -> none "template has the lowercase-q '## Open questions' H2 (exact line)"
//   .sh 6  (exactly four '## ' headings)               -> none "template has EXACTLY four '## ' H2 headings (no stray heading)"
//   .sh 7  (lowercase-q, refute capital-Q)             -> none "open-questions heading is lowercase-q and NOT capital-Q"
//   .sh 8  (no leading/trailing ws on headings)        -> none "no '## ' heading carries leading or trailing whitespace"
//   .sh 9  (ownership blockquote verbatim)             -> none "ownership header is a blockquote carrying the verbatim card string"
//   .sh 10 (four single-line HTML-comment examples)    -> none "exactly four single-line HTML-comment seed examples"
//   .sh 11 (fresh template total === 0)                -> none "fresh template parses to total === 0 (MEMORY_EMPTY survives)"
//   .sh 12 (all four sub-counts === 0)                 -> none "fresh template: all four sub-counts === 0"
//   .sh 13 (append one bullet -> interpretations 1)    -> none "appending one real bullet under ## Interpretations -> interpretations === 1, total === 1"
//   .sh 14 (advance JSON memory_path value)            -> cli  "advance stdout JSON carries memory_path === aidlc-docs/<phase>/<slug>/memory.md"
//   .sh 15 (memory_path forward-slash, relative)       -> cli  "advance memory_path uses no backslashes and is projectDir-relative (aidlc-docs/ prefix)"
//   .sh 16 (approve inherits memory_path)              -> cli  "approve inherits the memory_path key via handleAdvance delegation"

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseMemoryHeadings } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  FIXTURES_DIR,
  resetAidlcEnv,
  seedStateFile,
} from "../harness/fixtures.ts";

resetAidlcEnv();

// advance/approve emit memory_path against the ACTIVE INTENT's record prefix
// (relativeMemoryPath threaded relativeRecordDir(pd) -> aidlc/spaces/<sp>/intents/
// <slug>-<id8>); the flat aidlc-docs/ prefix is retired. midIdeationProject seeds
// the active-intent cursor at DEFAULT_RECORD_DIR (via createTestProject), so the
// row carries the per-intent record dir.
const RP = `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}`;

const BUN = process.execPath; // the bun running this test
const TOOL = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const TEMPLATE = join(
  AIDLC_SRC,
  "knowledge",
  "aidlc-shared",
  "memory-template.md",
);

// The four canonical headings, byte-for-byte what HEADING_TO_KEY keys on.
const CANONICAL = [
  "## Interpretations",
  "## Deviations",
  "## Tradeoffs",
  "## Open questions",
] as const;

const OWNERSHIP_LINE =
  "> This file is maintained by the orchestrator during stage execution. Add observations at the gate ritual, not by editing here directly.";

/** Read the shipped template's raw bytes (the exact file that ships). */
function templateRaw(): string {
  return readFileSync(TEMPLATE, "utf-8");
}

function templateLines(): string[] {
  return templateRaw().replace(/\r\n/g, "\n").split("\n");
}

// ---------------------------------------------------------------------------
// Cases 1-13 — template FILE structure + parseMemoryHeadings (mechanism none).
// ---------------------------------------------------------------------------
describe("t100 template structure + parser-safety (in-process)", () => {
  test("template file exists at the canonical path [.sh 1]", () => {
    // Bun's readFileSync throws if absent; readability == existence here, and
    // also pins the path .claude/knowledge/aidlc-shared/memory-template.md.
    expect(() => templateRaw()).not.toThrow();
    expect(TEMPLATE.endsWith(
      join("knowledge", "aidlc-shared", "memory-template.md"),
    )).toBe(true);
  });

  test("template has the '## Interpretations' H2 (exact line) [.sh 2]", () => {
    expect(templateLines()).toContain("## Interpretations");
  });

  test("template has the '## Deviations' H2 (exact line) [.sh 3]", () => {
    expect(templateLines()).toContain("## Deviations");
  });

  test("template has the '## Tradeoffs' H2 (exact line) [.sh 4]", () => {
    expect(templateLines()).toContain("## Tradeoffs");
  });

  test("template has the lowercase-q '## Open questions' H2 (exact line) [.sh 5]", () => {
    expect(templateLines()).toContain("## Open questions");
  });

  test("template has EXACTLY four '## ' H2 headings (no stray heading) [.sh 6]", () => {
    // Any stray `## X` resets `current` to null in the parser (aidlc-lib.ts
    // :1116-1119) — a stray heading would silently sever a canonical section.
    const h2 = templateLines().filter((l) => /^## /.test(l));
    expect(h2.length).toBe(4);
    // STRONGER than the .sh's bare count: the four must be EXACTLY the
    // canonical set (no near-miss heading masquerading as one of the four).
    expect(h2.slice().sort()).toEqual([...CANONICAL].slice().sort());
  });

  test("open-questions heading is lowercase-q and NOT capital-Q [.sh 7]", () => {
    const lines = templateLines();
    expect(lines).toContain("## Open questions");
    // The silent-zero trap: "## Open Questions" is not in HEADING_TO_KEY, so it
    // would count nothing. Refute the capital-Q variant outright.
    expect(lines).not.toContain("## Open Questions");
  });

  test("no '## ' heading carries leading or trailing whitespace [.sh 8]", () => {
    // The parser matches the RAW line (aidlc-lib.ts:1112) — any leading or
    // trailing whitespace makes the line miss HEADING_TO_KEY and count nothing.
    for (const line of templateLines()) {
      if (!line.includes("## Interpretations") &&
        !line.includes("## Deviations") &&
        !line.includes("## Tradeoffs") &&
        !line.includes("## Open questions")) {
        continue;
      }
      // Any line carrying a canonical heading must equal it verbatim — no
      // leading indent, no trailing spaces.
      expect(CANONICAL).toContain(line as (typeof CANONICAL)[number]);
    }
    // And refute any leading-whitespace `## ` heading anywhere.
    expect(templateLines().some((l) => /^\s+## /.test(l))).toBe(false);
  });

  test("ownership header is a blockquote carrying the verbatim card string [.sh 9]", () => {
    const lines = templateLines();
    expect(lines).toContain(OWNERSHIP_LINE);
    // It is a blockquote (starts with `>`), so the parser skips it
    // (aidlc-lib.ts:1125) — it never counts as an entry.
    const found = lines.find((l) => l === OWNERSHIP_LINE);
    expect(found?.startsWith(">")).toBe(true);
  });

  test("exactly four single-line HTML-comment seed examples [.sh 10]", () => {
    // Each seed example opens and closes on one line as `<!-- example: ... -->`
    // so parseMemoryHeadings excludes it (aidlc-lib.ts:1126) and the fresh
    // template stays at total === 0. There must be exactly four (one per
    // heading).
    const examples = templateLines().filter((l) =>
      /^<!-- example:.*-->$/.test(l),
    );
    expect(examples.length).toBe(4);
  });

  test("fresh template parses to total === 0 (MEMORY_EMPTY survives) [.sh 11]", () => {
    // LOAD-BEARING: a fresh template must parse empty, so the MEMORY_EMPTY
    // signal still fires. If a seed example were un-commented or split across
    // lines, this would be > 0.
    const r = parseMemoryHeadings(templateRaw());
    expect(r.total).toBe(0);
  });

  test("fresh template: all four sub-counts === 0 [.sh 12]", () => {
    const r = parseMemoryHeadings(templateRaw());
    expect(r.interpretations).toBe(0);
    expect(r.deviations).toBe(0);
    expect(r.tradeoffs).toBe(0);
    expect(r.open_questions).toBe(0);
  });

  test("appending one real bullet under ## Interpretations -> interpretations === 1, total === 1 [.sh 13]", () => {
    const proj = createTestProject();
    try {
      const copy = join(proj, "memory.md");
      copyFileSync(TEMPLATE, copy);
      // Insert a real (non-excluded) bullet directly under the heading — same
      // edit the .sh made via a bun one-liner string replace.
      const raw = readFileSync(copy, "utf-8").replace(
        "## Interpretations\n",
        "## Interpretations\n- 2026-05-29T11:00:00Z — a real observation\n",
      );
      writeFileSync(copy, raw);
      const r = parseMemoryHeadings(readFileSync(copy, "utf-8"));
      expect(r.interpretations).toBe(1);
      expect(r.total).toBe(1);
    } finally {
      cleanupTestProject(proj);
    }
  });
});

// ---------------------------------------------------------------------------
// Cases 14-16 — advance/approve stdout-JSON memory_path key (mechanism cli).
// ---------------------------------------------------------------------------
const tempProjects: string[] = [];
afterAll(() => {
  for (const p of tempProjects) cleanupTestProject(p);
});

/** Seed a mid-ideation project (Current Stage = feasibility, Scope = feature). */
function midIdeationProject(): string {
  const proj = createTestProject();
  tempProjects.push(proj);
  seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
  return proj;
}

/** Spawn `aidlc-state.ts <args> --project-dir <proj>`, return combined output. */
function runState(proj: string, args: string[]): { out: string; status: number } {
  const res = spawnSync(BUN, [TOOL, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    },
  });
  return {
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    status: res.status ?? -1,
  };
}

/** Pull `.memory_path` out of the FIRST parseable JSON object on stdout. */
function memoryPath(out: string): string | undefined {
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const obj = JSON.parse(t);
      if (typeof obj.memory_path === "string") return obj.memory_path;
    } catch {
      /* not the JSON line */
    }
  }
  return undefined;
}

describe("t100 advance/approve memory_path key (Bun spawn — CLI env seam)", () => {
  test("advance stdout JSON carries memory_path === <record-prefix>/<phase>/<slug>/memory.md [.sh 14]", () => {
    const proj = midIdeationProject();
    const r = runState(proj, ["advance", "feasibility", "scope-definition"]);
    expect(r.status).toBe(0);
    // next stage = scope-definition (phase ideation). The .sh asserted the
    // exact derived path; P9 reroots it under the bare space record prefix.
    expect(memoryPath(r.out)).toBe(
      `${RP}/ideation/scope-definition/memory.md`,
    );
  }, 30000);

  test("advance memory_path uses no backslashes and is projectDir-relative (record prefix) [.sh 15]", () => {
    const proj = midIdeationProject();
    const r = runState(proj, ["advance", "feasibility", "scope-definition"]);
    expect(r.status).toBe(0);
    const mp = memoryPath(r.out);
    expect(mp).toBeDefined();
    // Forward-slash only (worktree/Windows-portable) and relative.
    expect(mp).not.toContain("\\");
    expect(mp?.startsWith(`${RP}/`)).toBe(true);
  }, 30000);

  test("approve inherits the memory_path key via handleAdvance delegation [.sh 16]", () => {
    const proj = midIdeationProject();
    // gate-start moves feasibility to awaiting-approval; approve auto-advances
    // to the next in-scope stage (scope-definition), and the delegated
    // handleAdvance prints the envelope carrying memory_path.
    const gs = runState(proj, ["gate-start", "feasibility"]);
    expect(gs.status).toBe(0);
    const ap = runState(proj, ["approve", "feasibility"]);
    expect(ap.status).toBe(0);
    expect(memoryPath(ap.out)).toBe(
      `${RP}/ideation/scope-definition/memory.md`,
    );
  }, 30000);
});
