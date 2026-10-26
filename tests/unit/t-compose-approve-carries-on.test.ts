// covers: subcommand:aidlc-utility:recompose, function:composeGateOpen
//
// After the person approves a trimmed plan at the in-flight compose question,
// the work goes on in the same turn. A nightly's Codex legs on Linux and
// Windows ended the turn on recompose's counts, and the person had to type
// again (macOS went on into Intent Capture). The approval's recompose, run while
// the question's marker is still there as the engine's print orders, ends with
// the `next` to run; that next starts the stage the work stands at, and the walk
// never comes back to the composer or the trim. Without the marker (the named
// stage route, a jump, an undo) or with an orphaned one, recompose prints what
// it always printed: those steps say themselves what comes after.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { COMPOSE_MARKER_TTL_MS, composeMarkerPath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, runOrchestrateNext, seededRecordDir, setupIntegrationProject } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const env: Record<string, string | undefined> = {
  ...process.env,
  AIDLC_SESSION_OVERRIDE: "01995000-7a11-7000-8000-000000000035",
  AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
};
delete env.AIDLC_SCOPE_MAPPING;

const tool = (proj: string, name: string): string => join(proj, ".claude", "tools", name);

function run(proj: string, name: string, args: string[]): { status: number; out: string } {
  const res = spawnSync(process.execPath, [tool(proj, name), ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: env as Record<string, string>,
    cwd: proj,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function recordDirOf(proj: string): string {
  const active = join(proj, "aidlc", "spaces", "default", "intents", "active-intent");
  return existsSync(active) ? join(dirname(active), readFileSync(active, "utf-8").trim()) : seededRecordDir(proj);
}
const readState = (proj: string): string => readFileSync(join(recordDirOf(proj), "aidlc-state.md"), "utf-8");

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

// Feature work with Initialization done and the cursor on Intent Capture, with
// Market Research and Team Formation pending ahead of it: the nightly's shape
// (its fixture, Intent Capture not started) and work just created (Intent
// Capture under way). This chat's hooks are running.
type Shape = "not started" | "under way";
function work(shape: Shape = "under way"): string {
  const proj = shape === "not started"
    ? setupIntegrationProject({ withState: "state-initialization-done.md", stripEnvScope: true })
    : setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  projects.push(proj);
  if (shape === "under way") {
    const created = run(proj, "aidlc-utility.ts", ["intent-create", "--scope", "feature"]);
    expect(created.status, created.out).toBe(0);
  }
  const health = join(recordDirOf(proj), ".aidlc-engine", "hooks-health");
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "pre-tool-use.last"), new Date().toISOString());
  const state = readState(proj);
  expect(state).toContain("- **Current Stage**: intent-capture");
  expect(state).toMatch(shape === "not started" ? /- \[ \] intent-capture \u2014 EXECUTE/ : /- \[-\] intent-capture \u2014 EXECUTE/);
  return proj;
}

const next = (proj: string, args: string[] = []): Record<string, unknown> =>
  (runOrchestrateNext(tool(proj, "aidlc-orchestrate.ts"), proj, args, { env }).directive ?? {}) as Record<string, unknown>;

// What recompose has always printed, and nothing after it.
const COUNTS_ONLY = /^Recomposed: 2 skipped \(market-research, team-formation\), 0 added \(none\)\nStages in scope: \d+\nCompleted: \d+\/\d+\n$/;

describe("t-compose-approve-carries-on: an approved trim mid-work goes on to the next step", () => {
  test.each<Shape>(["not started", "under way"])("Approve at the in-flight compose question carries on into the stage the work stands at (%s), never back to the trim", (shape) => {
    const proj = work(shape);
    // The person asks for the trim: the engine hands the in-flight composer,
    // whose approval runs recompose while the question's marker is there.
    const compose = next(proj, ["compose", "drop market research and team formation, we already know the market and the team"]);
    expect(compose.kind).toBe("print");
    const print = String(compose.message);
    expect(print).toContain("aidlc-composer-agent");
    expect(print).toMatch(/write the pending-proposal marker `aidlc\/\.aidlc-compose-pending`/);
    expect(print).toMatch(/on approve run `[^`]*recompose /);
    writeFileSync(composeMarkerPath(proj), "{}\n", "utf-8");

    // Approve: the trim lands, and its output ends with the step that carries on.
    const approved = run(proj, "aidlc-utility.ts", ["recompose", "--skip", "market-research,team-formation"]);
    expect(approved.status, approved.out).toBe(0);
    const lines = approved.out.trimEnd().split("\n");
    expect(lines[0]).toBe("Recomposed: 2 skipped (market-research, team-formation), 0 added (none)");
    const tail = lines.at(-1) ?? "";
    expect(tail).toContain("aidlc/.aidlc-compose-pending");
    const named = /`([^`]*aidlc-orchestrate\.ts next)`/.exec(tail)?.[1];
    expect(named, approved.out).toBeDefined();

    // The agent deletes the marker and runs that next: the stage the work
    // stands at starts, and the walk never hands the composer or the trim back.
    rmSync(composeMarkerPath(proj));
    for (let beat = 0; beat < 2; beat++) {
      const step = next(proj);
      expect(step.kind, JSON.stringify(step)).toBe("run-stage");
      expect(step.stage).toBe("intent-capture");
      expect(JSON.stringify(step)).not.toContain("aidlc-composer-agent");
      expect(JSON.stringify(step)).not.toContain("recompose");
    }
    const after = readState(proj);
    expect(after).toMatch(/- \[ \] market-research \u2014 SKIP/);
    expect(after).toMatch(/- \[ \] team-formation \u2014 SKIP/);
    expect(after).toContain("- **Current Stage**: intent-capture");
  });

  test("with no compose question open, recompose prints only its counts", () => {
    const proj = work();
    expect(existsSync(composeMarkerPath(proj))).toBe(false);
    const flipped = run(proj, "aidlc-utility.ts", ["recompose", "--skip", "market-research,team-formation"]);
    expect(flipped.status, flipped.out).toBe(0);
    expect(flipped.out).toMatch(COUNTS_ONLY);
  });

  test("an orphaned compose marker is no open question: recompose prints only its counts", () => {
    const proj = work();
    const marker = composeMarkerPath(proj);
    writeFileSync(marker, "{}\n", "utf-8");
    const stale = (Date.now() - COMPOSE_MARKER_TTL_MS - 60_000) / 1000;
    utimesSync(marker, stale, stale);
    const flipped = run(proj, "aidlc-utility.ts", ["recompose", "--skip", "market-research,team-formation"]);
    expect(flipped.status, flipped.out).toBe(0);
    expect(flipped.out).toMatch(COUNTS_ONLY);
  });
});
