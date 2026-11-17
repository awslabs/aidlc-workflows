#!/usr/bin/env bun
// aidlc-cursor-adapter.ts — the Cursor hook shim (AUTHORED shell file; the
// aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared with the
// Claude Code harness). Modeled on codex's aidlc-codex-adapter.ts: ONE shim
// normalizes the Cursor payload to the ClaudeCodeHookInput shape and hands it
// to the named core hook: the guards run inside this process, the rest as a
// subprocess.
//
// Cursor payloads (live corpus, cursor-agent 2026.07.23 on Linux; the IDE
// shares the hooks.json surface) are near-isomorphic to Claude Code's with
// these load-bearing differences:
//   1. Event names are camelCase (sessionStart, preToolUse, ...) and each
//      event has its OWN stdout output schema — PreToolUse must emit
//      {"permission":"allow"|"deny"} JSON (deny may add agent_message),
//      NOT Claude's exit 2 + stderr (exit 2 does block, but the reason
//      channel is the JSON field; empty allow stdout is invalid JSON, so
//      failClosed IDE denies while the CLI treats silence as allow);
//      sessionStart context is {"additional_context"} (snake_case), and stop
//      cannot block at all — only {"followup_message"} (advisory nudge).
//   2. The shell tool is named "Shell" (tool_input.command, like Bash).
//      Read/Write/Edit/Task already match Claude's names and input shapes;
//      an edit reported as "StrReplace" (tool_input.path, never captured
//      live) is handed on as Edit.
//   3. No duplicate delivery (unlike Codex) and a REAL sessionEnd event
//      (unlike Codex/Copilot) — no replay cache, no heartbeat reconcile.
//   4. subagentStart/subagentStop are documented but NEVER fire on the CLI
//      (live-verified): subagent tracking rides Task tool events. Subagent-side
//      calls carry no identity and no usable lineage (transcript_path is null
//      at preToolUse time and, when present, names the subagent's OWN
//      conversation, never its parent). What IS reliable: sessionStart and
//      beforeSubmitPrompt fire ONLY for top-level conversations — a Task
//      subagent runs without either. The adapter therefore keeps a protected
//      project-local registry of known top-level conversations plus one record
//      per Task spawn, and attributes a call to the subagent only when its
//      conversation is not a known top-level one while spawn records are live.
//
// Usage (wired in .cursor/hooks.json, cwd = project root):
//   bun .cursor/hooks/aidlc-cursor-adapter.ts <target>
// where <target> ∈ session-start | session-end | mint | guards |
//                  audit-and-sensors | task-failure | runtime-compile |
//                  validate-state | stop

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decideFence,
  engineDirFor,
  enterHookWorkflow,
  promptMovesSelection,
  recordHookDrop,
  runHookHere,
  takeSessionSelectionNotice,
} from "../tools/aidlc-lib.ts";
import { settleClaudeTurnsFirst } from "../tools/aidlc-claude-turn-pending.ts";
import { aidlcDispatcherInvocation, aidlcInvocation, knownActiveSpace } from "../tools/aidlc-runtime-paths.ts";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

interface CursorHookInput {
  hook_event_name?: string;
  conversation_id?: string;
  generation_id?: string;
  session_id?: string;
  cwd?: string;
  workspace_roots?: string[];
  transcript_path?: string | null;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
  tool_use_id?: string;
  reason?: string;
  source?: string;
  prompt?: string;
  user_message?: string;
  is_background_agent?: boolean;
}

