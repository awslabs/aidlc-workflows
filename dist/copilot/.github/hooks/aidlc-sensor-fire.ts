// PostToolUse hook (Write|Edit matcher): the headline data-plane
// integration for the sensor system. Reads pre-resolved
// `sensors_applicable` for the active stage off `stage-graph.json` and
// spawns `aidlc-sensor.ts fire <id> --stage <slug> --output-path <path>`
// per matching entry.
//
// Per the v3 explainer §5: "the dispatcher does no resolution walks at
// runtime. Stage entry reads `sensors_applicable` off the node — already
// looked up, already attached."
//
// Coexists with `aidlc-audit-logger.ts` under the same Write|Edit
// matcher; recursion guard skips writes to the active record's
// `.aidlc-sensors/` directory.
//
// Exit-code contract (G5): always exit 0. Sensor verdicts surface
// through the dispatcher's audit rows (SENSOR_FIRED + paired
// SENSOR_PASSED|FAILED|BUDGET_OVERRIDE) and detail files. Blocking
// semantics defer to the future ralph driver.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GraphStage, loadGraph } from "../tools/aidlc-graph.ts";
import {
  auditFilePath,
  type ClaudeCodeHookInput,
  getField,
  hooksHealthDir,
  isClaudeCodeHookInput,
  isoTimestamp,
  readStateFile,
  recordHookDrop,
  resolveProjectDirFromHook,
  sensorsDir,
  stateFilePath,
  harnessDir,
} from "../tools/aidlc-lib.ts";

