// covers: function:parseStageFrontmatter, doc:SKILL.md(stage-graph-table)
//
// t38 — Lead Agent cross-check: SKILL.md Stage Graph table ⇄ each stage file's
// `lead_agent:` YAML frontmatter. Migrated from
// tests/integration/t38-stage-agent-cross-check.sh (TAP plan 32 — one assertion per
// Stage Graph table row). The .sh declared NO `# covers:` header; its subject is
// the Lead Agent column of the human-readable Stage Graph mirror in SKILL.md and
// the pure frontmatter parser it compares that column against, with the
// `(orchestrator)` ⇄ bare `orchestrator` normalization at the centre.
//
// Distinct from t32-stage-graph-consistency: t32's plan is ROW_COUNT*3 +
// FILE_COUNT and spans file-existence + execution + lead-agent *resolution*
// across all rows/files. t38's narrower, focused subject is the single
// per-row Lead Agent equality assertion — the file's lead_agent frontmatter
// must equal the table's Lead Agent column after stripping `()`. This twin
// reproduces t38's exact 32-assertion shape, not t32's.
//
// Mechanism: NONE (no process boundary). The .sh shelled out to `bun -e` per
// row only to reach parseStageFrontmatter — a PURE exported function — because
// bash cannot import a .ts module. Here we import it in-process and read the
// same two static surfaces the .sh inspected (no argv / exit-code / stdout /
// audit.md seam to cross):
//   - SKILL.md                              (the Stage Graph table, Lead Agent col)
//   - aidlc-common/stages/<phase>/<slug>.md (the stage files + their YAML)
// Zero LLM, zero tokens, zero spawns.
//
// Source under test:
//   - dist/claude/.claude/skills/aidlc/SKILL.md
//       `## Stage Graph` table: | Slug | # | Stage | Phase | Execution |
//       Lead Agent | Support Agents | Mode |  (the .sh's
//       `sed -n '/^## Stage Graph/,/^---$/p' | grep '^|' | tail -n +3` row
//       extraction is reproduced exactly below).
//   - dist/claude/.claude/tools/aidlc-lib.ts:982 parseStageFrontmatter(raw)
//       => Record<string, unknown>; pulls the scalar `lead_agent:` from the
//       `---...---` YAML block (ARRAY_KEYS excludes it, so it arrives as the
//       scalar string the table column must equal). The .sh did
//       `typeof obj.lead_agent === 'string' ? obj.lead_agent : ''`, so a
//       non-string parse becomes "" and mismatches a real table value.
//   - dist/claude/.claude/aidlc-common/stages/<phase>/<slug>.md  (stage files;
//       e.g. workspace-scaffold.md frontmatter `lead_agent: orchestrator`,
//       intent-capture.md `lead_agent: aidlc-product-agent`).
//
// Normalization contract (the .sh's load-bearing step, t38.sh:46-48): the
// graph renders an orchestrator-led stage as `(orchestrator)` (parenthesised);
// the YAML carries the bare slug `orchestrator`. The .sh strips ALL parens from
// the table cell (`tr -d '()'`) before comparing, so `(orchestrator)` becomes
// `orchestrator` and matches the file. We reproduce that exact strip.
//
// Old TAP -> new test parity (1:1 — the .sh emitted exactly one `ok`/`not_ok`
// per Stage Graph row; the twin keeps that per-row granularity via test.each,
// and is STRONGER on the corpus guard the .sh's static `plan 32` only implied):
//   .sh per-row (32x)  ok "<slug>: Lead Agent matches (<normalized>)"  /
//       not_ok on file-missing OR mismatch
//       -> test.each(ROWS) "row '<slug>': Lead Agent frontmatter matches graph
//          (<normalized>)" — asserts (a) the stage file exists at
//          <phase-dir>/<slug>.md, (b) parseStageFrontmatter yields a string
//          lead_agent, and (c) it equals the paren-stripped table value.
//   + STRONGER corpus guard (the .sh's `plan 32` froze the row count; an empty
//     or short table would make a `plan N` mismatch but no per-row failure):
//       "the Stage Graph table has the pinned 32 rows" pins ROWS.length === 32,
//       so a dropped/added row is caught as a count failure, mirroring the
//       static TAP plan the .sh declared.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import { parseStageFrontmatter } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const SKILL = join(AIDLC_SRC, "skills", "aidlc", "SKILL.md");
const STAGES_DIR = join(AIDLC_SRC, "aidlc-common", "stages");

