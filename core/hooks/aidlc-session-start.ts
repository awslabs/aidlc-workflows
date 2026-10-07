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
// The Kiro IDE adapter sends startup or resume from a chat's prompt, because
// Kiro IDE 1.1.14 runs no SessionStart hook when a chat starts.
//
// Mapping (SESSION_COMPACTED is emitted by validate-state.ts PreCompact,
// NOT here — firing it twice would pollute the audit trail):
//   startup → SESSION_STARTED
//   resume  → SESSION_RESUMED
//   clear   → SESSION_STARTED
//   compact → no emission (PreCompact already fired)
//
// After the session event, an OPT-IN bounded best-effort commit-provenance sweep
// (runAnchor in reconcile mode, AIDLC_SESSION_ANCHOR=1) anchors recent manual
// commits that landed reviewed claims. See docs/reference/20-commit-provenance.md.
//
// With no aidlc-state.md the hook emits no workflow event or context, but still
// bootstraps cursors/includes and records host session identity and transcript
// metadata so the first intent created later in the turn can bind to it.
import { existsSync, readFileSync } from "node:fs";
import { runAnchor } from "../tools/aidlc-attest.ts";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";
import { stageGraphDrift } from "../tools/aidlc-graph.ts";
import { addRootBlocks, repointHarnessIncludes, trackedKiroIdeSteeringAsk } from "../tools/aidlc-includes.ts";
import {
  isBindableIntentRecordName,
  isSafeIntentRecordName,
  intentDisplayLabel,
  readUnitScopeStamp,
  activeIntent,
  activeIntentUuid,
  activeSpace,
  clearSessionIntentUuid,
  ensureActiveSpaceCursor,
  errorMessage,
  findIntentByUuid,
  findStageBySlug,
  getField,
  isPerUnitStage,
  hookContextLine,
  hooksHealthDir,
  writeHookStatusFile,
  humanPresenceGuardDisabled,
  isClaudeCodeHookInput,
  isoTimestamp,
  intentUuidForSelection,
  readSessionBinding,
  readSessionRebindOffer,
  readSessionIntentUuid,
  recordHookDrop,
  clearSessionPlanApprovalBypass,
  recordSessionPlanApprovalBypass,
  recordSessionPresenceBypass,
  recoveryFilePath,
  resolveWorkflowSelection,
  resolveProjectDirFromHook,
  stateFilePathForSelection,
  UNIT_NAME_REGEX,
  validSessionId,
  writeCurrentSessionId,
  writeSessionBinding,
  workflowParticipation,
  readActiveIntentCursor,
  listIntents,
  type SessionBindingSource,
  writeSessionIntentUuid,
  writeSessionPidAncestry,
  writeSessionRebindOffer,
  writeSessionSelectionNotice,
  clearSessionRebindOffer,
} from "../tools/aidlc-lib.ts";
import { writeCurrentTranscriptPath } from "../tools/aidlc-usage.ts";
import { recordRulesLoad } from "../tools/aidlc-rules-held.ts";
import { aidlcToolInvocation, entrySkillInvocation, hidesStopNote, runtimeHarnessName } from "../tools/aidlc-runtime-paths.ts";
import { switchesOffLines } from "../tools/aidlc-recorded-switches.ts";