export async function run(input: string): Promise<number> {
// Step 1 — Resolve project dir from import.meta.url. Mirrors
// aidlc-audit-logger.ts and aidlc-runtime-compile.ts precedent.
const projectDir = resolveProjectDirFromHook(import.meta.url);

// Subprocess timeout. Defaults to 90s (covers tsc's 60s manifest cap +
// dispatcher overhead). t95's timeout case overrides via env var to
// avoid patching the production source tree. `Number(undefined) || N`
// pattern handles unset / empty / unparseable equally.
const SUBPROCESS_TIMEOUT_MS =
  Number(process.env.AIDLC_SENSOR_TIMEOUT_MS) || 90_000;

// Health-dir for the heartbeat (sensor-fire.last). Read by the future
// hook-health doctor.
const healthDir = hooksHealthDir(projectDir);

// Step 2 — TTY guard. Hook invoked outside a piped-stdin context (e.g.
// interactive shell, test harness running under `bash -x`) has no JSON
// to parse; exit cleanly instead of blocking on a terminal read.
if (process.stdin.isTTY) return 0;

// Step 3 — Stdin parse. Malformed JSON exits 0 silently.
// We use the central ClaudeCodeHookInput type guard from aidlc-lib.ts;
// the SKILL.md frontmatter pins this hook to the Write|Edit matcher,
// so we don't consult tool_name and only need tool_input.file_path.
let parsed: ClaudeCodeHookInput;
try {
  const raw: unknown = JSON.parse(input);
  if (!isClaudeCodeHookInput(raw)) return 0;
  parsed = raw;
} catch {
  return 0;
}

// Step 4 — Extract path. PostToolUse for Write/Edit always carries
// `tool_input.file_path` as an absolute path (verified by inspection
// of aidlc-audit-logger.ts:42 — the includes-filter works precisely
// because Claude Code passes absolute paths).
const filePath: string = parsed?.tool_input?.file_path ?? "";
if (!filePath) return 0;

// Step 5 — Recursion guard. Skip writes to the dispatcher's detail-file
// directory. Post-workspace-move that dir re-roots per intent
// (<record>/.aidlc-sensors/ via sensorsDir(projectDir, intent, space)); the
// active-intent resolution is implicit in sensorsDir's bare projectDir call
// (it resolves the active record root). Keep the flat `aidlc-docs/.aidlc-sensors/`
// literal as the transitional flat-legacy fallback (retired in P9). Dispatcher
// uses direct fs I/O so the loop isn't reachable today; defensive depth for
// future LLM sensors that may emit findings via Write.
const sensorsLeaf = sensorsDir(projectDir).replace(/\\/g, "/").replace(/\/$/, "");
const filePathNorm = filePath.replace(/\\/g, "/");
if (
  filePathNorm === sensorsLeaf ||
  filePathNorm.startsWith(`${sensorsLeaf}/`) ||
  filePath.includes("aidlc-docs/.aidlc-sensors/") ||
  filePath.includes("aidlc-docs\\.aidlc-sensors\\")
) {
  return 0;
}

// Step 6 — Pre-init guard. No audit.md → no active workflow → no-op.
// Mirrors aidlc-audit-logger.ts:48-50 + aidlc-runtime-compile.ts:62-64.
if (!existsSync(auditFilePath(projectDir))) return 0;

// Step 7 — State-file guard.
//
// readStateFile throws on missing aidlc-state.md (lib.ts:169-175).
// Pre-init or partially-deleted workspaces could have audit.md without
// state.md (audit.md is write-direct; state.md is overwrite-rename).
// G5 ("always exit 0") demands a guard before the read.
if (!existsSync(stateFilePath(projectDir))) return 0;

let stateContent: string;
try {
  stateContent = readStateFile(projectDir);
} catch {
  return 0;
}

// Step 8 — Heartbeat (G3). The future hook-health doctor reads this
// file's mtime to detect silent-hook failure. Placement: AFTER
// input/recursion/audit/state guards but BEFORE the
// active-stage and graph-read guards. Doctor must distinguish two
// valid no-SENSOR_FIRED states: (a) healthy hook firing on a stage
// with empty sensors_applicable like workspace-scaffold, (b) no
// matches glob hit since last fire. See plan § Cross-milestone for the
// canonical heuristic.
mkdirSync(healthDir, { recursive: true });
writeFileSync(
  join(healthDir, "sensor-fire.last"),
  isoTimestamp(),
  "utf-8"
);

// Step 8b — First-fire banner. On the first invocation against a
// workspace (no .first-fired marker yet), print a one-line stderr
// pointer to the AI-DLC documentation, then touch the marker so
// it never repeats. Stderr only — never stdout — so it stays advisory
// and can't be mistaken for hook output. Marker write failure is
// non-fatal: at worst the banner repeats, which is harmless. The
// always-exit-0 contract (G5) is untouched.
const firstFiredMarker = join(healthDir, ".first-fired");
if (!existsSync(firstFiredMarker)) {
  process.stderr.write(
    "[aidlc] Sensors are now watching this workspace. " +
      "See the AI-DLC documentation to learn how rules and " +
      "the learning loop work.\n"
  );
  try {
    writeFileSync(firstFiredMarker, isoTimestamp(), "utf-8");
  } catch {
    // Marker write failure is non-fatal — banner may repeat next fire.
  }
}

// Step 9 — Active stage lookup (C3). The compile-resolved
// `sensors_applicable` list is keyed on the stage slug; we read it
// from state. Missing or "none" → no active stage → no-op.
const currentStage = getField(stateContent, "Current Stage") ?? "";
if (!currentStage || currentStage === "none") return 0;

// Step 10 — Stage-graph read (C4). loadGraph() returns GraphStage[]
// which carries `sensors_applicable: SensorResolution[]`; goes through
// the AIDLC_STAGE_GRAPH env-var seam (load t94 fixtures via that seam,
// not hand-rolled JSON.parse).
let stageNode: GraphStage | undefined;
try {
  stageNode = loadGraph().find((s) => s.slug === currentStage);
} catch {
  // pre-compile / missing graph / framework-not-installed
  return 0;
}
// Stage missing from graph (stale state-graph mismatch) — same exit.
if (!stageNode) return 0;

// No applicable sensors. Empty array is the workspace-scaffold case;
// undefined is the unlikely missing-field case (compile guarantees it).
const applicableSensors = stageNode.sensors_applicable ?? [];
if (applicableSensors.length === 0) return 0;

// Step 11 — Per-entry dispatch (C5).
//
// G1 lock-in: matches IS the filter. Entries without a matches glob
// do not fire. The framework artifact glob is `**/{aidlc-docs,intents}/**`
// (P9 — the per-intent record tree carries an `/intents/` segment; the legacy
// `aidlc-docs/` arm stays so a pre-migration artifact still matches). The
// relaxed `**/<seg>/**` form (vs `**/<seg>/**/*.md`) is load-bearing: the
// upstream dispatcher's bespoke globToRegex rejects the *.md form even though
// Bun.Glob accepts both — both engines agree on the relaxed form.
const sensorTs = join(projectDir, harnessDir(), "tools", "aidlc-sensor.ts");
for (const entry of applicableSensors) {
  if (!entry.matches) continue;
  const glob = new Bun.Glob(entry.matches);
  if (!glob.match(filePath)) continue;

  // Spawn dispatcher (C1). Bare-script form (`bun <script> ...`)
  // matches the upstream dispatcher manifest's `command:` convention.
  // Sync subprocess; user pays wall-clock per Write inside an active
  // stage with applicable sensors.
  //
  // TPL note: this hook invokes the DISPATCHER (aidlc-sensor.ts fire), not the
  // per-sensor script directly. The dispatcher re-resolves the stageNode by
  // --stage and owns the template seam — it derives --templates-dir +
  // --template-eligible (via templateEligibleArtifacts) and threads them to the
  // required-sections script. So both invocation sites (this hook and a direct
  // `aidlc-sensor fire`) converge on the dispatcher's single threading point and
  // stay consistent; the hook passes only --stage/--output-path as before.
  try {
    const result = spawnSync(
      "bun",
      [
        sensorTs,
        "fire",
        entry.id,
        "--stage",
        currentStage,
        "--output-path",
        filePath,
      ],
      {
        cwd: projectDir,
        timeout: SUBPROCESS_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    // Sensor outcomes stay inside the dispatcher (paired audit rows by
    // Fire id; dispatcher exits 0). Hook-level failures get recorded
    // for `--doctor` to surface (mirrors aidlc-runtime-compile.ts:115-121):
    //   - timeout: spawnSync sets BOTH `result.error.code === "ETIMEDOUT"`
    //     and `result.signal === "SIGTERM"` on timeout. We OR-check
    //     defensively (either alone is sufficient evidence) and check
    //     timeout FIRST so it isn't misclassified as a generic spawn
    //     failure.
    //   - true spawn failure (bun off PATH, ENOENT, EACCES):
    //     result.error set without timeout signal.
    //   - dispatcher invocation error (unknown id, missing flags,
    //     matches-rejection): result.status !== 0, no error.
    const isTimeout =
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
      result.signal === "SIGTERM";
    if (isTimeout) {
      recordHookDrop(
        projectDir,
        "sensor-fire",
        `${entry.id}: subprocess killed by SIGTERM (timeout)`
      );
    } else if (result.error) {
      recordHookDrop(
        projectDir,
        "sensor-fire",
        `${entry.id}: ${result.error.message}`
      );
    } else if (result.status !== 0) {
      const stderr = result.stderr?.toString().trim() ?? "";
      recordHookDrop(
        projectDir,
        "sensor-fire",
        `${entry.id}: dispatcher exit ${result.status}${stderr ? `: ${stderr}` : ""}`
      );
    }
  } catch (e: unknown) {
    // Thrown error from spawnSync itself — not from the child process.
    recordHookDrop(
      projectDir,
      "sensor-fire",
      `${entry.id}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

// Step 12 — exit 0 (advisory always per G5).
return 0;
}

if (import.meta.main) {
  process.exit(await run(await Bun.stdin.text()));
}
