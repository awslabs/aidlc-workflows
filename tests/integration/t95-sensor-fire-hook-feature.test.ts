// covers: hook:aidlc-sensor-fire
//
// t95 — behavioural contract for the PostToolUse sensor-fire hook end-to-end.
// Migrated from tests/integration/t95-sensor-fire-hook-feature.sh (TAP plan 19).
// The .sh carried NO `# covers:` header; its subject is the shipped hook
// dist/claude/.claude/hooks/aidlc-sensor-fire.ts, whose registry unit is
// `hook:aidlc-sensor-fire` (the same id t131 credits).
//
// Mechanism: cli. A hook has no in-process arg surface — Claude Code drives it
// by piping PostToolUse JSON on stdin with CLAUDE_PROJECT_DIR set, exactly as
// settings.json wires it. The hook's whole contract is process-boundary
// side-effects: it spawns `bun <proj>/.claude/tools/aidlc-sensor.ts fire <id>
// --stage <slug> --output-path <path>` per matching sensor (hook :195-222),
// records hook-level drops via recordHookDrop to
// aidlc-docs/.aidlc-hooks-health/sensor-fire.drops (hook :238-257, lib.ts:1554),
// and touches the heartbeat sensor-fire.last (hook :134-139). (The
// sensor-fire.skipped accounting under the old test-run mode was removed per
// #369.) None of that is
// observable in-process, so every row SPAWNS the real hook via the bun runtime
// (spawnSync, input: JSON) and asserts on the bytes / mtimes / exit code the
// subprocess leaves behind. spawnCount = all.
//
// SOURCE UNDER TEST (dist/claude/.claude/hooks/aidlc-sensor-fire.ts):
//   :43-44 SUBPROCESS_TIMEOUT_MS = Number(env.AIDLC_SENSOR_TIMEOUT_MS) || 90_000
//          — the env-var seam the timeout case overrides (no source patch).
//   (The old test-run-mode skip that appended to sensor-fire.skipped was removed
//          per #369.)
//   :134-139 heartbeat — writes isoTimestamp() to sensor-fire.last every fire.
//   :184-185 empty sensors_applicable -> exit 0 (no spawn).
//   :196-222 per-entry dispatch — `if (!entry.matches) continue` then
//          new Bun.Glob(entry.matches).match(filePath); spawn argv is
//          ["fire", entry.id, "--stage", currentStage, "--output-path", filePath].
//   :235-257 timeout (SIGTERM/ETIMEDOUT) -> recordHookDrop "...subprocess killed
//          by SIGTERM (timeout)"; non-zero exit -> recordHookDrop "...dispatcher
//          exit <n>...". Always exit 0 (G5 advisory, :269).
//   loadGraph() honours AIDLC_STAGE_GRAPH (aidlc-graph.ts:160-162) — the seam
//   the synthetic-graph cases inject through.
//
// FIXTURE DISCIPLINE (mirrors make_project / make_project_active, t95:90-110):
// a fresh temp project with aidlc-docs/, .claude/tools/, .claude/hooks/, and a
// per-test MOCK aidlc-sensor.ts at <proj>/.claude/tools/aidlc-sensor.ts (the
// exact path the hook joins at :195) that records its argv to T95_SPAWN_LOG and
// exits per T95_STUB_MODE (pass | fail-exit-1 | slow). Synthetic stage-graph
// fixtures are written to temp files and injected via AIDLC_STAGE_GRAPH. All
// temp dirs cleaned in afterAll; nothing under tests/fixtures/**.
//
// Old TAP -> new test parity (1:1, 19 .sh asserts -> 19 expect()-bearing test()):
//   C1 t1  (Inception md write fires 2 md sensors)        -> C1a
//   C1 t2  (argv carries "fire")                           -> C1b
//   C1 t3  (argv carries --stage requirements-analysis)    -> C1c
//   C1 t4  (argv carries --output-path)                    -> C1d
//   C2 t5  (2 matching applicable -> 2 spawns)             -> C2a
//   C2 t6  (spawns preserve applicable order a before b)   -> C2b
//   C3 t7  (TS write -> only linter+type-check spawn)      -> C3a
//   C3 t8  (TS fires linter+type-check, skips req-sections)-> C3b
//   C3 t9  (md write -> only the 2 md sensors spawn)        -> C3c
//   C4 t10 (mixed-glob on .md -> 1 spawn)                  -> C4a
//   C4 t11 (spawned id is sensor-md-only)                  -> C4b
//   C5 t12 (hook exit 0 on subprocess timeout)             -> C5a
//   C5 t13 (timeout -> recordHookDrop SIGTERM/timeout)     -> C5b
//   C6 t14 (hook exit 0 on subprocess exit 1)              -> C6a
//   C6 t15 (exit 1 -> recordHookDrop "dispatcher exit 1")  -> C6b
//   C7 t16 (stdout never carries {decision: block})       -> C7
//   C8 t17 (heartbeat mtime advances on 2nd invocation)    -> C8
//   C9 t18/t19 (the Test-Run-mode skip -> sensor-fire.skipped accounting) were
//      dropped per #369 when the test-run mechanism was removed.
//
// Several are STRONGER: argv is parsed from the recorded JSON and asserted as an
// EXACT ordered slice (not a substring grep), and the spawn count is the parsed
// line count of the dispatcher's own argv log.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-sensor-fire.ts");