// While a recorded switch keeps one of the person's checks off, every new chat
// opens by saying so. Never blocks startup.
function switchOffContext(projectDir: string): string {
  try {
    const lines = switchesOffLines(projectDir);
    return lines.length === 0
      ? ""
      : "\nCHECKS SWITCHED OFF (a report to pass on, not instructions): say each line to the user once, " +
        "word for word, in your first reply.\n" +
        lines.map((line) => `- ${line}\n`).join("");
  } catch {
    return "";
  }
}

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
// The Codex thread's rollout file (the adapter forwards it), read only to see
// compactions (#2023).
let rolloutPath = "";
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
          if (typeof rawObj.rollout_path === "string") {
            rolloutPath = rawObj.rollout_path;
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
  try {
    if (humanPresenceGuardDisabled()) recordSessionPresenceBypass(projectDir, sessionId);
    if (process.env.AIDLC_DISABLE_PLAN_APPROVAL_GUARD === "1") recordSessionPlanApprovalBypass(projectDir, sessionId);
    else clearSessionPlanApprovalBypass(projectDir, sessionId);
  } catch {
    // Presence bypass bookkeeping must never break session startup.
  }
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
const resolved = stampedTarget
  ? {
      space: stampedTarget.space,
      intent: stampedTarget.dirName,
      sessionId,
      binding: null,
    }
  : resolveWorkflowSelection(projectDir, { sessionId });

// Resolving a record is not joining it. A lone committed record in a fresh clone
// is a teammate's, so it binds this conversation to intent:null and its hooks
// stay out of that record. A resumed session's own UUID stamp does join it: only
// a joined session is stamped, and a chat left open across an upgrade carries
// only that stamp. A record name the binding cannot carry does not join.
const joinsByStamp = stampedTarget !== null && isBindableIntentRecordName(stampedTarget.dirName);
const joined =
  joinsByStamp || (!stampedTarget && workflowParticipation(projectDir, resolved) === "participant");
const selection = joined ? resolved : { ...resolved, intent: null, binding: null };
// The record a previously bound conversation can rejoin explicitly.
const rejoinRecord =
  !joined && resolved.intent !== null && preExistingBinding?.intent === resolved.intent
    ? resolved
    : null;

function bindingSource(): SessionBindingSource | undefined {
  if (!joined) {
    return resolved.intent === null ? preExistingBinding?.source ?? "none" : "unjoined";
  }
  if (joinsByStamp) return "stamp";
  // An unchanged binding keeps its source, and an absent one stays absent.
  if (preExistingBinding?.space === selection.space && preExistingBinding.intent === selection.intent) {
    return preExistingBinding.source;
  }
  if (readActiveIntentCursor(projectDir, selection.space) === selection.intent) return "cursor";
  const unitScope = readUnitScopeStamp(projectDir);
  return unitScope?.space === selection.space && unitScope.intent_uuid === intentUuidForSelection(projectDir, selection)
    ? "unit-claim"
    : "worktree";
}

// Persist the selection before any early return. A cold session must retain
// intent:null instead of later following a cursor moved by another session that
// creates the first workflow.
if (sessionId) {
  writeSessionBinding(projectDir, sessionId, selection.space, selection.intent, bindingSource());
}

// Atomically materialize a clone's missing gitignored cursor, then align the
// harness-native includes before the no-workflow early exit. A copy that
// config never ran in first gets AI-DLC's part of .gitignore and AGENTS.md,
// after the team's own content, so a part written here is aligned too.
ensureActiveSpaceCursor(projectDir);
// A file written here may be one the host already read for this chat.
let includeRepointed = addRootBlocks(projectDir).length > 0;
try {
  if (repointHarnessIncludes(projectDir, selection.space).length > 0) includeRepointed = true;
} catch {
  // non-fatal — includes self-heal on the next /aidlc / switch / --doctor
}

// What the host loaded into this chat, so `next` can tell whether the chat
// already holds a stage's rule text (#2023). A failure only means the full
// text is sent, so it never blocks the start.
if (sessionId && !rebindCheckOnly) {
  try {
    recordRulesLoad(projectDir, sessionId, source, selection.space, rolloutPath, includeRepointed);
  } catch {
    // the next stage gets its rules in full
  }
}

// Kiro IDE: a repo that committed the steering file before AI-DLC wrote the
// memory text into it keeps tracking it; the person is asked once.
let trackedSteeringAsk = "";
if (sessionId && !rebindCheckOnly) {
  try {
    trackedSteeringAsk = trackedKiroIdeSteeringAsk(projectDir);
  } catch {
    // Asked at a later start.
  }
}

const stateFile = stateFilePathForSelection(projectDir, selection);

// No workflow joined — retain only the session identity recorded above.
if (!existsSync(stateFile)) {
  if (sessionId) {
    let rejoin = "";
    // The per-prompt rebind probe relays an offer through a blocking channel, so
    // it offers a given rejoin once.
    const rejoinSignature = rejoinRecord?.intent ? `rejoin:${rejoinRecord.space}/${rejoinRecord.intent}` : "";
    const offerNow = rejoinSignature !== "" &&
      (!rebindCheckOnly || readSessionRebindOffer(projectDir, sessionId) !== rejoinSignature);
    if (rejoinRecord?.intent && isSafeIntentRecordName(rejoinRecord.intent) && offerNow) {
      if (rebindCheckOnly) writeSessionRebindOffer(projectDir, sessionId, rejoinSignature);
      const slug = intentDisplayLabel(
        listIntents(projectDir, rejoinRecord.space).find((entry) => entry.dirName === rejoinRecord.intent) ??
          { dirName: rejoinRecord.intent },
      );
      const entrySkill = entrySkillInvocation();
      // The record name selects exactly this record; the label is display only.
      const command =
        rejoinRecord.space === activeSpace(projectDir)
          ? `\`${entrySkill} intent ${rejoinRecord.intent}\``
          : `\`${entrySkill} space ${rejoinRecord.space}\`, then \`${entrySkill} intent ${rejoinRecord.intent}\``;
      rejoin =
        `\nINTENT REBIND OFFER: This conversation was working ${slug}, but it has not joined that workflow on this machine. ` +
        `Rejoin ${slug}? [Y/n] - on Yes, run ${command}; on No, continue without a workflow.`;
      if (rebindCheckOnly) {
        writeSessionSelectionNotice(
          projectDir,
          sessionId,
          `This chat was working on ${slug}, which it has not joined on this machine, so it carries on without a workflow. ` +
            `To pick ${slug} up again, run ${command}.`,
        );
      }
    }
    process.stdout.write(hookContextLine(
      "SessionStart",
      `AIDLC Runtime Session: ${sessionId}\n` +
        "Use this exact value for any Plan Approval --session argument in this conversation." +
        rejoin +
        (rebindCheckOnly ? "" : switchOffContext(projectDir)) +
        (trackedSteeringAsk ? `\n${trackedSteeringAsk}` : ""),
    ));
  }
  return 0;
}

// Write health heartbeat
const healthDir = hooksHealthDir(
  projectDir,
  selection.intent ?? undefined,
  selection.space,
);
writeHookStatusFile(healthDir, "session-start.last", isoTimestamp());

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

// --- Commit-provenance anchor sweep (OPT-IN) ----------------------------------
//
// OFF by default, and deliberately so. Anchors are enrichment: `attest resolve`
// recomputes attribution from committed receipts + evidence and never reads a
// SOURCE_COMMITTED row, so nothing in the resolver degrades when the sweep never
// runs. That makes an implicit audit-record write on every session start pure
// cost — startup work plus a mutation of the append-only trail that the user did
// not ask for. Writing to the audit trail is an explicit act; `aidlc attest
// anchor --reconcile` is that act.
//
// Set AIDLC_SESSION_ANCHOR=1 to opt in. Humans commit manually, mostly between
// sessions, so a session start is the only automatic observation point that
// exists; a team that wants the audit trail to name landed commits without
// remembering a command can turn this on. Dedupe against prior anchors and
// SWARM_SOURCE_MERGED receipts lives inside runAnchor, so re-running every
// session is idempotent, and the eventType gate keeps it off compact resumes
// and rebind probes. See docs/reference/20-commit-provenance.md §7.
if (eventType && process.env.AIDLC_SESSION_ANCHOR === "1") {
  try {
    runAnchor(projectDir, { reconcile: true, maxCommits: 25 });
  } catch {
    // Best-effort: a project dir that is not a git repository (and has no
    // sole recorded repo to auto-select) or a transient git failure must
    // never break session startup.
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
      // The offer's commands carry the record name, so only a name in the record-name shape is offered.
      if (was && isSafeIntentRecordName(was.dirName)) {
        const signature =
          `${was.space}/${was.dirName}->${activeSp}/${liveDir ?? "(none)"}`;
        const alreadyOffered =
          readSessionRebindOffer(projectDir, sessionId) === signature;
        const live = liveUuid ? findIntentByUuid(projectDir, liveUuid) : null;
        const liveSlug = live ? intentDisplayLabel(live) : "(none)";
        const entrySkill = entrySkillInvocation();
        // The cursor verb switches within the active space. When the stamped
        // intent lives elsewhere, prefix the space switch. Use the harness's
        // native entry skill so Codex never receives a slash command.
        const switchInstruction =
          was.space === activeSp
            ? `run \`${entrySkill} intent ${was.dirName}\``
            : `first run \`${entrySkill} space ${was.space}\`; after it completes, run \`${entrySkill} intent ${was.dirName}\``;
        if (!alreadyOffered) {
          rebindOffer =
            `INTENT REBIND OFFER: This conversation is bound to ${intentDisplayLabel(was)}, but the shared cursor names ${liveSlug}. ` +
            `Move the shared cursor back to ${intentDisplayLabel(was)}? [Y/n] - on Yes, ${switchInstruction}; ` +
            `on No, keep working ${intentDisplayLabel(was)} through this session binding. This changes only machine-local navigation.\n`;
          writeSessionRebindOffer(projectDir, sessionId, signature);
          if (rebindCheckOnly) {
            // The prompt that ran this probe goes through on this chat's own
            // work: its binding (or, for a chat stamped by an earlier version,
            // the binding written from that stamp above) selected it.
            const wasLabel = intentDisplayLabel(was);
            writeSessionSelectionNotice(
              projectDir,
              sessionId,
              `Another chat selected ${liveSlug}; this chat stays on ${wasLabel}. ` +
                `To make ${wasLabel} the selected work again, ${switchInstruction}.`,
            );
          }
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

// Cursor's prompt hook cannot add context, so the probe's offer reaches the
// person as the line written above, on the conversation's next directive; the
// prompt itself always goes through. Consume a real drift here so the same
// line is not written again for the same move.
if (rebindCheckOnly) {
  if (rebindOffer) {
    if (binding && selectedUuid) {
      writeSessionIntentUuid(projectDir, sessionId, selectedUuid);
    } else if (liveUuid) {
      writeSessionIntentUuid(projectDir, sessionId, liveUuid);
    }
    process.stdout.write(hookContextLine("SessionStart", `AIDLC Runtime Session: ${sessionId}\n${rebindOffer}`));
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
// The Unit's own stage is named when it is not Current Stage. Solo unit-major
// Construction keeps Current Stage on the first per-unit stage while each Unit
// works through the later ones, so there it is the step in progress (#1411).
// Both come from the state file, so the step is named only when Unit Stage is
// a real per-unit stage and Active Unit a valid Unit name.
const activeUnit = getField(content, "Active Unit");
const unitStageNode = findStageBySlug(getField(content, "Unit Stage")?.trim() ?? "");
const unitStage = unitStageNode && isPerUnitStage(unitStageNode) ? unitStageNode.slug : null;
const stepUnit = activeUnit && UNIT_NAME_REGEX.test(activeUnit.trim()) ? activeUnit.trim() : null;
// Only while Current Stage is itself a per-unit stage: a jump that left the
// per-unit stages leaves the Unit mirror behind, and its step is not current.
const currentNode = findStageBySlug(stage);
const inUnitStages = currentNode !== undefined && isPerUnitStage(currentNode);
const laterUnitStage = stepUnit && unitStage && inUnitStages && unitStage !== stage ? unitStage : null;
const unitByUnit =
  getField(content, "Construction Iteration")?.trim() === "unit-major" &&
  getField(content, "Unit Ownership")?.trim() !== "team";
const unitLine = activeUnit
  ? `Active Unit: ${activeUnit}${laterUnitStage ? ` on ${laterUnitStage}` : ""} (${getField(content, "Unit State") ?? "in-progress"}` +
    `${getField(content, "Unit Pause Reason") ? `; reason: ${getField(content, "Unit Pause Reason")}` : ""}` +
    `${getField(content, "Unit Next Action") ? `; next: ${getField(content, "Unit Next Action")}` : ""})\n` +
    (laterUnitStage && unitByUnit
      ? `Current Step: ${laterUnitStage} for unit ${stepUnit}. Construction runs one unit at a time, ` +
        `so Current Stage stays ${stage} until every unit is done.\n`
      : "")
  : "";

// Check for compaction recovery breadcrumb
const recoveryFile = recoveryFilePath(
  projectDir,
  selection.intent ?? undefined,
  selection.space,
);
const recovery = existsSync(recoveryFile)
  ? "NOTE: A compaction recovery breadcrumb exists at .aidlc-engine/recovery.md - check if state was preserved correctly.\n"
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
      `Run \`${aidlcToolInvocation("graph")} compile\` to include them, then start a fresh workflow (an in-flight workflow keeps its original stage set).\n`;
  }
} catch {
  // Drift check failed, never block startup over an advisory.
}

// Where the tool hides the Stop note from the person, the agent says its line.
let hidesTheNote = false;
try {
  hidesTheNote = hidesStopNote(runtimeHarnessName(projectDir));
} catch {
  // An unreadable install keeps the default step.
}
const sayTheLine = hidesTheNote
  ? ". This tool does not show that line to the person, so if you carry on with the work, first say it to them once, on its own line, and nothing else about it."
  : ", and say nothing about it.";

const context = `AIDLC WORKFLOW ACTIVE
${rebindOffer}Scope: ${scope}
Runtime Session: ${sessionId || "(unavailable)"}
Lifecycle Phase: ${phase}
Current Stage: ${stage}
Status: ${status}
Active Agent: ${agent}
Last Completed: ${last}
Next Action: ${next}
${unitLine}${recovery}${driftNote}${switchOffContext(projectDir).trimStart()}A BARE /aidlc re-entry carries on with this work, the same as /aidlc --resume: send the first \`next\` as \`next --resume\` and continue directly, with no resume menu. Then follow the recovery protocol's Session resume, including its one SAY line. When the person asks to redo, jump, or start fresh (at an approval gate too, where it is that request and not the gate's answer), report it with \`report --result resumed --choice <redo|jump|fresh>\` (add \`--target <stage slug>\` for the stage they named, and \`--unit <unit>\` or \`--every-unit\` when they named a Unit or said every Unit) and follow the print it returns. Check the active intent's aidlc-state.md for full context.

FORWARDING-LOOP DISCIPLINE (non-negotiable — the engine owns ALL routing):
- The engine route (\`aidlc engine orchestrate\`) is the ONLY authority on the next move. You run it, you do EXACTLY what its one directive says, and you report stage-work outcomes. Repeat only when the directive calls for continuation; a terminal directive or required human wait ends the turn. You never re-derive routing yourself.
- STEP 1: YOUR VERY FIRST ACTION: take everything the user typed after \`/aidlc\` and append it to the first \`next\` call UNCHANGED. The flags ARE the user's intent; dropping them sends the workflow to the wrong place. \`/aidlc --phase ideation\` -> you MUST run \`next --phase ideation\`, never bare \`next\`. \`/aidlc --stage X\` -> \`next --stage X\`. \`/aidlc\` alone -> \`next --resume\` (this work is active). Before running that first \`next\`, verify: if the user's message contained \`--phase\`/\`--stage\`/\`--scope\`/\`--depth\`/freeform text, it MUST appear on your \`next\` command; a bare \`next\` when the user gave arguments is a bug.
- When a directive is \`{kind:"print"}\` whose message names a command to run (e.g. \`aidlc engine jump execute ...\`, a scope/config change, or \`init\`): that named command is your IMMEDIATE next tool call. Run THAT EXACT command FIRST. Do NOT run \`next\` again, do NOT read more files, do NOT plan a stage — until the named command has run. Re-running the engine before it is a protocol violation that silently skips the move.
- After the named command, obey the message's ending. If it says "then stop", print the command's output and END THE TURN: no \`next\`, \`report\`, or stage work. In particular, \`/aidlc space default\` and other terminal workspace navigation stop even when the destination has an unfinished intent. Selecting it does not request resuming it. Continue only when the directive explicitly says to continue.
- If you end a turn while this work still needs you, AI-DLC answers with one line, "AI-DLC is carrying on with <stage>." It is from AI-DLC, not the person: never record it as their answer${sayTheLine} Follow the aidlc skill's "When AI-DLC carries on by itself" steps; in short: if you just asked the person a question you have not recorded, record it with \`log decision\` and end the turn without asking it again or saying anything else; if you were doing the work of a \`run-stage\` you still hold, finish its steps and run the \`report\` built from it (its stage, plus \`--unit\` in team-owned Unit work); otherwise \`continue\` with the rules receipt you hold, or run \`next\`, and follow the step it returns.${trackedSteeringAsk ? `\n\n${trackedSteeringAsk}` : ""}`;

process.stdout.write(hookContextLine("SessionStart", context));
return 0;
}

if (import.meta.main) {
  process.exit(await run(await Bun.stdin.text()));
}
