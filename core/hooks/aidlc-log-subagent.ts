// SubagentStop hook: Emit SUBAGENT_COMPLETED when a subagent finishes.
//
// Receives JSON on stdin with subagent info. Audits only while a workflow is
// running.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";
import {
  workflowParticipation,
  type ClaudeCodeHookInput,
  completeSubagentInflight,
  errorMessage,
  getField,
  hooksHealthDir,
  writeHookStatusFile,
  isClaudeCodeHookInput,
  isoTimestamp,
  isScopedReviewCopy,
  openReviewRequests,
  readAuditShardEvents,
  recordDir,
  recordHookDrop,
  renderReviewFileDigests,
  resolveProjectDirFromHook,
  resolveWorkflowSelection,
  REVIEW_FILE_DIGEST_FIELD,
  reviewFileDigestOnDisk,
  scopedReviewCopyName,
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
  let selection: ReturnType<typeof resolveWorkflowSelection>;
  try {
    selection = resolveWorkflowSelection(projectDir, {
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
  // A conversation that has not joined this workflow records nothing in it.
  if (selection.intent !== null && workflowParticipation(projectDir, selection) !== "participant") return 0;
  // Record the completion in the workflow whose state was just read.
  const intent = selection.intent ?? undefined;
  const space = intent ? selection.space : undefined;

  const healthDir = hooksHealthDir(projectDir, intent, space);
  writeHookStatusFile(healthDir, "log-subagent.last", isoTimestamp());

  if (completionError) {
    recordHookDrop(
      projectDir,
      "log-subagent",
      `could not update background-subagent in-flight ledger: ${completionError}`,
      intent,
      space,
    );
  }

  let agentType =
    typeof parsed.agent_type === "string" && parsed.agent_type.trim()
      ? parsed.agent_type
      : "unknown";
  const agentId: string = parsed.agent_id ?? "";
  const agentMessage: string = (parsed.last_assistant_message ?? "").slice(0, 200);
  // A reviewer copy (Kiro, aidlc-kiro-review-copy.ts) is its request's
  // reviewer under another name: the row names the reviewer, so the review's
  // evidence is found as the reviewer's, and keeps the copy's name beside it.
  // Only a copy whose request is still open is read this way.
  let dispatchAgent: string | null = null;
  let openRequests: ReturnType<typeof openReviewRequests> | null = null;
  if (isScopedReviewCopy(agentType)) {
    try {
      openRequests = openReviewRequests(readAuditShardEvents(projectDir, intent, space));
      const request = openRequests.find((open) => scopedReviewCopyName(open.requestId) === agentType);
      if (request) {
        dispatchAgent = agentType;
        agentType = request.reviewer;
      } else {
        recordHookDrop(
          projectDir,
          "log-subagent",
          `${agentType} finished with no open review request of its own; recorded under its own name`,
          intent,
          space,
        );
      }
    } catch (e) {
      recordHookDrop(projectDir, "log-subagent", `reviewer copy not resolved: ${errorMessage(e)}`, intent, space);
    }
  }

  const fields: Record<string, string> = {
    "Agent Type": agentType,
  };
  if (dispatchAgent !== null) fields["Dispatch Agent"] = dispatchAgent;
  if (agentId) fields["Agent ID"] = agentId;
  if (agentMessage) fields.Message = agentMessage;
  // What a reviewer left in the review file of every request still open for
  // it, at the moment it finished. The review is the reviewer's: the verdict
  // compares the bytes it records with this digest and marks a file that
  // changed since (aidlc-log.ts review --verdict) as edited after the reviewer.
  // Evidence only: a ledger or record that cannot be read leaves the row as
  // it was.
  try {
    const record = recordDir(projectDir, intent, space);
    if (record !== null) {
      const digests = (openRequests ?? openReviewRequests(readAuditShardEvents(projectDir, intent, space)))
        .filter((request) => request.reviewer === agentType)
        .map((request) => ({
          reviewFile: request.reviewFile,
          digest: reviewFileDigestOnDisk(join(record, ...request.reviewFile.split("/"))),
        }));
      if (digests.length > 0) fields[REVIEW_FILE_DIGEST_FIELD] = renderReviewFileDigests(digests);
    }
  } catch (e) {
    recordHookDrop(projectDir, "log-subagent", `review file digest not recorded: ${errorMessage(e)}`, intent, space);
  }

  try {
    appendAuditEntry("SUBAGENT_COMPLETED", fields, projectDir, intent, space);
  } catch (e) {
    recordHookDrop(projectDir, "log-subagent", errorMessage(e), intent, space);
    return 0;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await run(await Bun.stdin.text()));
}