// P9 per-intent layout: the sensor-fire hook's active-workflow gate resolves
// state via stateFilePath() and the audit trail via auditFilePath() — under the
// active intent's record. The FRAMEWORK sensor `matches` glob was widened to
// `**/{aidlc-docs,intents}/**` (the per-intent record arm + the legacy aidlc-docs
// arm for a pre-migration project), so a trigger fires from EITHER a legacy
// aidlc-docs/ path OR a per-intent intents/<record>/ path (see C1a vs C1a-intents).
const PINNED_CLONE_ID = "testcloneid95";
function pinnedShardName(): string {
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "host";
  return `${host}-${PINNED_CLONE_ID}.md`;
}
const FRAMEWORK_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

// The mock dispatcher (t95:60-88): records argv to T95_SPAWN_LOG and exits per
// T95_STUB_MODE. Written to <proj>/.claude/tools/aidlc-sensor.ts — the path the
// hook joins at :195 — so the real hook spawns OUR stub.
const MOCK_DISPATCHER = `// @ts-nocheck
// t95 mock dispatcher: record argv and exit per T95_STUB_MODE.
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const out = process.env.T95_SPAWN_LOG;
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  const line = JSON.stringify(process.argv) + "\\n";
  if (existsSync(out)) appendFileSync(out, line);
  else writeFileSync(out, line);
}
const mode = process.env.T95_STUB_MODE ?? "pass";
if (mode === "slow") {
  Bun.sleepSync(5000);
  process.stdout.write('{"pass":true}\\n');
  process.exit(0);
} else if (mode === "fail-exit-1") {
  process.stderr.write("dispatcher invocation error: fixture\\n");
  process.exit(1);
}
process.stdout.write('{"pass":true}\\n');
process.exit(0);
`;

/** make_project (t95:90-96): per-intent workspace shell + the mock dispatcher +
 *  a pinned clone-id (so a later makeProjectActive's shard path is deterministic). */
function makeProject(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  mkdirSync(join(proj, ".claude", "tools"), { recursive: true });
  mkdirSync(join(proj, ".claude", "hooks"), { recursive: true });
  writeFileSync(
    join(proj, ".claude", "tools", "aidlc-sensor.ts"),
    MOCK_DISPATCHER,
    "utf-8",
  );
  writeFileSync(join(proj, "aidlc", ".aidlc-clone-id"), `${PINNED_CLONE_ID}\n`, "utf-8");
  return proj;
}

/** make_project_active (t95:100-110): project + state.md into the record (active
 *  stage, so the cursor resolves) + the resolved audit SHARD (the :100 gate). */
