// PostToolUse hook: Emit ARTIFACT_CREATED / ARTIFACT_UPDATED when files under
// the active intent record or active space codekb tree are written or edited.
// Distinguishes CREATE vs UPDATE by checking whether the target file existed
// before the Write/Edit.
//
// Receives JSON on stdin from Claude Code. No-op if no audit.md exists (no
// active workflow in this cwd) to preserve the existing "only log when
// relevant" behaviour.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { appendAuditEntryUnlocked } from "../tools/aidlc-audit.ts";
import {
  auditFilePath,
  type ClaudeCodeHookInput,
  codekbDir,
  docsRoot,
  errorMessage,
  getField,
  hookDebug,
  hooksHealthDir,
  isClaudeCodeHookInput,
  activeSummaryAuthorizationForRecordPath,
  isoTimestamp,
  loadStageGraphAll,
  recordHookDrop,
  resolveProjectDirFromHook,
  type StageEntry,
  stateFilePath,
  SUMMARY_AUTHORIZATION_FIELD,
  withAuditLock,
} from "../tools/aidlc-lib.ts";

// Attribution fields on ARTIFACT_CREATED / ARTIFACT_UPDATED rows. Each is
// derived deterministically and is ABSENT (not empty) when it cannot be:
// - Role: who the framework says is working. The dispatched agent's
//   `agent_type` when the payload carries one, else the state file's
//   `Active Agent` (set at stage start by aidlc-state.ts).
// - Mode: the compiled graph node's `mode` for the state file's Current Stage.
// - Actor: the payload's identity. `subagent:<agent_type>` when present,
//   `main-session` when absent on a harness whose payloads carry identity
//   (Claude Code, Codex, Kiro CLI scoped registration, Cursor, opencode,
//   Copilot), and absent when the payload declares
//   `agent_identity_unavailable` (Kiro IDE; an ambiguous Cursor ledger).
// Nothing here reads prompt text or model output.
export const ROLE_FIELD = "Role";
export const MODE_FIELD = "Mode";
export const ACTOR_FIELD = "Actor";

export interface WriteAttribution {
  role?: string;
  mode?: string;
  actor?: string;
}

/**
 * Pure derivation of the attribution fields from the payload identity, the
 * state file's `Active Agent` and `Current Stage`, and the compiled graph.
 */
export function deriveWriteAttribution(
  payload: { agent_type?: unknown; agent_identity_unavailable?: unknown },
  state: string | null,
  graph: readonly Pick<StageEntry, "slug" | "mode">[],
): WriteAttribution {
  const agentType =
    typeof payload.agent_type === "string" && payload.agent_type.length > 0
      ? payload.agent_type
      : null;
  const activeAgent = state === null ? null : getField(state, "Active Agent");
  const currentStage = state === null ? null : getField(state, "Current Stage");
  const attribution: WriteAttribution = {};
  const role = agentType ?? (activeAgent && activeAgent.length > 0 ? activeAgent : null);
  if (role !== null) attribution.role = role;
  if (currentStage && currentStage.length > 0) {
    const slug = currentStage.trim().toLowerCase().replace(/\s+/g, "-");
    const node = graph.find((stage) => stage.slug === slug);
    if (node && node.mode.length > 0) attribution.mode = node.mode;
  }
  if (agentType !== null) attribution.actor = `subagent:${agentType}`;
  else if (payload.agent_identity_unavailable !== true) attribution.actor = "main-session";
  return attribution;
}

