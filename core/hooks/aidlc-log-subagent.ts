// SubagentStop hook: Emit SUBAGENT_COMPLETED when a subagent finishes.
//
// Receives JSON on stdin with subagent info. Audits only while a workflow is
// running, or with no work while a stage run on its own is open in the space's
// own record. Its pair, SUBAGENT_DISPATCHED (a helper was sent), is written by
// recordSubagentDispatch: from the dispatch hook every adapter but Cursor's and
// Kiro IDE's runs, and here for a `hook_event_name: "SubagentStart"` those two
// forward.
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
  isolatedRunWithoutWork,
  isoTimestamp,
  isScopedReviewCopy,
  openReviewRequests,
  readAuditShardEvents,
  recordDir,
  recordHookDrop,
  renderReviewFileDigests,
  resolveProjectDirFromHook,
  resolveWorkflowSelection,
  runRecordDir,
  REVIEW_FILE_DIGEST_FIELD,
  reviewCopyRequest,
  reviewFileDigestOnDisk,
  stateFilePathForSelection,
  swarmUnitOpenReviews,
  validSessionId,
} from "../tools/aidlc-lib.ts";

// The selection's record takes a helper's rows while its workflow runs, or with
// no work while a stage run on its own is open in the space's own record.
function recordsHelpers(projectDir: string, selection: ReturnType<typeof resolveWorkflowSelection>): boolean {
  let stateContent: string;
  try {
    stateContent = readFileSync(stateFilePathForSelection(projectDir, selection), "utf-8");
  } catch {
    return isolatedRunWithoutWork(projectDir, selection);
  }
  return getField(stateContent, "Status") === "Running";
}

/**
 * Record that helpers were sent (SUBAGENT_DISPATCHED) in the workflow the
 * sending chat has joined; a completion of the same agent closes it
 * (subagentDispatchesShowNoReviewer). One row per dispatch: a crew's roles are
 * one row, as sent, and a dispatch that names no agent is `unknown`. A
 * reviewer copy (Kiro) is recorded under its request's reviewer, as its
 * completion is. Evidence only: a failure is a drop, which a review verdict
 * reads as a doubt, and nothing here changes whether the helper goes.
 */
export function recordSubagentDispatch(projectDir: string, rawSessionId: unknown, agents: ReadonlyArray<string>): void {
  const sessionId =
    typeof rawSessionId === "string" && rawSessionId.length > 0 ? validSessionId(rawSessionId) : null;
  let selection: ReturnType<typeof resolveWorkflowSelection>;
  try {
    selection = resolveWorkflowSelection(projectDir, { sessionId: sessionId ?? undefined });
    if (!recordsHelpers(projectDir, selection)) return;
    if (selection.intent !== null && workflowParticipation(projectDir, selection) !== "participant") return;
  } catch {
    return;
  }
  const intent = selection.intent ?? undefined;
  const space = intent ? selection.space : undefined;
  try {
    const named = agents.map((agent) => agent.trim()).filter((agent) => agent !== "");
    const agentType = named.length === 0 ? "unknown" : named.join(",");
    const copy = named.length === 1 && isScopedReviewCopy(agentType)
      ? reviewCopyRequest(openReviewRequests(readAuditShardEvents(projectDir, intent, space)), agentType)
      : undefined;
    appendAuditEntry(
      "SUBAGENT_DISPATCHED",
      copy ? { "Agent Type": copy.reviewer, "Dispatch Agent": agentType } : { "Agent Type": agentType },
      projectDir,
      intent,
      space,
    );
  } catch (e) {
    recordHookDrop(projectDir, "log-subagent", `dispatch not recorded: ${errorMessage(e)}`, intent, space);
  }
}

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
  // A helper sent, not one finished: only its record, no completion, ledger
  // change or heartbeat (a beat is read as a completion hook that ran).
  if (parsed.hook_event_name === "SubagentStart") {
    recordSubagentDispatch(projectDir, rawSessionId, [typeof parsed.agent_type === "string" ? parsed.agent_type : ""]);
    return 0;
  }
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

  let selection: ReturnType<typeof resolveWorkflowSelection>;
  try {
    selection = resolveWorkflowSelection(projectDir, {
      sessionId: sessionId ?? undefined,
    });
  } catch {
    return 0;
  }
  if (!recordsHelpers(projectDir, selection)) return 0;
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
      const request = reviewCopyRequest(openRequests, agentType);
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
  // it, at the moment it finished: a side-by-side Unit's too, recorded in the
  // Unit's own worktree while its reviewer runs from here. The review is the
  // reviewer's: the verdict compares the bytes it records with this digest and
  // marks a file that changed since (aidlc-log.ts review --verdict) as edited
  // after the reviewer.
  // Evidence only: a ledger or record that cannot be read leaves the row as
  // it was.
  try {
    const record = intent ? recordDir(projectDir, intent, space) : runRecordDir(projectDir);
    if (record !== null) {
      const units = intent && space && agentType !== "unknown" ? swarmUnitOpenReviews(projectDir, intent, space) : [];
      const digests = [
        { record, requests: openRequests ?? openReviewRequests(readAuditShardEvents(projectDir, intent, space)) },
        ...units,
      ].flatMap((open) => open.requests
        .filter((request) => request.reviewer === agentType)
        .map((request) => ({
          reviewFile: request.reviewFile,
          digest: reviewFileDigestOnDisk(join(open.record, ...request.reviewFile.split("/"))),
        })));
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