function makeProjectActive(slug = "requirements-analysis"): string {
  const proj = makeProject();
  mkdirSync(seededRecordDir(proj), { recursive: true });
  writeFileSync(
    seededStateFile(proj),
    `- **Workflow**: bugfix\n- **Current Stage**: ${slug}\n`,
    "utf-8",
  );
  const auditDir = seededAuditDir(proj);
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(join(auditDir, pinnedShardName()), "audit fixture\n", "utf-8");
  return proj;
}

interface SynthSensor {
  id: string;
  path: string;
  matches: string;
}

/** synth_graph (t95:132-159): a one-stage graph carrying sensors_applicable[]. */
function synthGraph(proj: string, slug: string, applicable: SynthSensor[]): string {
  const node = {
    slug,
    number: "1.0",
    name: "Synthetic Stage",
    phase: "construction",
    execution: "ALWAYS",
    lead_agent: "aidlc-developer-agent",
    support_agents: [],
    mode: "inline",
    produces: [],
    consumes: [],
    requires_stage: [],
    inputs: "",
    outputs: "",
    rules_in_context: [],
    sensors_applicable: applicable,
  };
  const out = join(proj, "synth-graph.json");
  writeFileSync(out, JSON.stringify([node]), "utf-8");
  return out;
}

interface HookRun {
  status: number;
  out: string;
}

/**
 * run_hook_with (t95:112-128): pipe PostToolUse Write JSON on stdin with
 * CLAUDE_PROJECT_DIR, AIDLC_STAGE_GRAPH, T95_SPAWN_LOG, T95_STUB_MODE and the
 * optional AIDLC_SENSOR_TIMEOUT_MS seam set, against the real hook.
 */
