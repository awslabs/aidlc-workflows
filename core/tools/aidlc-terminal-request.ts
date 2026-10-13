import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  recordFileTargetOrThrow,
  sessionsDir,
  workflowLifecycle,
  appendIntentToRegistry, auditBlockField, markSelectedWork, readAuditShardEvents, readIntentRegistry, readSessionBinding, registerIntentRecord,
  resolveWorkflowSelection, stateFilePath, writeStateFile, writeRecordFileNoFollow,
  readRegularFileNoFollowOrThrow, projectDescriptionFilePath, writeFileAtomic,
  updateIntentScope, updateIntentStatus, selectIntentForSession,
  withWorkflowRecordLock,
  type CreatedIntent, type WorkflowRecordSelection,
  type WorkflowSelection,
} from "./aidlc-lib.ts";
import { appendAuditEntries, renderAuditFieldValue, type AuditEntryInput } from "./aidlc-audit.ts";
import type { IntentSettingsRequest } from "./aidlc-guard-switch.ts";
import { latestMessage, type StoredMessage } from "./aidlc-message-store.ts";

// Terminal hooks keep the person's message outside the historical record. Its
// receipt names the work selected when they spoke; a pre-completion message or
// a different chat's message cannot stand in for a new request on that work.
// This is request authority only, never a receipt that approves an old gate.
export type TerminalRequest = StoredMessage & { workflow: NonNullable<StoredMessage["workflow"]> };
export type TerminalRequestUse = "line" | "settings" | "scope" | "creation";
type TerminalReceipt = Pick<TerminalRequest, "session" | "id" | "at" | "workflow">;
type MutationReceipt = TerminalReceipt & { use: TerminalRequestUse };
type RequestSelection = Pick<WorkflowSelection, "space" | "intent" | "sessionId">;
const REQUEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MUTATION_MAX_BYTES = 4 * 1024 * 1024;

function usedPath(projectDir: string, message: TerminalReceipt, use: TerminalRequestUse): string {
  const key = createHash("sha256")
    .update(JSON.stringify([message.session, message.id, message.workflow.space, message.workflow.intent, use]))
    .digest("hex");
  return relative(projectDir, join(sessionsDir(projectDir), "terminal-requests", `${key}.taken`));
}

/** The current, unspent prompt for this terminal selection, or no authority. */
export function currentTerminalRequest(
  projectDir: string,
  selection: RequestSelection,
  use?: TerminalRequestUse,
): TerminalRequest | null {
  if (selection.sessionId === null) return null;
  const lifecycle = workflowLifecycle(projectDir, selection);
  if (lifecycle !== "completed" && lifecycle !== "archived") return null;
  const message = latestMessage(projectDir, selection.sessionId);
  if (message === null || message.source !== "prompt" || message.workflow === undefined) return null;
  if (message.workflow.space !== selection.space || message.workflow.intent !== selection.intent) return null;
  const age = Date.now() - Date.parse(message.at);
  if (age < 0 || age > REQUEST_MAX_AGE_MS) return null;
  const request = message as TerminalRequest;
  if (use !== undefined) {
    try {
      if (existsSync(recordFileTargetOrThrow(projectDir, usedPath(projectDir, request, use))) &&
        readMutation(projectDir, request, use)?.phase !== "pending") return null;
    } catch {
      return null;
    }
  }
  return request;
}

export interface TerminalMutationPlan {
  selection: WorkflowRecordSelection;
  before: string | null;
  beforeRevision?: string | null;
  after: string;
  audit: AuditEntryInput[];
  output: string[];
  settings: IntentSettingsRequest;
  description?: string;
  scope?: string;
  status?: "in-flight";
  creation?: { created: CreatedIntent; scope: string; repos: string[]; sessionId?: string; questionId?: string };
}
interface TerminalMutation {
  version: 1;
  phase: "pending" | "applied";
  operation: string;
  // Kept independently of the bounded message inbox so an explicit retry can
  // finish already-committed bookkeeping without reviving an old request.
  receipt?: MutationReceipt;
  plan: TerminalMutationPlan;
}

