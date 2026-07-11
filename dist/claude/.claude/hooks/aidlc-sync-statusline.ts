// PostToolUse hook: Sync aidlc-state.md current stage.
//
// Two activation paths, distinguished by the payload:
//   1. Claude Code / Kiro CLI — a TaskUpdate carrying status + activeForm
//      "[slug]". Fires on transition to in_progress; the slug comes from the
//      activeForm suffix.
//   2. Kiro IDE — the IDE gives no task payload (toolArgs is empty), so the
//      adapter sends tool_input.source = "ide-audit-sync" and this hook reads
//      the latest STAGE_STARTED slug from the audit tail instead. Payload-free.
// In both cases the slug is reconciled into the state file via set-status.
// Receives JSON on stdin from the adapter / Claude Code.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ClaudeCodeHookInput,
  getField,
  hookDebug,
  hooksHealthDir,
  isClaudeCodeHookInput,
  isoTimestamp,
  latestStartedStageSlug,
  parseCheckboxes,
  readAllAuditShards,
  readStateFile,
  resolveProjectDirFromHook,
  stateFilePath,
  harnessDir,
} from "../tools/aidlc-lib.ts";

export async function run(input: string): Promise<number> {
const projectDir = resolveProjectDirFromHook(import.meta.url);
hookDebug(projectDir, "sync-statusline", "invoked");

// Read JSON from stdin. Exit cleanly if stdin is a TTY — no Claude Code JSON
// coming in this scenario (test / direct-run / debug-mode inherited stdin).
if (process.stdin.isTTY) return 0;

let parsed: ClaudeCodeHookInput;
try {
  const raw: unknown = JSON.parse(input);
  if (!isClaudeCodeHookInput(raw)) return 0;
  parsed = raw;
} catch {
  return 0;
}

// State file must exist (won't exist before handleInit runs)
const stateFile = stateFilePath(projectDir);
if (!existsSync(stateFile)) return 0;

// Resolve the target slug by activation path.
let slug = "";
const source = parsed.tool_input?.source ?? "";
if (source === "ide-audit-sync") {
  // Kiro IDE path: derive the current stage from the audit tail (payload-free).
  // This is a FORWARD-ONLY mirror: it may only nudge Current Stage toward the
  // latest STAGE_STARTED, never backward. Without the guards below, the last
  // STAGE_STARTED lingers after a stage completes (approve advances Current
  // Stage / finalize sets it to none + Status: Completed but emits no new
  // STAGE_STARTED), so a naive "audit != state → set-status" would resurrect a
  // finished stage — set-status forces Status: Running and flips the checkbox
  // back to in-progress. Guards, in order:
  const stateContent = readStateFile(projectDir);
  const status = (getField(stateContent, "Status") ?? "").trim();
  const current = (getField(stateContent, "Current Stage") ?? "").trim();
  const audit = readAllAuditShards(projectDir);
  const auditSlug = latestStartedStageSlug(audit);
  hookDebug(projectDir, "sync-statusline", "ide-audit-sync", { auditSlug, current, status });

  // (a) Only sync a live, running workflow. A completed/parked workflow (Status
  //     != Running) or a cleared pointer (Current Stage none/empty) is ahead of
  //     the audit tail by design — never rewind it.
  if (status !== "Running") return 0;
  if (current === "" || current === "none") return 0;
  // (b) No audit slug, or it already matches state → nothing to do.
  if (!auditSlug) return 0;
  if (current === auditSlug) return 0;
  // (c) Never sync BACKWARD: if the audit slug is a stage the workflow has
  //     already completed or skipped, the state is legitimately ahead of it
  //     (the stage finished; a newer STAGE_STARTED just wasn't the last row).
  //     Syncing would demote a done stage — refuse.
  const checkboxes = parseCheckboxes(stateContent);
  const auditCb = checkboxes.find((c) => c.slug === auditSlug);
  if (auditCb && (auditCb.state === "completed" || auditCb.state === "skipped")) {
    hookDebug(projectDir, "sync-statusline", "skip: audit slug already done/skipped", {
      auditSlug,
      auditState: auditCb.state,
    });
    return 0;
  }
  slug = auditSlug;
} else {
  // Claude Code / Kiro CLI path: TaskUpdate → in_progress with "[slug]" suffix.
  const status = parsed.tool_input?.status ?? "";
  if (status !== "in_progress") return 0;
  const activeForm: string = parsed.tool_input?.activeForm ?? "";
  if (!activeForm) return 0;
  const slugMatch = activeForm.match(/\[([a-z][a-z0-9-]*)\]$/);
  if (!slugMatch) return 0;
  slug = slugMatch[1];
}

// Health heartbeat
const healthDir = hooksHealthDir(projectDir);
mkdirSync(healthDir, { recursive: true });
writeFileSync(join(healthDir, "sync-statusline.last"), isoTimestamp(), "utf-8");

// Update state file via set-status (call the utility tool directly)
const toolPath = join(projectDir, harnessDir(), "tools", "aidlc-utility.ts");
hookDebug(projectDir, "sync-statusline", "set-status", { slug });
Bun.spawnSync(["bun", toolPath, "set-status", "--stage", slug, "--project-dir", projectDir], {
  stdout: "ignore",
  stderr: "ignore",
});
return 0;
}

if (import.meta.main) {
  process.exit(await run(await Bun.stdin.text()));
}
