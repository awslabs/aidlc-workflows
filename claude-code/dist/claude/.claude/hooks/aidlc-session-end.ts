// SessionEnd hook: Emit SESSION_ENDED when a Claude Code conversation ends.
// The workflow lifecycle is independent of session lifecycle — ending a
// session does NOT complete the workflow. This event is observability only.
//
// No-op if aidlc-state.md is absent in cwd (the canonical "active workflow"
// signal — matches session-start.ts and the plan definition).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";
import {
  errorMessage,
  isClaudeCodeHookInput,
  isoTimestamp,
  recordHookDrop,
  resolveProjectDirFromHook,
  stateFilePath,
} from "../tools/aidlc-lib.ts";

const projectDir = resolveProjectDirFromHook(import.meta.url);

// No workflow active — do nothing (consistent with session-start.ts)
if (!existsSync(stateFilePath(projectDir))) process.exit(0);

// Health heartbeat
const healthDir = join(projectDir, "aidlc-docs", ".aidlc-hooks-health");
mkdirSync(healthDir, { recursive: true });
writeFileSync(join(healthDir, "session-end.last"), isoTimestamp(), "utf-8");

// Read stdin for reason field (Claude Code may pass reason=logout|clear|prompt_input_exit etc.).
// Guard on isTTY — if stdin is a terminal (test / direct-run / debug-mode pipeline
// that inherits TTY), skip the read to avoid blocking forever.
let reason = "unknown";
if (!process.stdin.isTTY) {
  try {
    const input = await Bun.stdin.text();
    if (input) {
      const raw: unknown = JSON.parse(input);
      if (isClaudeCodeHookInput(raw) && raw.reason) {
        reason = String(raw.reason);
      }
    }
  } catch {
    // Treat malformed/missing stdin as unknown
  }
}

try {
  appendAuditEntry("SESSION_ENDED", { Reason: reason }, projectDir);
} catch (e) {
  recordHookDrop(projectDir, "session-end", errorMessage(e));
  process.exit(0);
}
