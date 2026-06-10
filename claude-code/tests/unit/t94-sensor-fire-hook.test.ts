// covers: hook:aidlc-sensor-fire
//
// t94 — unit-level behavioural contract for the PostToolUse sensor-fire hook:
// every GUARD and EARLY-EXIT branch of its 12-step flow. Migrated from
// tests/unit/t94-sensor-fire-hook-unit.sh (TAP plan 18). The .sh carried NO
// `# covers:` header; its subject is the shipped hook
// dist/claude/.claude/hooks/aidlc-sensor-fire.ts, whose registry unit is
// `hook:aidlc-sensor-fire` (the same id t95 and t131 credit). t94 is the
// guard/early-exit half (no-spawn proofs + heartbeat placement); t95 is the
// dispatch/timeout/heartbeat-advance half — complementary subjects, one hook.
//
// Mechanism: cli. A hook has no in-process arg surface — it is a top-level
// script that reads PostToolUse JSON off stdin, resolves CLAUDE_PROJECT_DIR,
// and terminates with process.exit (hook :53,:63,:67,:74,:85,:90,:98,:104,
// :123,:166,:177,:180,:185,:269). Its whole contract is process-boundary
// side-effects: it spawns `bun <proj>/.claude/tools/aidlc-sensor.ts fire <id>
// --stage <slug> --output-path <path>` per matching sensor (hook :195-222),
// touches the heartbeat sensor-fire.last (hook :134-139), and appends to
// sensor-fire.skipped under Test Run Mode (hook :112-124). None of that is
// observable in-process, so every case SPAWNS the real hook via the bun runtime
// (spawnSync, input: JSON) and asserts on the exit code + the bytes/existence
// the subprocess leaves behind. spawnCount = all.
//
// "No spawn" is proven the same way the .sh proved it: a STUB aidlc-sensor.ts at
// <proj>/.claude/tools/aidlc-sensor.ts (the exact path the hook joins at :195)
// records its argv to T94_SPAWN_LOG. The hook's only spawn target is that path,
// so the ABSENCE of the log file after a hook run is positive proof the per-entry
// dispatch loop never fired. The heartbeat file (sensor-fire.last) and skipped
// file (sensor-fire.skipped) under aidlc-docs/.aidlc-hooks-health/ are checked
// directly on disk.
//
// SOURCE UNDER TEST (dist/claude/.claude/hooks/aidlc-sensor-fire.ts):
//   :53      TTY guard — process.stdin.isTTY -> exit 0.
//   :59-67   stdin parse — malformed JSON / non-hook-shaped input -> exit 0.
//   :73-74   empty tool_input.file_path -> exit 0.
//   :81-86   recursion guard — path under aidlc-docs/.aidlc-sensors/ -> exit 0.
//   :90      pre-init guard — no audit.md -> exit 0 (BEFORE heartbeat).
//   :98      state-existence guard — no aidlc-state.md -> exit 0 (BEFORE heartbeat).
//   :110-124 Test Run Mode skip (G2) — append isoTimestamp()+"\n" to
//            sensor-fire.skipped, then exit 0; NO heartbeat, NO spawn.
//   :134-139 heartbeat (G3) — writes isoTimestamp() to sensor-fire.last. Placed
//            AFTER the test-run guard but BEFORE the active-stage/graph guards,
//            so it IS written for the "valid-but-no-fire" cases (missing graph,
//            empty sensors_applicable).
//   :165-166 active-stage early-exit — missing Current Stage / "none" -> exit 0.
//   :172-180 stage-graph early-exits — loadGraph() throws (missing AIDLC_STAGE_GRAPH
//            file) -> exit 0; stage slug not in graph -> exit 0.
//   :184-185 empty sensors_applicable (workspace-scaffold) -> exit 0.
//   :196-199 G1 glob filter — `if (!entry.matches) continue` then
//            new Bun.Glob(entry.matches).match(filePath) -> a non-matching path
//            and an entry with no `matches` field both skip the spawn.
//   loadGraph() honours the AIDLC_STAGE_GRAPH env-var seam (aidlc-graph.ts:160-162)
//   — the seam the synthetic-graph / missing-graph cases inject through.
//
// FIXTURE DISCIPLINE (mirrors make_project / make_project_active, .sh:56-104): a
// fresh temp project with aidlc-docs/, .claude/tools/ + a per-test STUB
// aidlc-sensor.ts at <proj>/.claude/tools/aidlc-sensor.ts (records argv to
// T94_SPAWN_LOG). Synthetic stage-graph fixtures are written to temp files and
// injected via AIDLC_STAGE_GRAPH. All temp dirs cleaned in afterAll; nothing
// under tests/fixtures/**.
//
// Old TAP -> new test parity (1:1, 18 .sh asserts -> 18 expect()-bearing test()):
//   .sh case 1  TTY/empty-stdin guard -> exit 0               -> "TTY/empty-stdin guard exits 0"
//   .sh case 2  malformed JSON -> exit 0, no spawn            -> "malformed JSON stdin exits 0 with no spawn"
//   .sh case 3  valid payload + applicable sensors -> spawn   -> "valid payload + applicable sensors fires the dispatcher"
//   .sh case 4  recursion guard (.aidlc-sensors/) -> no spawn -> "recursion guard skips writes under .aidlc-sensors/"
//   .sh case 5  empty file_path -> no spawn                   -> "empty file_path -> no spawn"
//   .sh case 6  non-aidlc path -> no glob match -> no spawn   -> "non-aidlc path -> no glob match -> no spawn"
//   .sh case 7  no audit.md -> exit 0, no heartbeat, no spawn -> "no audit.md -> exit 0, no heartbeat, no spawn"
//   .sh case 8  no state.md (audit present) -> no heartbeat   -> "no aidlc-state.md -> exit 0, no heartbeat (guard precedes heartbeat)"
//   .sh case 9a Test Run Mode true -> skipped appended        -> "Test Run Mode true -> skipped-file appended, no heartbeat, no spawn"
//   .sh case 9b skipped line is an ISO timestamp              -> "Test Run Mode skipped-file line carries an ISO timestamp"
//   .sh case 10 Test Run Mode false -> heartbeat written      -> "Test Run Mode false -> continues; heartbeat written, no spawn (path filter)"
//   .sh case 11 heartbeat carries an ISO timestamp            -> "heartbeat file carries an ISO timestamp"
//   .sh case 12 missing Current Stage -> no spawn             -> "missing Current Stage -> no spawn"
//   .sh case 13 Current Stage: none -> no spawn               -> "Current Stage: none -> no spawn"
//   .sh case 14 missing stage-graph.json -> no spawn (HB kept)-> "missing stage-graph.json -> no spawn, heartbeat still written (G3 placement)"
//   .sh case 15 stage slug not in graph -> no spawn           -> "stage slug not in graph -> no spawn"
//   .sh case 16 empty sensors_applicable -> no spawn (HB kept)-> "empty sensors_applicable (workspace-scaffold) -> no spawn, heartbeat present"
//   .sh case 17 entry without `matches` -> no fire            -> "sensors_applicable entry without matches -> no fire (G1: matches IS the filter)"
//
// Several are STRONGER: exit code is asserted exactly (=== 0, not just "rc==0"),
// the dispatcher argv is parsed from the recorded JSON and asserted as an EXACT
// ordered slice for the spawn case, and the ISO-timestamp assertions read the
// real bytes on disk against the same YYYY-MM-DDThh:mm:ssZ shape the .sh grepped.

