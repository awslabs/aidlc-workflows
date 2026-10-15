// covers: function:parseStageFrontmatter, doc:SKILL.md(stage-graph-table)
//
// t38 — Lead Agent cross-check: SKILL.md Stage Graph table ⇄ each stage file's
// `lead_agent:` YAML frontmatter. Its subject is the Lead Agent column of the
// human-readable Stage Graph mirror in SKILL.md and the pure frontmatter parser
// it compares that column against, with the `(orchestrator)` <-> bare
// `orchestrator` normalization at the centre.
//
// Distinct from t32-stage-graph-consistency: t32's plan is ROW_COUNT*3 +
// FILE_COUNT and spans file-existence + execution + lead-agent *resolution*
// across all rows/files. t38's narrower, focused subject is the single
// per-row Lead Agent equality assertion — the file's lead_agent frontmatter
// must equal the table's Lead Agent column after stripping `()`.
//
// Mechanism: NONE (no process boundary). We import parseStageFrontmatter (a PURE
// exported function) in-process and read the two static surfaces directly (no
// argv / exit-code / stdout / audit.md seam to cross):
//   - SKILL.md                              (the Stage Graph table, Lead Agent col)
//   - aidlc-common/stages/<phase>/<slug>.md (the stage files + their YAML)
// Zero LLM, zero tokens, zero spawns.
//
// Source under test:
//   - dist/claude/.claude/skills/aidlc/SKILL.md
//       `## Stage Graph` table: | Slug | # | Stage | Phase | Execution |
//       Lead Agent | Support Agents | Mode |
//   - dist/claude/.claude/tools/aidlc-lib.ts parseStageFrontmatter(raw)
//       => Record<string, unknown>; pulls the scalar `lead_agent:` from the
//       `---...---` YAML block (ARRAY_KEYS excludes it, so it arrives as the
//       scalar string the table column must equal). A non-string parse becomes
//       "" and mismatches a real table value.
//   - dist/claude/.claude/aidlc-common/stages/<phase>/<slug>.md  (stage files;
//       e.g. workspace-scaffold.md frontmatter `lead_agent: orchestrator`,
//       intent-capture.md `lead_agent: aidlc-product-agent`).
//
// Normalization contract (the .sh's load-bearing step, t38.sh): the
// graph renders an orchestrator-led stage as `(orchestrator)` (parenthesised);
// the YAML carries the bare slug `orchestrator`. ALL parens are stripped from
// the table cell before comparing, so `(orchestrator)` becomes `orchestrator`
// and matches the file.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import { parseStageFrontmatter } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// The generated Stage Graph table lives in tables.md beside the orchestrator skill.
const SKILL = join(AIDLC_SRC, "skills", "aidlc", "tables.md");
const STAGES_DIR = join(AIDLC_SRC, "aidlc-common", "stages");

/** A parsed Stage Graph table row (only the columns t38 reads off `|`-split). */
interface GraphRow {
  slug: string;
  phase: string;
  leadAgent: string;
}

/**
 * Extract the Stage Graph table rows: the slice from the `## Stage Graph`
 * heading to the closing `---`, keep only `|`-prefixed lines, drop the header +
 * separator (first two). Trim each cell, so cell[1]=slug, cell[4]=phase,
 * cell[6]=leadAgent of a leading-pipe markdown row.
 */
function extractGraphRows(): GraphRow[] {
  const lines = readFileSync(SKILL, "utf-8").split(/\r?\n/);

  const start = lines.findIndex((l) => /^## Stage Graph/.test(l));
  if (start < 0) throw new Error("tables.md: no '## Stage Graph' heading found");
  // tables.md ends with the stage graph; a rule after it ends it otherwise.
  let end = lines.length - 1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^---$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const slice = lines.slice(start, end + 1);

  // Drop the | Slug |... header + |---|... separator.
  const pipeLines = slice.filter((l) => /^\|/.test(l)).slice(2);

  const rows: GraphRow[] = [];
  for (const line of pipeLines) {
    // A leading-pipe row splits to ["", slug, num, stage, phase, execution,
    // leadAgent, support, mode, ""]. Trim each cell.
    const cells = line.split("|").map((c) => c.trim());
    const slug = cells[1] ?? "";
    if (!slug) continue;
    rows.push({
      slug,
      phase: cells[4] ?? "",
      leadAgent: cells[6] ?? "",
    });
  }
  return rows;
}

function phaseToDir(phase: string): string {
  return phase.toLowerCase();
}

// Strip every paren so the graph's `(orchestrator)` compares equal to the
// YAML's bare `orchestrator`.
function normalizeLeadAgent(leadAgent: string): string {
  return leadAgent.replace(/[()]/g, "");
}

const ROWS = extractGraphRows();

describe("t38 Lead Agent cross-check (migrated from t38-stage-agent-cross-check.sh, plan 32)", () => {
  // An explicit corpus guard so a dropped/added Stage Graph row fails loudly
  // (test.each over an empty/short table would otherwise pass vacuously).
  test("the Stage Graph table has the pinned 33 rows", () => {
    expect(ROWS.length).toBe(33);
  });

  // --- The per-row Lead Agent assertions --------------------------------------
  test.each(ROWS)(
    "row '$slug': Lead Agent frontmatter matches graph ($leadAgent)",
    (row) => {
      const stageFile = join(STAGES_DIR, phaseToDir(row.phase), `${row.slug}.md`);

      expect(
        existsSync(stageFile),
        `stage file not found: ${stageFile}`,
      ).toBe(true);

      const fm = parseStageFrontmatter(readFileSync(stageFile, "utf-8"));
      const fileAgent = typeof fm.lead_agent === "string" ? fm.lead_agent : "";

      const graphNormalized = normalizeLeadAgent(row.leadAgent);
      expect(fileAgent).toBe(graphNormalized);
    },
  );
});
