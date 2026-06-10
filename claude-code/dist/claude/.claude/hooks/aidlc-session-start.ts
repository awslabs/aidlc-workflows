// SessionStart hook: Emit session events (SESSION_STARTED / SESSION_RESUMED)
// and inject workflow context for the model on resume/compaction.
//
// Session events are hook-owned because only Claude Code knows when a
// conversation begins. Workflow events are state-tool-owned and live on a
// separate stream. See docs/reference/12-state-machine.md.
//
// Source field values (from Claude Code's SessionStart hook input):
//   startup — fresh conversation
//   resume  — /resume from a prior session
//   clear   — /clear used to start anew within an existing session
//   compact — session resuming after context compaction
//
// Mapping (SESSION_COMPACTED is emitted by validate-state.ts PreCompact,
// NOT here — firing it twice would pollute the audit trail):
//   startup → SESSION_STARTED
//   resume  → SESSION_RESUMED
//   clear   → SESSION_STARTED
//   compact → no emission (PreCompact already fired)
//
// The hook is a no-op if aidlc-state.md is absent in cwd (no active workflow).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";
import {
  errorMessage,
  getField,
  isClaudeCodeHookInput,
  isoTimestamp,
  recordHookDrop,
  resolveProjectDirFromHook,
  stateFilePath,
} from "../tools/aidlc-lib.ts";

const projectDir = resolveProjectDirFromHook(import.meta.url);
const stateFile = stateFilePath(projectDir);

// No workflow active — do nothing
if (!existsSync(stateFile)) process.exit(0);

// Write health heartbeat
const healthDir = join(projectDir, "aidlc-docs", ".aidlc-hooks-health");
mkdirSync(healthDir, { recursive: true });
writeFileSync(join(healthDir, "session-start.last"), isoTimestamp(), "utf-8");

// Read stdin. Distinguish four cases so a phantom startup event isn't
// recorded when the real source was resume/compact but stdin was malformed:
//   - stdin is a TTY: hook invoked interactively (tests, direct run) →
//     startup. SKIP stdin read to avoid blocking forever on terminal input.
//     Claude Code always pipes JSON, never runs the hook with a TTY attached.
//   - piped but empty: hook invoked outside Claude Code with `</dev/null` or
//     similar → startup.
//   - valid JSON with source: use it.
//   - non-empty stdin that fails JSON.parse: source=malformed (recorded in
//     the audit, so the operator can see something went wrong instead of
//     silently mislabelling it).
let source = "startup";
if (!process.stdin.isTTY) {
  try {
    const input = await Bun.stdin.text();
    if (input.length > 0) {
      try {
        const raw: unknown = JSON.parse(input);
        if (isClaudeCodeHookInput(raw)) {
          source = raw.source ? String(raw.source) : "unknown";
        } else {
          source = "unknown";
        }
      } catch {
        source = "malformed";
      }
    }
  } catch {
    // stdin read itself failed — treat as startup (no payload available)
  }
}

// Emit session event. appendAuditEntry creates audit.md if missing, so no
// audit-existence guard — the state-file guard above is the sole "workflow
// is active" check.
let eventType: string | null = null;
if (source === "startup" || source === "clear") eventType = "SESSION_STARTED";
else if (source === "resume") eventType = "SESSION_RESUMED";
else if (source === "malformed") eventType = "SESSION_STARTED"; // visible via Source field
// compact / unknown: no emission — compact is owned by PreCompact hook

if (eventType) {
  try {
    appendAuditEntry(eventType, { Source: source }, projectDir);
  } catch (e) {
    recordHookDrop(projectDir, "session-start", errorMessage(e));
    // Non-fatal — continue with context injection
  }
}

// Read and parse state file for context injection
const content = readFileSync(stateFile, "utf-8");

const phase = getField(content, "Lifecycle Phase") ?? "unknown";
const stage = getField(content, "Current Stage") ?? "unknown";
const status = getField(content, "Status") ?? "unknown";
const last = getField(content, "Last Completed Stage") ?? "none";
const next = getField(content, "Next Action") ?? "resume current stage";
const agent = getField(content, "Active Agent") ?? "unknown";
const scope = getField(content, "Scope") ?? "unknown";

// Check for compaction recovery breadcrumb
const recoveryFile = join(projectDir, "aidlc-docs", ".aidlc-recovery.md");
const recovery = existsSync(recoveryFile)
  ? "NOTE: A compaction recovery breadcrumb exists at .aidlc-recovery.md — check if state was preserved correctly.\n"
  : "";

const context = `AIDLC WORKFLOW ACTIVE
Scope: ${scope}
Lifecycle Phase: ${phase}
Current Stage: ${stage}
Status: ${status}
Active Agent: ${agent}
Last Completed: ${last}
Next Action: ${next}
${recovery}On resume: offer the user the standard resume options (Resume / Redo / Jump / Start Fresh). Check aidlc-docs/aidlc-state.md for full context.`;

// Output additionalContext as JSON
const output = JSON.stringify({ additionalContext: context });
process.stdout.write(`${output}\n`);
