// covers: cli:aidlc-learnings(persist)
//
// t112 — isFrameworkDistributionPath guard recognises the RELOCATED framework
// tree (v0.6.0 milestone 0 — aidlc-claude-code/ -> dist/claude/). Migrated from
// tests/unit/t112-learnings-distribution-guard.sh (TAP plan 3, 3 bun spawns).
//
// Mechanism: cli. The guard `isFrameworkDistributionPath` (aidlc-learnings.ts
// :619-621) is INTERNAL (not exported), so it is exercised BEHAVIOURALLY via
// the `persist` subcommand exactly as the .sh did — through the process
// boundary. The contract is: when a sensor-binding selection resolves a
// manifest path that contains `dist/claude/.claude/sensors`, persist REFUSES
// (process.exit(1), :507) before any disk write; an ordinary project path is
// ACCEPTED and the manifest is scaffolded under the project's own
// .claude/sensors. The refusal `process.exit(1)` and the absence/presence of
// the scaffolded `aidlc-bad.md` are observables only reachable through the
// spawned binary — an in-process import cannot reach the guard (it is not
// exported) and would lose the exit-code shell. spawnCount = all (3 cases run
// the real tool).
//
// Source under test (dist/claude/.claude/tools/aidlc-learnings.ts):
//   :502 manifestPath = sensorManifestPath(projectDir, sensorId)
//          => join(projectDir, ".claude", "sensors", `aidlc-${sensorId}.md`)
//   :506 if (isFrameworkDistributionPath(manifestPath)) fail(..., 1)
//          - REJECTS BEFORE the Write-1 mkdir/writeFileAtomic at :525-528
//   :619 isFrameworkDistributionPath(path) =>
//          path.includes(join("dist", "claude", ".claude", "sensors"))
//          - the RELOCATED segment (was join("aidlc-claude-code", ...))
//   :532 bindSensorToStage(projectDir, origin_stage, sensorId) — Write-2,
//          edits the seeded stage's `sensors:` frontmatter; only reached on
//          the accept path.
//
// Why this regression guard exists: the v0.6.0 milestone 0 repo move changed the
// framework path segments. If a future refactor breaks the relocated segment
// recognition, the guard stops firing SILENTLY and a per-project learning loop
// could scaffold INTO the shipped framework distribution. This pins that the
// guard still fires on the new path and still lets a normal project through.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1 (relocated framework path -> refused, exit 1)
//        -> "relocated framework path (dist/claude/.claude/sensors) is refused with exit 1"
//   .sh test 2 (refuse left NO manifest behind — reject before write)
//        -> "refusal leaves no aidlc-bad.md scaffolded under the framework tree"
//   .sh test 3 (ordinary project path -> accepted, manifest scaffolded)
//        -> "ordinary project path is accepted and the manifest lands under the project's .claude/sensors"
//   (STRONGER than the .sh: test 1 also pins the refusal message names the
//    offending manifest path; test 3 also asserts exit 0 AND the two-write
//    bind appended the sensor id to the seeded stage's frontmatter.)

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_SRC, toPortablePath } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const TOOL = join(AIDLC_SRC, "tools", "aidlc-learnings.ts");

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

/**
 * Build a minimal active-stage project rooted at <root>, mirroring the .sh's
 * seed_project (t112:43-81): an active user-stories stage with a seeded stage
 * .md under .claude/aidlc-common/stages/inception/, a runtime-graph, and a
 * sensor-binding selections.json. Parameterised on the absolute project root
 * so callers can place the tail at .../dist/claude (framework-tree shape) vs a
 * plain project — the only difference that drives the guard.
 */
function seedProject(root: string): void {
  mkdirSync(join(root, "aidlc-docs", "inception", "user-stories"), { recursive: true });
  mkdirSync(join(root, ".claude", "rules"), { recursive: true });
  mkdirSync(join(root, ".claude", "aidlc-common", "stages", "inception"), { recursive: true });
  mkdirSync(join(root, ".claude", "sensors"), { recursive: true });

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
      "sensors:",
      "  - required-sections",
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
  // A sensor-binding selection — persist resolves the manifest path under the
  // project's .claude/sensors and runs it through isFrameworkDistributionPath.
  writeFileSync(
    join(root, "sel.json"),
    JSON.stringify({
      stage_slug: "user-stories",
      selections: [
        {
          candidate_id: "c9",
          type: "sensor",
          origin_stage: "user-stories",
          manifest_fields: {
            id: "bad",
            kind: "deterministic",
            command: "x",
            default_severity: "advisory",
            description: "d",
            matches: "**/*",
          },
        },
      ],
    }),
    "utf-8",
  );
}

