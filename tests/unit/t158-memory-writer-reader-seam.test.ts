// covers: subcommand:aidlc-learnings:persist
//
// t158 - memory writer/reader ROUND-TRIP.
//
// The METHOD reader loadRules()/rulesDir() reads the workspace tree
// aidlc/spaces/default/memory/ (neutral names org/team/project.md). A learnings
// WRITER aimed at a harness rule dir would land a confirmed learning where that
// reader cannot see it - a SILENT LOSS.
//
// A confirmed learning IS a practice (vision section 6): persist appends a
// practice line under the routed heading in {project,team}.md (via
// memoryDirFor(), the SAME MEMORY_SEGMENTS loadRules() reads from). The
// write->read round-trip: persist a team-scoped learning -> the resolver
// (loadRules, pointed at the memory dir) sees the practice line under its
// heading.
//
// Mechanism: cli (spawnSync of the shipped aidlc-learnings.ts persist) +
// in-process import of memoryDirFor (the reader-root oracle) + loadRules (the
// resolver). No LLM.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_SRC, learningsSelectionsPath, toPortablePath, writeLearningsSelections } from "../harness/fixtures.ts";
import { loadRules, memoryDirFor } from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { memoryGuardPolicyDeclarations } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// The selections file is bound to this stage in the intent-less default space.
const BINDING = { space: "default", intent: null, stage_slug: "user-stories" };

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
  const memDir = memoryDirFor(root);
  mkdirSync(memDir, { recursive: true });
  // The intent-less space's own state, the evidence persist takes that the
  // space exists (#1592): writing the picks' file makes its folder.
  mkdirSync(join(root, "aidlc", "spaces", "default", "intents"), { recursive: true });
  writeFileSync(join(root, "aidlc", "spaces", "default", "intents", "aidlc-state.md"), "# AI-DLC State Tracking\n- **Current Stage**: user-stories\n- **Scope**: feature\n", "utf-8");

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
  writeLearningsSelections(root, {
    ...BINDING,
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
  });
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
      learningsSelectionsPath(root, BINDING),
      "--project-dir",
      root,
    ],
    { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env },
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
  // persist writes the learning UNDER the reader root, so the resolver sees it.
  // No `*-learnings.md` file, no harness rule dir - the practice lands in the
  // method file the resolver reads.
  test("learnings writer lands under the relocated reader root", () => {
    savedRulesDir = process.env.AIDLC_RULES_DIR;
    const root = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t158-")));
    tempDirs.push(root);
    seedProject(root);

    const r = runPersist(root);
    expect(r.status).toBe(0);

    const readerRoot = memoryDirFor(root);
    // The practice landed in a method file under the reader root (team.md),
    // NOT a `*-learnings.md` parallel surface and NOT the old harness rules dir.
    const writtenUnderReader = mdFilesUnder(readerRoot).filter((p) =>
      /\b(team|project)\.md$/.test(p),
    );
    expect(writtenUnderReader.length).toBeGreaterThan(0);
    expect(mdFilesUnder(readerRoot).some((p) => p.includes("learnings"))).toBe(false);
    expect(existsSync(join(root, ".claude", "rules", "aidlc-team-learnings.md"))).toBe(false);
  });

  test("round-trip: persisted learning is visible to the resolver (loadRules)", () => {
    savedRulesDir = process.env.AIDLC_RULES_DIR;
    const root = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t158b-")));
    tempDirs.push(root);
    seedProject(root);

    expect(runPersist(root).status).toBe(0);

    process.env.AIDLC_RULES_DIR = memoryDirFor(root);
    const rules = loadRules();
    const team = rules.find((rf) => rf.scope === "team");
    expect(team).toBeDefined();
    const corrections = team?.headings.get("Corrections") ?? "";
    expect(corrections).toContain("Used Given/When/Then for AC; team standardised");
    expect(corrections).toContain("(learned ");

    // Belt-and-braces: the raw team.md carries the cid idempotency marker.
    // "unscoped" is the correct intent-slug component here: this fixture has
    // no aidlc/spaces/.../intents/ active-intent cursor at all, so activeIntent()
    // cannot resolve a real intent and cidMarker falls back to its documented
    // "unscoped" sentinel (#735).
    const teamMd = readFileSync(join(memoryDirFor(root), "team.md"), "utf-8");
    expect(teamMd).toMatch(/cid:unscoped:user-stories:[0-9a-f]{8}/);
  });
  // A learning worded as a field the engine reads (`Methodology: tdd`,
  // `Mode: strict`) is read as that value: its date stays out of the value,
  // where the Testing Posture and Guard Policy readers refused it as invalid.
  // A field the engine does not read from that section (`Ordering:` under
  // Corrections, `Mode:` under Testing Posture) keeps the visible date.
  test("round-trip: a learned field line is read as its value", () => {
    savedRulesDir = process.env.AIDLC_RULES_DIR;
    const root = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t158c-")));
    tempDirs.push(root);
    seedProject(root);
    writeLearningsSelections(root, {
      ...BINDING,
      selections: [
        { candidate_id: "c1", type: "learning", scope: "project", heading: "Testing Posture", text: "Methodology: tdd", source: "orchestrator" },
        { candidate_id: "c2", type: "learning", scope: "project", heading: "Guard Policy", text: "Mode: strict", source: "orchestrator" },
        { candidate_id: "c3", type: "learning", scope: "project", heading: "Corrections", text: "Keep handlers thin", source: "orchestrator" },
        { candidate_id: "c4", type: "learning", scope: "project", heading: "Corrections", text: "Ordering: list imports alphabetically", source: "orchestrator" },
        { candidate_id: "c5", type: "learning", scope: "project", heading: "Testing Posture", text: "Mode: pairing on the parser", source: "orchestrator" },
      ],
    });

    expect(runPersist(root).status).toBe(0);

    const projectMd = readFileSync(join(memoryDirFor(root), "project.md"), "utf-8");
    expect(projectMd).toMatch(/^- Methodology: tdd <!-- learned \d{4}-\d{2}-\d{2} --> <!-- cid:/m);
    expect(projectMd).toMatch(/^- Mode: strict <!-- learned \d{4}-\d{2}-\d{2} --> <!-- cid:/m);
    expect(projectMd).toMatch(/^- Keep handlers thin \(learned \d{4}-\d{2}-\d{2}\) <!-- cid:/m);
    expect(projectMd).toMatch(/^- Ordering: list imports alphabetically \(learned \d{4}-\d{2}-\d{2}\) <!-- cid:/m);
    expect(projectMd).toMatch(/^- Mode: pairing on the parser \(learned \d{4}-\d{2}-\d{2}\) <!-- cid:/m);
    const posture = resolveTestingPosture(root);
    expect([posture.methodology, posture.source]).toEqual(["tdd", "project"]);
    expect(memoryGuardPolicyDeclarations(root).map((d) => [d.layer, d.value])).toEqual([["project", "strict"]]);
  });
});
