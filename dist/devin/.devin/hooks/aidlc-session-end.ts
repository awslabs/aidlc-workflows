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
  activeIntentUuid,
  errorMessage,
  findIntentByUuid,
  hooksHealthDir,
  isClaudeCodeHookInput,
  isoTimestamp,
  readSessionIntentUuid,
  recordHookDrop,
  resolveProjectDirFromHook,
  stateFilePath,
  validSessionId,
} from "../tools/aidlc-lib.ts";

export async function run(input: string): Promise<number> {
const projectDir = resolveProjectDirFromHook(import.meta.url);

// Read stdin for the reason and session identity. The session stamp preserves
// attribution when intent-create has already moved the shared active cursor.
// Guard on isTTY — if stdin is a terminal (test / direct-run / debug-mode pipeline
// that inherits TTY), skip the read to avoid blocking forever.
let reason = "unknown";
let sessionId = "";
if (!process.stdin.isTTY) {
  try {
    if (input) {
      const raw: unknown = JSON.parse(input);
      if (isClaudeCodeHookInput(raw)) {
        if (raw.reason) reason = String(raw.reason);
        if (typeof raw.session_id === "string") {
          sessionId = validSessionId(raw.session_id) ?? "";
        }
      }
    }
  } catch {
    // Treat malformed/missing stdin as unknown
  }
}

let intent: string | undefined;
let space: string | undefined;
if (sessionId) {
  const stampedUuid = readSessionIntentUuid(projectDir, sessionId);
  if (stampedUuid) {
    const stampedIntent = findIntentByUuid(projectDir, stampedUuid);
    if (!stampedIntent) {
      recordHookDrop(
        projectDir,
        "session-end",
        `session ${sessionId} is stamped to unknown intent ${stampedUuid}; refusing active-cursor fallback`,
      );
      return 0;
    }
    intent = stampedIntent.dirName;
    space = stampedIntent.space;
  } else if (activeIntentUuid(projectDir)) {
    // A UUID-backed workflow has exact per-session ownership. Falling back to
    // the shared cursor here can attribute a concurrent pre-workflow session's
    // end to an intent it never invoked. Missing identity therefore fails
    // closed; flat/legacy workspaces (no active UUID) retain cursor fallback.
    return 0;
  }
}

// No workflow active for the resolved session intent — do nothing (consistent
// with session-start.ts). A session without an id, or a flat legacy workflow,
// retains cursor fallback.
if (!existsSync(stateFilePath(projectDir, intent, space))) return 0;

// Health heartbeat follows the same session-owned intent as the audit event.
const healthDir = hooksHealthDir(projectDir, intent, space);
mkdirSync(healthDir, { recursive: true });
writeFileSync(join(healthDir, "session-end.last"), isoTimestamp(), "utf-8");

try {
  appendAuditEntry("SESSION_ENDED", { Reason: reason }, projectDir, intent, space);
} catch (e) {
  recordHookDrop(projectDir, "session-end", errorMessage(e));
  return 0;
}
return 0;
}

if (import.meta.main) {
  process.exit(await run(await Bun.stdin.text()));
}