/** A canonical command identity, independent of flag ordering. */
export function terminalOperation(name: string, args: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
    value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
      : value;
  return createHash("sha256").update(JSON.stringify([name, canonical(args)])).digest("hex");
}

function validReceipt(raw: unknown): raw is MutationReceipt {
  const receipt = raw as Partial<MutationReceipt> | null;
  return receipt !== null && typeof receipt === "object" &&
    typeof receipt.session === "string" && receipt.session.length > 0 &&
    typeof receipt.id === "string" && receipt.id.length > 0 &&
    typeof receipt.at === "string" && Number.isFinite(Date.parse(receipt.at)) &&
    ["line", "settings", "scope", "creation"].includes(receipt.use ?? "") &&
    typeof receipt.workflow?.space === "string" &&
    (receipt.workflow.intent === null || typeof receipt.workflow.intent === "string") &&
    ["Completed", "Archived"].includes(receipt.workflow.status);
}

function serializeMutation(mutation: TerminalMutation): string {
  const text = `${JSON.stringify(mutation)}\n`;
  if (Buffer.byteLength(text, "utf8") > MUTATION_MAX_BYTES) {
    throw new Error("The requested change is too large to save safely. Its request has not been spent.");
  }
  return text;
}

function readMutation(projectDir: string, message: TerminalReceipt, use: TerminalRequestUse): TerminalMutation | null {
  const path = recordFileTargetOrThrow(projectDir, usedPath(projectDir, message, use));
  if (!existsSync(path)) return null;
  const text = readRegularFileNoFollowOrThrow(path, "terminal request operation", MUTATION_MAX_BYTES).toString("utf8");
  if (text === "") return null; // A legacy spent request, or the routing-only mark.
  const value = JSON.parse(text) as TerminalMutation;
  if (value.version !== 1 || !["pending", "applied"].includes(value.phase) ||
    typeof value.operation !== "string" ||
    (value.receipt !== undefined && (!validReceipt(value.receipt) ||
      value.receipt.session !== message.session || value.receipt.id !== message.id ||
      value.receipt.at !== message.at || value.receipt.use !== use ||
      value.receipt.workflow.space !== message.workflow.space ||
      value.receipt.workflow.intent !== message.workflow.intent ||
      value.receipt.workflow.status !== message.workflow.status)) || !value.plan ||
    (value.plan.before !== null && typeof value.plan.before !== "string") ||
    (value.plan.beforeRevision !== undefined && value.plan.beforeRevision !== null && typeof value.plan.beforeRevision !== "string") ||
    typeof value.plan.after !== "string" || value.plan.settings === null || typeof value.plan.settings !== "object" ||
    !Object.values(value.plan.settings).every(setting => setting !== undefined && setting !== null &&
      typeof setting.value === "string" && typeof setting.source === "string") || !Array.isArray(value.plan.audit) ||
    !value.plan.audit.every(entry => entry !== null && typeof entry === "object" &&
      typeof entry.eventType === "string" && entry.fields !== null && typeof entry.fields === "object" &&
      Object.values(entry.fields).every(field => typeof field === "string")) ||
    !Array.isArray(value.plan.output) || !value.plan.output.every(line => typeof line === "string") ||
    (value.plan.description !== undefined && typeof value.plan.description !== "string") ||
    (value.plan.scope !== undefined && typeof value.plan.scope !== "string") ||
    (value.plan.status !== undefined && value.plan.status !== "in-flight") ||
    typeof value.plan.selection?.space !== "string" ||
    !(value.plan.selection.intent === null || typeof value.plan.selection.intent === "string")) {
    throw new Error("The saved terminal request operation is unreadable.");
  }
  resolveWorkflowSelection(projectDir, {
    space: value.plan.selection.space, intent: value.plan.selection.intent ?? "",
  });
  if (value.plan.creation !== undefined) {
    const creation = value.plan.creation;
    if (creation.created?.space !== value.plan.selection.space ||
      creation.created.dirName !== value.plan.selection.intent ||
      typeof creation.created.uuid !== "string" || !/^[0-9a-f-]{36}$/i.test(creation.created.uuid) ||
      typeof creation.created.slug !== "string" ||
      typeof creation.scope !== "string" || !Array.isArray(creation.repos) ||
      !creation.repos.every(repo => typeof repo === "string") ||
      (creation.sessionId !== undefined && creation.sessionId !== message.session) ||
      (creation.questionId !== undefined && typeof creation.questionId !== "string")) {
      throw new Error("The saved creation identity is unreadable.");
    }
    // Only the validated physical selection supplies a write path.
    creation.created.recordDir = dirname(stateFilePath(projectDir, creation.created.dirName, creation.created.space));
  }
  return value;
}

