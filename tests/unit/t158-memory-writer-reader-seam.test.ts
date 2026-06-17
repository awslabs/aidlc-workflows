// covers: subcommand:aidlc-learnings:persist
//
// t158 — memory writer/reader ROUND-TRIP (P6 closed the P5 seam).
//
// P5 relocated the METHOD reader: loadRules()/rulesDir() now read the workspace
// tree aidlc/spaces/default/memory/ (neutral names org/team/project.md). In
// Stage A the learnings WRITER (aidlc-learnings.ts learningsFilePath() →
// persist) still targeted the OLD harness rule dir, so a confirmed learning
// landed where the relocated reader could no longer see it — a SILENT LOSS.
// This file was a `test.failing` tripwire guarding that window.
//
// P6 closed the seam: a confirmed learning IS a practice (vision §6) — persist
// now appends a practice line under the routed heading in the relocated
// {project,team}.md (via memoryDirFor(), the SAME MEMORY_SEGMENTS loadRules()
// reads from), and the `*-learnings.md` slots + fractional tiers are gone. The
// tripwire is therefore CONVERTED to a normal passing write→read round-trip:
// persist a team-scoped learning → the resolver (loadRules, pointed at the
// relocated memory dir) sees the practice line under its heading.
//
// Mechanism: cli (spawnSync of the shipped aidlc-learnings.ts persist) +
// in-process import of memoryDirFor (the reader-root oracle) + loadRules (the
// resolver). No LLM.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_SRC, toPortablePath } from "../harness/fixtures.ts";
import { loadRules, memoryDirFor } from "../../dist/claude/.claude/tools/aidlc-graph.ts";

const BUN = process.execPath;
const TOOL = join(AIDLC_SRC, "tools", "aidlc-learnings.ts");

const tempDirs: string[] = [];
let savedRulesDir: string | undefined;
afterEach(() => {
  if (savedRulesDir === undefined) delete process.env.AIDLC_RULES_DIR;
  else process.env.AIDLC_RULES_DIR = savedRulesDir;
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

// A minimal active-stage project (modeled on t112's seed_project) with an
// active user-stories stage, runtime-graph, and a relocated method dir holding
// a team.md that already ships the `## Corrections` heading (the §13 default
// routing target) — so the round-trip reads back a practice the writer
// appended under an existing heading.
function seedProject(root: string): void {
  mkdirSync(join(root, "aidlc-docs", "inception", "user-stories"), { recursive: true });
  mkdirSync(join(root, ".claude", "aidlc-common", "stages", "inception"), { recursive: true });
  const memDir = memoryDirFor(root); // the relocated reader root
  mkdirSync(memDir, { recursive: true });

  // The team.md the resolver reads. Ships the `## Corrections` heading the
  // §13 default routing targets; loadRules requires valid frontmatter-or-none
  // — a bare prose file resolves with default frontmatter.
  writeFileSync(
    join(memDir, "team.md"),
    "# Team-Level Rules\n\n## Corrections\n\n<!-- Self-learning loop appends here. -->\n",
    "utf-8",
  );

  writeFileSync(
    join(root, "aidlc-docs", "aidlc-state.md"),
    "# AI-DLC State Tracking\n- **Current Stage**: user-stories\n- **Scope**: feature\n",
    "utf-8",
  );
  writeFileSync(
    join(root, "aidlc-docs", "runtime-graph.json"),
    JSON.stringify({
      workflow_id: "w1",
      scope: "feature",
      started_at: "2026-05-28T13:00:00Z",
      stages: [
        {
          stage_slug: "user-stories",
          memory_path: "aidlc-docs/inception/user-stories/memory.md",
        },
      ],
    }),
    "utf-8",
  );
  writeFileSync(
    join(root, ".claude", "aidlc-common", "stages", "inception", "user-stories.md"),
    [
      "---",
      "slug: user-stories",
      "phase: inception",
      "execution: ALWAYS",
      "lead_agent: aidlc-product-agent",
      "support_agents: []",
      "inputs: foo",
      "outputs: bar",
      "---",
      "",
      "# User Stories",
      "",
      "## Steps",
      "1. do the thing",
      "",
    ].join("\n"),
    "utf-8",
  );
  // A team-scoped LEARNING selection routed to the `## Corrections` heading —
  // persist appends it as a practice line into the relocated team.md.
  writeFileSync(
    join(root, "sel.json"),
    JSON.stringify({
      stage_slug: "user-stories",
      selections: [
        {
          candidate_id: "c1",
          type: "learning",
          scope: "team",
          heading: "Corrections",
          text: "Used Given/When/Then for AC; team standardised",
          source: "orchestrator",
        },
      ],
    }),
    "utf-8",
  );
}

function runPersist(root: string): { status: number; out: string } {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.AIDLC_STAGES_DIR;
  delete env.AIDLC_RULES_DIR;
  const res = spawnSync(
    BUN,
    [
      TOOL,
      "persist",
      "--slug",
      "user-stories",
      "--selections-json",
      join(root, "sel.json"),
      "--project-dir",
      root,
    ],
    { encoding: "utf-8", env },
  );
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

// Recursively collect every *.md path under a dir (relative to it).
function mdFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

describe("t158 memory writer/reader round-trip (P6 closed the P5 seam)", () => {
  // The seam is CLOSED: persist writes the learning UNDER the relocated reader
  // root, so the resolver sees it. No `*-learnings.md` file, no old harness
  // rule dir — the practice lands in the method file the resolver reads.
  test("learnings writer lands under the relocated reader root", () => {
    savedRulesDir = process.env.AIDLC_RULES_DIR;
    const root = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t158-")));
    tempDirs.push(root);
    seedProject(root);

    const r = runPersist(root);
    // persist must succeed (exit 0).
    expect(r.status).toBe(0);

    const readerRoot = memoryDirFor(root);
    // The practice landed in a method file under the reader root (team.md),
    // NOT a `*-learnings.md` parallel surface and NOT the old harness rules dir.
    const writtenUnderReader = mdFilesUnder(readerRoot).filter((p) =>
      /\b(team|project)\.md$/.test(p),
    );
    expect(writtenUnderReader.length).toBeGreaterThan(0);
    expect(mdFilesUnder(readerRoot).some((p) => p.includes("learnings"))).toBe(false);
    // The OLD harness rules dir was never written (it isn't even created).
    expect(existsSync(join(root, ".claude", "rules", "aidlc-team-learnings.md"))).toBe(false);
  });

  // The full round-trip: persist → loadRules (the resolver) reads the practice
  // line back out of the relocated team.md under its heading.
  test("round-trip: persisted learning is visible to the resolver (loadRules)", () => {
    savedRulesDir = process.env.AIDLC_RULES_DIR;
    const root = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t158b-")));
    tempDirs.push(root);
    seedProject(root);

    expect(runPersist(root).status).toBe(0);

    // Point the resolver at the relocated method dir and read it back.
    process.env.AIDLC_RULES_DIR = memoryDirFor(root);
    const rules = loadRules();
    const team = rules.find((rf) => rf.scope === "team");
    expect(team).toBeDefined();
    // The resolver surfaced the practice under `## Corrections`.
    const corrections = team?.headings.get("Corrections") ?? "";
    expect(corrections).toContain("Used Given/When/Then for AC; team standardised");
    expect(corrections).toContain("(learned ");

    // Belt-and-braces: the raw team.md carries the cid idempotency marker.
    const teamMd = readFileSync(join(memoryDirFor(root), "team.md"), "utf-8");
    expect(teamMd).toContain("cid:user-stories:c1");
  });
});