interface PersistResult {
  status: number;
  out: string; // combined stdout+stderr
}

/**
 * Run `bun aidlc-learnings.ts persist --slug user-stories --selections-json
 * <root>/sel.json --project-dir <root>` and capture the exit code + combined
 * output. The .sh ran with `set +e` and read `$?` (it swallows the exit code
 * for the assertion). AIDLC_STAGES_DIR is explicitly removed so the tool's
 * stagesDir() falls back to <projectDir>/.claude/aidlc-common/stages — the
 * seeded tree — matching the .sh's clean-shell environment (the .sh never
 * exports it).
 */
function runPersist(root: string): PersistResult {
  const env = { ...process.env };
  delete env.AIDLC_STAGES_DIR;
  delete env.CLAUDE_PROJECT_DIR;
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
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/** A fresh temp dir registered for afterEach teardown (mirrors the .sh mktemp -d). */
function mkTempRoot(): string {
  const d = toPortablePath(mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aidlc-t112-")));
  tempDirs.push(d);
  return d;
}

describe("t112 aidlc-learnings persist — framework-distribution guard (migrated from t112-learnings-distribution-guard.sh, plan 3)", () => {
  // ===========================================================================
  // Case 1 + 2 — RELOCATED framework path. The project root's tail IS the
  // relocated framework tree (.../dist/claude), so the resolved manifest path
  // is .../dist/claude/.claude/sensors/aidlc-bad.md, which
  // isFrameworkDistributionPath must now recognise -> refuse, exit 1, no write.
  // ===========================================================================
  test("relocated framework path (dist/claude/.claude/sensors) is refused with exit 1 [.sh test 1]", () => {
    const fwroot = join(mkTempRoot(), "fw", "dist", "claude");
    seedProject(fwroot);
    const r = runPersist(fwroot);
    // The .sh asserted EC_FW == 1 only; STRONGER here — the refusal message
    // (aidlc-learnings.ts:507) names the offending manifest path, proving the
    // refuse arm (not some unrelated exit-1 path) fired.
    expect(r.status).toBe(1);
    expect(r.out).toContain(
      "refusing to scaffold a sensor manifest under the framework distribution",
    );
    expect(r.out).toContain(join("dist", "claude", ".claude", "sensors", "aidlc-bad.md"));
  }, 30000);

  test("refusal leaves no aidlc-bad.md scaffolded under the framework tree [.sh test 2]", () => {
    const fwroot = join(mkTempRoot(), "fw", "dist", "claude");
    seedProject(fwroot);
    const r = runPersist(fwroot);
    // The guard must reject BEFORE the Write-1 mkdir/writeFileAtomic (:525-528):
    // no manifest scaffolded despite the refusal.
    expect(r.status).toBe(1);
    expect(existsSync(join(fwroot, ".claude", "sensors", "aidlc-bad.md"))).toBe(false);
  }, 30000);

  // ===========================================================================
  // Case 3 — ordinary PROJECT path (no dist/claude tail). Must PASS the guard,
  // exit 0, scaffold the manifest under the project's own .claude/sensors, and
  // perform the two-write bind into the seeded stage's frontmatter.
  // ===========================================================================
  test("ordinary project path is accepted and the manifest lands under the project's .claude/sensors [.sh test 3]", () => {
    const projroot = join(mkTempRoot(), "proj", "my-app");
    seedProject(projroot);
    const r = runPersist(projroot);
    // The .sh asserted exit 0 AND the manifest present.
    expect(r.status).toBe(0);
    expect(existsSync(join(projroot, ".claude", "sensors", "aidlc-bad.md"))).toBe(true);
    // STRONGER than the .sh: the scaffolded manifest carries the sensor id, and
    // the two-write bind (aidlc-learnings.ts:532) appended the id to the seeded
    // stage's `sensors:` frontmatter — proving the accept arm ran to completion,
    // not merely past the guard.
    const manifest = readFileSync(
      join(projroot, ".claude", "sensors", "aidlc-bad.md"),
      "utf-8",
    );
    expect(manifest).toContain("id: bad");
    const stageFile = readFileSync(
      join(
        projroot,
        ".claude",
        "aidlc-common",
        "stages",
        "inception",
        "user-stories.md",
      ),
      "utf-8",
    );
    expect(stageFile).toMatch(/^[ \t]+-[ \t]+bad\s*$/m);
  }, 30000);
});
