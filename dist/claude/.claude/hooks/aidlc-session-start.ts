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
// The Cursor adapter additionally sends `rebind_check: true` with source=resume
// on beforeSubmitPrompt because Cursor's sessionStart has no resume source.
// That internal probe emits no session event and returns only a rebind offer.
//
// Mapping (SESSION_COMPACTED is emitted by validate-state.ts PreCompact,
// NOT here — firing it twice would pollute the audit trail):
//   startup → SESSION_STARTED
//   resume  → SESSION_RESUMED
//   clear   → SESSION_STARTED
//   compact → no emission (PreCompact already fired)
//
// With no aidlc-state.md the hook emits no workflow event or context, but still
// bootstraps cursors/includes and records host session identity and transcript
// metadata so the first intent created later in the turn can bind to it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";
import { stageGraphDrift } from "../tools/aidlc-graph.ts";
import { repointHarnessIncludes } from "../tools/aidlc-includes.ts";
import {
  activeIntent,
  activeIntentUuid,
  activeSpace,
  clearSessionIntentUuid,
  ensureActiveSpaceCursor,
  errorMessage,
  findIntentByUuid,
  getField,
  harnessDir,
  hooksHealthDir,
  isClaudeCodeHookInput,
  isoTimestamp,
  intentUuidForSelection,
  readSessionBinding,
  readSessionRebindOffer,
  readSessionIntentUuid,
  recordHookDrop,
  recoveryFilePath,
  resolveWorkflowSelection,
  resolveProjectDirFromHook,
  stateFilePathForSelection,
  validSessionId,
  writeCurrentSessionId,
  writeSessionBinding,
  writeSessionIntentUuid,
  writeSessionPidAncestry,
  writeSessionRebindOffer,
  clearSessionRebindOffer,
} from "../tools/aidlc-lib.ts";
import { writeCurrentTranscriptPath } from "../tools/aidlc-usage.ts";

