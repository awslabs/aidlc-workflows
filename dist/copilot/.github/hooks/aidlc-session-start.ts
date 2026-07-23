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
import { stageGraphDrift } from "../tools/aidlc-graph.ts";
import { repointHarnessIncludes } from "../tools/aidlc-includes.ts";
import {
  activeIntentUuid,
  activeSpace,
  errorMessage,
  findIntentByUuid,
  getField,
  harnessDir,
  hooksHealthDir,
  isClaudeCodeHookInput,
  isoTimestamp,
  readSessionIntentUuid,
  recordHookDrop,
  recoveryFilePath,
  resolveProjectDirFromHook,
  stateFilePath,
  writeCurrentSessionId,
  writeSessionIntentUuid,
} from "../tools/aidlc-lib.ts";

export async function run(input: string): Promise<number> {
const projectDir = resolveProjectDirFromHook(import.meta.url);

// Idempotent ensure-step (P0.1 robustness): align the harness-native includes
// with the active space at session start, BEFORE the no-workflow early-exit, so
// turn-1 on a fresh clone (no aidlc-state.md yet) still has the includes pointed
// at the active space. A no-op at `default` (the common case) and whenever the
// cursor + includes already agree — so it never dirties a single-team committed
// tree. Best-effort: a failure here must never break session startup.
try {
  repointHarnessIncludes(projectDir, activeSpace(projectDir));
} catch {
  // non-fatal — includes self-heal on the next /aidlc / switch / --doctor
}

const stateFile = stateFilePath(projectDir);

// No workflow active — do nothing
if (!existsSync(stateFile)) return 0;

// Write health heartbeat
const healthDir = hooksHealthDir(projectDir);
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
// The conversation id Claude Code stamps on every hook input. Used to key the
// per-session→intent record (resume rebind below); "" when absent (a TTY/empty
// invocation) — the rebind logic no-ops without it.
let sessionId = "";
if (!process.stdin.isTTY) {
  try {
    if (input.length > 0) {
      try {
        const raw: unknown = JSON.parse(input);
        if (isClaudeCodeHookInput(raw)) {
          source = raw.source ? String(raw.source) : "unknown";
          if (typeof raw.session_id === "string") sessionId = raw.session_id;
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

// Record the live conversation as the "current session" on EVERY fire (startup /
// resume / clear / compact) — NOT gated on eventType. The hook is the only place
// that sees session_id; a CLI switch (`/aidlc intent <slug>`) cannot. This marker
// lets the switch tool re-stamp the live session's record so a deliberate
// in-conversation switch doesn't fire a FALSE rebind nag on resume (see the
// re-stamp in handleIntent, aidlc-utility.ts). Separate file from the per-session
// stamp below; no-op without a session_id.
if (sessionId) writeCurrentSessionId(projectDir, sessionId);

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
//     additionalContext — it CORRECTS the per-user cursor on a Yes, it NEVER
//     rebuilds the session (the session is CLI-owned; the intent is the durable,
//     harness-neutral record). No session_id (TTY/empty stdin) → no-op.
const activeSp = activeSpace(projectDir);
const liveUuid = activeIntentUuid(projectDir, activeSp);
let rebindOffer = "";
if (sessionId) {
  if (eventType === "SESSION_STARTED") {
    // Stamp the intent this conversation is bound to (only when one resolves —
    // a flat-legacy / pre-birth project has no uuid to stamp).
    if (liveUuid) writeSessionIntentUuid(projectDir, sessionId, liveUuid);
  } else if (source === "resume") {
    const stampedUuid = readSessionIntentUuid(projectDir, sessionId);
    // Offer ONLY on a real drift: a stamp exists, it differs from the live
    // cursor, and it still resolves to a known intent (a stale stamp from a
    // since-deleted intent names nothing → no offer).
    if (stampedUuid && stampedUuid !== liveUuid) {
      const was = findIntentByUuid(projectDir, stampedUuid);
      if (was) {
        const live = liveUuid ? findIntentByUuid(projectDir, liveUuid) : null;
        const liveSlug = live ? live.slug : "(none)";
        // The cursor verb is `/aidlc intent <slug>` (switches within the active
        // space). When the stamped intent lives in another space, prefix the
        // space switch so the rebind command is complete.
        const switchCmd =
          was.space === activeSp
            ? `/aidlc intent ${was.slug}`
            : `/aidlc space ${was.space} && /aidlc intent ${was.slug}`;
        rebindOffer =
          `INTENT REBIND OFFER: This conversation was working ${was.slug}, but the active intent is ${liveSlug}. ` +
          `Switch back to ${was.slug}? [Y/n] — on Yes, run \`${switchCmd}\` to move the cursor; ` +
          `on No, keep working ${liveSlug}. This corrects the per-user cursor only; it never rebuilds the conversation.\n`;
      }
    }
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
const recoveryFile = recoveryFilePath(projectDir);
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
Lifecycle Phase: ${phase}
Current Stage: ${stage}
Status: ${status}
Active Agent: ${agent}
Last Completed: ${last}
Next Action: ${next}
${recovery}${driftNote}On resume: offer the user the standard resume options (Resume / Redo / Jump / Start Fresh). Check the active intent's aidlc-state.md for full context.

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
