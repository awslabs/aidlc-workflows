// covers: function:parseStageFrontmatter, doc:SKILL.md(stage-graph-table)
//
// t32 — Stage Graph table (SKILL.md) ⇄ stage files on disk consistency.
// Migrated from tests/feature/t32-stage-graph-consistency.sh
// (dynamic TAP plan = ROW_COUNT*3 + FILE_COUNT; at the shipped 32-row graph /
// 32 stage files = 128 assertions). The .sh declared NO `# covers:` header;
// its subject is the human-readable Stage Graph mirror in SKILL.md and the
// pure frontmatter parser it cross-references the table against.
//
// Mechanism: NONE (no process boundary). The .sh shelled out to `bun -e`
// per row only to reach parseStageFrontmatter — a PURE exported function.
// Here we import it in-process and read the same three static surfaces the
// .sh inspected (no argv / exit-code / stdout / audit.md seam to cross):
//   - SKILL.md                              (the Stage Graph table)
//   - aidlc-common/stages/<phase>/<slug>.md (the stage files + their YAML)
//   - agents/<lead_agent>.md                (the agent files)
// Zero LLM, zero tokens, zero spawns.
//
// Source under test:
//   - dist/claude/.claude/skills/aidlc/SKILL.md
//       `## Stage Graph` table: | Slug | # | Stage | Phase | Execution |
//       Lead Agent | Support Agents | Mode |  (the .sh's sed/grep/tail -n +3
//       row extraction is reproduced exactly below).
//   - dist/claude/.claude/tools/aidlc-lib.ts:982 parseStageFrontmatter(raw)
//       => Record<string, unknown>; pulls scalar `execution:` / `lead_agent:`
//       from the `---...---` YAML block (ARRAY_KEYS excludes them, so both
//       arrive as the scalar string the table column must equal).
//   - dist/claude/.claude/aidlc-common/stages/<phase>/<slug>.md  (stage files)
//   - dist/claude/.claude/agents/aidlc-<role>-agent.md           (agent files)
//
// Old TAP -> new test parity (every .sh assertion family preserved, several
// STRONGER — the .sh emitted one `ok` per row/file; the twin keeps the same
// per-row/per-file granularity via test.each PLUS adds set-equality guards):
//   .sh fam 1  "graph row '<slug>' has stage file"             (ROW_COUNT ok's)
//       -> test.each(rows) "graph row '<slug>' has a stage file on disk"
//   .sh fam 2  "graph '<slug>' Execution matches file (<exec>)" (ROW_COUNT ok's)
//       -> test.each(rows) "row '<slug>' Execution matches frontmatter execution:"
//          STRONGER: parses the REAL file via parseStageFrontmatter (the .sh
//          did too) AND pins the table value is a known ALWAYS|CONDITIONAL token.
//   .sh fam 3  "graph '<slug>' lead agent '<a>' has agent file" / orchestrator
//       (ROW_COUNT ok's)
//       -> test.each(rows) "row '<slug>' Lead Agent resolves (file or orchestrator)"
//          STRONGER: also asserts the file's lead_agent: frontmatter equals the
//          table's Lead Agent column (the .sh never cross-checked the YAML's
//          lead_agent against the table — only that the file exists).
//   .sh fam 4  "stage file '<slug>' has row in graph table"     (FILE_COUNT ok's)
//       -> test.each(files) "stage file '<slug>' has a row in the graph table"
//   + STRONGER set guards the .sh only got transitively:
//       "graph row count equals stage-file count" and
//       "graph slug set == stage-file slug set" (bidirectional, exact).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import { parseStageFrontmatter } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const SKILL = join(AIDLC_SRC, "skills", "aidlc", "SKILL.md");
const STAGES_DIR = join(AIDLC_SRC, "aidlc-common", "stages");
const AGENTS_DIR = join(AIDLC_SRC, "agents");

/** A parsed Stage Graph table row (the columns the .sh read off `|`-split). */
interface GraphRow {
  slug: string;
  num: string;
  stage: string;
  phase: string;
  execution: string;
  leadAgent: string;
}

/**
 * Extract the Stage Graph table rows, byte-for-byte the .sh's pipeline:
 *   sed -n '/^## Stage Graph/,/^---$/p' SKILL | grep '^|' | tail -n +3
 * i.e. the slice from the `## Stage Graph` heading to the closing `---`,
 * keep only `|`-prefixed lines, drop the header + separator (first two).
 * Then split on `|` and `xargs`-trim each cell (the .sh piped each through
 * `xargs`, which collapses surrounding whitespace).
 */
function extractGraphRows(): GraphRow[] {
  const text = readFileSync(SKILL, "utf-8");
  const lines = text.split(/\r?\n/);

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
    // IFS='|' read -r _ slug num stage phase execution lead_agent _ _
    // A leading-pipe markdown row splits to ["", slug, num, stage, phase,
    // execution, leadAgent, support, mode, ""]. xargs-trim each cell.
    const cells = line.split("|").map((c) => c.trim());
    const slug = cells[1] ?? "";
    if (!slug) continue; // [ -z "$slug" ] && continue
    rows.push({
      slug,
      num: cells[2] ?? "",
      stage: cells[3] ?? "",
      phase: cells[4] ?? "",
      execution: cells[5] ?? "",
      leadAgent: cells[6] ?? "",
    });
  }
  return rows;
}