export async function run(input: string): Promise<number> {
const projectDir = resolveProjectDirFromHook(import.meta.url);

// Read stdin before the workflow-state gate. A fresh session commonly starts
// before the first intent is created; retaining its id lets intent-create stamp
// that
// session to the new record without inventing session ownership in the tool.
let source = "startup";
let rebindCheckOnly = false;
// The conversation id Claude Code stamps on every hook input. Used to key the
// per-session→intent record (resume rebind below); "" when absent (a TTY/empty
// invocation) — the rebind logic no-ops without it.
let sessionId = "";
// The live transcript path, if the host pipes it on SessionStart. Persisted
// below so the statusline/state tools can find the transcript even before the
// first Stop/PostToolUse fold writes the pointer. "" when absent.
let transcriptPath = "";
if (!process.stdin.isTTY) {
  try {
    if (input.length > 0) {
      try {
        const raw: unknown = JSON.parse(input);
        if (isClaudeCodeHookInput(raw)) {
          source = raw.source ? String(raw.source) : "unknown";
          if (typeof raw.session_id === "string") {
            sessionId = validSessionId(raw.session_id) ?? "";
          }
          const rawObj = raw as Record<string, unknown>;
          if (typeof rawObj.transcript_path === "string") {
            transcriptPath = rawObj.transcript_path;
          }
          rebindCheckOnly = rawObj.rebind_check === true;
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

// Persist the transcript path (best-effort; the usage helper swallows write
// errors and no-ops on an empty path). Lets the statusline resolve the live
// transcript on a fresh session before any fold has written the pointer. Only
// the Claude harness pipes transcript_path here; elsewhere transcriptPath stays
// "" and this is a no-op.
try {
  writeCurrentTranscriptPath(projectDir, sessionId, transcriptPath);
} catch {
  // never break session startup on a usage-bookkeeping failure
}

// Record the live conversation on EVERY fire, including a pre-workflow start.
// intent-create reads this marker and binds an unstamped session to the first
// intent it creates. Separate from the per-session intent stamp below.
if (sessionId) {
  writeCurrentSessionId(projectDir, sessionId);
  writeSessionPidAncestry(projectDir, sessionId);
}

// Resolve one session-local workflow target before any state read. An existing
// binding wins; a first-seen session inherits the shared cursors and records
// that fallback immediately, including an intent:null cold workspace.
const preExistingBinding =
  sessionId ? readSessionBinding(projectDir, sessionId) : null;
const preExistingStamp =
  sessionId ? readSessionIntentUuid(projectDir, sessionId) : null;
if (
  sessionId &&
  (
    source === "startup" ||
    source === "clear" ||
    (readSessionRebindOffer(projectDir, sessionId) !== null &&
      preExistingBinding === null)
  )
) {
  clearSessionRebindOffer(projectDir, sessionId);
}
const stampedTarget =
  source === "resume" && !preExistingBinding && preExistingStamp
    ? findIntentByUuid(projectDir, preExistingStamp)
    : null;
const selection = stampedTarget
  ? {
      space: stampedTarget.space,
      intent: stampedTarget.dirName,
      sessionId,
      binding: null,
    }
  : resolveWorkflowSelection(projectDir, { sessionId });

// Persist the resolved fallback before any early return. A cold session must
// retain intent:null instead of later following a cursor moved by another
// session that creates the first workflow.
if (sessionId) {
  writeSessionBinding(projectDir, sessionId, selection.space, selection.intent);
}

// Atomically materialize a clone's missing gitignored cursor, then align the
// harness-native includes before the no-workflow early exit.
ensureActiveSpaceCursor(projectDir);
try {
  repointHarnessIncludes(projectDir, selection.space);
} catch {
  // non-fatal — includes self-heal on the next /aidlc / switch / --doctor
}

const stateFile = stateFilePathForSelection(projectDir, selection);

// No workflow active — retain only the session identity recorded above.
if (!existsSync(stateFile)) {
  if (sessionId) {
    process.stdout.write(`${JSON.stringify({
      additionalContext:
        `AIDLC Runtime Session: ${sessionId}\n` +
        "Use this exact value for any Plan Approval --session argument in this conversation.",
    })}\n`);
  }
  return 0;
}

// Write health heartbeat
const healthDir = hooksHealthDir(
  projectDir,
  selection.intent ?? undefined,
  selection.space,
);
mkdirSync(healthDir, { recursive: true });
writeFileSync(join(healthDir, "session-start.last"), isoTimestamp(), "utf-8");

// Emit session event. appendAuditEntry creates audit.md if missing, so no
// audit-existence guard — the state-file guard above is the sole "workflow
// is active" check.
let eventType: string | null = null;
if (!rebindCheckOnly) {
  if (source === "startup" || source === "clear") eventType = "SESSION_STARTED";
  else if (source === "resume") eventType = "SESSION_RESUMED";
  else if (source === "malformed") eventType = "SESSION_STARTED"; // visible via Source field
}
// compact / unknown: no emission — compact is owned by PreCompact hook

if (eventType) {
  try {
    appendAuditEntry(
      eventType,
      { Source: source, ...(sessionId ? { Session: sessionId } : {}) },
      projectDir,
      selection.intent ?? undefined,
      selection.space,
    );
  } catch (e) {
    recordHookDrop(projectDir, "session-start", errorMessage(e));
    // Non-fatal — continue with context injection
  }
}

// --- Resume rebind (P8) -------------------------------------------------------
//
// A conversation works ONE intent; the active-intent cursor is durable + shared
// across sessions. So resuming an A-chat after the cursor moved to B would
// inject B's context silently (vision §3, the central multi-space hazard). We
// fix it with a per-session→intent stamp (aidlc/.aidlc-sessions/<id>):
//   - On a STARTED-class event, stamp the working intent's UUID for this
//     session so a later resume can detect a cursor drift.
//   - On RESUMED, if the stamped UUID differs from the live cursor AND still
//     names a real intent, OFFER a rebind. The offer is a print directive in
//     additionalContext. The stamp follows the live intent by default (the No
//     path); on Yes, the named intent-switch command moves both cursor and stamp
//     back together. No session_id (TTY/empty stdin) → no-op.
const activeSp = activeSpace(projectDir);
const liveDir = activeIntent(projectDir, activeSp);
const liveUuid = activeIntentUuid(projectDir, activeSp);
const binding = preExistingBinding;
const selectedUuid = intentUuidForSelection(projectDir, selection);
let rebindOffer = "";
if (sessionId) {
  const stampedUuid = preExistingStamp;
  if (eventType === "SESSION_STARTED") {
    if (selectedUuid) writeSessionIntentUuid(projectDir, sessionId, selectedUuid);
  } else if (source === "resume") {
    const ownedUuid = binding ? selectedUuid : stampedUuid;
    if (ownedUuid && ownedUuid !== liveUuid) {
      const was = findIntentByUuid(projectDir, ownedUuid);
      if (was) {
        const signature =
          `${was.space}/${was.dirName}->${activeSp}/${liveDir ?? "(none)"}`;
        const alreadyOffered =
          readSessionRebindOffer(projectDir, sessionId) === signature;
        const live = liveUuid ? findIntentByUuid(projectDir, liveUuid) : null;
        const liveSlug = live ? live.slug : "(none)";
        const entrySkill = harnessDir() === ".codex" ? "$aidlc" : "/aidlc";
        // The cursor verb switches within the active space. When the stamped
        // intent lives elsewhere, prefix the space switch. Use the harness's
        // native entry skill so Codex never receives a slash command.
        const switchInstruction =
          was.space === activeSp
            ? `run \`${entrySkill} intent ${was.slug}\``
            : `first run \`${entrySkill} space ${was.space}\`; after it completes, run \`${entrySkill} intent ${was.slug}\``;
        if (!alreadyOffered) {
          rebindOffer =
            `INTENT REBIND OFFER: This conversation is bound to ${was.slug}, but the shared cursor names ${liveSlug}. ` +
            `Move the shared cursor back to ${was.slug}? [Y/n] - on Yes, ${switchInstruction}; ` +
            `on No, keep working ${was.slug} through this session binding. This changes only machine-local navigation.\n`;
          writeSessionRebindOffer(projectDir, sessionId, signature);
        }
      }
    } else {
      clearSessionRebindOffer(projectDir, sessionId);
    }

    // A binding owns attribution. Without one, preserve the legacy stamp that
    // follows the live cursor after the offer.
    if (binding && selectedUuid) {
      writeSessionIntentUuid(projectDir, sessionId, selectedUuid);
    } else if (binding && stampedUuid) {
      clearSessionIntentUuid(projectDir, sessionId);
    } else if (stampedTarget && selectedUuid) {
      writeSessionIntentUuid(projectDir, sessionId, selectedUuid);
    } else if (liveUuid) {
      writeSessionIntentUuid(projectDir, sessionId, liveUuid);
    } else if (stampedUuid) {
      clearSessionIntentUuid(projectDir, sessionId);
    }
  } else if (!stampedUuid && selectedUuid) {
    writeSessionIntentUuid(projectDir, sessionId, selectedUuid);
  }
}

// Cursor can only surface this probe through beforeSubmitPrompt's blocking
// user_message channel. Consume a real drift after returning it so the next
// submission can either run the named switch command (Yes) or continue on the
// live intent (No) instead of receiving the same warning forever.
if (rebindCheckOnly) {
  if (rebindOffer) {
    if (binding && selectedUuid) {
      writeSessionIntentUuid(projectDir, sessionId, selectedUuid);
    } else if (liveUuid) {
      writeSessionIntentUuid(projectDir, sessionId, liveUuid);
    }
    process.stdout.write(`${JSON.stringify({
      additionalContext:
        `AIDLC Runtime Session: ${sessionId}\n${rebindOffer}`,
    })}\n`);
  }
  return 0;
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

// Unit-level checkpoint (issue 681 claim 2): when a per-unit stage stopped
// mid-unit, name the exact unit, its state, and — for a paused unit — the
// recorded reason and next action, so a fresh session lands on the stopping
// point instead of re-deriving it from disk coverage.
const activeUnit = getField(content, "Active Unit");
const unitLine = activeUnit
  ? `Active Unit: ${activeUnit} (${getField(content, "Unit State") ?? "in-progress"}` +
    `${getField(content, "Unit Pause Reason") ? `; reason: ${getField(content, "Unit Pause Reason")}` : ""}` +
    `${getField(content, "Unit Next Action") ? `; next: ${getField(content, "Unit Next Action")}` : ""})\n`
  : "";

// Check for compaction recovery breadcrumb
const recoveryFile = recoveryFilePath(
  projectDir,
  selection.intent ?? undefined,
  selection.space,
);
const recovery = existsSync(recoveryFile)
  ? "NOTE: A compaction recovery breadcrumb exists at .aidlc-recovery.md — check if state was preserved correctly.\n"
  : "";

// Stage-graph drift advisory (issue #364). The runtime resolves stages from
// the compiled stage-graph.json only, a stage `.md` added to disk without a
// recompile is silently never executed. Surface it once at session start so the
// operator isn't left guessing why a new stage never runs. Fail-open: a drift
// check that throws (e.g. a malformed graph) must never block session startup,
// so it degrades to no advisory.
let driftNote = "";
try {
  const { uncompiledStages } = stageGraphDrift();
  if (uncompiledStages.length > 0) {
    driftNote =
      `NOTE: ${uncompiledStages.length} stage file(s) on disk are not in the compiled stage graph and will NOT execute: ${uncompiledStages.join(", ")}. ` +
      `Run \`bun ${harnessDir()}/tools/aidlc-graph.ts compile\` to include them, then start a fresh workflow (an in-flight workflow keeps its original stage set).\n`;
  }
} catch {
  // Drift check failed, never block startup over an advisory.
}

const context = `AIDLC WORKFLOW ACTIVE
${rebindOffer}Scope: ${scope}
Runtime Session: ${sessionId || "(unavailable)"}
Lifecycle Phase: ${phase}
Current Stage: ${stage}
Status: ${status}
Active Agent: ${agent}
Last Completed: ${last}
Next Action: ${next}
${unitLine}${recovery}${driftNote}On BARE /aidlc re-entry, offer the user the standard resume options (Resume / Redo / Jump / Start Fresh). Explicit /aidlc --resume already selects Resume: do NOT offer the menu; forward --resume unchanged and continue directly. Check the active intent's aidlc-state.md for full context.

FORWARDING-LOOP DISCIPLINE (non-negotiable — the engine owns ALL routing):
- The engine binary (\`aidlc-orchestrate.ts\`) is the ONLY authority on the next move. You run it, you do EXACTLY what its one directive says, you commit with \`report\`, you repeat. You never re-derive routing yourself.
- STEP 1 — YOUR VERY FIRST ACTION: take everything the user typed after \`/aidlc\` and append it to the first \`next\` call UNCHANGED. The flags ARE the user's intent; dropping them sends the workflow to the wrong place. \`/aidlc --phase ideation\` → you MUST run \`next --phase ideation\`, never bare \`next\`. \`/aidlc --stage X\` → \`next --stage X\`. \`/aidlc\` alone → \`next\`. Before running that first \`next\`, verify: if the user's message contained \`--phase\`/\`--stage\`/\`--scope\`/\`--depth\`/freeform text, it MUST appear on your \`next\` command — a bare \`next\` when the user gave arguments is a bug.
- When a directive is \`{kind:"print"}\` whose message names a command to run (e.g. \`aidlc-jump.ts execute ...\`, a scope/config change, or \`init\`): that named command is your IMMEDIATE next tool call. Run THAT EXACT command FIRST. Do NOT run \`next\` again, do NOT read more files, do NOT plan a stage — until the named command has run. Re-running the engine before it is a protocol violation that silently skips the move.`;

// Output additionalContext as JSON
const output = JSON.stringify({ additionalContext: context });
process.stdout.write(`${output}\n`);
return 0;
}

if (import.meta.main) {
  process.exit(await run(await Bun.stdin.text()));
}