export async function run(input: string): Promise<number> {
const projectDir = resolveProjectDirFromHook(import.meta.url);
hookDebug(projectDir, "write-audit-log", "invoked", { projectDir, cwd: process.cwd() });

// Write health heartbeat
const healthDir = hooksHealthDir(projectDir);
mkdirSync(healthDir, { recursive: true });
writeFileSync(join(healthDir, "write-audit-log.last"), isoTimestamp(), "utf-8");

// Read JSON from stdin. If stdin is a TTY (interactive shell, test harness
// running under `bash -x`-inheriting pipeline), no JSON is coming — exit
// cleanly instead of blocking on the terminal read.
if (process.stdin.isTTY) {
  hookDebug(projectDir, "write-audit-log", "exit: stdin isTTY");
  return 0;
}

let parsed: ClaudeCodeHookInput;
try {
  const raw: unknown = JSON.parse(input);
  if (!isClaudeCodeHookInput(raw)) {
    hookDebug(projectDir, "write-audit-log", "exit: not ClaudeCodeHookInput", { input: input.slice(0, 200) });
    return 0;
  }
  parsed = raw;
} catch {
  hookDebug(projectDir, "write-audit-log", "exit: stdin parse failed", { input: input.slice(0, 200) });
  return 0;
}

const tool = parsed.tool_name ?? "";
const rawFile: string = parsed.tool_input?.file_path ?? "";
if (!rawFile) return 0;
const file = isAbsolute(rawFile) ? rawFile : join(projectDir, rawFile);
const auditFileValue = file.replace(/\\/g, "/");
const fileNorm = auditFileValue; // forward-slash form for all path matching below

// Only log writes to the active intent's RECORD tree, plus the space's codekb
// tree. The record re-roots per intent (aidlc/spaces/<space>/intents/
// <slug>-<id8>/…), so a bare `includes("aidlc-docs/")` gate would DROP every
// artifact write on the workspace layout. docsRoot() resolves that per-intent
// root when an intent is active, else the bare space record root - the write is
// logged iff it lands under that root. The codekb arm covers reverse-
// engineering's artifacts: they live at the SPACE level keyed by repo
// (aidlc/spaces/<space>/codekb/<repo>/…, a sibling of intents/, outside the
// record root), and without it those writes emit no ARTIFACT_* rows at all -
// which blinded the approve-time gate-revision backstop to codekb revisions
// (Revision Count silently stayed 0 on a revised-then-approved RE gate).
// codekbDir(pd, "_") is <pd>/aidlc/spaces/<space>/codekb/_; its parent is the
// codekb root for the active space (same idiom as producesDirsForStage in
// aidlc-state.ts).
const recordRoot = docsRoot(projectDir).replace(/\\/g, "/").replace(/\/$/, "");
const underRecord = fileNorm === recordRoot || fileNorm.startsWith(`${recordRoot}/`);
const codekbRoot = join(codekbDir(projectDir, "_"), "..")
  .replace(/\\/g, "/")
  .replace(/\/$/, "");
const underCodekb = fileNorm.startsWith(`${codekbRoot}/`);
hookDebug(projectDir, "write-audit-log", "path-gate", {
  tool,
  file: fileNorm,
  recordRoot,
  underRecord,
  codekbRoot,
  underCodekb,
});
if (!underRecord && !underCodekb) {
  hookDebug(projectDir, "write-audit-log", "exit: not under record or codekb root");
  return 0;
}

// Don't log writes to an audit shard itself (avoid recursion). The shard is
// audit/<host>-<clone>.md under the record dir; the bare audit.md guard also
// covers a migrated tree's pre-shard audit.md before it is relocated.
if (
  file.endsWith("/audit.md") ||
  file.endsWith("\\audit.md") ||
  /[/\\]audit[/\\][^/\\]+\.md$/.test(file)
) {
  hookDebug(projectDir, "write-audit-log", "exit: write to audit shard (recursion guard)");
  return 0;
}

const auditFile = auditFilePath(projectDir);

// Don't auto-create the audit trail — the orchestrator creates it at workflow start.
if (!existsSync(auditFile)) {
  hookDebug(projectDir, "write-audit-log", "exit: audit file missing", { auditFile });
  return 0;
}

// Extract the context breadcrumb: the path relative to the record root (the
// per-intent record dir on the new layout, or the flat `aidlc-docs/` root),
// or "codekb > <repo> > <name>" for a codekb write. Prefer the root prefixes;
// fall back to the `aidlc-docs/` anchor for a flat-legacy write that didn't
// match either root.
let context: string;
if (underRecord && fileNorm.length > recordRoot.length) {
  context = fileNorm.slice(recordRoot.length + 1).replace(/\//g, " > ");
} else if (underCodekb) {
  context = `codekb > ${fileNorm.slice(codekbRoot.length + 1).replace(/\//g, " > ")}`;
} else {
  const aidlcIdxPosix = file.indexOf("aidlc-docs/");
  const aidlcIdxWin = file.indexOf("aidlc-docs\\");
  const aidlcIdx = aidlcIdxPosix >= 0 ? aidlcIdxPosix : aidlcIdxWin;
  context = aidlcIdx >= 0
    ? file.slice(aidlcIdx + "aidlc-docs/".length).replace(/[/\\]/g, " > ")
    : file;
}

// CREATE vs UPDATE distinction:
// - Edit tool → always UPDATE (Edit requires the file to pre-exist)
// - Write tool → CREATE only if the file was brand new; otherwise UPDATE
// PostToolUse fires after the write, so `existsSync` is always true by the
// time this hook runs. We infer "was this a net-new file?" from the file's
// mtime matching its filesystem creation timestamp (within a small epsilon), true on fresh
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
    // The filesystem creation timestamp (birthtimeMs) tracks mtimeMs on fresh
    // creation. If a file was overwritten, mtime advances past that timestamp.
    // Accept 10ms slack for
    // filesystem timestamp granularity.
    isNew = Math.abs(st.mtimeMs - st.birthtimeMs) < 10;
  } catch {
    // stat failure → default to CREATED (safer than UPDATED for net-new files)
    isNew = true;
  }
  eventType = isNew ? "ARTIFACT_CREATED" : "ARTIFACT_UPDATED";
}