export async function run(
  target: string,
  input: string,
  _extraArgs: string[] = [],
): Promise<number> {
  let rawInput = "";
  let cursor: CursorHookInput = {};
  if (!process.stdin.isTTY) {
    try {
      rawInput = input;
      if (rawInput.length > 0) cursor = JSON.parse(rawInput) as CursorHookInput;
    } catch {
      if (target === "guards") {
        process.stdout.write(`${JSON.stringify({
          permission: "deny",
          agent_message:
            "AIDLC could not read this tool call's hook input, so its safety checks could not run and the call " +
            "was stopped. Retry it once; if it is stopped again, tell the person to quit Cursor fully and open " +
            "this folder again, since Cursor sends this input itself.",
        })}\n`);
      }
      return 0;
    }
  }
  // A Cursor IDE report has the edit tool arriving as "StrReplace" with the
  // file in tool_input.path (never captured live). The core hooks know that
  // call as "Edit" with tool_input.file_path, so it is handed on as one here,
  // before any check or the audit reads it.
  if (cursor.tool_name === "StrReplace") {
    const toolInput = cursor.tool_input ?? {};
    cursor = {
      ...cursor,
      tool_name: "Edit",
      tool_input: { ...toolInput, file_path: toolInput.file_path ?? toolInput.path },
    };
  }

  const projectDirRaw =
    process.env.AIDLC_PROJECT_DIR ??
    process.env.CURSOR_PROJECT_DIR ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.cwd();
  const projectDir = isAbsolute(projectDirRaw)
    ? projectDirRaw
    : resolve(process.cwd(), projectDirRaw);
  const sessionId = cursor.session_id ?? cursor.conversation_id;
  // What a core hook is given on top of this process's environment, as a child
  // or (runGuard) while it runs here.
  const projectPins = {
    AIDLC_PROJECT_DIR: projectDir,
    CLAUDE_PROJECT_DIR: projectDir,
    CURSOR_PROJECT_DIR: projectDir,
  };
  const projectEnv = { ...process.env, ...projectPins };

  // --- Core-hook subprocess plumbing ------------------------------------------

  function runCore(hookFile: string, stdinText: string): { stdout: string; code: number } {
    const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
    const hook = hookFile.replace(/^aidlc-|\.ts$/g, "");
    const authorityToken = hook === "record-human-turn" ? randomUUID() : "";
    const command = executable
      ? authorityToken
        ? [executable, "--internal-aidlc-record-human-turn", join(HOOKS_DIR, hookFile)]
        : [executable, "engine", "hook", hook]
      : authorityToken
        ? [
            process.execPath,
            join(HOOKS_DIR, "..", "tools", "aidlc.ts"),
            "--internal-aidlc-record-human-turn",
            join(HOOKS_DIR, hookFile),
          ]
        : [process.execPath, join(HOOKS_DIR, hookFile)];
    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(stdinText, "utf-8"),
      stdout: "pipe",
      stderr: "ignore",
      cwd: projectDir,
      env: authorityToken
        ? { ...projectEnv, AIDLC_INTERNAL_HUMAN_TURN_TOKEN: authorityToken }
        : projectEnv,
    });
    return { stdout: r.stdout?.toString() ?? "", code: r.exitCode ?? 0 };
  }

  function runCoreWithStderr(
    hookFile: string,
    stdinText: string,
  ): { stdout: string; stderr: string; code: number; signal: string | null } {
    const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
    const hook = hookFile.replace(/^aidlc-|\.ts$/g, "");
    const authorityToken = hook === "record-human-turn" ? randomUUID() : "";
    const command = executable
      ? authorityToken
        ? [executable, "--internal-aidlc-record-human-turn", join(HOOKS_DIR, hookFile)]
        : [executable, "engine", "hook", hook]
      : authorityToken
        ? [
            process.execPath,
            join(HOOKS_DIR, "..", "tools", "aidlc.ts"),
            "--internal-aidlc-record-human-turn",
            join(HOOKS_DIR, hookFile),
          ]
        : [process.execPath, join(HOOKS_DIR, hookFile)];
    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(stdinText, "utf-8"),
      stdout: "pipe",
      stderr: "pipe",
      cwd: projectDir,
      env: authorityToken
        ? { ...projectEnv, AIDLC_INTERNAL_HUMAN_TURN_TOKEN: authorityToken }
        : projectEnv,
    });
    return {
      stdout: r.stdout?.toString() ?? "",
      stderr: r.stderr?.toString() ?? "",
      code: r.exitCode ?? 1,
      signal: r.exitCode === null ? (r.signalCode ?? "a signal") : null,
    };
  }

  // --- Subagent-identity ledger -------------------------------------------------
  //
  // Cursor delivers NO agent identity on a subagent's own tool calls, and the
  // subagentStart/Stop events never fire on the CLI. Its payloads carry no
  // parent lineage either: transcript_path is null at preToolUse time and,
  // when present (postToolUse), names the subagent's OWN conversation
  // (agent-transcripts/<own-conversation>/<own-conversation>.jsonl — flat,
  // live-verified). What IS reliable, live-verified both ways: sessionStart
  // and beforeSubmitPrompt fire ONLY for top-level conversations, never for a
  // Task subagent's. So the adapter keeps two kinds of tmpdir markers:
  //   - a MAIN marker per top-level conversation (written at sessionStart,
  //     beforeSubmitPrompt, and for a Task spawn's own parent), and
  //   - one spawn RECORD per in-flight Task (agent + parent + task id).
  // A guard event is attributed to the subagent only when live spawn records
  // exist and the event's conversation is not a known main. A main's next
  // synchronous Task dispatch proves its prior Task returned, so that prior
  // record is retired before the new one is written. Genuine cross-parent
  // ambiguity stays conservative when a reviewer is among the live agents:
  // scope the call as that reviewer (or deny when multiple reviewer identities
  // are possible) rather than silently disabling reviewer enforcement. Each
  // attributed call refreshes the record mtimes so a long-running reviewer
  // never silently outlives the freshness window. The store lives in the
  // project runtime tree, and a delegated tool cannot name it or write over it
  // by a path its command names (touchesProtectedReviewerState). A second,
  // separately stored witness survives loss of the primary ledger so unknown
  // conversations still fail closed for every delegated role.
  const LEDGER_TTL_MS = 30 * 60 * 1000;
  const REVIEWER_DISPATCH_TTL_MS = 6 * 60 * 60 * 1000;
  const AMBIGUOUS_REVIEWER = "__aidlc_ambiguous_reviewer__";
  const REVIEW_AGENT_RE = /^aidlc-(architecture-reviewer|product-lead)-agent$/;
  const AIDLC_RUNTIME_DIR = join(projectDir, "aidlc");
  const LEDGER_DIR = join(projectDir, "aidlc", ".aidlc-cursor-subagents");
  const ledgerPrefix = "spawn-";
  const witnessPrefix = ".aidlc-cursor-subagent-";

  interface SubagentRecord {
    agent: string;
    parent: string;
    task: string;
  }

  function digest(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
  }

  function taskIdentity(): string {
    return cursor.tool_use_id ?? cursor.generation_id ?? "";
  }

  function ledgerFile(parent: string, task: string): string {
    return join(LEDGER_DIR, `${ledgerPrefix}${digest(parent)}-${digest(task)}.json`);
  }

  function mainFile(conversation: string): string {
    return join(LEDGER_DIR, `main-${digest(conversation)}.marker`);
  }

  function witnessFile(parent: string, task: string): string {
    return join(
      AIDLC_RUNTIME_DIR,
      `${witnessPrefix}${digest(parent)}-${digest(task)}.json`,
    );
  }

  function ledgerFiles(): string[] {
    try {
      return readdirSync(LEDGER_DIR)
        .filter((name) => name.startsWith(ledgerPrefix) && name.endsWith(".json"))
        .map((name) => join(LEDGER_DIR, name));
    } catch {
      return [];
    }
  }

  function witnessFiles(): string[] {
    try {
      return readdirSync(AIDLC_RUNTIME_DIR)
        .filter((name) => name.startsWith(witnessPrefix) && name.endsWith(".json"))
        .map((name) => join(AIDLC_RUNTIME_DIR, name));
    } catch {
      return [];
    }
  }

  function removeLedger(path: string): void {
    try {
      rmSync(path, { force: true });
    } catch {
      // best-effort; stale records also expire via TTL
    }
  }

  function touchMarker(path: string): void {
    const now = new Date();
    try {
      utimesSync(path, now, now);
    } catch {
      mkdirSync(LEDGER_DIR, { recursive: true });
      writeFileSync(path, "", "utf-8");
    }
  }

  function registerMain(): void {
    const conversation = cursor.conversation_id ?? "";
    if (!conversation) return;
    try {
      touchMarker(mainFile(conversation));
    } catch {
      // best-effort — a missed marker only risks widening enforcement, and
      // only while a spawn record is live
    }
  }

  // Cursor flags a background agent only on lifecycle payloads (sessionStart,
  // beforeSubmitPrompt, sessionEnd). Remember the flag per conversation so the
  // agent's stop, which carries no flag, stays out of the foreground workflow.
  function backgroundFile(): string | null {
    const conversation = cursor.conversation_id ?? sessionId;
    return conversation
      ? join(LEDGER_DIR, `background-${digest(conversation)}.marker`)
      : null;
  }

  function rememberBackground(): void {
    const path = backgroundFile();
    if (!path || typeof cursor.is_background_agent !== "boolean") return;
    try {
      if (cursor.is_background_agent) touchMarker(path);
      else removeLedger(path);
    } catch {
      // best-effort: an unrecorded background agent's stop gets the
      // foreground nudge, which is the behavior without this record
    }
  }

  function isBackground(): boolean {
    if (typeof cursor.is_background_agent === "boolean") return cursor.is_background_agent;
    const path = backgroundFile();
    if (!path) return false;
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }

  function isKnownMain(conversation: string): boolean {
    try {
      const path = mainFile(conversation);
      if (!statSync(path).isFile()) return false;
      // sessionStart/beforeSubmitPrompt are top-level-only lifecycle signals.
      // Once established, that identity remains authoritative until sessionEnd
      // removes the marker; inactivity alone must not turn a resumed main into
      // another conversation's active reviewer.
      touchMarker(path);
      return true;
    } catch {
      return false;
    }
  }

  function readRecord(path: string): SubagentRecord | null {
    try {
      if (Date.now() - statSync(path).mtimeMs > LEDGER_TTL_MS) {
        removeLedger(path);
        return null;
      }
      const record = JSON.parse(readFileSync(path, "utf-8")) as Partial<SubagentRecord>;
      if (!record.agent || !record.parent || !record.task) return null;
      return record as SubagentRecord;
    } catch {
      return null;
    }
  }

  function recordKey(record: SubagentRecord): string {
    return `${record.parent}\0${record.task}`;
  }

  function retireSpawn(record: SubagentRecord): void {
    removeLedger(ledgerFile(record.parent, record.task));
    removeLedger(witnessFile(record.parent, record.task));
  }

  let activeReviewerDispatchCache: string | null | undefined;
  function activeReviewerDispatch(): string | null {
    if (activeReviewerDispatchCache !== undefined) {
      return activeReviewerDispatchCache;
    }
    try {
      // The same active space the engine reads.
      const spacePointer = join(projectDir, "aidlc", "active-space");
      const space = existsSync(spacePointer)
        ? knownActiveSpace(join(projectDir, "aidlc"), readFileSync(spacePointer, "utf-8"))
        : "default";
      const intentsDir = join(projectDir, "aidlc", "spaces", space, "intents");
      const activePointer = join(intentsDir, "active-intent");
      const activeIntent = readFileSync(activePointer, "utf-8").trim();
      if (!activeIntent || activeIntent.includes("/") || activeIntent.includes("\\")) return null;
      const dispatch = join(engineDirFor(join(intentsDir, activeIntent)), "reviewer-dispatch.json");
      const stat = statSync(dispatch);
      activeReviewerDispatchCache =
        stat.isFile() && Date.now() - stat.mtimeMs <= REVIEWER_DISPATCH_TTL_MS
          ? dispatch
          : null;
    } catch {
      activeReviewerDispatchCache = null;
    }
    return activeReviewerDispatchCache;
  }

  function recordSpawn(subagentType: string): boolean {
    const parent = cursor.conversation_id ?? "";
    const task = taskIdentity();
    if (!parent || !task) return false;
    registerMain(); // spawning a Task proves this conversation is a main
    // Task is synchronous. If this parent can issue another Task, its previous
    // delegate has returned even though Cursor CLI emits no postToolUse event
    // for Task. Retire and log those records before opening the next dispatch.
    for (const priorPath of ledgerFiles()) {
      const prior = readRecord(priorPath);
      if (prior?.parent !== parent) continue;
      runCore(
        "aidlc-log-subagent.ts",
        JSON.stringify({
          hook_event_name: "SubagentStop",
          agent_type: prior.agent,
          ...(sessionId ? { session_id: sessionId } : {}),
        }),
      );
      retireSpawn(prior);
    }
    for (const priorPath of witnessFiles()) {
      const prior = readRecord(priorPath);
      if (prior?.parent !== parent) continue;
      retireSpawn(prior);
    }
    const path = ledgerFile(parent, task);
    const witness = witnessFile(parent, task);
    const pending = `${path}.${process.pid}.tmp`;
    const pendingWitness = `${witness}.${process.pid}.tmp`;
    const record = { agent: subagentType, parent, task };
    try {
      mkdirSync(LEDGER_DIR, { recursive: true });
      writeFileSync(pendingWitness, JSON.stringify(record), "utf-8");
      renameSync(pendingWitness, witness);
      writeFileSync(pending, JSON.stringify(record), "utf-8");
      renameSync(pending, path);
      // The record that this helper was sent, which its completion closes:
      // Cursor runs no dispatch hook of AI-DLC's, so it is forwarded here, once
      // the Task is let through. Evidence only: it never stops the Task.
      try {
        runCore(
          "aidlc-log-subagent.ts",
          JSON.stringify({
            hook_event_name: "SubagentStart",
            agent_type: subagentType,
            ...(sessionId ? { session_id: sessionId } : {}),
          }),
        );
      } catch {
        // The verdict reads a missing record as nothing sent: no line.
      }
      return true;
    } catch {
      removeLedger(pending);
      removeLedger(pendingWitness);
      retireSpawn(record);
      return false;
    }
  }

  function clearSpawn(): void {
    const parent = cursor.conversation_id ?? "";
    const task = taskIdentity();
    if (!parent) return;
    if (task) {
      retireSpawn({ agent: "", parent, task });
      return;
    }
    // Defensive fallback for a completion payload that omits tool_use_id:
    // clear only this parent conversation's records.
    for (const path of ledgerFiles()) {
      const record = readRecord(path);
      if (record?.parent === parent) retireSpawn(record);
    }
    for (const path of witnessFiles()) {
      const record = readRecord(path);
      if (record?.parent === parent) retireSpawn(record);
    }
  }

  function activeSubagent(): string {
    const conversation = cursor.conversation_id ?? "";
    if (!conversation || isKnownMain(conversation)) return "";
    const reviewerDispatch = activeReviewerDispatch();
    const ledgerPaths = ledgerFiles();
    const witnessPaths = witnessFiles();
    const live: Array<{ path: string; record: SubagentRecord }> = [];
    const witnesses = new Map<string, { path: string; record: SubagentRecord }>();
    let unreadableState = false;
    for (const path of ledgerPaths) {
      const record = readRecord(path);
      if (record) live.push({ path, record });
      else unreadableState = true;
    }
    for (const path of witnessPaths) {
      const record = readRecord(path);
      if (record) witnesses.set(recordKey(record), { path, record });
      else unreadableState = true;
    }
    if (live.length === 0) {
      return reviewerDispatch === null &&
        witnesses.size === 0 &&
        !unreadableState
        ? ""
        : AMBIGUOUS_REVIEWER;
    }
    if (
      unreadableState ||
      witnesses.size !== live.length ||
      live.some(({ record }) => {
        const witness = witnesses.get(recordKey(record))?.record;
        return !witness || witness.agent !== record.agent;
      })
    ) {
      return AMBIGUOUS_REVIEWER;
    }
    // A conversation that spawned a live Task is a main even if its marker
    // write failed.
    if (live.some(({ record }) => record.parent === conversation)) return "";
    const refresh = () => {
      // Keep an actively-working subagent attributed past the TTL: freshness
      // bounds idle staleness, not legitimate long reviews.
      for (const { path } of live) {
        try {
          utimesSync(path, new Date(), new Date());
          const record = readRecord(path);
          if (record) {
            utimesSync(
              witnesses.get(recordKey(record))?.path ?? witnessFile(record.parent, record.task),
              new Date(),
              new Date(),
            );
          }
        } catch {
          // The next call observes the broken pair and fails closed.
        }
      }
    };
    const agents = new Set(live.map(({ record }) => record.agent));
    const reviewers = [...agents].filter((agent) => REVIEW_AGENT_RE.test(agent));
    // An active reviewer dispatch is independent evidence that an unknown
    // conversation may be the reviewer. If only non-reviewer records survive,
    // partial ledger loss must not silently disable reviewer-scope enforcement.
    if (reviewerDispatch !== null && reviewers.length === 0) {
      refresh();
      return AMBIGUOUS_REVIEWER;
    }
    if (agents.size !== 1) {
      if (reviewers.length === 1) {
        refresh();
        return reviewers[0];
      }
      if (reviewers.length > 1) {
        refresh();
        return AMBIGUOUS_REVIEWER;
      }
      refresh();
      return AMBIGUOUS_REVIEWER;
    }
    refresh();
    return live[0].record.agent;
  }

  // Cursor's shell tool is "Shell"; the core hooks key on Claude's "Bash".
  // Everything else (Read/Write/Edit/Grep/Glob/Task/...) already matches, and
  // a "StrReplace" edit was handed on as Edit when the payload was read.
  const toolName = cursor.tool_name === "Shell" ? "Bash" : (cursor.tool_name ?? "");

  // Cursor is the first harness with a FIRST-CLASS file-deletion tool
  // ("Delete", tool_input.file_path; probe-verified). Every other harness
  // deletes through the shell, which reviewer-scope already reads as Bash.
  // The reviewer-scope allowlist knows nothing about "Delete" and would exit
  // early, letting a unit-scoped reviewer delete a SIBLING unit's artifacts
  // unchallenged. Present it to that guard as a path-shaped write so the same
  // scope bound applies.
  //
  // Reviewer-guard-only on purpose: the state-transition guard detects direct
  // aidlc-state.ts lifecycle commands in Bash and has no path-tool contract;
  // the audit logger derives ARTIFACT_CREATED / ARTIFACT_UPDATED from the tool
  // name, so folding Delete into Write there would log a deletion as a write.
  // Those paths keep the real name.
  const reviewerToolName = toolName === "Delete" ? "Write" : toolName;

  let attributedAgent: string | null = null;
  function attributed(): string {
    attributedAgent ??= activeSubagent();
    return attributedAgent;
  }

  // A delegate's identity serves two checks: the reviewer read scope and the
  // state-transition check. When both stand aside for this work, as Guard
  // Policy off makes them, the identity checks below protect nothing, so a
  // delegate runs its builds, tests and searches as the main chat does and
  // Cursor's own approval applies. Read once per call, through the same
  // decision the core checks make.
  let delegateChecksStandAsideCache: boolean | undefined;
  function delegateChecksStandAside(): boolean {
    if (delegateChecksStandAsideCache !== undefined) return delegateChecksStandAsideCache;
    const workflow = enterHookWorkflow(projectDir, sessionId);
    try {
      delegateChecksStandAsideCache = (["reviewer-scope", "state-transition"] as const)
        .every((fence) => decideFence(projectDir, fence).decision === "stand-aside");
    } catch {
      delegateChecksStandAsideCache = false;
    } finally {
      workflow.restore();
    }
    return delegateChecksStandAsideCache;
  }

  let effectiveCwdCache: string | undefined;
  function effectiveCwd(): string {
    if (effectiveCwdCache !== undefined) return effectiveCwdCache;
    const nested =
      cursor.tool_input?.working_directory ??
      cursor.tool_input?.cwd;
    for (const candidate of [nested, cursor.cwd]) {
      if (typeof candidate !== "string" || candidate.length === 0) continue;
      effectiveCwdCache = isAbsolute(candidate)
        ? candidate
        : resolve(projectDir, candidate);
      return effectiveCwdCache;
    }
    effectiveCwdCache = projectDir;
    return effectiveCwdCache;
  }

  function claudeShaped(eventName: string, nameOverride?: string): string {
    const agent = attributed();
    return JSON.stringify({
      ...cursor,
      hook_event_name: eventName,
      tool_name: nameOverride ?? toolName,
      cwd: effectiveCwd(),
      ...(agent && agent !== AMBIGUOUS_REVIEWER ? { agent_type: agent } : {}),
    });
  }

  type PathFlavor = "posix" | "win32";

  interface ShellWordVariant {
    value: string;
    activeGlobIndexes: number[];
    flavor: PathFlavor;
  }

  interface ShellWord {
    variants: ShellWordVariant[];
  }

  function shellWords(command: string): { words: ShellWord[]; ambiguous: boolean } {
    const words: ShellWord[] = [];
    let posixWord = "";
    let windowsWord = "";
    let posixGlobIndexes: number[] = [];
    let windowsGlobIndexes: number[] = [];
    let started = false;
    let quote: "'" | '"' | null = null;
    const push = () => {
      if (started) {
        const variants: ShellWordVariant[] = [
          { value: posixWord, activeGlobIndexes: posixGlobIndexes, flavor: "posix" },
          { value: windowsWord, activeGlobIndexes: windowsGlobIndexes, flavor: "win32" },
        ];
        const applicable =
          process.platform === "win32" && windowsWord.startsWith("~\\")
            ? variants.filter((variant) => variant.flavor === "win32")
            : variants;
        words.push({
          variants: applicable.filter(
            (variant, index) =>
              applicable.findIndex(
                (candidate) =>
                  candidate.flavor === variant.flavor &&
                  candidate.value === variant.value &&
                  candidate.activeGlobIndexes.join(",") ===
                    variant.activeGlobIndexes.join(","),
              ) === index,
          ),
        });
      }
      posixWord = "";
      windowsWord = "";
      posixGlobIndexes = [];
      windowsGlobIndexes = [];
      started = false;
    };
    const appendPosix = (ch: string, activeGlob = false) => {
      if (activeGlob) posixGlobIndexes.push(posixWord.length);
      posixWord += ch;
      started = true;
    };
    const appendWindows = (ch: string, activeGlob = false) => {
      if (activeGlob) windowsGlobIndexes.push(windowsWord.length);
      windowsWord += ch;
      started = true;
    };
    const appendBoth = (
      ch: string,
      posixActiveGlob = false,
      windowsActiveGlob = posixActiveGlob,
    ) => {
      appendPosix(ch, posixActiveGlob);
      appendWindows(ch, windowsActiveGlob);
    };

    for (let i = 0; i < command.length; i++) {
      const ch = command[i];
      if (quote === "'") {
        if (ch === "'") quote = null;
        else appendBoth(ch, false, "*?[]{}".includes(ch));
        continue;
      }
      if (ch === "\\") {
        const next = command[i + 1] ?? "";
        appendWindows("\\");
        if (!next) {
          appendPosix("\\");
          continue;
        }
        if (quote === '"') {
          if ('$`"\\\n'.includes(next)) {
            if (next !== "\n") {
              appendPosix(next);
              if (next === '"') quote = null;
              else appendWindows(next, "*?[]{}".includes(next));
            }
            i++;
          } else {
            appendPosix("\\");
          }
        } else {
          if (next !== "\n") {
            appendPosix(next);
            appendWindows(next, "*?[]{}".includes(next));
          }
          i++;
        }
        continue;
      }
      if (quote !== null) {
        if (ch === quote) quote = null;
        else appendBoth(ch, false, "*?[]{}".includes(ch));
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        started = true;
        continue;
      }
      if (/\s/.test(ch) || ";|&()<>".includes(ch)) {
        push();
        continue;
      }
      appendBoth(ch, "*?[]{}".includes(ch));
    }
    push();
    return { words, ambiguous: quote !== null };
  }

  interface ShellCommandPart {
    text: string;
    operatorAfter: "" | ";" | "\n" | "&&" | "||" | "|" | "&";
  }

  function shellCommandParts(command: string): ShellCommandPart[] {
    const segments: ShellCommandPart[] = [];
    let quote: "'" | '"' | null = null;
    let escaped = false;
    let start = 0;
    for (let i = 0; i < command.length; i++) {
      const ch = command[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" && quote !== "'") {
        escaped = true;
        continue;
      }
      if (quote !== null) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (!";\n|&".includes(ch)) continue;
      let operator = ch as ShellCommandPart["operatorAfter"];
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) {
        operator = `${ch}${ch}` as ShellCommandPart["operatorAfter"];
        i++;
      }
      segments.push({ text: command.slice(start, i - operator.length + 1), operatorAfter: operator });
      start = i + 1;
    }
    segments.push({ text: command.slice(start), operatorAfter: "" });
    return segments;
  }

  interface ReviewFreezeCommandModule {
    shellCommandInvocationDetails?: (
      command: string,
    ) => Array<{ name: string; args: string[] }>;
    shellWriteTargets?: (
      command: string,
      cwd?: string,
      rawWords?: string[],
      shell?: "posix" | "powershell",
    ) => string[];
    writeTargets?: (
      toolName: string,
      toolInput: Record<string, unknown> | undefined,
      cwd?: string,
    ) => string[];
  }

  let reviewFreezeCommandModule: Promise<ReviewFreezeCommandModule> | null =
    null;
  function loadReviewFreezeCommandModule(): Promise<ReviewFreezeCommandModule> {
    reviewFreezeCommandModule ??= import(
      join(HOOKS_DIR, "review-freeze-command.ts")
    ) as Promise<ReviewFreezeCommandModule>;
    return reviewFreezeCommandModule;
  }

  let reviewFreezeTargetsCache: string[] | null | undefined;
  async function reviewFreezeTargets(): Promise<string[] | null> {
    if (reviewFreezeTargetsCache !== undefined) {
      return reviewFreezeTargetsCache;
    }
    try {
      const module = await loadReviewFreezeCommandModule();
      reviewFreezeTargetsCache =
        typeof module.writeTargets === "function"
          ? module.writeTargets(
              reviewerToolName,
              cursor.tool_input,
              effectiveCwd(),
            )
          : null;
    } catch {
      // Null means classification was unavailable, never "no write targets";
      // the guard chain below must keep the full review-freeze hook fail-closed.
      reviewFreezeTargetsCache = null;
    }
    return reviewFreezeTargetsCache;
  }

  function protectedReviewerPaths(): string[] {
    const dispatch = activeReviewerDispatch();
    return [
      LEDGER_DIR,
      ...witnessFiles(),
      ...(dispatch === null ? [] : [dispatch]),
    ];
  }

  interface CanonicalPath {
    flavor: PathFlavor;
    value: string;
  }

  interface Canonicalization {
    paths: CanonicalPath[];
    ambiguous: boolean;
  }

  function fullyQualifiedWindows(value: string): boolean {
    const normalized = value.replaceAll("/", "\\");
    return (
      /^[A-Za-z]:\\/.test(normalized) ||
      /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(normalized)
    );
  }

  function normalizeWindowsDialect(raw: string): { value: string; ambiguous: boolean } {
    if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) {
      const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
      raw = win32.join(home, raw.slice(2));
    }
    const gitBash = raw.match(/^\/(?:cygdrive\/)?([A-Za-z])\/(.*)$/);
    let value = gitBash
      ? `${gitBash[1].toUpperCase()}:\\${gitBash[2] ?? ""}`
      : raw.replaceAll("/", "\\");
    if (/^\\\\\?\\UNC\\/i.test(value)) {
      value = `\\\\${value.slice("\\\\?\\UNC\\".length)}`;
    } else if (/^\\\\[?.]\\[A-Za-z]:\\/.test(value)) {
      value = value.slice(4);
    } else if (/^\\\?\?\\[A-Za-z]:\\/.test(value)) {
      value = value.slice(4);
    } else if (/^(?:\\\\[?.]\\|\\\?\?\\)/.test(value)) {
      return { value, ambiguous: true };
    }

    const parsed = win32.parse(value);
    const components = value.slice(parsed.root.length).split("\\");
    let ambiguous = false;
    const normalizedComponents = components.map((component, index) => {
      if (component === "." || component === ".." || component.length === 0) return component;
      let normalized = component.replace(/[ .]+$/g, "");
      const stream = normalized.indexOf(":");
      if (stream !== -1) {
        if (index !== components.length - 1) ambiguous = true;
        normalized = normalized.slice(0, stream);
      }
      if (normalized.length === 0) ambiguous = true;
      return normalized;
    });
    return {
      value: `${parsed.root}${normalizedComponents.join("\\")}`,
      ambiguous,
    };
  }

  function canonicalExistingAncestor(
    flavor: PathFlavor,
    candidate: string,
  ): { path?: string; ambiguous: boolean } {
    const hostFlavor: PathFlavor = process.platform === "win32" ? "win32" : "posix";
    if (flavor !== hostFlavor) return { ambiguous: false };
    const api = flavor === "win32" ? win32 : posix;
    const missingSegments: string[] = [];
    let cursor = candidate;
    while (true) {
      try {
        lstatSync(cursor);
        try {
          return {
            path: api.resolve(realpathSync.native(cursor), ...missingSegments),
            ambiguous: false,
          };
        } catch {
          return { ambiguous: true };
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") return { ambiguous: true };
      }
      const parent = api.dirname(cursor);
      if (parent === cursor) return { ambiguous: true };
      missingSegments.unshift(api.basename(cursor));
      cursor = parent;
    }
  }

  function expandPosixTilde(
    raw: string,
    cwd: string,
  ): { value: string; ambiguous: boolean } {
    const home = (process.env.HOME ?? homedir()).replaceAll("\\", "/");
    if (raw === "~") return { value: home, ambiguous: false };
    if (raw.startsWith("~/")) {
      return { value: posix.join(home, raw.slice(2)), ambiguous: false };
    }
    if (raw === "~+") return { value: cwd, ambiguous: false };
    if (raw.startsWith("~+/")) {
      return { value: posix.join(cwd, raw.slice(3)), ambiguous: false };
    }
    const oldPwd = process.env.OLDPWD?.replaceAll("\\", "/");
    if (raw === "~-" || raw.startsWith("~-/")) {
      if (!oldPwd || !posix.isAbsolute(oldPwd)) return { value: raw, ambiguous: true };
      return {
        value: raw === "~-" ? oldPwd : posix.join(oldPwd, raw.slice(3)),
        ambiguous: false,
      };
    }

    const named = raw.match(/^~([^/]+)(?:\/(.*))?$/);
    if (!named) return { value: raw, ambiguous: false };
    const username = named[1];
    let namedHome: string | undefined;
    if (process.platform !== "win32") {
      try {
        const row = readFileSync("/etc/passwd", "utf-8")
          .split(/\r?\n/)
          .find((line) => line.split(":", 1)[0] === username);
        const fields = row?.split(":");
        if (fields?.[5]) namedHome = fields[5];
      } catch {
        // Missing account data leaves the shell identity ambiguous.
      }
    }
    const currentUser = process.env.USER ?? process.env.LOGNAME ?? process.env.USERNAME;
    if (!namedHome && currentUser === username) namedHome = home;
    if (!namedHome || !posix.isAbsolute(namedHome)) {
      return { value: raw, ambiguous: true };
    }
    return {
      value: named[2] ? posix.join(namedHome, named[2]) : namedHome,
      ambiguous: false,
    };
  }

  function canonicalPathVariants(
    raw: string,
    cwd: string,
    flavorHint?: PathFlavor,
  ): Canonicalization {
    const out = new Map<string, CanonicalPath>();
    let ambiguous = false;
    const store = (flavor: PathFlavor, value: string): void => {
      const api = flavor === "win32" ? win32 : posix;
      let normalized = api.normalize(value);
      const root = api.parse(normalized).root;
      while (
        normalized.length > root.length &&
        (normalized.endsWith("/") || normalized.endsWith("\\"))
      ) {
        normalized = normalized.slice(0, -1);
      }
      if (flavor === "win32") normalized = normalized.replaceAll("\\", "/").toLowerCase();
      const key = `${flavor}:${normalized}`;
      out.set(key, { flavor, value: normalized });
    };
    const add = (flavor: PathFlavor, value: string): void => {
      let normalizedValue = value;
      if (flavor === "win32") {
        const normalized = normalizeWindowsDialect(value);
        ambiguous ||= normalized.ambiguous;
        if (normalized.ambiguous) return;
        normalizedValue = normalized.value;
      }
      const api = flavor === "win32" ? win32 : posix;
      const lexical = api.normalize(normalizedValue);
      store(flavor, lexical);
      const real = canonicalExistingAncestor(flavor, lexical);
      ambiguous ||= real.ambiguous;
      if (real.path) {
        if (flavor === "win32") {
          const normalized = normalizeWindowsDialect(real.path);
          ambiguous ||= normalized.ambiguous;
          if (!normalized.ambiguous) store(flavor, normalized.value);
        } else {
          store(flavor, real.path);
        }
      }
    };

    if (flavorHint !== "win32") {
      const posixCwd = cwd.replaceAll("\\", "/");
      const expanded = expandPosixTilde(raw, posixCwd);
      ambiguous ||= expanded.ambiguous;
      const posixRaw = expanded.value;
      if (!fullyQualifiedWindows(posixRaw) && posix.isAbsolute(posixCwd)) {
        add("posix", posix.resolve(posixCwd, posixRaw));
      }
    }

    if (flavorHint !== "posix") {
      const normalizedRaw = normalizeWindowsDialect(raw);
      const normalizedCwd = normalizeWindowsDialect(cwd);
      ambiguous ||= normalizedRaw.ambiguous || normalizedCwd.ambiguous;
      if (!normalizedRaw.ambiguous && !normalizedCwd.ambiguous) {
        if (fullyQualifiedWindows(normalizedRaw.value)) {
          add("win32", win32.resolve(normalizedRaw.value));
        } else if (fullyQualifiedWindows(normalizedCwd.value)) {
          add("win32", win32.resolve(normalizedCwd.value, normalizedRaw.value));
        }
      }
    }
    return { paths: [...out.values()], ambiguous };
  }

  function isWithinPath(child: string, parent: string): boolean {
    return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
  }

  function shortNameGlobTouchesProtected(
    pattern: string,
    cwd: string,
    protectedPaths: readonly string[],
    flavorHint?: PathFlavor,
  ): boolean {
    if (flavorHint !== "win32") return false;
    const normalized = normalizeWindowsDialect(pattern);
    if (normalized.ambiguous) return true;
    const parsed = win32.parse(normalized.value);
    const components = normalized.value.slice(parsed.root.length).split("\\");
    const shortIndex = components.findIndex(
      (component) => component.includes("~") && /[*?[\]{}]/.test(component),
    );
    if (shortIndex === -1) return false;
    const base = win32.join(parsed.root, ...components.slice(0, shortIndex));
    const directories = canonicalPathVariants(base, cwd, "win32");
    if (directories.ambiguous || directories.paths.length === 0) return true;
    const protectedResults = protectedPaths.map((path) =>
      canonicalPathVariants(path, projectDir)
    );
    if (protectedResults.some((result) => result.ambiguous || result.paths.length === 0)) {
      return true;
    }
    const protectedVariants = protectedResults.flatMap((result) => result.paths);
    const globMatches = (glob: string, value: string): boolean => {
      let source = "^";
      for (const ch of glob) {
        if (ch === "*") source += ".*";
        else if (ch === "?") source += ".";
        else source += ch.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
      }
      return new RegExp(`${source}$`, "i").test(value);
    };
    const shortComponentMatches = (glob: string, longName: string): boolean => {
      const tilde = glob.indexOf("~");
      if (tilde === -1) return globMatches(glob, longName);
      const stem = glob.slice(0, tilde);
      const shortSource = longName.replace(/^[ .]+/, "").replace(/[ .]/g, "");
      return globMatches(`${stem}*`, shortSource);
    };
    return directories.paths.some((directory) =>
      protectedVariants.some((protectedPath) => {
        if (directory.flavor !== protectedPath.flavor) return false;
        const relative = posix.relative(directory.value, protectedPath.value);
        if (relative === ".." || relative.startsWith("../")) return false;
        const protectedComponents = relative.split("/");
        if (!shortComponentMatches(components[shortIndex], protectedComponents[0] ?? "")) {
          return false;
        }
        return components.slice(shortIndex + 1).every(
          (component, index) =>
            protectedComponents[index + 1] !== undefined &&
            globMatches(component, protectedComponents[index + 1]),
        );
      })
    );
  }

  function overlapsProtectedPath(
    candidate: string,
    protectedPaths: readonly string[],
    cwd = projectDir,
    flavorHint?: PathFlavor,
  ): boolean {
    const candidates = canonicalPathVariants(candidate, cwd, flavorHint);
    const protectedResults = protectedPaths.map((path) =>
      canonicalPathVariants(path, projectDir)
    );
    const protectedVariants = protectedResults.flatMap((result) => result.paths);
    if (
      candidates.ambiguous ||
      protectedResults.some((result) => result.ambiguous || result.paths.length === 0)
    ) {
      return true;
    }
    if (candidates.paths.length === 0) return flavorHint === undefined;
    return candidates.paths.some((normalized) =>
      protectedVariants.some(
        (protectedPath) =>
          normalized.flavor === protectedPath.flavor &&
          (isWithinPath(normalized.value, protectedPath.value) ||
            isWithinPath(protectedPath.value, normalized.value)),
      )
    );
  }

  function globPrefixTouchesProtected(
    raw: string,
    cwd: string,
    protectedPaths: readonly string[],
    globIndex = raw.search(/[*?[\]{}]/),
    flavorHint?: PathFlavor,
  ): boolean {
    if (["{", "}", "(", ")"].includes(raw)) return false;
    if (globIndex === -1) return false;
    let prefix = raw.slice(0, globIndex);
    const equals = prefix.lastIndexOf("=");
    if (equals !== -1) prefix = prefix.slice(equals + 1);
    const bracedPwd = "$" + "{PWD}";
    if (prefix === "$PWD" || prefix === bracedPwd) {
      prefix = cwd;
    } else if (prefix.startsWith("$PWD/") || prefix.startsWith("$PWD\\")) {
      prefix = `${cwd}${prefix.slice("$PWD".length)}`;
    } else if (
      prefix.startsWith(`${bracedPwd}/`) ||
      prefix.startsWith(`${bracedPwd}\\`)
    ) {
      prefix = `${cwd}${prefix.slice(bracedPwd.length)}`;
    }
    const expandedPattern = `${prefix}${raw.slice(globIndex)}`;
    if (shortNameGlobTouchesProtected(expandedPattern, cwd, protectedPaths, flavorHint)) {
      return true;
    }
    const candidates = canonicalPathVariants(prefix, cwd, flavorHint);
    if (candidates.ambiguous) return true;
    if (candidates.paths.length === 0) return flavorHint === undefined;
    const protectedResults = protectedPaths.map((path) =>
      canonicalPathVariants(path, projectDir)
    );
    if (protectedResults.some((result) => result.ambiguous || result.paths.length === 0)) {
      return true;
    }
    const protectedVariants = protectedResults.flatMap((result) => result.paths);
    return candidates.paths.some((candidate) =>
      protectedVariants.some(
        (protectedPath) =>
          candidate.flavor === protectedPath.flavor &&
          protectedPath.value.startsWith(candidate.value),
      )
    );
  }

  function concreteWordTouchesProtected(
    raw: string,
    cwd: string,
    protectedPaths: readonly string[],
    hasActiveGlob = /[*?[\]{}]/.test(raw),
    flavorHint?: PathFlavor,
  ): boolean {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) return false;
    const equals = raw.lastIndexOf("=");
    const candidate = (equals === -1 ? raw : raw.slice(equals + 1))
      .replace(/^[,:[\]{}()]+|[,:[\]{}()]+$/g, "");
    if (
      candidate.length === 0 ||
      candidate.startsWith("-") ||
      /[$`]/.test(candidate) ||
      hasActiveGlob ||
      (!candidate.includes("/") && !candidate.includes("\\") && !candidate.startsWith("."))
    ) {
      return false;
    }
    return overlapsProtectedPath(candidate, protectedPaths, cwd, flavorHint);
  }

  interface ShellCwdState {
    cwd: string;
    stack: string[];
    status: "success" | "failure" | "unknown";
    logicalAmbiguous: boolean;
  }

  const MAX_SHELL_CWD_STATES = 128;

  function shellCwdIdentity(path: string, flavor: PathFlavor): string {
    const hostFlavor: PathFlavor = process.platform === "win32" ? "win32" : "posix";
    const api = flavor === "win32" ? win32 : posix;
    let identity = api.normalize(path);
    if (flavor === hostFlavor) {
      try {
        identity = realpathSync.native(path);
      } catch {
        // A missing or synthetic cross-platform path retains its lexical identity.
      }
    }
    identity = api.normalize(identity);
    return flavor === "win32" ? identity.toLowerCase() : identity;
  }

  function shellCwdStateKey(state: ShellCwdState, flavor: PathFlavor): string {
    return [
      shellCwdIdentity(state.cwd, flavor),
      ...state.stack.map((path) => shellCwdIdentity(path, flavor)),
      state.status,
    ].join("\0");
  }

  function updateShellCwd(
    words: readonly ShellWord[],
    flavor: PathFlavor,
    state: ShellCwdState,
  ): "none" | "location" | "ambiguous" {
    const values = words
      .map((word) => word.variants.find((variant) => variant.flavor === flavor)?.value)
      .filter((value): value is string => value !== undefined);
    let index = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(values[index] ?? "")) index++;
    while (["command", "builtin"].includes((values[index] ?? "").toLowerCase())) {
      index++;
      if (values[index] === "--") index++;
    }
    const controlHead = ["if", "elif", "while", "until", "case", "for", "select", "function"].includes(
      (values[index] ?? "").toLowerCase(),
    );
    const controlContext =
      controlHead ||
      values.some((value) => ["{", "then", "else", "do"].includes(value.toLowerCase()));
    while (["{", "then", "else", "do", "!"].includes((values[index] ?? "").toLowerCase())) {
      index++;
    }
    if (["if", "elif", "while", "until"].includes((values[index] ?? "").toLowerCase())) {
      index++;
    }
    const cwdCommands = new Set([
      "cd",
      "chdir",
      "pushd",
      "push-location",
      "set-location",
      "sl",
      "popd",
      "pop-location",
    ]);
    const leafName = (value: string): string =>
      win32.basename(posix.basename(value)).toLowerCase();
    if (controlContext && !cwdCommands.has(leafName(values[index] ?? ""))) {
      const nested = values.findIndex(
        (value, candidate) => candidate > index && cwdCommands.has(leafName(value)),
      );
      if (nested !== -1) index = nested;
    }
    const executable = values[index];
    if (!executable) return "none";
    const name = leafName(executable);
    if (["popd", "pop-location"].includes(name)) {
      if (state.logicalAmbiguous) return "ambiguous";
      const restored = state.stack.pop();
      if (!restored) return "ambiguous";
      state.cwd = restored;
      return "location";
    }
    const push = ["pushd", "push-location"].includes(name);
    if (
      !push &&
      !["cd", "chdir", "set-location", "sl"].includes(name)
    ) {
      return "none";
    }
    if (state.logicalAmbiguous && push) return "ambiguous";

    const args = values.slice(index + 1);
    let operand = "";
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (["-path", "-literalpath"].includes(arg.toLowerCase())) {
        operand = args[i + 1] ?? "";
        break;
      }
      if (["/d", "-l", "-p", "--"].includes(arg.toLowerCase())) continue;
      if (arg.startsWith("-")) continue;
      operand = arg;
      break;
    }
    if (!operand) operand = "~";
    if (/[$`*?[\]{}]/.test(operand)) return "ambiguous";
    if (
      state.logicalAmbiguous &&
      (operand === "-" ||
        operand.startsWith("~") ||
        operand.replaceAll("\\", "/").split("/").includes(".."))
    ) {
      return "ambiguous";
    }

    let next: string;
    if (flavor === "posix") {
      if (operand === "-") operand = "~-";
      const expanded = expandPosixTilde(operand, state.cwd.replaceAll("\\", "/"));
      if (expanded.ambiguous) return "ambiguous";
      let base = state.cwd.replaceAll("\\", "/");
      if (state.logicalAmbiguous && !posix.isAbsolute(expanded.value)) {
        try {
          base = realpathSync.native(state.cwd).replaceAll("\\", "/");
        } catch {
          return "ambiguous";
        }
      }
      next = posix.resolve(base, expanded.value);
      if (posix.isAbsolute(expanded.value)) state.logicalAmbiguous = false;
    } else {
      const normalized = normalizeWindowsDialect(operand);
      if (normalized.ambiguous) return "ambiguous";
      let base = state.cwd;
      if (state.logicalAmbiguous && !fullyQualifiedWindows(normalized.value)) {
        try {
          base = realpathSync.native(state.cwd);
        } catch {
          return "ambiguous";
        }
      }
      next = win32.resolve(base, normalized.value);
      if (fullyQualifiedWindows(normalized.value)) state.logicalAmbiguous = false;
    }
    if (push) state.stack.push(state.cwd);
    state.cwd = next;
    return "location";
  }

  function pathOperandValues(toolInput: Record<string, unknown>): string[] {
    const values: string[] = [];
    const append = (value: unknown): void => {
      if (typeof value === "string") values.push(value);
      else if (Array.isArray(value)) {
        for (const item of value) append(item);
      }
    };
    for (const [key, value] of Object.entries(toolInput)) {
      if (key === "cwd" || key === "working_directory" || key === "command") continue;
      if (
        key === "path" ||
        key === "file" ||
        key === "source" ||
        key === "target" ||
        key === "destination" ||
        key.endsWith("_path") ||
        key.endsWith("_file")
      ) {
        append(value);
      }
    }
    return values;
  }

  // The words a shell line writes, as the shared reader names them in either
  // shell's reading: the target words as written (globs and variables kept),
  // and for a directory destination its resolved child paths. `unnamed` when it
  // writes what the reader cannot name: the reader then gives back the folder
  // it reads from (a wrapper it cannot follow, xargs feeding a mutator, a
  // piped cmdlet), and it does not follow `find -exec`; or the reader failed.
  async function shellWriteWords(command: string, cwd: string): Promise<{ words: Set<string>; unnamed: boolean }> {
    try {
      const module = await loadReviewFreezeCommandModule();
      if (typeof module.shellWriteTargets !== "function" || typeof module.shellCommandInvocationDetails !== "function") {
        return { words: new Set(), unnamed: true };
      }
      const raw: string[] = [];
      for (const shell of ["posix", "powershell"] as const) module.shellWriteTargets(command, cwd, raw, shell);
      const from = resolve(cwd);
      const runsCommands = module.shellCommandInvocationDetails(command).some(({ name, args }) =>
        name === "find" && args.some((arg) => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg))
      );
      return { words: new Set(raw.filter((word) => word !== from)), unnamed: runsCommands || raw.includes(from) };
    } catch {
      return { words: new Set(), unnamed: true };
    }
  }

  async function touchesProtectedReviewerState(): Promise<boolean> {
    const toolInput = cursor.tool_input ?? {};
    const serialized = JSON.stringify(toolInput).replaceAll("\\", "/");
    // A Windows path serializes its backslash as an escaped pair, so the engine
    // directory and the dispatch file may end up separated by two slashes.
    const reviewerDispatch = new RegExp(`${engineDirFor("").replaceAll("\\", "/").replaceAll(".", "\\.")}/+reviewer-dispatch\\.json`);
    if (
      reviewerDispatch.test(serialized) ||
      [".aidlc-cursor-subagents", "aidlc-cursor-subagent-"].some((token) => serialized.includes(token))
    ) {
      return true;
    }

    const protectedPaths = protectedReviewerPaths();
    const cwd = effectiveCwd();
    const command = toolInput.command;
    if (toolName === "Bash" && typeof command === "string") {
      // Only a write can change the records, so a read, a search, a build or a
      // test is not judged by its words: only the words the line writes are.
      const written = await shellWriteWords(command, cwd);
      if (written.words.size === 0 && !written.unnamed) {
        // The guards case reuses this classification for the review freeze.
        await reviewFreezeTargets();
        return false;
      }
      const values = new Set(shellCommandParts(command).flatMap(({ text }) =>
        shellWords(text).words.flatMap(({ variants }) => variants.map(({ value }) => value))
      ));
      const judgesEveryWord = written.unnamed || [...written.words].some((word) => !values.has(word));
      const states: Record<PathFlavor, ShellCwdState[]> = {
        posix: [{ cwd, stack: [], status: "unknown", logicalAmbiguous: false }],
        win32: [{ cwd, stack: [], status: "unknown", logicalAmbiguous: false }],
      };
      let operatorBefore: ShellCommandPart["operatorAfter"] = "";
      for (const part of shellCommandParts(command)) {
        const segment = part.text;
        const parsed = shellWords(segment);
        if (parsed.ambiguous) return true;
        const activeStates: Record<PathFlavor, ShellCwdState[]> = {
          posix: [],
          win32: [],
        };
        const carriedStates: Record<PathFlavor, ShellCwdState[]> = {
          posix: [],
          win32: [],
        };
        for (const flavor of ["posix", "win32"] as const) {
          for (const state of states[flavor]) {
            const active = {
              cwd: state.cwd,
              stack: [...state.stack],
              status: state.status,
              logicalAmbiguous: state.logicalAmbiguous,
            };
            const carried = {
              cwd: state.cwd,
              stack: [...state.stack],
              status: state.status,
              logicalAmbiguous: state.logicalAmbiguous,
            };
            if (operatorBefore === "&&") {
              if (state.status !== "failure") activeStates[flavor].push(active);
              if (state.status !== "success") carriedStates[flavor].push(carried);
            } else if (operatorBefore === "||") {
              if (state.status !== "success") activeStates[flavor].push(active);
              if (state.status !== "failure") carriedStates[flavor].push(carried);
            } else {
              activeStates[flavor].push(active);
            }
          }
        }
        if (
          parsed.words.some(({ variants }) =>
            (judgesEveryWord || variants.some(({ value }) => written.words.has(value))) &&
            variants.some(
              ({ value, activeGlobIndexes, flavor }) =>
                activeStates[flavor].some(
                  (state) =>
                    globPrefixTouchesProtected(
                      value,
                      state.cwd,
                      protectedPaths,
                      activeGlobIndexes[0] ?? -1,
                      flavor,
                    ) ||
                    concreteWordTouchesProtected(
                      value,
                      state.cwd,
                      protectedPaths,
                      activeGlobIndexes.length > 0,
                      flavor,
                    ),
                ),
            )
          )
        ) {
          return true;
        }
        const isolatedSubshell = /^\s*\(.*\)\s*$/.test(segment);
        const nonPersistent =
          isolatedSubshell || ["|", "&"].includes(part.operatorAfter);
        const controlAmbiguous =
          /[{}]/.test(segment) ||
          /\b(?:if|elif|else|while|until|case|for|select|function|then|do)\b/i.test(
            segment,
          );
        for (const flavor of ["posix", "win32"] as const) {
          const nextStates: ShellCwdState[] = [...carriedStates[flavor]];
          for (const state of activeStates[flavor]) {
            const original = {
              cwd: state.cwd,
              stack: [...state.stack],
              status: state.status,
              logicalAmbiguous: state.logicalAmbiguous,
            };
            const changed = {
              cwd: state.cwd,
              stack: [...state.stack],
              status: state.status,
              logicalAmbiguous: state.logicalAmbiguous,
            };
            const update = updateShellCwd(parsed.words, flavor, changed);
            if (update === "ambiguous") return true;
            if (update === "none") {
              nextStates.push({ ...original, status: "unknown" });
              continue;
            }
            let viable = false;
            try {
              viable = statSync(changed.cwd).isDirectory();
            } catch {
              // A literal directory change to a missing path cannot succeed.
            }
            if (!viable) {
              nextStates.push({ ...original, status: "failure" });
            } else if (nonPersistent) {
              nextStates.push({ ...original, status: "success" });
            } else if (controlAmbiguous) {
              nextStates.push(
                { ...original, status: "unknown" },
                { ...changed, status: "unknown" },
              );
            } else {
              nextStates.push({ ...changed, status: "success" });
            }
          }
          const deduped = new Map<string, ShellCwdState>();
          for (const state of nextStates) {
            const key = shellCwdStateKey(state, flavor);
            const existing = deduped.get(key);
            if (!existing) {
              deduped.set(key, state);
              continue;
            }
            const sameLogicalState =
              existing.cwd === state.cwd &&
              existing.stack.length === state.stack.length &&
              existing.stack.every((path, index) => path === state.stack[index]);
            existing.logicalAmbiguous ||=
              state.logicalAmbiguous || !sameLogicalState;
            if (state.cwd.length < existing.cwd.length) {
              existing.cwd = state.cwd;
              existing.stack = [...state.stack];
            }
          }
          if (deduped.size > MAX_SHELL_CWD_STATES) return true;
          states[flavor] = [...deduped.values()];
        }
        operatorBefore = part.operatorAfter;
      }
      const concrete = await reviewFreezeTargets();
      if (
        concrete?.some((path) =>
          overlapsProtectedPath(path, protectedPaths, cwd)
        )
      ) {
        return true;
      }
    }

    return pathOperandValues(toolInput).some(
      (value) =>
        (globPrefixTouchesProtected(value, cwd, protectedPaths) ||
          (!/[\s*?[\]{}]/.test(value) &&
            overlapsProtectedPath(value, protectedPaths, cwd))),
    );
  }

  // The guards run their core hook inside this process, as on Codex and
  // Copilot: a child loads the whole engine again, so as children a shell
  // call's four guards cost five engine loads. A guard that cannot be imported
  // or exports no run() runs as a child. The engine's hook route settles the
  // project's waiting Claude Code turns before a hook runs; a guard run here
  // skips that route, so under the compiled engine the chain settles once,
  // before its first guard.
  let turnsSettled = false;
  async function runGuard(
    file: string,
    input: string,
  ): Promise<{ stdout: string; stderr: string; code: number; signal: string | null }> {
    if (!turnsSettled && process.env.AIDLC_COMPILED_EXECUTABLE) settleClaudeTurnsFirst(projectDir);
    turnsSettled = true;
    const here = await runHookHere(join(HOOKS_DIR, file), input, projectPins);
    return here === null ? runCoreWithStderr(file, input) : { ...here, signal: null };
  }

  // Exit 2 is a guard's refusal. A guard that fails on its own (it throws, its
  // file is missing, it is killed) refuses nothing, as in the core hook group;
  // its error line goes where doctor reads hook drops, with a severity tag in
  // it neutralized so only the hook that writes a drop decides doctor's verdict.
  async function blockedByGuard(file: string, input: string): Promise<boolean> {
    const r = await runGuard(file, input);
    if (r.code === 0) return false;
    if (r.code !== 2) {
      const hook = file.replace(/^aidlc-|\.ts$/g, "");
      const lines = r.stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
      const line = (lines.find((entry) => entry.startsWith("error:")) ??
        lines.filter((entry) => !/^Bun v\d/.test(entry)).at(-1) ?? "no error output")
        .replace(/\[(degraded|advisory)\]/gi, "($1)");
      const how = r.signal === null ? `exited ${r.code}` : `was stopped by ${r.signal}`;
      recordHookDrop(projectDir, hook, `${hook} ${how} under the Cursor adapter: ${line.slice(0, 240)}`);
      return false;
    }
    process.stdout.write(`${JSON.stringify({
      permission: "deny",
      agent_message: r.stderr.trim() || "blocked by AIDLC guard hook",
    })}\n`);
    return true;
  }

  // Cursor IDE failClosed preToolUse treats empty stdout as invalid JSON and
  // blocks. Cursor CLI treats the same silence as allow. Always emit allow JSON.
  function writeAllow(): void {
    process.stdout.write(`${JSON.stringify({ permission: "allow" })}\n`);
  }

  // --- Targets ------------------------------------------------------------------

  switch (target) {
    case "session-start": {
      // sessionStart never fires for a Task subagent's conversation
      // (live-verified) — this conversation is a top-level one.
      registerMain();
      rememberBackground();
      if (isBackground()) {
        // A background agent is a side worker: it gets a hands-off note
        // instead of the workflow context that would tell it to resume.
        process.stdout.write(`${JSON.stringify({
          additional_context:
            "AIDLC: this is a Cursor background agent. The AI-DLC workflow in this " +
            "project is driven from the user's foreground chat. Do not run /aidlc " +
            "or AIDLC workflow commands, and do not edit files under aidlc/ or " +
            "AIDLC's own files under .cursor/ (its hooks, tools, skills, agents, " +
            "and aidlc rules); other Cursor configuration such as .cursor/mcp.json " +
            "is fine to change. Reading any of them and running " +
            `\`${aidlcDispatcherInvocation("status")}\` are fine. If asked to do AIDLC ` +
            "work, tell the user to do it from the foreground chat. Do your task " +
            "and report back.",
        })}\n`);
        return 0;
      }
      const fwd = JSON.stringify({
        hook_event_name: "SessionStart",
        source: cursor.source ?? "startup",
        ...(sessionId ? { session_id: sessionId } : {}),
      });
      const r = runCore("aidlc-session-start.ts", fwd);
      // Core prints {"additionalContext"} (Claude's key); Cursor consumes
      // {"additional_context"} (live-verified injection channel).
      try {
        const parsed = JSON.parse(r.stdout) as { additionalContext?: string };
        if (parsed.additionalContext) {
          process.stdout.write(`${JSON.stringify({ additional_context: parsed.additionalContext })}\n`);
        }
      } catch {
        // no context payload — silent
      }
      return 0;
    }

    case "session-end": {
      const background = isBackground();
      // Cursor does not deliver Task postToolUse on its real CLI lifecycle.
      // Retire every still-live Task for this parent through the canonical
      // SubagentStop hook before ending the session, explicitly qualifying the
      // terminal event as inferred instead of silently dropping it.
      if (cursor.conversation_id) {
        for (const path of ledgerFiles().sort()) {
          const record = readRecord(path);
          if (record?.parent !== cursor.conversation_id) continue;
          runCore(
            "aidlc-log-subagent.ts",
            JSON.stringify({
              hook_event_name: "SubagentStop",
              agent_type: record.agent,
              last_assistant_message:
                "inferred: Cursor emitted sessionEnd without Task postToolUse; " +
                "the live Task record was retired.",
              ...(sessionId ? { session_id: sessionId } : {}),
            }),
          );
          retireSpawn(record);
        }
        for (const path of witnessFiles().sort()) {
          const record = readRecord(path);
          if (record?.parent !== cursor.conversation_id) continue;
          runCore(
            "aidlc-log-subagent.ts",
            JSON.stringify({
              hook_event_name: "SubagentStop",
              agent_type: record.agent,
              last_assistant_message:
                "inferred: Cursor emitted sessionEnd after the primary Task ledger was lost; " +
                "the independent delegation witness was retired.",
              ...(sessionId ? { session_id: sessionId } : {}),
            }),
          );
          retireSpawn(record);
        }
        removeLedger(mainFile(cursor.conversation_id));
      }
      const ended = backgroundFile();
      if (ended) removeLedger(ended);
      // A background agent never opened a workflow session.
      if (background) return 0;
      const fwd = JSON.stringify({
        hook_event_name: "SessionEnd",
        reason: cursor.reason ?? "other",
        ...(sessionId ? { session_id: sessionId } : {}),
      });
      runCore("aidlc-session-end.ts", fwd);
      return 0;
    }

    case "mint": {
      // beforeSubmitPrompt fires only for top-level conversations
      // (live-verified) — register this one as a main either way.
      registerMain();
      // Hosts without sessionStart still flag the agent here.
      rememberBackground();
      // A Cursor background agent submits prompts with no human present; its
      // turn must not mint HUMAN_TURN (the approval gates' presence evidence).
      if (isBackground()) return 0;
      const prompt = cursor.prompt ?? cursor.user_message ?? "";
      // Cursor's sessionStart fires only for a new conversation and carries no
      // startup/resume discriminator. Probe the core resume-rebind logic here,
      // where the same session_id is available, BEFORE the turn is recorded,
      // so the turn lands on this chat's own work. The person's prompt always
      // goes through: beforeSubmitPrompt cannot add context, so the probe
      // leaves its one line for this conversation's next directive instead.
      if (sessionId) {
        runCore(
          "aidlc-session-start.ts",
          JSON.stringify({
            hook_event_name: "SessionStart",
            source: "resume",
            session_id: sessionId,
            rebind_check: true,
          }),
        );
        // A typed switch or create moves this chat itself, so a line about its
        // old selection, from this probe or an earlier prompt's, is dropped.
        if (promptMovesSelection(prompt)) takeSessionSelectionNotice(projectDir, sessionId);
      }
      // A real human acted this turn.
      runCore(
        "aidlc-record-human-turn.ts",
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          ...(sessionId ? { session_id: sessionId } : {}),
          prompt,
        }),
      );
      return 0;
    }

    case "guards": {
      // preToolUse: the state-transition, reviewer read-scope, and review-freeze
      // guards (the Claude settings.json registration order). The core hooks
      // self-filter by tool; plan approval runs for both workspace mutations
      // and Task dispatch before a spawn feeds the identity ledger. Block
      // contract conversion: core exit 2 + stderr becomes
      // Cursor's {"permission":"deny","agent_message"} stdout JSON
      // (live-verified: the deny blocks the call and relays the reason).
      // Allow paths write {"permission":"allow"} — required under failClosed.
      if (toolName === "Task") {
        const parentAgent = activeSubagent();
        if (parentAgent) {
          const identity =
            parentAgent === AMBIGUOUS_REVIEWER ? "an ambiguously attributed reviewer" : parentAgent;
          process.stdout.write(`${JSON.stringify({
            permission: "deny",
            agent_message:
              `AIDLC nested delegation is not allowed: ${identity} must complete ` +
              "its delegated task directly and cannot invoke Task.",
          })}\n`);
          return 0;
        }
        if (await blockedByGuard("aidlc-plan-approval-guard.ts", claudeShaped("PreToolUse"))) {
          return 0;
        }
        const sub = cursor.tool_input?.subagent_type;
        if (
          typeof sub === "string" &&
          sub.length > 0 &&
          !recordSpawn(sub) &&
          !delegateChecksStandAside()
        ) {
          process.stdout.write(`${JSON.stringify({
            permission: "deny",
            agent_message:
              "AI-DLC could not start this specialist. Start it again; if it is stopped again, tell the person " +
              `to run \`${aidlcInvocation()} doctor\` in a terminal, which names what is broken.`,
          })}\n`);
          return 0;
        }
        writeAllow();
        return 0;
      }
      const agent = attributed();
      if (agent && await touchesProtectedReviewerState() && !delegateChecksStandAside()) {
        process.stdout.write(`${JSON.stringify({
          permission: "deny",
          agent_message:
            "AIDLC delegated agents cannot read, modify, or remove reviewer attribution state.",
        })}\n`);
        return 0;
      }
      if (agent === AMBIGUOUS_REVIEWER && !delegateChecksStandAside()) {
        process.stdout.write(`${JSON.stringify({
          permission: "deny",
          agent_message:
            "AIDLC delegated-agent identity is unavailable or ambiguous while delegation state is active; " +
            "the operation was denied rather than losing attribution enforcement.",
        })}\n`);
        return 0;
      }
      const guards = [
        {
          file: "aidlc-state-transition-guard.ts",
          input: claudeShaped("PreToolUse"),
        },
        {
          file: "aidlc-reviewer-scope.ts",
          input: claudeShaped("PreToolUse", reviewerToolName),
        },
      ];
      // An attributed Bash call was already classified by the exact exported
      // review-freeze target parser while checking protected attribution
      // paths. Reuse that result: an empty target set is the hook's first allow
      // condition, so running the freeze hook again can add no decision value.
      // Undefined/null are not classifications and always retain the guard.
      if (
        toolName !== "Bash" ||
        reviewFreezeTargetsCache === undefined ||
        reviewFreezeTargetsCache === null ||
        reviewFreezeTargetsCache.length > 0
      ) {
        guards.push({
          file: "aidlc-review-freeze.ts",
          input: claudeShaped("PreToolUse", reviewerToolName),
        });
      }
      const planToolName = toolName === "Delete" ? "Write" : toolName;
      if (["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(planToolName)) {
        guards.push({
          file: "aidlc-plan-approval-guard.ts",
          input: claudeShaped("PreToolUse", planToolName),
        });
      }
      for (const guard of guards) {
        if (await blockedByGuard(guard.file, guard.input)) return 0;
      }
      writeAllow();
      return 0;
    }

    case "audit-and-sensors": {
      // postToolUse Write|Edit → audit THEN sensors (Claude registration
      // order); postToolUse Task → subagent completion (log + ledger clear).
      if (toolName === "Write" || toolName === "Edit") {
        const fwd = claudeShaped("PostToolUse");
        runCore("aidlc-write-audit-log.ts", fwd);
        runCore("aidlc-run-sensors.ts", fwd);
      } else if (toolName === "Task") {
        const sub = cursor.tool_input?.subagent_type;
        const fwd = JSON.stringify({
          hook_event_name: "SubagentStop",
          ...(typeof sub === "string" && sub.length > 0 ? { agent_type: sub } : {}),
          ...(sessionId ? { session_id: sessionId } : {}),
        });
        runCore("aidlc-log-subagent.ts", fwd);
        clearSpawn();
      }
      return 0;
    }

    case "task-failure": {
      // postToolUseFailure: failed Task calls do not pass through postToolUse,
      // so remove their attribution record here. Other failed tools are no-ops.
      if (toolName === "Task") clearSpawn();
      return 0;
    }

    case "runtime-compile": {
      // postToolUse Shell → the runtime-graph compile watcher (keys on Bash +
      // tool_input.command — the mapped payload is its exact contract).
      if (toolName === "Bash") runCore("aidlc-rebuild-stage-graph.ts", claudeShaped("PostToolUse"));
      return 0;
    }

    case "validate-state": {
      // preCompact: the core hook resolves the workflow from the session id,
      // which Cursor may send only as conversation_id.
      runCore("aidlc-validate-state.ts", JSON.stringify({
        hook_event_name: "PreCompact",
        ...(sessionId ? { session_id: sessionId } : {}),
      }));
      return 0;
    }

    case "stop": {
      // A background agent's stop never enters the forwarding loop: the nudge
      // would tell it to run `next` and reset the foreground's steering.
      if (isBackground()) return 0;
      // Cursor's stop hook CANNOT block (no decision channel). The core stop
      // hook's {"decision":"block","reason"} converts to a followup_message —
      // the forwarding-loop nudge is ADVISORY on this harness (the opencode
      // session.idle precedent), re-engaging the loop by injecting the reason
      // as a follow-up prompt instead of refusing the stop.
      const r = runCore("aidlc-continue-workflow.ts", rawInput);
      try {
        const parsed = JSON.parse(r.stdout) as { decision?: string; reason?: string };
        if (parsed.decision === "block" && parsed.reason) {
          process.stdout.write(`${JSON.stringify({ followup_message: parsed.reason })}\n`);
        }
      } catch {
        // advisory — no output
      }
      return 0;
    }

    default:
      return 0;
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv[2] ?? "", await Bun.stdin.text(), process.argv.slice(3)));
}
