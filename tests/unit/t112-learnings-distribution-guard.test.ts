// covers: cli:aidlc-learnings(persist)
//
// t112 - isFrameworkDistributionPath guard recognises the framework tree under
// dist/claude/.
//
// Mechanism: cli. The guard `isFrameworkDistributionPath` (aidlc-learnings.ts)
// is INTERNAL (not exported), so it is exercised BEHAVIOURALLY via the `persist`
// subcommand, through the process boundary. The contract is: when a
// sensor-binding selection resolves a manifest path that contains
// `dist/claude/.claude/sensors`, persist REFUSES (process.exit(1)) before the
// sensor manifest write; an ordinary project path is ACCEPTED and the manifest
// is scaffolded under the project's own .claude/sensors. The refusal
// `process.exit(1)` and the absence/presence of the scaffolded `aidlc-bad.md`
// are observables only reachable through the spawned binary - an in-process
// import cannot reach the guard (it is not exported) and would lose the
// exit-code shell. spawnCount = all (3 cases run the real tool).
//
// Why this regression guard exists: if a future refactor breaks the framework
// segment recognition, the guard stops firing SILENTLY and a per-project
// learning loop could scaffold INTO the shipped framework distribution. This
// pins that the guard still fires on the framework path and still lets a normal
// project through.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
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

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const TOOL = join(AIDLC_SRC, "tools", "aidlc-learnings.ts");

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

/**
 * Build a minimal active-stage project rooted at <root>: an active user-stories
 * stage with a seeded stage .md under .claude/aidlc-common/stages/inception/, a
 * runtime-graph, and a sensor-binding selections.json. Parameterised on the
 * absolute project root so callers can place the tail at .../dist/claude
 * (framework-tree shape) vs a plain project - the only difference that drives
 * the guard.
 */
function seedProject(root: string): void {
  mkdirSync(join(root, "aidlc", "spaces", "default"), { recursive: true });
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
      space: "default",
      intent: null,
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
 * output. AIDLC_STAGES_DIR is explicitly removed so the tool's stagesDir()
 * falls back to <projectDir>/.claude/aidlc-common/stages - the seeded tree.
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
    { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env },
  );
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

function mkTempRoot(): string {
  const d = toPortablePath(mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aidlc-t112-")));
  tempDirs.push(d);
  return d;
}

describe("t112 aidlc-learnings persist — framework-distribution guard (migrated from t112-learnings-distribution-guard.sh, plan 3)", () => {
  // ===========================================================================
  // Case 1 + 2 - framework path. The project root's tail IS the
  // framework tree (.../dist/claude), so the resolved manifest path
  // is .../dist/claude/.claude/sensors/aidlc-bad.md, which
  // isFrameworkDistributionPath must recognise -> refuse, exit 1, no write.
  // ===========================================================================
  test("relocated framework path (dist/claude/.claude/sensors) is refused with exit 1 [.sh test 1]", () => {
    const fwroot = join(mkTempRoot(), "fw", "dist", "claude");
    seedProject(fwroot);
    const r = runPersist(fwroot);
    // The refusal message (handlePersist in aidlc-learnings.ts) names the offending
    // manifest path, proving the refuse arm (not some unrelated exit-1 path) fired.
    expect(r.status).toBe(1);
    expect(r.out).toContain(
      "refusing to scaffold a sensor manifest under the framework distribution",
    );
    expect(r.out).toContain(join("dist", "claude", ".claude", "sensors", "aidlc-bad.md"));
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("refusal leaves no aidlc-bad.md scaffolded under the framework tree [.sh test 2]", () => {
    const fwroot = join(mkTempRoot(), "fw", "dist", "claude");
    seedProject(fwroot);
    const r = runPersist(fwroot);
    // The guard must reject BEFORE handlePersist's Write-1 mkdir/writeFileAtomic:
    // no manifest scaffolded despite the refusal.
    expect(r.status).toBe(1);
    expect(existsSync(join(fwroot, ".claude", "sensors", "aidlc-bad.md"))).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // ===========================================================================
  // Case 3 — ordinary PROJECT path (no dist/claude tail). Must PASS the guard,
  // exit 0, scaffold the manifest under the project's own .claude/sensors, and
  // perform the two-write bind into the seeded stage's frontmatter.
  // ===========================================================================
  test("ordinary project path is accepted and the manifest lands under the project's .claude/sensors [.sh test 3]", () => {
    const projroot = join(mkTempRoot(), "proj", "my-app");
    seedProject(projroot);
    const r = runPersist(projroot);
    expect(r.status).toBe(0);
    expect(existsSync(join(projroot, ".claude", "sensors", "aidlc-bad.md"))).toBe(true);
    // The scaffolded manifest carries the sensor id, and the two-write bind
    // (bindSensorToStage in aidlc-learnings.ts) appended the id to the seeded
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
