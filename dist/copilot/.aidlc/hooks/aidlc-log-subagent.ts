// SubagentStop hook: Emit SUBAGENT_COMPLETED when a subagent finishes.
// Replaces the previous free-form `## Subagent Completed` markdown write with
// a canonical audit event.
//
// Receives JSON on stdin with subagent info. No-op unless a workflow is running.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";
import {
  type ClaudeCodeHookInput,
  completeSubagentInflight,
  errorMessage,
  getField,
  hooksHealthDir,
  isClaudeCodeHookInput,
  isoTimestamp,
  recordHookDrop,
  resolveProjectDirFromHook,
  resolveWorkflowSelection,
  stateFilePathForSelection,
  validSessionId,
} from "../tools/aidlc-lib.ts";

export async function run(input: string): Promise<number> {
  const projectDir = resolveProjectDirFromHook(import.meta.url);

  // Read JSON before workflow resolution: completion must remove only the
  // finishing session's in-flight entry, even when that session no longer has a
  // running workflow to audit.
  if (process.stdin.isTTY) return 0;

  let parsed: ClaudeCodeHookInput;
  try {
    const raw: unknown = JSON.parse(input);
    if (!isClaudeCodeHookInput(raw)) return 0;
    parsed = raw;
  } catch {
    return 0;
  }

  const rawSessionId = parsed.session_id;
  const sessionId =
    typeof rawSessionId === "string" && rawSessionId.length > 0
      ? validSessionId(rawSessionId)
      : null;

  let completionError = "";
  try {
    completeSubagentInflight(projectDir, rawSessionId);
  } catch (error) {
    completionError = errorMessage(error);
  }

  let stateContent: string;
  try {
    const selection = resolveWorkflowSelection(projectDir, {
      sessionId: sessionId ?? undefined,
    });
    stateContent = readFileSync(
      stateFilePathForSelection(projectDir, selection),
      "utf-8",
    );
  } catch {
    return 0;
  }
  if (getField(stateContent, "Status") !== "Running") return 0;

  // Write health heartbeat
  const healthDir = hooksHealthDir(projectDir);
  mkdirSync(healthDir, { recursive: true });
  writeFileSync(join(healthDir, "log-subagent.last"), isoTimestamp(), "utf-8");

  if (completionError) {
    recordHookDrop(
      projectDir,
      "log-subagent",
      `could not update background-subagent in-flight ledger: ${completionError}`,
    );
  }

  const agentType = parsed.agent_type ?? "unknown";
  const agentId: string = parsed.agent_id ?? "";
  const agentMessage: string = (parsed.last_assistant_message ?? "").slice(0, 200);

  const fields: Record<string, string> = {
    "Agent Type": agentType,
  };
  if (agentId) fields["Agent ID"] = agentId;
  if (agentMessage) fields.Message = agentMessage;

  try {
    appendAuditEntry("SUBAGENT_COMPLETED", fields, projectDir);
  } catch (e) {
    recordHookDrop(projectDir, "log-subagent", errorMessage(e));
    return 0;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await run(await Bun.stdin.text()));
}
