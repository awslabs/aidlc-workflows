// PostToolUse hook: Emit ARTIFACT_CREATED / ARTIFACT_UPDATED when files under
// aidlc-docs/ are written or edited. Distinguishes CREATE vs UPDATE by checking
// whether the target file existed before the Write/Edit.
//
// Receives JSON on stdin from Claude Code. No-op if no audit.md exists (no
// active workflow in this cwd) to preserve the existing "only log when
// relevant" behaviour.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";
import {
  auditFilePath,
  type ClaudeCodeHookInput,
  errorMessage,
  isClaudeCodeHookInput,
  isoTimestamp,
  recordHookDrop,
  resolveProjectDirFromHook,
} from "../tools/aidlc-lib.ts";

const projectDir = resolveProjectDirFromHook(import.meta.url);

// Write health heartbeat
const healthDir = join(projectDir, "aidlc-docs", ".aidlc-hooks-health");
mkdirSync(healthDir, { recursive: true });
writeFileSync(join(healthDir, "audit-logger.last"), isoTimestamp(), "utf-8");

// Read JSON from stdin. If stdin is a TTY (interactive shell, test harness
// running under `bash -x`-inheriting pipeline), no JSON is coming — exit
// cleanly instead of blocking on the terminal read.
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

const tool = parsed.tool_name ?? "";
const file: string = parsed.tool_input?.file_path ?? "";

// Only log writes to aidlc-docs/ (match both POSIX and Windows separators)
if (!file.includes("aidlc-docs/") && !file.includes("aidlc-docs\\")) process.exit(0);

// Don't log writes to audit.md itself (avoid recursion)
if (file.endsWith("/audit.md") || file.endsWith("\\audit.md")) process.exit(0);

const auditFile = auditFilePath(projectDir);

// Don't auto-create audit.md — the orchestrator creates it during --init or workflow start.
if (!existsSync(auditFile)) process.exit(0);

// Extract context from file path (handle both separators)
const aidlcIdxPosix = file.indexOf("aidlc-docs/");
const aidlcIdxWin = file.indexOf("aidlc-docs\\");
const aidlcIdx = aidlcIdxPosix >= 0 ? aidlcIdxPosix : aidlcIdxWin;
const context = aidlcIdx >= 0
  ? file.slice(aidlcIdx + "aidlc-docs/".length).replace(/[/\\]/g, " > ")
  : file;

// CREATE vs UPDATE distinction:
// - Edit tool → always UPDATE (Edit requires the file to pre-exist)
// - Write tool → CREATE only if the file was brand new; otherwise UPDATE
// PostToolUse fires after the write, so `existsSync` is always true by the
// time this hook runs. We infer "was this a net-new file?" from the file's
// mtime equalling its birthtime (within a small epsilon) — true on fresh
// creation, false on overwrite. This matches the plan's intent that
// ARTIFACT_CREATED answers "when was this artifact first created?" and
// Write-overwriting-existing should emit ARTIFACT_UPDATED.
let eventType: string;
if (tool === "Edit") {
  eventType = "ARTIFACT_UPDATED";
} else {
  // Write or any other create-capable tool: check if file was net-new.
  let isNew = false;
  try {
    const { statSync } = await import("node:fs");
    const st = statSync(file);
    // birthtimeMs is monotonic with mtimeMs on fresh creation. If a file was
    // overwritten, mtime advances past birthtime. Accept 10ms slack for
    // filesystem timestamp granularity.
    isNew = Math.abs(st.mtimeMs - st.birthtimeMs) < 10;
  } catch {
    // stat failure → default to CREATED (safer than UPDATED for net-new files)
    isNew = true;
  }
  eventType = isNew ? "ARTIFACT_CREATED" : "ARTIFACT_UPDATED";
}

try {
  appendAuditEntry(eventType, {
    Tool: tool,
    File: file,
    Context: context,
  }, projectDir);
} catch (e) {
  // Hook must be a no-op on any audit emission failure to avoid breaking the
  // user's tool call. Record the drop so `--doctor` can surface it, then
  // exit cleanly.
  recordHookDrop(projectDir, "audit-logger", errorMessage(e));
  process.exit(0);
}
