// PostToolUse hook: Sync aidlc-state.md on stage task activation
// Triggered on TaskUpdate — extracts slug from activeForm "[slug]" suffix
// Receives JSON on stdin from Claude Code
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ClaudeCodeHookInput,
  hooksHealthDir,
  isClaudeCodeHookInput,
  isoTimestamp,
  resolveProjectDirFromHook,
  stateFilePath,
  harnessDir,
} from "../tools/aidlc-lib.ts";

const projectDir = resolveProjectDirFromHook(import.meta.url);

// Read JSON from stdin. Exit cleanly if stdin is a TTY — no Claude Code JSON
// coming in this scenario (test / direct-run / debug-mode inherited stdin).
if (process.stdin.isTTY) process.exit(0);

const input = await Bun.stdin.text();
let parsed: ClaudeCodeHookInput;
try {
  const raw: unknown = JSON.parse(input);
  if (!isClaudeCodeHookInput(raw)) process.exit(0);
  parsed = raw;
} catch {
  process.exit(0);
}

const status = parsed.tool_input?.status ?? "";

// Only fire when a task transitions to in_progress
if (status !== "in_progress") process.exit(0);

const activeForm: string = parsed.tool_input?.activeForm ?? "";
if (!activeForm) process.exit(0);

// Extract slug from "[slug]" suffix in activeForm
const slugMatch = activeForm.match(/\[([a-z][a-z0-9-]*)\]$/);
if (!slugMatch) process.exit(0);
const slug = slugMatch[1];

// State file must exist (won't exist before handleInit runs)
const stateFile = stateFilePath(projectDir);
if (!existsSync(stateFile)) process.exit(0);

// Health heartbeat
const healthDir = hooksHealthDir(projectDir);
mkdirSync(healthDir, { recursive: true });
writeFileSync(join(healthDir, "sync-statusline.last"), isoTimestamp(), "utf-8");

// Update state file via set-status (call the utility tool directly)
const toolPath = join(projectDir, harnessDir(), "tools", "aidlc-utility.ts");
Bun.spawnSync(["bun", toolPath, "set-status", "--stage", slug, "--project-dir", projectDir], {
  stdout: "ignore",
  stderr: "ignore",
});