/** Every stage file on disk: phase-dir + slug (basename without .md). */
function listStageFiles(): { slug: string; phaseDir: string; path: string }[] {
  const out: { slug: string; phaseDir: string; path: string }[] = [];
  for (const phaseDir of readdirSync(STAGES_DIR)) {
    const dir = join(STAGES_DIR, phaseDir);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // not a directory
    }
    for (const f of entries) {
      if (!f.endsWith(".md")) continue;
      out.push({ slug: f.replace(/\.md$/, ""), phaseDir, path: join(dir, f) });
    }
  }
  return out;
}

const ROWS = extractGraphRows();
const STAGE_FILES = listStageFiles();
const STAGE_FILE_BY_SLUG = new Map(STAGE_FILES.map((s) => [s.slug, s]));
const GRAPH_SLUGS = new Set(ROWS.map((r) => r.slug));

// phase_to_dir(): lowercase the Phase column (the .sh's `tr '[:upper:]'...`).
function phaseToDir(phase: string): string {
  return phase.toLowerCase();
}

describe("t32 Stage Graph ⇄ stage files (migrated from t32-stage-graph-consistency.sh)", () => {
  // The fixture must actually have rows/files; an empty graph would vacuously
  // pass every test.each below. Guard the corpus the .sh's `plan N` implied.
  test("the Stage Graph table and stages dir are non-empty", () => {
    expect(ROWS.length).toBeGreaterThan(0);
    expect(STAGE_FILES.length).toBeGreaterThan(0);
  });

  // STRONGER than the .sh (which only got this transitively via families 1+4):
  // exact count + bidirectional slug-set equality, so a row with no file OR a
  // file with no row is caught as a set mismatch, not just a per-item miss.
  test("graph row count equals stage-file count", () => {
    expect(ROWS.length).toBe(STAGE_FILES.length);
  });

  test("graph slug set == stage-file slug set (bidirectional)", () => {
    const fileSlugs = new Set(STAGE_FILES.map((s) => s.slug));
    const onlyInGraph = [...GRAPH_SLUGS].filter((s) => !fileSlugs.has(s));
    const onlyOnDisk = [...fileSlugs].filter((s) => !GRAPH_SLUGS.has(s));
    expect(onlyInGraph).toEqual([]);
    expect(onlyOnDisk).toEqual([]);
  });

  // --- .sh family 1: each graph row's slug has a stage file on disk ---------
  test.each(ROWS)("graph row '$slug' has a stage file on disk", (row) => {
    const file = STAGE_FILE_BY_SLUG.get(row.slug);
    expect(file, `no stage file for graph row '${row.slug}'`).toBeDefined();
    // The .sh also pinned the file lives under the lowercased-Phase dir.
    expect(file!.phaseDir).toBe(phaseToDir(row.phase));
  });

  // --- .sh family 2: Execution column matches the file's YAML frontmatter ---
  test.each(ROWS)(
    "row '$slug' Execution matches frontmatter execution: ($execution)",
    (row) => {
      // Table value is a known execution token (parser-independent guard).
      expect(["ALWAYS", "CONDITIONAL"]).toContain(row.execution);
      const file = STAGE_FILE_BY_SLUG.get(row.slug);
      expect(file).toBeDefined();
      // Parse the REAL stage file via the same pure function the .sh used.
      const fm = parseStageFrontmatter(readFileSync(file!.path, "utf-8"));
      expect(typeof fm.execution).toBe("string");
      expect(fm.execution).toBe(row.execution);
    },
  );

  // --- .sh family 3: Lead Agent resolves to an agent file (or orchestrator) -
  test.each(ROWS)(
    "row '$slug' Lead Agent resolves (file or orchestrator)",
    (row) => {
      const file = STAGE_FILE_BY_SLUG.get(row.slug);
      expect(file).toBeDefined();
      const fm = parseStageFrontmatter(readFileSync(file!.path, "utf-8"));

      if (row.leadAgent === "(orchestrator)") {
        // .sh: `ok "... lead agent is orchestrator (no file needed)"`.
        // STRONGER: the file's frontmatter lead_agent must be the bare
        // `orchestrator` token (the table renders it parenthesised).
        expect(fm.lead_agent).toBe("orchestrator");
      } else {
        // .sh: assert_file_exists "$AGENTS_DIR/<lead_agent>.md".
        const agentFile = join(AGENTS_DIR, `${row.leadAgent}.md`);
        const agentBody = readFileSync(agentFile, "utf-8");
        expect(agentBody.length).toBeGreaterThan(0);
        // STRONGER: the stage file's lead_agent: frontmatter agrees with the
        // table's Lead Agent column (the .sh never cross-checked the YAML).
        expect(fm.lead_agent).toBe(row.leadAgent);
      }
    },
  );

  // --- .sh family 4: every stage file on disk has a row in the graph --------
  test.each(STAGE_FILES)(
    "stage file '$slug' has a row in the graph table",
    (file) => {
      expect(
        GRAPH_SLUGS.has(file.slug),
        `stage file '${file.slug}' has no graph row`,
      ).toBe(true);
    },
  );
});
