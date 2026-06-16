// covers: subcommand:aidlc-learnings:persist
//
// t158 — FAIL-SAFE TRIPWIRE for the P5 reader/writer seam (deferred to P6).
//
// P5 relocated the METHOD reader: loadRules()/rulesDir() now read the workspace
// tree aidlc/spaces/default/memory/ (neutral names org/team/project.md). But the
// learnings WRITER (aidlc-learnings.ts learningsFilePath() → persist) and the
// practices-promote writer (aidlc-state.ts) were intentionally NOT moved in
// Stage A — they still target the OLD harness rule dir <harness>/<rulesSubdir>/
// with the OLD aidlc-<scope>-learnings.md / aidlc-<scope>.md names. Redirecting
// those writers is P6's scope (the plan: "P6 owns aidlc-learnings.ts +
// learningsFilePath + the promote prose").
//
// THE HAZARD this guards: in the window between Stage A and P6, a confirmed
// learning is written where the relocated reader can no longer see it — a
// SILENT LOSS. The review flagged it MAJOR; the user asked for a fail-safe in
// Stage A so the broken seam cannot pass silently and cannot be forgotten.
//
// HOW THIS TRIPWIRE WORKS (test.failing):
//   - We run the REAL `aidlc-learnings persist` with a team-scoped learning and
//     observe WHERE it writes.
//   - We compute the relocated reader's root via the exported memoryDirFor()
//     (the same MEMORY_SEGMENTS loadRules() reads from).
//   - The assertion DEMANDS the writer wrote UNDER the reader's root (i.e. the
//     round-trip closes). Today it does NOT — so the assertion throws — and
//     because this is `test.failing`, a throw == PASS. The suite stays green
//     while the seam is legitimately deferred.
//   - The MOMENT P6 redirects the writer into aidlc/spaces/<space>/memory/, the
//     assertion stops throwing → `test.failing` FLIPS TO RED → P6 is forced to
//     delete this tripwire (or convert it to a normal passing round-trip test).
//     The seam cannot be silently "fixed and forgotten", nor silently left
//     broken past P6.
//
// Mechanism: cli (spawnSync of the shipped aidlc-learnings.ts persist) +
// in-process import of memoryDirFor (the reader-root oracle). No LLM.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_SRC, toPortablePath } from "../harness/fixtures.ts";
import { memoryDirFor } from "../../dist/claude/.claude/tools/aidlc-graph.ts";

const BUN = process.execPath;
const TOOL = join(AIDLC_SRC, "tools", "aidlc-learnings.ts");

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

// A minimal active-stage project (modeled on t112's seed_project) with an
// active user-stories stage, runtime-graph, and the .claude/rules/ dir the OLD
// writer targets. We deliberately also create the relocated reader root so the
// "did the writer land under the reader root?" check is about WHERE persist
// wrote, not about a missing dir.
function seedProject(root: string): void {
  mkdirSync(join(root, "aidlc-docs", "inception", "user-stories"), { recursive: true });
  mkdirSync(join(root, ".claude", "rules"), { recursive: true });
  mkdirSync(join(root, ".claude", "aidlc-common", "stages", "inception"), { recursive: true });
  mkdirSync(memoryDirFor(root), { recursive: true }); // the relocated reader root

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
  // A team-scoped LEARNING selection (not a sensor) — persist writes it to the
  // learnings file via learningsFilePath().
  writeFileSync(
    join(root, "sel.json"),
    JSON.stringify({
      stage_slug: "user-stories",
      selections: [
        {
          candidate_id: "c1",
          type: "learning",
          scope: "team",
          heading: "Deviation",
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

describe("t158 memory writer/reader seam (P5→P6 fail-safe tripwire)", () => {
  // GREEN today (seam deferred to P6): persist writes the learning to the OLD
  // <harness>/rules/ dir, NOT under the relocated reader root, so the
  // round-trip assertion throws → test.failing counts it as PASS. When P6
  // redirects the writer under aidlc/spaces/<space>/memory/, this stops
  // throwing → test.failing FLIPS RED → P6 must remove/convert this tripwire.
  test.failing(
    "[TRIPWIRE — P6 must remove] learnings writer lands UNDER the relocated reader root",
    () => {
      const root = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t158-")));
      tempDirs.push(root);
      seedProject(root);

      const r = runPersist(root);
      // persist must succeed (exit 0) — if it errors the tripwire is meaningless.
      expect(r.status).toBe(0);

      const readerRoot = memoryDirFor(root);
      const writtenUnderReader = mdFilesUnder(readerRoot).filter((p) =>
        p.includes("learnings") || /\b(team|project)\.md$/.test(p),
      );
      // THE SEAM CLAIM: P6 makes this true (writer writes under the reader root).
      // Today it is false → throws → test.failing PASSES.
      expect(writtenUnderReader.length).toBeGreaterThan(0);
    },
  );

  // A companion guard that is GREEN normally and documents the CURRENT (broken)
  // reality on disk, so a reader of the suite sees the seam explicitly: today
  // the learning lands in the OLD harness rules dir, which the reader ignores.
  test("documents the CURRENT seam: persist still writes the OLD harness rules dir", () => {
    const root = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t158b-")));
    tempDirs.push(root);
    seedProject(root);

    const r = runPersist(root);
    expect(r.status).toBe(0);

    // The learning landed under <harness>/rules/ (the OLD location), not the
    // relocated reader root — the documented Stage-A→P6 divergence.
    const oldRulesDir = join(root, ".claude", "rules");
    const wroteOld = mdFilesUnder(oldRulesDir).some((p) => p.includes("learnings"));
    const readerRoot = memoryDirFor(root);
    const wroteNew = mdFilesUnder(readerRoot).some((p) => p.includes("learnings"));
    expect(wroteOld).toBe(true);
    expect(wroteNew).toBe(false);
  });
});