function mutationFault(point: "before-audit" | "after-audit" | "after-state" | "before-finalize", creation: boolean): void {
  if (process.env.AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT === point ||
    (creation && process.env.AIDLC_TEST_INTENT_CREATE_FAIL_AT === ({
      "before-audit": "", "after-audit": "before-state", "after-state": "after-state", "before-finalize": "after-list",
    }[point]))) throw new Error(`injected terminal request failure at ${point}`);
}

function stateRevision(path: string): string | null {
  if (!existsSync(path)) return null;
  const stat = statSync(path, { bigint: true });
  // chmod repairs do not invalidate a retry. Replacing or rewriting the state
  // does, even when another operation restored byte-identical old content.
  return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.size}`;
}

// Called only by explicit commands while holding W then the selected I lock.
// The journal is written before audit/state, and its exact plan is resumed.
// The applied phase never authorizes a second execution of the operation.
function finishMutation(projectDir: string, message: TerminalReceipt, use: TerminalRequestUse, mutation: TerminalMutation, validate: (plan: TerminalMutationPlan) => void, finalizeOnly = false): TerminalMutationPlan {
  const plan = mutation.plan;
  const { space, intent } = plan.selection;
  return withWorkflowRecordLock(projectDir, () => {
  const statePath = stateFilePath(projectDir, intent ?? undefined, space);
  const current = existsSync(statePath) ? readFileSync(statePath, "utf8") : null;
  if (mutation.phase === "applied") {
    if (plan.creation === undefined && current !== plan.after) throw new Error("This request was already applied; it cannot change the work again.");
    return plan;
  }
  if (finalizeOnly && current !== plan.after) {
    throw new Error("The earlier request did not finish its state change; a newer message cannot revive it.");
  }
  if (current !== plan.before && current !== plan.after) {
    throw new Error("This work changed while the requested operation was interrupted. Its saved operation cannot overwrite the newer state.");
  }
  const operation = createHash("sha256").update(usedPath(projectDir, message, use)).digest("hex");
  const unreadable: string[] = [];
  const rows = readAuditShardEvents(projectDir, intent ?? undefined, space, unreadable);
  if (unreadable.length > 0) throw new Error("The interrupted operation's audit cannot be read; repair it before retrying.");
  const recorded = new Set(rows.filter(row => auditBlockField(row.block, "Request Operation") === operation)
    .flatMap(row => {
      const index = auditBlockField(row.block, "Request Entry");
      const expected = plan.audit[Number(index)];
      return expected !== undefined && String(Number(index)) === index && row.event === expected.eventType &&
        Object.entries(expected.fields).every(([key, value]) =>
          key === "Timestamp" || auditBlockField(row.block, key) === renderAuditFieldValue(value, projectDir).trim())
        ? [index] : [];
    }));
  if (current === plan.after && plan.audit.some((_, index) => !recorded.has(String(index)))) {
    throw new Error("The applied request's audit is incomplete; repair it before finishing its bookkeeping.");
  }
  if (current !== plan.after) {
    if (plan.beforeRevision !== undefined && stateRevision(statePath) !== plan.beforeRevision) {
      throw new Error("The state was rewritten after this operation started; its old request cannot be replayed.");
    }
    if (latestMessage(projectDir, message.session)?.id !== message.id) {
      throw new Error("A newer message arrived before the interrupted operation could finish.");
    }
    const age = Date.now() - Date.parse(message.at);
    if (age < 0 || age > REQUEST_MAX_AGE_MS) throw new Error("The interrupted request has expired.");
    validate(plan);
    mutationFault("before-audit", plan.creation !== undefined);
    const remaining = plan.audit.flatMap((entry, index) => recorded.has(String(index)) ? [] : [{
      ...entry, fields: { ...entry.fields, "Message Id": message.id, "Request Operation": operation, "Request Entry": String(index) },
    }]);
    if (remaining.length > 0) appendAuditEntries(remaining, projectDir, intent ?? undefined, space);
    mutationFault("after-audit", plan.creation !== undefined);
    if (plan.description !== undefined) writeFileAtomic(projectDescriptionFilePath(projectDir, intent ?? undefined, space), plan.description);
    writeStateFile(projectDir, plan.after, intent ?? undefined, space);
    mutationFault("after-state", plan.creation !== undefined);
  }
  if (plan.creation !== undefined) {
    const creation = plan.creation;
    const binding = message.session === null ? null : readSessionBinding(projectDir, message.session);
    // A pick can change the chat's work without producing a new prompt. A
    // retry may complete its old result, but must preserve that newer choice.
    const selectCreated = !finalizeOnly && (binding === null ||
      (binding.space === message.workflow.space && binding.intent === message.workflow.intent) ||
      (binding.space === space && binding.intent === intent));
    const existing = readIntentRegistry(projectDir, space).find(row => row.dirName === intent);
    if (existing !== undefined && existing.uuid !== creation.created.uuid) throw new Error("The requested work's record identity changed.");
    if (existing === undefined) {
      if (!selectCreated) {
        appendIntentToRegistry(projectDir, {
          uuid: creation.created.uuid, slug: creation.created.slug, dirName: creation.created.dirName,
          scope: creation.scope, ...(creation.repos.length > 0 ? { repos: creation.repos } : {}),
          status: "in-flight", ...(creation.questionId ? { request: creation.questionId } : {}),
        }, space);
      } else registerIntentRecord(projectDir, creation.created, creation.scope, creation.repos, creation.sessionId, creation.questionId);
    } else if (selectCreated) selectIntentForSession(projectDir, intent!, space, creation.sessionId);
    // Creation advanced this record before its registry was finalized. Seed
    // that evidence once, preserving any later turn or engine advance.
    markSelectedWork(projectDir, creation.created.dirName, creation.created.space);
  } else {
    if (intent !== null && plan.scope !== undefined) updateIntentScope(projectDir, intent, plan.scope, space);
    if (intent !== null && plan.status !== undefined) updateIntentStatus(projectDir, intent, plan.status, space);
  }
  mutationFault("before-finalize", plan.creation !== undefined);
  writeRecordFileNoFollow(projectDir, usedPath(projectDir, message, use), serializeMutation({ ...mutation, phase: "applied" }));
  return plan;
  }, resolveWorkflowSelection(projectDir, { space, intent: intent ?? "" }));
}

/** A newer prompt permits only bookkeeping for an effect already committed. */
export function resumeTerminalMutation(
  projectDir: string, sessionId: string | null, use: TerminalRequestUse, operation: string,
  validate: (plan: TerminalMutationPlan) => void,
  selection?: WorkflowRecordSelection,
): TerminalMutationPlan | null {
  if (sessionId === null) return null;
  const message = latestMessage(projectDir, sessionId);
  if (message?.source === "prompt" && message.workflow !== undefined &&
    (selection === undefined || (selection.space === message.workflow.space && selection.intent === message.workflow.intent))) {
    const mutation = readMutation(projectDir, message as TerminalRequest, use);
    if (mutation !== null) {
      if (mutation.operation !== operation) return null;
      return finishMutation(projectDir, message as TerminalRequest, use, mutation, validate);
    }
  }
  const directory = recordFileTargetOrThrow(projectDir, relative(projectDir, join(sessionsDir(projectDir), "terminal-requests")));
  if (!existsSync(directory)) return null;
  const candidates: { receipt: MutationReceipt; mutation: TerminalMutation }[] = [];
  for (const name of readdirSync(directory)) {
    if (!/^[0-9a-f]{64}\.taken$/.test(name)) continue;
    let receipt: MutationReceipt;
    let mutation: TerminalMutation | null;
    try {
      const path = recordFileTargetOrThrow(projectDir, relative(projectDir, join(directory, name)));
      const raw = JSON.parse(readRegularFileNoFollowOrThrow(path, "terminal request operation", MUTATION_MAX_BYTES).toString("utf8")) as TerminalMutation;
      if (!validReceipt(raw.receipt)) continue;
      receipt = raw.receipt;
      if (receipt.session !== sessionId || receipt.use !== use || receipt.id === message?.id ||
        (selection !== undefined && (receipt.workflow.space !== selection.space || receipt.workflow.intent !== selection.intent)) ||
        recordFileTargetOrThrow(projectDir, usedPath(projectDir, receipt, use)) !== path ||
        raw.phase !== "pending" || raw.operation !== operation) continue;
      mutation = readMutation(projectDir, receipt, use);
    } catch {
      continue; // An unrelated or malformed mark never grants authority.
    }
    if (mutation === null) continue;
    const statePath = stateFilePath(projectDir, mutation.plan.selection.intent ?? undefined, mutation.plan.selection.space);
    if (!existsSync(statePath) || readFileSync(statePath, "utf8") !== mutation.plan.after) continue;
    candidates.push({ receipt, mutation });
  }
  if (candidates.length > 1) throw new Error("More than one earlier request needs its saved result repaired; select the intended work before retrying.");
  if (candidates.length === 0) return null;
  const candidate = candidates[0]!;
  return finishMutation(projectDir, candidate.receipt, use, candidate.mutation, validate, true);
}

export function applyTerminalMutation(
  projectDir: string, message: TerminalRequest, use: TerminalRequestUse, operation: string, plan: TerminalMutationPlan,
  validate: (plan: TerminalMutationPlan) => void,
): TerminalMutationPlan {
  if (latestMessage(projectDir, message.session)?.id !== message.id) throw new Error("A newer message arrived before the requested operation started.");
  const previous = readMutation(projectDir, message, use);
  if (previous !== null) {
    if (previous.operation !== operation) throw new Error("Finish the interrupted requested operation before applying a different one.");
    return finishMutation(projectDir, message, use, previous, validate);
  }
  const rel = usedPath(projectDir, message, use);
  let path = recordFileTargetOrThrow(projectDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  path = recordFileTargetOrThrow(projectDir, rel);
  if (existsSync(path)) throw new Error("This request has already been used.");
  const mutation: TerminalMutation = {
    version: 1, phase: "pending", operation,
    receipt: { session: message.session, id: message.id, at: message.at, workflow: message.workflow, use },
    plan: { ...plan, beforeRevision: stateRevision(stateFilePath(projectDir, plan.selection.intent ?? undefined, plan.selection.space)) },
  };
  // Explicit callers hold the workspace lock. Atomic replacement means a
  // crash cannot leave a half-written claim that permanently loses authority.
  writeRecordFileNoFollow(projectDir, rel, serializeMutation(mutation));
  return finishMutation(projectDir, message, use, mutation, validate);
}

/**
 * Hand out a line or spend its authority for one explicit operation, once.
 * Separate uses let next hand out the exact line and its setter/create step
 * carry it out. Exclusive creation also prevents two processes spending it.
 * The mark lives outside the intent, including in a delegated worktree.
 */
export function takeTerminalRequest(
  projectDir: string,
  message: TerminalRequest,
  use: TerminalRequestUse,
): boolean {
  if (latestMessage(projectDir, message.session)?.id !== message.id) return false;
  const rel = usedPath(projectDir, message, use);
  let target = recordFileTargetOrThrow(projectDir, rel);
  mkdirSync(dirname(target), { recursive: true });
  target = recordFileTargetOrThrow(projectDir, rel);
  try {
    closeSync(openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