import { afterAll, describe, expect, test } from "bun:test";
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
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-sensor-fire.ts");
const FRAMEWORK_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");

// ISO-8601-ish prefix the .sh grepped for: YYYY-MM-DDThh:mm:ss... (isoTimestamp
// emits the trailing Z; we anchor on the date+T to match the .sh's
// `^[0-9]{4}-[0-9]{2}-[0-9]{2}T`).
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/;

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// Stub dispatcher (.sh:66-81): record argv to T94_SPAWN_LOG and exit 0. Written
// to <proj>/.claude/tools/aidlc-sensor.ts — the path the hook joins at :195 — so
// the real hook spawns OUR stub, and the log file's ABSENCE proves "no spawn".
const STUB_DISPATCHER = `// @ts-nocheck
// t94 stub dispatcher: capture argv to T94_SPAWN_LOG and exit 0.
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const out = process.env.T94_SPAWN_LOG;
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  const line = JSON.stringify(process.argv) + "\\n";
  if (existsSync(out)) appendFileSync(out, line);
  else writeFileSync(out, line);
}
process.stdout.write('{"pass":true}\\n');
process.exit(0);
`;

/** make_project (.sh:56-84): temp dir + aidlc-docs/ + the stub dispatcher. */
function makeProject(): string {
  const proj = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t94-")));
  tempDirs.push(proj);
  mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
  mkdirSync(join(proj, ".claude", "tools"), { recursive: true });
  writeFileSync(
    join(proj, ".claude", "tools", "aidlc-sensor.ts"),
    STUB_DISPATCHER,
    "utf-8",
  );
  return proj;
}

