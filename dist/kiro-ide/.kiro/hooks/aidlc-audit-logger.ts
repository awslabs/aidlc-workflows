// PostToolUse hook: Emit ARTIFACT_CREATED / ARTIFACT_UPDATED when files under
// the active intent record or active space codekb tree are written or edited.
// Distinguishes CREATE vs UPDATE by checking whether the target file existed
// before the Write/Edit.
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
  codekbDir,
  docsRoot,
  errorMessage,
  hookDebug,
  hooksHealthDir,
  isClaudeCodeHookInput,
  isoTimestamp,
  recordHookDrop,
  resolveProjectDirFromHook,
} from "../tools/aidlc-lib.ts";

const projectDir = resolveProjectDirFromHook(import.meta.url);
hookDebug(projectDir, "audit-logger", "invoked", { projectDir, cwd: process.cwd() });

// Write health heartbeat
const healthDir = hooksHealthDir(projectDir);
mkdirSync(healthDir, { recursive: true });
writeFileSync(join(healthDir, "audit-logger.last"), isoTimestamp(), "utf-8");

// Read JSON from stdin. If stdin is a TTY (interactive shell, test harness
// running under `bash -x`-inheriting pipeline), no JSON is coming — exit
// cleanly instead of blocking on the terminal read.
if (process.stdin.isTTY) {
  hookDebug(projectDir, "audit-logger", "exit: stdin isTTY");
  process.exit(0);
}

const input = await Bun.stdin.text();
let parsed: ClaudeCodeHookInput;
try {
  const raw: unknown = JSON.parse(input);
  if (!isClaudeCodeHookInput(raw)) {
    hookDebug(projectDir, "audit-logger", "exit: not ClaudeCodeHookInput", { input: input.slice(0, 200) });
    process.exit(0);
  }
  parsed = raw;
} catch {
  hookDebug(projectDir, "audit-logger", "exit: stdin parse failed", { input: input.slice(0, 200) });
  process.exit(0);
}

const tool = parsed.tool_name ?? "";
const file: string = parsed.tool_input?.file_path ?? "";
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
hookDebug(projectDir, "audit-logger", "path-gate", {
  tool,
  file: fileNorm,
  recordRoot,
  underRecord,
  codekbRoot,
  underCodekb,
});
if (!underRecord && !underCodekb) {
  hookDebug(projectDir, "audit-logger", "exit: not under record or codekb root");
  process.exit(0);
}

// Don't log writes to an audit shard itself (avoid recursion). The shard is
// audit/<host>-<clone>.md under the record dir; the bare audit.md guard also
// covers a migrated tree's pre-shard audit.md before it is relocated.
if (
  file.endsWith("/audit.md") ||
  file.endsWith("\\audit.md") ||
  /[/\\]audit[/\\][^/\\]+\.md$/.test(file)
) {
  hookDebug(projectDir, "audit-logger", "exit: write to audit shard (recursion guard)");
  process.exit(0);
}

const auditFile = auditFilePath(projectDir);

// Don't auto-create the audit trail — the orchestrator creates it at workflow start.
if (!existsSync(auditFile)) {
  hookDebug(projectDir, "audit-logger", "exit: audit file missing", { auditFile });
  process.exit(0);
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
    File: auditFileValue,
    Context: context,
  }, projectDir);
  hookDebug(projectDir, "audit-logger", "emitted", { eventType, file: auditFileValue, context });
} catch (e) {
  // Hook must be a no-op on any audit emission failure to avoid breaking the
  // user's tool call. Record the drop so `--doctor` can surface it, then
  // exit cleanly.
  hookDebug(projectDir, "audit-logger", "exit: emit threw", { eventType, error: errorMessage(e) });
  recordHookDrop(projectDir, "audit-logger", errorMessage(e));
  process.exit(0);
}