/** A parsed Stage Graph table row (only the columns t38 reads off `|`-split). */
interface GraphRow {
  slug: string;
  phase: string;
  leadAgent: string;
}

/**
 * Extract the Stage Graph table rows, byte-for-byte the .sh's pipeline
 * (t38.sh:15):
 *   sed -n '/^## Stage Graph/,/^---$/p' SKILL | grep '^|' | tail -n +3
 * i.e. the slice from the `## Stage Graph` heading to the closing `---`, keep
 * only `|`-prefixed lines, drop the header + separator (first two). The .sh
 * then did `IFS='|' read -r _ slug _ _ phase _ lead_agent _ _` and `xargs`-trim
 * each cell, so cell[1]=slug, cell[4]=phase, cell[6]=leadAgent of a
 * leading-pipe markdown row.
 */
function extractGraphRows(): GraphRow[] {
  const lines = readFileSync(SKILL, "utf-8").split(/\r?\n/);

  // sed -n '/^## Stage Graph/,/^---$/p'
  const start = lines.findIndex((l) => /^## Stage Graph/.test(l));
  if (start < 0) throw new Error("SKILL.md: no '## Stage Graph' heading found");
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^---$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const slice = lines.slice(start, end + 1);

  // grep '^|' | tail -n +3  (drop the | Slug |... header + |---|... separator)
  const pipeLines = slice.filter((l) => /^\|/.test(l)).slice(2);

  const rows: GraphRow[] = [];
  for (const line of pipeLines) {
    // A leading-pipe row splits to ["", slug, num, stage, phase, execution,
    // leadAgent, support, mode, ""]. xargs-trim each cell.
    const cells = line.split("|").map((c) => c.trim());
    const slug = cells[1] ?? "";
    if (!slug) continue; // [ -z "$slug" ] && continue
    rows.push({
      slug,
      phase: cells[4] ?? "",
      leadAgent: cells[6] ?? "",
    });
  }
  return rows;
}

// phase_to_dir(): lowercase the Phase column (the .sh's `tr '[:upper:]'...`).
function phaseToDir(phase: string): string {
  return phase.toLowerCase();
}

// graph_normalized=$(echo "$lead_agent" | tr -d '()'): strip every paren so the
// graph's `(orchestrator)` compares equal to the YAML's bare `orchestrator`.
function normalizeLeadAgent(leadAgent: string): string {
  return leadAgent.replace(/[()]/g, "");
}

const ROWS = extractGraphRows();

describe("t38 Lead Agent cross-check (migrated from t38-stage-agent-cross-check.sh, plan 32)", () => {
  // The .sh's `plan 32` froze the row count; reproduce that as an explicit
  // corpus guard so a dropped/added Stage Graph row fails loudly (test.each
  // over an empty/short table would otherwise pass vacuously).
  test("the Stage Graph table has the pinned 33 rows", () => {
    expect(ROWS.length).toBe(33);
  });

  // --- The 32 per-row Lead Agent assertions (one `ok`/`not_ok` each) ---------
  test.each(ROWS)(
    "row '$slug': Lead Agent frontmatter matches graph ($leadAgent)",
    (row) => {
      const stageFile = join(STAGES_DIR, phaseToDir(row.phase), `${row.slug}.md`);

      // .sh: not_ok "<slug>: Lead Agent cross-check" "stage file not found".
      expect(
        existsSync(stageFile),
        `stage file not found: ${stageFile}`,
      ).toBe(true);

      // Parse the REAL stage file via the same pure function the .sh reached
      // through `bun -e`. The .sh coerced a non-string lead_agent to "" before
      // comparing; assert the contract that it IS a string here (a non-string
      // would be a real mismatch against any table value).
      const fm = parseStageFrontmatter(readFileSync(stageFile, "utf-8"));
      const fileAgent = typeof fm.lead_agent === "string" ? fm.lead_agent : "";

      // .sh: graph_normalized = lead_agent with all parens stripped, then
      // assert file_agent === graph_normalized.
      const graphNormalized = normalizeLeadAgent(row.leadAgent);
      expect(fileAgent).toBe(graphNormalized);
    },
  );
});