// A write under the record descends from the summary confirmation that is the
// active authorization for its stage (and Unit) at the moment of the write. The
// row carries that authorization's id, so completion can ask "does this output
// descend from the current confirmation" instead of "did it land after the
// receipt". A write with no active authorization for its scope carries no id.
//
// The lookup and the append share one audit-lock hold: the answer command
// writes the registry and appends its receipt under the same lock, so a
// registry can never be observed here without the receipt that minted it (nor
// during a rollback that removes it).
const fields: Record<string, string> = {
  Tool: tool,
  File: auditFileValue,
  Context: context,
};
let graph: StageEntry[] = [];
try {
  graph = loadStageGraphAll();
} catch (e) {
  hookDebug(projectDir, "write-audit-log", "stage graph unreadable", { error: errorMessage(e) });
}
const stageSlugs: ReadonlySet<string> = new Set(graph.map((stage) => stage.slug));

// Attribution: state, graph, and payload identity only (never prompt text).
// Every field is optional so rows stay byte-identical where nothing derives.
let stateContent: string | null = null;
try {
  stateContent = readFileSync(stateFilePath(projectDir), "utf-8");
} catch (e) {
  hookDebug(projectDir, "write-audit-log", "state file unreadable", { error: errorMessage(e) });
}
const attribution = deriveWriteAttribution(parsed, stateContent, graph);
if (attribution.role !== undefined) fields[ROLE_FIELD] = attribution.role;
if (attribution.mode !== undefined) fields[MODE_FIELD] = attribution.mode;
if (attribution.actor !== undefined) fields[ACTOR_FIELD] = attribution.actor;

try {
  withAuditLock(projectDir, () => {
    if (underRecord && fileNorm.length > recordRoot.length) {
      const authorization = activeSummaryAuthorizationForRecordPath(
        projectDir,
        fileNorm.slice(recordRoot.length + 1),
        stageSlugs,
      );
      if (authorization !== null) fields[SUMMARY_AUTHORIZATION_FIELD] = authorization.id;
    }
    appendAuditEntryUnlocked(eventType, fields, projectDir);
  });
  hookDebug(projectDir, "write-audit-log", "emitted", { eventType, file: auditFileValue, context });
} catch (e) {
  // Hook must be a no-op on any audit emission failure to avoid breaking the
  // user's tool call. Record the drop so `--doctor` can surface it, then
  // exit cleanly.
  hookDebug(projectDir, "write-audit-log", "exit: emit threw", { eventType, error: errorMessage(e) });
  recordHookDrop(projectDir, "write-audit-log", errorMessage(e));
  return 0;
}
return 0;
}

if (import.meta.main) {
  process.exit(await run(await Bun.stdin.text()));
}