function runHook(
  proj: string,
  filePath: string,
  opts: {
    graph?: string;
    mode?: string;
    timeoutMs?: string;
  } = {},
): HookRun {
  const json = JSON.stringify({
    tool_name: "Write",
    tool_input: { file_path: filePath },
  });
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PROJECT_DIR: proj,
    AIDLC_STAGE_GRAPH: opts.graph ?? FRAMEWORK_GRAPH,
    T95_SPAWN_LOG: join(proj, ".spawn.log"),
    T95_STUB_MODE: opts.mode ?? "pass",
  };
  if (opts.timeoutMs !== undefined) env.AIDLC_SENSOR_TIMEOUT_MS = opts.timeoutMs;
  const res = spawnSync(BUN, [HOOK], {
    input: json,
    encoding: "utf-8",
    env,
    timeout: 30_000,
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

const spawnLog = (proj: string): string => join(proj, ".spawn.log");

/** The dispatcher's recorded argv lines, each a JSON-encoded process.argv array. */
function spawnArgvs(proj: string): string[][] {
  const f = spawnLog(proj);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as string[]);
}

function dropsPath(proj: string): string {
  return join(seededRecordDir(proj), ".aidlc-hooks-health", "sensor-fire.drops");
}

describe("t95 sensor-fire hook — single & multi-entry fire (mechanism cli — spawnSync)", () => {
  test("C1a: Inception markdown write fires the 2 markdown sensors [.sh test 1]", () => {
    const proj = makeProjectActive("requirements-analysis");
    const r = runHook(
      proj,
      join(proj, "aidlc-docs", "inception", "requirements-analysis", "intent.md"),
    );
    expect(r.status).toBe(0);
    // requirements-analysis ships required-sections + upstream-coverage, both
    // with matches: **/{aidlc-docs,intents}/** — two should fire.
    expect(spawnArgvs(proj).length).toBe(2);
  }, 30000);

  test("C1a-intents: a write under the per-intent record dir fires the 2 markdown sensors (the {aidlc-docs,intents} glob's intents arm) [P9 layout]", () => {
    // GUARDS the sensor-glob fix: the framework glob is **/{aidlc-docs,intents}/**.
    // C1a drives the legacy aidlc-docs/ arm; on the per-intent layout the real
    // write path is under aidlc/spaces/<space>/intents/<record>/, which matches
    // ONLY via the new `intents` arm. Without this case a regression of that arm
    // (e.g. reverting to **/aidlc-docs/**) leaves C1a green while the sensors go
    // silent on every real workflow — the exact dead-glob bug P9 fixed.
    const proj = makeProjectActive("requirements-analysis");
    const r = runHook(
      proj,
      join(seededRecordDir(proj), "inception", "requirements-analysis", "intent.md"),
    );
    expect(r.status).toBe(0);
    expect(spawnArgvs(proj).length).toBe(2);
  }, 30000);

  test("C1b: spawned argv carries the fire subcommand [.sh test 2]", () => {
    const proj = makeProjectActive("requirements-analysis");
    runHook(
      proj,
      join(proj, "aidlc-docs", "inception", "requirements-analysis", "intent.md"),
    );
    const argv = spawnArgvs(proj)[0];
    // STRONGER than the .sh's substring grep: "fire" is the argv element right
    // after [bun, <sensor.ts>].
    expect(argv[2]).toBe("fire");
  }, 30000);

  test("C1c: spawned argv carries --stage requirements-analysis [.sh test 3]", () => {
    const proj = makeProjectActive("requirements-analysis");
    runHook(
      proj,
      join(proj, "aidlc-docs", "inception", "requirements-analysis", "intent.md"),
    );
    const argv = spawnArgvs(proj)[0];
    // STRONGER: the flag and its value are adjacent (ordered pair), not merely
    // both present somewhere.
    const i = argv.indexOf("--stage");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("requirements-analysis");
  }, 30000);

  test("C1d: spawned argv carries the --output-path flag with the written path [.sh test 4]", () => {
    const proj = makeProjectActive("requirements-analysis");
    const fp = join(
      proj,
      "aidlc-docs",
      "inception",
      "requirements-analysis",
      "intent.md",
    );
    runHook(proj, fp);
    const argv = spawnArgvs(proj)[0];
    const i = argv.indexOf("--output-path");
    expect(i).toBeGreaterThan(-1);
    // STRONGER: the .sh only checked the flag is present; assert the value is
    // the exact file_path the hook was driven with.
    expect(argv[i + 1]).toBe(fp);
  }, 30000);

  test("C2a: stage with 2 matching sensors_applicable -> 2 spawns [.sh test 5]", () => {
    const proj = makeProjectActive("synthetic-multi");
    const graph = synthGraph(proj, "synthetic-multi", [
      { id: "sensor-a", path: ".claude/sensors/aidlc-a.md", matches: "**/aidlc-docs/**" },
      { id: "sensor-b", path: ".claude/sensors/aidlc-b.md", matches: "**/aidlc-docs/**" },
    ]);
    runHook(proj, join(proj, "aidlc-docs", "foo.md"), { graph });
    expect(spawnArgvs(proj).length).toBe(2);
  }, 30000);

  test("C2b: spawns preserve sensors_applicable order (sensor-a before sensor-b) [.sh test 6]", () => {
    const proj = makeProjectActive("synthetic-multi");
    const graph = synthGraph(proj, "synthetic-multi", [
      { id: "sensor-a", path: ".claude/sensors/aidlc-a.md", matches: "**/aidlc-docs/**" },
      { id: "sensor-b", path: ".claude/sensors/aidlc-b.md", matches: "**/aidlc-docs/**" },
    ]);
    runHook(proj, join(proj, "aidlc-docs", "foo.md"), { graph });
    const argvs = spawnArgvs(proj);
    // argv[3] is the sensor id (after bun, sensor.ts, "fire").
    expect(argvs[0][3]).toBe("sensor-a");
    expect(argvs[1][3]).toBe("sensor-b");
  }, 30000);
});

describe("t95 sensor-fire hook — multi-glob filtering at the stage level (mechanism cli — spawnSync)", () => {
  const CODE_STAGE: SynthSensor[] = [
    { id: "linter", path: ".claude/sensors/aidlc-linter.md", matches: "**/*.{ts,js}" },
    { id: "type-check", path: ".claude/sensors/aidlc-type-check.md", matches: "**/*.{ts,tsx}" },
    { id: "required-sections", path: ".claude/sensors/aidlc-required-sections.md", matches: "**/aidlc-docs/**" },
    { id: "upstream-coverage", path: ".claude/sensors/aidlc-upstream-coverage.md", matches: "**/aidlc-docs/**" },
  ];

  test("C3a: TS write at a code stage -> only linter + type-check fire (markdown filtered) [.sh test 7]", () => {
    const proj = makeProjectActive("code-generation-syn");
    const graph = synthGraph(proj, "code-generation-syn", CODE_STAGE);
    runHook(proj, join(proj, "src", "foo.ts"), { graph });
    expect(spawnArgvs(proj).length).toBe(2);
  }, 30000);

  test("C3b: TS write fires linter + type-check, skips required-sections (multi-glob filter) [.sh test 8]", () => {
    const proj = makeProjectActive("code-generation-syn");
    const graph = synthGraph(proj, "code-generation-syn", CODE_STAGE);
    runHook(proj, join(proj, "src", "foo.ts"), { graph });
    const ids = spawnArgvs(proj).map((a) => a[3]);
    expect(ids).toContain("linter");
    expect(ids).toContain("type-check");
    expect(ids).not.toContain("required-sections");
    expect(ids).not.toContain("upstream-coverage");
  }, 30000);

  test("C3c: markdown write at the same stage -> only the 2 markdown sensors fire (code filtered) [.sh test 9]", () => {
    const proj = makeProjectActive("code-generation-syn");
    const graph = synthGraph(proj, "code-generation-syn", CODE_STAGE);
    runHook(proj, join(proj, "aidlc-docs", "foo.md"), { graph });
    const ids = spawnArgvs(proj).map((a) => a[3]);
    expect(spawnArgvs(proj).length).toBe(2);
    // STRONGER than the .sh count-only check: assert WHICH two fired.
    expect(ids).toContain("required-sections");
    expect(ids).toContain("upstream-coverage");
    expect(ids).not.toContain("linter");
    expect(ids).not.toContain("type-check");
  }, 30000);

  test("C4a: mixed-glob stage on a .md write -> only the md sensor fires [.sh test 10]", () => {
    const proj = makeProjectActive("glob-mixed");
    const graph = synthGraph(proj, "glob-mixed", [
      { id: "sensor-md-only", path: ".claude/sensors/aidlc-md.md", matches: "**/aidlc-docs/**" },
      { id: "sensor-ts-only", path: ".claude/sensors/aidlc-ts.md", matches: "**/*.{ts}" },
    ]);
    runHook(proj, join(proj, "aidlc-docs", "x.md"), { graph });
    expect(spawnArgvs(proj).length).toBe(1);
  }, 30000);

  test("C4b: the single spawned id is sensor-md-only (not sensor-ts-only) [.sh test 11]", () => {
    const proj = makeProjectActive("glob-mixed");
    const graph = synthGraph(proj, "glob-mixed", [
      { id: "sensor-md-only", path: ".claude/sensors/aidlc-md.md", matches: "**/aidlc-docs/**" },
      { id: "sensor-ts-only", path: ".claude/sensors/aidlc-ts.md", matches: "**/*.{ts}" },
    ]);
    runHook(proj, join(proj, "aidlc-docs", "x.md"), { graph });
    expect(spawnArgvs(proj)[0][3]).toBe("sensor-md-only");
  }, 30000);
});

describe("t95 sensor-fire hook — error recovery is advisory (always exit 0) (mechanism cli — spawnSync)", () => {
  test("C5a: hook exits 0 even when the subprocess times out (G5 advisory) [.sh test 12]", () => {
    const proj = makeProjectActive("requirements-analysis");
    // AIDLC_SENSOR_TIMEOUT_MS=2000 overrides the 90s default; the stub sleeps
    // 5000ms (T95_STUB_MODE=slow) so the spawn is SIGTERM'd.
    const r = runHook(
      proj,
      join(proj, "aidlc-docs", "inception", "requirements-analysis", "intent.md"),
      { mode: "slow", timeoutMs: "2000" },
    );
    expect(r.status).toBe(0);
  }, 30000);

  test("C5b: timeout -> recordHookDrop with a SIGTERM/timeout reason [.sh test 13]", () => {
    const proj = makeProjectActive("requirements-analysis");
    runHook(
      proj,
      join(proj, "aidlc-docs", "inception", "requirements-analysis", "intent.md"),
      { mode: "slow", timeoutMs: "2000" },
    );
    // The failure event must ACTUALLY FIRE (§6-E): the drops file exists and
    // names the SIGTERM-timeout drop the hook records at :238-243.
    expect(existsSync(dropsPath(proj))).toBe(true);
    const drops = readFileSync(dropsPath(proj), "utf-8");
    expect(drops).toContain("subprocess killed by SIGTERM");
  }, 30000);

  test("C6a: hook exits 0 even when the subprocess exits non-zero (G5 advisory) [.sh test 14]", () => {
    const proj = makeProjectActive("requirements-analysis");
    const r = runHook(
      proj,
      join(proj, "aidlc-docs", "inception", "requirements-analysis", "intent.md"),
      { mode: "fail-exit-1" },
    );
    expect(r.status).toBe(0);
  }, 30000);

  test("C6b: subprocess exit 1 -> recordHookDrop with a 'dispatcher exit 1' reason [.sh test 15]", () => {
    const proj = makeProjectActive("requirements-analysis");
    runHook(
      proj,
      join(proj, "aidlc-docs", "inception", "requirements-analysis", "intent.md"),
      { mode: "fail-exit-1" },
    );
    // The failure event must ACTUALLY FIRE (§6-E): the drop names the non-zero
    // exit the hook records at :250-256.
    expect(existsSync(dropsPath(proj))).toBe(true);
    const drops = readFileSync(dropsPath(proj), "utf-8");
    expect(drops).toContain("dispatcher exit 1");
  }, 30000);

  test("C7: hook stdout never carries a {decision: block} payload (advisory contract) [.sh test 16]", () => {
    const proj = makeProjectActive("requirements-analysis");
    // The .sh captured stdout only (2>/dev/null). spawnSync separates streams;
    // assert the hook never emits a decision JSON on stdout.
    const json = JSON.stringify({
      tool_name: "Write",
      tool_input: {
        file_path: join(
          proj,
          "aidlc-docs",
          "inception",
          "requirements-analysis",
          "intent.md",
        ),
      },
    });
    const res = spawnSync(BUN, [HOOK], {
      input: json,
      encoding: "utf-8",
      env: {
        ...(process.env as Record<string, string>),
        CLAUDE_PROJECT_DIR: proj,
        AIDLC_STAGE_GRAPH: FRAMEWORK_GRAPH,
        T95_SPAWN_LOG: join(proj, ".spawn.log"),
        T95_STUB_MODE: "pass",
      },
      timeout: 30_000,
    });
    const stdout = res.stdout ?? "";
    expect(stdout.includes("decision")).toBe(false);
  }, 30000);
});

describe("t95 sensor-fire hook — heartbeat & skipped-file accounting (mechanism cli — spawnSync)", () => {
  test("C8: heartbeat mtime advances on the second invocation [.sh test 17]", () => {
    const proj = makeProjectActive("requirements-analysis");
    const fp = join(
      proj,
      "aidlc-docs",
      "inception",
      "requirements-analysis",
      "intent.md",
    );
    runHook(proj, fp);
    const hb = join(seededRecordDir(proj), ".aidlc-hooks-health", "sensor-fire.last");
    expect(existsSync(hb)).toBe(true);
    const m1 = statSync(hb).mtimeMs;
    Bun.sleepSync(1100); // isoTimestamp() has second granularity; advance > 1s.
    runHook(proj, fp);
    const m2 = statSync(hb).mtimeMs;
    expect(m2).toBeGreaterThan(m1);
  }, 30000);

  // C9a/C9b (the Test-Run-mode sensor-fire skip -> sensor-fire.skipped
  // accounting) were dropped per #369 when the test-run mechanism was removed.
});