/**
 * make_project_active (.sh:90-104): project + state.md whose Current Stage is a
 * stage that carries applicable md-glob sensors in the FRAMEWORK graph
 * (requirements-analysis -> required-sections + upstream-coverage) + audit.md
 * (the active-workflow gate at hook :90).
 */
function makeProjectActive(): string {
  const proj = makeProject();
  writeFileSync(
    join(proj, "aidlc-docs", "aidlc-state.md"),
    [
      "# AI-DLC State (t94 fixture)",
      "",
      "- **Workflow**: bugfix",
      "- **Scope**: bugfix",
      "- **Phase**: inception",
      "- **Current Stage**: requirements-analysis",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(join(proj, "aidlc-docs", "audit.md"), "audit fixture\n", "utf-8");
  return proj;
}

/** Write a minimal aidlc-state.md from raw body lines (the .sh's heredocs). */
function seedState(proj: string, body: string): void {
  writeFileSync(join(proj, "aidlc-docs", "aidlc-state.md"), body, "utf-8");
}

/** Write a bare audit.md (the active-workflow gate at hook :90). */
function seedAudit(proj: string): void {
  writeFileSync(join(proj, "aidlc-docs", "audit.md"), "audit fixture\n", "utf-8");
}

function spawnLogPath(proj: string): string {
  return join(proj, ".spawn.log");
}
function heartbeatPath(proj: string): string {
  return join(proj, "aidlc-docs", ".aidlc-hooks-health", "sensor-fire.last");
}
function skippedPath(proj: string): string {
  return join(proj, "aidlc-docs", ".aidlc-hooks-health", "sensor-fire.skipped");
}

interface HookRun {
  status: number;
}

/**
 * run_hook (.sh:109-120): pipe PostToolUse Write JSON on stdin with
 * CLAUDE_PROJECT_DIR, AIDLC_STAGE_GRAPH (defaults to the framework graph), and
 * T94_SPAWN_LOG set, against the real hook. The stub dispatcher writes argv to
 * the spawn log; checks read disk afterward.
 */
function runHook(
  proj: string,
  filePath: string,
  graph: string = FRAMEWORK_GRAPH,
): HookRun {
  const json = JSON.stringify({
    tool_name: "Write",
    tool_input: { file_path: filePath },
  });
  const res = spawnSync(BUN, [HOOK], {
    input: json,
    encoding: "utf-8",
    env: {
      ...(process.env as Record<string, string>),
      CLAUDE_PROJECT_DIR: proj,
      AIDLC_STAGE_GRAPH: graph,
      T94_SPAWN_LOG: spawnLogPath(proj),
    },
  });
  return { status: res.status ?? -1 };
}

// A path under the stage's artifact tree that the aidlc-docs glob matches.
function inceptionMd(proj: string): string {
  return join(proj, "aidlc-docs", "inception", "x.md");
}

describe("t94 aidlc-sensor-fire hook — guards + early exits (migrated from t94-sensor-fire-hook-unit.sh, plan 18)", () => {
  // ===========================================================================
  // Step 2-5 — input guards.
  // ===========================================================================

  test("TTY/empty-stdin guard exits 0 [.sh case 1]", () => {
    const proj = makeProjectActive();
    // Reproduce the .sh `</dev/null`: no piped JSON. spawnSync with no `input`
    // and stdin inherited from a non-TTY test runner still has nothing to read,
    // so the hook's stdin.text() yields "" -> JSON.parse throws -> exit 0. We
    // pass empty input explicitly to match the </dev/null contract.
    const res = spawnSync(BUN, [HOOK], {
      input: "",
      encoding: "utf-8",
      env: {
        ...(process.env as Record<string, string>),
        CLAUDE_PROJECT_DIR: proj,
        AIDLC_STAGE_GRAPH: FRAMEWORK_GRAPH,
        T94_SPAWN_LOG: spawnLogPath(proj),
      },
    });
    expect(res.status).toBe(0);
    // No JSON -> no work: the dispatcher must not have fired.
    expect(existsSync(spawnLogPath(proj))).toBe(false);
  });

  test("malformed JSON stdin exits 0 with no spawn [.sh case 2]", () => {
    const proj = makeProjectActive();
    const res = spawnSync(BUN, [HOOK], {
      input: "this is not json",
      encoding: "utf-8",
      env: {
        ...(process.env as Record<string, string>),
        CLAUDE_PROJECT_DIR: proj,
        AIDLC_STAGE_GRAPH: FRAMEWORK_GRAPH,
        T94_SPAWN_LOG: spawnLogPath(proj),
      },
    });
    expect(res.status).toBe(0);
    expect(existsSync(spawnLogPath(proj))).toBe(false);
  });

  test("valid payload + applicable sensors fires the dispatcher [.sh case 3]", () => {
    const proj = makeProjectActive();
    // requirements-analysis carries two md-glob sensors (required-sections,
    // upstream-coverage) in the framework graph; an aidlc-docs/**/*.md write
    // matches **/aidlc-docs/** for both.
    const filePath = join(
      proj,
      "aidlc-docs",
      "inception",
      "requirements-analysis",
      "intent.md",
    );
    const r = runHook(proj, filePath);
    expect(r.status).toBe(0);
    expect(existsSync(spawnLogPath(proj))).toBe(true);
    // STRONGER than the .sh's mere file-existence check: parse the recorded argv
    // and assert the dispatcher was invoked with the fire-contract slice the
    // hook emits at :208-216 (process.argv = [bun, scriptPath, ...flags]).
    const lines = readFileSync(spawnLogPath(proj), "utf-8")
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBe(2); // both applicable md sensors fire
    const firstArgv = JSON.parse(lines[0]) as string[];
    expect(firstArgv.slice(2)).toEqual([
      "fire",
      "required-sections",
      "--stage",
      "requirements-analysis",
      "--output-path",
      filePath,
    ]);
  });

  test("recursion guard skips writes under .aidlc-sensors/ [.sh case 4]", () => {
    const proj = makeProjectActive();
    const filePath = join(
      proj,
      "aidlc-docs",
      ".aidlc-sensors",
      "foo",
      "bar.md",
    );
    const r = runHook(proj, filePath);
    expect(r.status).toBe(0);
    expect(existsSync(spawnLogPath(proj))).toBe(false);
  });

  test("empty file_path -> no spawn [.sh case 5]", () => {
    const proj = makeProjectActive();
    // tool_input with no file_path: the hook's `?? ""` yields "" -> exit 0 (:74).
    const json = JSON.stringify({ tool_name: "Write", tool_input: {} });
    const res = spawnSync(BUN, [HOOK], {
      input: json,
      encoding: "utf-8",
      env: {
        ...(process.env as Record<string, string>),
        CLAUDE_PROJECT_DIR: proj,
        AIDLC_STAGE_GRAPH: FRAMEWORK_GRAPH,
        T94_SPAWN_LOG: spawnLogPath(proj),
      },
    });
    expect(res.status).toBe(0);
    expect(existsSync(spawnLogPath(proj))).toBe(false);
  });

  test("non-aidlc path -> no glob match -> no spawn [.sh case 6]", () => {
    const proj = makeProjectActive();
    // A path outside aidlc-docs/ never matches **/aidlc-docs/**, so the per-entry
    // dispatch loop `continue`s on both applicable sensors (:199).
    const r = runHook(proj, join(tmpdir(), "scratch-not-aidlc", "notes.txt"));
    expect(r.status).toBe(0);
    expect(existsSync(spawnLogPath(proj))).toBe(false);
  });

  // ===========================================================================
  // Step 6-7 — pre-init guards (BEFORE the heartbeat at :134).
  // ===========================================================================

  test("no audit.md -> exit 0, no heartbeat, no spawn [.sh case 7]", () => {
    const proj = makeProject();
    // state.md present but audit.md absent -> hook :90 exits before the heartbeat.
    seedState(proj, "- **Current Stage**: requirements-analysis\n");
    const r = runHook(proj, inceptionMd(proj));
    expect(r.status).toBe(0);
    expect(existsSync(heartbeatPath(proj))).toBe(false);
    expect(existsSync(spawnLogPath(proj))).toBe(false);
  });

  test("no aidlc-state.md -> exit 0, no heartbeat (guard precedes heartbeat) [.sh case 8]", () => {
    const proj = makeProject();
    // audit.md present but state.md absent -> hook :98 exits before the heartbeat.
    seedAudit(proj);
    const r = runHook(proj, inceptionMd(proj));
    expect(r.status).toBe(0);
    expect(existsSync(heartbeatPath(proj))).toBe(false);
    expect(existsSync(spawnLogPath(proj))).toBe(false);
  });

  // ===========================================================================
  // G2 — Test Run Mode skip.
  // ===========================================================================

  test("Test Run Mode true -> skipped-file appended, no heartbeat, no spawn [.sh case 9a]", () => {
    const proj = makeProject();
    seedAudit(proj);
    seedState(
      proj,
      "- **Current Stage**: requirements-analysis\n- **Test Run Mode**: true\n",
    );
    const r = runHook(proj, inceptionMd(proj));
    expect(r.status).toBe(0);
    expect(existsSync(skippedPath(proj))).toBe(true);
    expect(existsSync(heartbeatPath(proj))).toBe(false);
    expect(existsSync(spawnLogPath(proj))).toBe(false);
  });

  test("Test Run Mode skipped-file line carries an ISO timestamp [.sh case 9b]", () => {
    const proj = makeProject();
    seedAudit(proj);
    seedState(
      proj,
      "- **Current Stage**: requirements-analysis\n- **Test Run Mode**: true\n",
    );
    runHook(proj, inceptionMd(proj));
    const firstLine = readFileSync(skippedPath(proj), "utf-8").split("\n")[0];
    expect(ISO_RE.test(firstLine)).toBe(true);
  });

  // ===========================================================================
  // Step 8 — heartbeat (G3) written for valid-but-no-fire flows.
  // ===========================================================================

  test("Test Run Mode false -> continues; heartbeat written, no spawn (path filter) [.sh case 10]", () => {
    const proj = makeProject();
    seedAudit(proj);
    seedState(
      proj,
      "- **Current Stage**: requirements-analysis\n- **Test Run Mode**: false\n",
    );
    // A non-aidlc path passes the test-run guard + writes the heartbeat, but the
    // glob never matches so no sensor fires.
    const r = runHook(proj, join(tmpdir(), "scratch-trm-false", "x.txt"));
    expect(r.status).toBe(0);
    expect(existsSync(heartbeatPath(proj))).toBe(true);
    expect(existsSync(spawnLogPath(proj))).toBe(false);
  });

  test("heartbeat file carries an ISO timestamp [.sh case 11]", () => {
    const proj = makeProjectActive();
    // Non-aidlc path: passes every guard up to + including the heartbeat write,
    // then no glob match -> no spawn. Heartbeat bytes are the assertion surface.
    runHook(proj, join(tmpdir(), "scratch-hb", "x.txt"));
    const hb = readFileSync(heartbeatPath(proj), "utf-8");
    expect(ISO_RE.test(hb)).toBe(true);
  });

  // ===========================================================================
  // Step 9 — active-stage early exits.
  // ===========================================================================

  test("missing Current Stage -> no spawn [.sh case 12]", () => {
    const proj = makeProject();
    seedAudit(proj);
    seedState(proj, "- **Workflow**: bugfix\n");
    const r = runHook(proj, inceptionMd(proj));
    expect(r.status).toBe(0);
    expect(existsSync(spawnLogPath(proj))).toBe(false);
  });

  test("Current Stage: none -> no spawn [.sh case 13]", () => {
    const proj = makeProject();
    seedAudit(proj);
    seedState(proj, "- **Current Stage**: none\n");
    const r = runHook(proj, inceptionMd(proj));
    expect(r.status).toBe(0);
    expect(existsSync(spawnLogPath(proj))).toBe(false);
  });

  // ===========================================================================
  // Step 10 — stage-graph early exits (AIDLC_STAGE_GRAPH seam).
  // ===========================================================================

  test("missing stage-graph.json -> no spawn, heartbeat still written (G3 placement) [.sh case 14]", () => {
    const proj = makeProjectActive();
    // loadGraph() throws when the AIDLC_STAGE_GRAPH file does not exist; the hook
    // catches it and exits 0 (:177). The heartbeat at :134 ran BEFORE the graph
    // read, so it is present — the placement contract.
    const r = runHook(proj, inceptionMd(proj), "/nonexistent/stage-graph.json");
    expect(r.status).toBe(0);
    expect(existsSync(spawnLogPath(proj))).toBe(false);
    expect(existsSync(heartbeatPath(proj))).toBe(true);
  });

  test("stage slug not in graph -> no spawn [.sh case 15]", () => {
    const proj = makeProject();
    seedAudit(proj);
    seedState(proj, "- **Current Stage**: nonexistent-stage-slug\n");
    const r = runHook(proj, inceptionMd(proj));
    expect(r.status).toBe(0);
    expect(existsSync(spawnLogPath(proj))).toBe(false);
  });

  test("empty sensors_applicable (workspace-scaffold) -> no spawn, heartbeat present [.sh case 16]", () => {
    const proj = makeProject();
    seedAudit(proj);
    // workspace-scaffold carries sensors_applicable: [] in the framework graph,
    // so the hook exits at :185 — but the heartbeat at :134 already wrote.
    seedState(proj, "- **Current Stage**: workspace-scaffold\n");
    const r = runHook(proj, inceptionMd(proj));
    expect(r.status).toBe(0);
    expect(existsSync(spawnLogPath(proj))).toBe(false);
    expect(existsSync(heartbeatPath(proj))).toBe(true);
  });

  // ===========================================================================
  // Step 11 — G1 glob filter: matches IS the filter.
  // ===========================================================================

  test("sensors_applicable entry without matches -> no fire (G1: matches IS the filter) [.sh case 17]", () => {
    const proj = makeProjectActive();
    // Synthetic graph: requirements-analysis with one sensor lacking `matches`.
    // hook :197 `if (!entry.matches) continue` -> the loop skips it, no spawn.
    const synGraph = join(proj, "syn-graph.json");
    writeFileSync(
      synGraph,
      JSON.stringify([
        {
          slug: "requirements-analysis",
          number: "1.1",
          name: "Requirements Analysis",
          phase: "inception",
          execution: "ALWAYS",
          lead_agent: "aidlc-product-agent",
          support_agents: [],
          mode: "inline",
          produces: [],
          consumes: [],
          requires_stage: [],
          inputs: "",
          outputs: "",
          rules_in_context: [],
          sensors_applicable: [
            {
              id: "no-matches-sensor",
              path: ".claude/sensors/aidlc-no-matches-sensor.md",
            },
          ],
        },
      ]),
      "utf-8",
    );
    const r = runHook(proj, inceptionMd(proj), synGraph);
    expect(r.status).toBe(0);
    expect(existsSync(spawnLogPath(proj))).toBe(false);
  });
});
