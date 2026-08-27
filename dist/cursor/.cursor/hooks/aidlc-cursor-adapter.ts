#!/usr/bin/env bun
// aidlc-cursor-adapter.ts — the Cursor hook shim (AUTHORED shell file; the
// aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared with the
// Claude Code harness). Modeled on codex's aidlc-codex-adapter.ts: ONE shim
// normalizes the Cursor payload to the ClaudeCodeHookInput shape and
// subprocess-pipes into the named core hook.
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
//      Read/Write/Edit/Task already match Claude's names and input shapes.
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

import { createHash } from "node:crypto";
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
            "AIDLC guard input was malformed; the operation was denied because its safety checks could not run.",
        })}\n`);
      }
      return 0;
    }
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
  const projectEnv = {
    ...process.env,
    AIDLC_PROJECT_DIR: projectDir,
    CLAUDE_PROJECT_DIR: projectDir,
    CURSOR_PROJECT_DIR: projectDir,
  };

  // --- Core-hook subprocess plumbing ------------------------------------------

  function runCore(hookFile: string, stdinText: string): { stdout: string; code: number } {
    const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
    const command = executable
      ? [executable, "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
      : [process.execPath, join(HOOKS_DIR, hookFile)];
    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(stdinText, "utf-8"),
      stdout: "pipe",
      stderr: "ignore",
      cwd: projectDir,
      env: projectEnv,
    });
    return { stdout: r.stdout?.toString() ?? "", code: r.exitCode ?? 0 };
  }

  function runCoreWithStderr(
    hookFile: string,
    stdinText: string,
  ): { stdout: string; stderr: string; code: number } {
    const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
    const command = executable
      ? [executable, "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
      : [process.execPath, join(HOOKS_DIR, hookFile)];
    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(stdinText, "utf-8"),
      stdout: "pipe",
      stderr: "pipe",
      cwd: projectDir,
      env: projectEnv,
    });
    return {
      stdout: r.stdout?.toString() ?? "",
      stderr: r.stderr?.toString() ?? "",
      code: r.exitCode ?? 1,
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
  // project runtime tree, and delegated tools cannot access it. A second,
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
      const spacePointer = join(projectDir, "aidlc", "active-space");
      const rawSpace = existsSync(spacePointer)
        ? readFileSync(spacePointer, "utf-8").trim()
        : "default";
      const space = /^[a-z0-9][a-z0-9._-]*$/.test(rawSpace) ? rawSpace : "default";
      const intentsDir = join(projectDir, "aidlc", "spaces", space, "intents");
      const activePointer = join(intentsDir, "active-intent");
      const activeIntent = readFileSync(activePointer, "utf-8").trim();
      if (!activeIntent || activeIntent.includes("/") || activeIntent.includes("\\")) return null;
      const dispatch = join(intentsDir, activeIntent, ".aidlc-reviewer-dispatch.json");
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
  // Everything else (Read/Write/Edit/Grep/Glob/Task/...) already matches.
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

  function shellCommandSegments(command: string): string[] {
    return shellCommandParts(command).map((part) => part.text);
  }

  interface ReviewFreezeCommandModule {
    shellCommandAltersExecutableResolution?: (command: string) => boolean;
    shellCommandInvocationDetails?: (
      command: string,
    ) => Array<{
      name: string;
      args: string[];
      ambiguous?: boolean;
      executable?: string;
      launchers?: string[];
      dataDrivenMutation?: boolean;
      executableResolutionChanged?: boolean;
    }>;
    shellCommandInvocations?: (
      command: string,
    ) => Array<{ name: string; args: string[]; ambiguous?: boolean }>;
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

  function shellUsesDynamicExpansion(command: string): boolean {
    let quote: "'" | '"' | null = null;
    let escaped = false;
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
      if (quote === "'") {
        if (ch === "'") quote = null;
        continue;
      }
      if (quote === '"') {
        if (ch === '"') {
          quote = null;
          continue;
        }
        if (ch === "`") return true;
        if (ch === "$") {
          const next = command[i + 1] ?? "";
          if (/[\w@*#?$!{('"_-]/.test(next)) return true;
        }
        if (ch === "%" && /%[^%\r\n]+%/.test(command.slice(i))) return true;
        if (ch === "!" && /![^!\r\n]+!/.test(command.slice(i))) return true;
        continue;
      }
      if (ch === "'") {
        quote = "'";
        continue;
      }
      if (ch === '"') {
        quote = '"';
        continue;
      }
      if (ch === "`") return true;
      if (ch === "^") return true;
      if (ch === "%" && /%[^%\r\n]+%/.test(command.slice(i))) return true;
      if (ch === "!" && /![^!\r\n]+!/.test(command.slice(i))) return true;
      if (ch === "$") {
        const next = command[i + 1] ?? "";
        if (/[\w@*#?$!{('"_-]/.test(next)) return true;
      }
    }
    return false;
  }

  function shellUsesDirectHostExpression(command: string): boolean {
    let quote: "'" | '"' | null = null;
    let escaped = false;
    let outside = "";
    for (const ch of command) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "`") {
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
      outside += ch;
    }
    return (
      /(?:^|[\s(])\+(?=[\s)]|$)/.test(outside) ||
      /(?:^|[\s(])&(?=[\s(]|$)/.test(outside) ||
      /(?:^|\s)-(?:join|replace|split)\b/i.test(outside) ||
      /\(\s*[A-Za-z]+-[A-Za-z]+/i.test(outside)
    );
  }

  function shellUsesConstructedHostInvocation(command: string): boolean {
    return /(?:^|[;\s])&\s*\(/.test(command);
  }

  function gitUsesIndirectShellAlias(
    args: readonly string[],
    command: string,
  ): boolean {
    if (args.some((arg) => /^alias\.[^=]+=!/i.test(arg))) return true;
    const configIndex = args.indexOf("config");
    if (configIndex !== -1) {
      const aliasIndex = args.findIndex(
        (arg, index) => index > configIndex && /^alias\.[^.=\s]+$/i.test(arg),
      );
      if (
        aliasIndex !== -1 &&
        args.slice(aliasIndex + 1).some((arg) => !arg.startsWith("-"))
      ) {
        return true;
      }
    }
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const configEnv =
        arg === "--config-env" ? args[i + 1] ?? "" : arg.replace(/^--config-env=/, "");
      if (
        configEnv !== arg &&
        /^(?:alias\.[^=]+|include(?:If\.[^=]+)?\.path)=/i.test(configEnv)
      ) {
        return true;
      }
      if (
        arg === "-c" &&
        /^(?:alias\.[^=]+|include(?:If\.[^=]+)?\.path)=/i.test(args[i + 1] ?? "")
      ) {
        return true;
      }
    }
    if (/\bGIT_CONFIG_(?:GLOBAL|SYSTEM|PARAMETERS)=/i.test(command)) return true;
    return /\bGIT_CONFIG_KEY_\d+=alias\./i.test(command);
  }

  function gitInvocation(
    args: readonly string[],
  ): { subcommand: string; subcommandIndex: number; prefix: string[] } {
    const valueOptions = new Set([
      "-C",
      "-c",
      "--config-env",
      "--exec-path",
      "--git-dir",
      "--namespace",
      "--super-prefix",
      "--work-tree",
    ]);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") {
        return {
          subcommand: args[i + 1] ?? "",
          subcommandIndex: i + 1,
          prefix: [...args.slice(0, i + 1)],
        };
      }
      if (valueOptions.has(arg)) {
        i++;
        continue;
      }
      if (arg.startsWith("-")) continue;
      return { subcommand: arg, subcommandIndex: i, prefix: [...args.slice(0, i)] };
    }
    return { subcommand: "", subcommandIndex: -1, prefix: [...args] };
  }

  interface GitCommandContext {
    cwd: string;
    env: Record<string, string | undefined>;
    ambiguous: boolean;
  }

  function shellExecutableName(value: string): string {
    return win32.basename(posix.basename(value))
      .replace(/\.(?:exe|com|cmd|bat)$/i, "")
      .toLowerCase();
  }

  function isGitInspectionEnvironmentName(name: string): boolean {
    const candidate = process.platform === "win32" ? name.toUpperCase() : name;
    return /^(?:HOME|XDG_CONFIG_HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|PAGER|GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|NAMESPACE|EXEC_PATH|PAGER)|GIT_CONFIG(?:_GLOBAL|_SYSTEM|_NOSYSTEM|_PARAMETERS|_COUNT|_KEY_\d+|_VALUE_\d+)?)$/.test(
      candidate,
    );
  }

  function deleteEnvironmentName(
    env: Record<string, string | undefined>,
    name: string,
  ): void {
    const candidate = process.platform === "win32" ? name.toUpperCase() : name;
    for (const key of Object.keys(env)) {
      const existing = process.platform === "win32" ? key.toUpperCase() : key;
      if (existing === candidate) delete env[key];
    }
  }

  function environmentValue(
    env: Record<string, string | undefined>,
    name: string,
  ): string | undefined {
    const candidate = process.platform === "win32" ? name.toUpperCase() : name;
    for (const [key, value] of Object.entries(env)) {
      const existing = process.platform === "win32" ? key.toUpperCase() : key;
      if (existing === candidate) return value;
    }
    return undefined;
  }

  function gitCommandEnvironment(
    command: string,
    initialCwd = projectDir,
  ): GitCommandContext {
    const env: Record<string, string | undefined> = { ...projectEnv };
    const commandEnv: Record<string, string | undefined> = { ...projectEnv };
    let invocationCwd = initialCwd;
    const flavor: PathFlavor = process.platform === "win32" ? "win32" : "posix";
    for (const segment of shellCommandSegments(command)) {
      const parsed = shellWords(segment);
      if (parsed.ambiguous) continue;
      let values = parsed.words
        .map((word) => word.variants.find((variant) => variant.flavor === flavor)?.value)
        .filter((value): value is string => value !== undefined);
      let index = 0;
      const collectAssignments = () => {
        for (; index < values.length; index++) {
          const match = values[index].match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
          if (!match) break;
          deleteEnvironmentName(commandEnv, match[1]);
          commandEnv[match[1]] = match[2];
          if (isGitInspectionEnvironmentName(match[1])) {
            deleteEnvironmentName(env, match[1]);
            env[match[1]] = match[2];
          }
        }
      };
      const consumeWrapperOptions = (
        spec: {
          shortValues?: readonly string[];
          longValues?: readonly string[];
          shortOptionalValues?: readonly string[];
          longOptionalValues?: readonly string[];
          shortFlags?: readonly string[];
          longFlags?: readonly string[];
          numericShortValue?: boolean;
        },
      ) => {
        const shortValues = new Set(spec.shortValues ?? []);
        const longValues = new Set(spec.longValues ?? []);
        const shortOptionalValues = new Set(spec.shortOptionalValues ?? []);
        const longOptionalValues = new Set(spec.longOptionalValues ?? []);
        const shortFlags = new Set(spec.shortFlags ?? []);
        const longFlags = new Set(spec.longFlags ?? []);
        while (index < values.length) {
          const option = values[index];
          if (option === "--") {
            index++;
            return false;
          }
          if (option === "-" || !option.startsWith("-")) return false;
          if (option.startsWith("--")) {
            const equals = option.indexOf("=");
            const name = equals === -1 ? option : option.slice(0, equals);
            if (longValues.has(name)) {
              if (equals !== -1) {
                index++;
              } else if (values[index + 1] !== undefined) {
                index += 2;
              } else {
                return true;
              }
              continue;
            }
            if (longOptionalValues.has(name) || longFlags.has(name)) {
              index++;
              continue;
            }
            return true;
          }
          if (spec.numericShortValue && /^-\d+$/.test(option)) {
            index++;
            continue;
          }
          const name = option.slice(0, 2);
          if (shortValues.has(name)) {
            if (option.length > 2) {
              index++;
            } else if (values[index + 1] !== undefined) {
              index += 2;
            } else {
              return true;
            }
            continue;
          }
          if (shortOptionalValues.has(name)) {
            index++;
            continue;
          }
          if (
            option.length > 1 &&
            [...option.slice(1)].every((flag) => shortFlags.has(`-${flag}`))
          ) {
            index++;
            continue;
          }
          return true;
        }
        return false;
      };
      const simpleWrappers: Record<
        string,
        Parameters<typeof consumeWrapperOptions>[0]
      > = {
        exec: { shortValues: ["-a"], shortFlags: ["-c", "-l"] },
        nohup: { longFlags: ["--help", "--version"] },
        nice: {
          shortValues: ["-n"],
          longValues: ["--adjustment"],
          longFlags: ["--help", "--version"],
          numericShortValue: true,
        },
        ionice: {
          shortValues: ["-c", "-n", "-p", "-P", "-u"],
          longValues: ["--class", "--classdata", "--pid", "--pgid", "--uid"],
          shortFlags: ["-t"],
          longFlags: ["--ignore", "--help", "--version"],
        },
        stdbuf: {
          shortValues: ["-i", "-o", "-e"],
          longValues: ["--input", "--output", "--error"],
          longFlags: ["--help", "--version"],
        },
        setsid: {
          shortFlags: ["-c", "-f", "-w"],
          longFlags: ["--ctty", "--fork", "--wait", "--help", "--version"],
        },
        sudo: {
          shortValues: ["-C", "-D", "-g", "-h", "-p", "-r", "-t", "-T", "-u"],
          longValues: [
            "--chdir",
            "--close-from",
            "--group",
            "--host",
            "--prompt",
            "--role",
            "--type",
            "--user",
          ],
          shortOptionalValues: ["-E"],
          longOptionalValues: ["--preserve-env"],
          shortFlags: ["-A", "-b", "-e", "-H", "-K", "-k", "-l", "-n", "-P", "-S", "-s", "-V", "-v"],
          longFlags: [
            "--askpass",
            "--background",
            "--edit",
            "--help",
            "--login",
            "--non-interactive",
            "--remove-timestamp",
            "--reset-timestamp",
            "--set-home",
            "--shell",
            "--stdin",
            "--validate",
            "--version",
          ],
        },
        doas: {
          shortValues: ["-C", "-u"],
          shortFlags: ["-L", "-n", "-s"],
        },
        xargs: {
          shortValues: ["-a", "-d", "-E", "-I", "-J", "-L", "-n", "-P", "-s"],
          longValues: [
            "--arg-file",
            "--delimiter",
            "--max-args",
            "--max-procs",
            "--max-chars",
            "--process-slot-var",
          ],
          shortOptionalValues: ["-e", "-i", "-l"],
          longOptionalValues: ["--eof", "--replace", "--max-lines"],
          shortFlags: ["-0", "-o", "-p", "-r", "-t", "-x"],
          longFlags: [
            "--null",
            "--open-tty",
            "--interactive",
            "--no-run-if-empty",
            "--show-limits",
            "--verbose",
            "--exit",
            "--help",
            "--version",
          ],
        },
        time: {
          shortValues: ["-f", "-o"],
          longValues: ["--format", "--output"],
          shortFlags: ["-a", "-p", "-v"],
          longFlags: ["--append", "--portability", "--verbose", "--help", "--version"],
        },
        unbuffer: { shortFlags: ["-p"] },
      };
      while (index < values.length) {
        collectAssignments();
        const wrapper = shellExecutableName(values[index] ?? "");
        if (wrapper === "command") {
          index++;
          while (index < values.length && values[index].startsWith("-")) {
            const option = values[index++];
            if (option === "--") break;
            if (option.includes("v") || option.includes("V")) {
              return { cwd: invocationCwd, env, ambiguous: false };
            }
            if (![...option.slice(1)].every((flag) => flag === "p")) {
              return { cwd: invocationCwd, env, ambiguous: true };
            }
          }
          continue;
        }
        if (wrapper === "env") {
          index++;
          while (index < values.length) {
            const option = values[index];
            if (option === "--") {
              index++;
              break;
            }
            if (["-u", "--unset"].includes(option)) {
              const name = values[index + 1] ?? "";
              deleteEnvironmentName(commandEnv, name);
              if (isGitInspectionEnvironmentName(name)) deleteEnvironmentName(env, name);
              index += 2;
              continue;
            }
            if (["-C", "--chdir"].includes(option)) {
              const directory = values[index + 1];
              if (!directory) return { cwd: invocationCwd, env, ambiguous: true };
              invocationCwd = isAbsolute(directory)
                ? directory
                : resolve(invocationCwd, directory);
              index += 2;
              continue;
            }
            if (["-a", "--argv0"].includes(option)) {
              if (!values[index + 1]) {
                return { cwd: invocationCwd, env, ambiguous: true };
              }
              index += 2;
              continue;
            }
            if (["-S", "--split-string"].includes(option)) {
              const split = shellWords(values[index + 1] ?? "");
              if (split.ambiguous) return { cwd: invocationCwd, env, ambiguous: true };
              const splitValues = split.words
                .map((word) => word.variants.find((variant) => variant.flavor === flavor)?.value)
                .filter((value): value is string => value !== undefined);
              values = [...values.slice(0, index), ...splitValues, ...values.slice(index + 2)];
              continue;
            }
            if (option.startsWith("-S") && option.length > 2) {
              const split = shellWords(option.slice(2));
              if (split.ambiguous) return { cwd: invocationCwd, env, ambiguous: true };
              const splitValues = split.words
                .map((word) => word.variants.find((variant) => variant.flavor === flavor)?.value)
                .filter((value): value is string => value !== undefined);
              values = [...values.slice(0, index), ...splitValues, ...values.slice(index + 1)];
              continue;
            }
            if (option.startsWith("--split-string=")) {
              const split = shellWords(option.slice("--split-string=".length));
              if (split.ambiguous) return { cwd: invocationCwd, env, ambiguous: true };
              const splitValues = split.words
                .map((word) => word.variants.find((variant) => variant.flavor === flavor)?.value)
                .filter((value): value is string => value !== undefined);
              values = [...values.slice(0, index), ...splitValues, ...values.slice(index + 1)];
              continue;
            }
            if (option.startsWith("--unset=")) {
              const name = option.slice("--unset=".length);
              deleteEnvironmentName(commandEnv, name);
              if (isGitInspectionEnvironmentName(name)) deleteEnvironmentName(env, name);
              index++;
              continue;
            }
            const attached = option.match(/^-(u|C|a)(.+)$/);
            if (attached) {
              if (attached[1] === "u") {
                deleteEnvironmentName(commandEnv, attached[2]);
                if (isGitInspectionEnvironmentName(attached[2])) {
                  deleteEnvironmentName(env, attached[2]);
                }
              } else if (attached[1] === "C") {
                invocationCwd = isAbsolute(attached[2])
                  ? attached[2]
                  : resolve(invocationCwd, attached[2]);
              }
              index++;
              continue;
            }
            if (option === "-" || option === "-i" || option === "--ignore-environment") {
              for (const name of Object.keys(commandEnv)) delete commandEnv[name];
              for (const name of Object.keys(env)) {
                if (isGitInspectionEnvironmentName(name)) delete env[name];
              }
              index++;
              continue;
            }
            if (/^-[i0v]+$/.test(option)) {
              if (option.includes("i")) {
                for (const name of Object.keys(commandEnv)) delete commandEnv[name];
                for (const name of Object.keys(env)) {
                  if (isGitInspectionEnvironmentName(name)) delete env[name];
                }
              }
              index++;
              continue;
            }
            if (option.startsWith("--chdir=")) {
              const directory = option.slice("--chdir=".length);
              if (!directory) return { cwd: invocationCwd, env, ambiguous: true };
              invocationCwd = isAbsolute(directory)
                ? directory
                : resolve(invocationCwd, directory);
              index++;
              continue;
            }
            if (option.startsWith("--argv0=")) {
              if (option.length === "--argv0=".length) {
                return { cwd: invocationCwd, env, ambiguous: true };
              }
              index++;
              continue;
            }
            if (option === "-0" || option === "--null") {
              index++;
              continue;
            }
            if (
              option === "-v" ||
              option === "--debug" ||
              option === "--list-signal-handling" ||
              option === "--help" ||
              option === "--version" ||
              /^(?:--default-signal|--ignore-signal|--block-signal)(?:=.*)?$/.test(option)
            ) {
              index++;
              continue;
            }
            if (!option.startsWith("-")) break;
            return { cwd: invocationCwd, env, ambiguous: true };
          }
          continue;
        }
        const spec = simpleWrappers[wrapper];
        if (spec) {
          index++;
          if (consumeWrapperOptions(spec)) {
            return { cwd: invocationCwd, env, ambiguous: true };
          }
          continue;
        }
        if (wrapper === "timeout") {
          index++;
          if (
            consumeWrapperOptions({
              shortValues: ["-k", "-s"],
              longValues: ["--kill-after", "--signal"],
              longFlags: [
                "--foreground",
                "--preserve-status",
                "--verbose",
                "--help",
                "--version",
              ],
            })
          ) {
            return { cwd: invocationCwd, env, ambiguous: true };
          }
          if (index < values.length) index++;
          continue;
        }
        break;
      }
      if (shellExecutableName(values[index] ?? "") === "git") {
        const gitArgs = values.slice(index + 1);
        for (let i = 0; i < gitArgs.length; i++) {
          const arg = gitArgs[i];
          const configEnv =
            arg === "--config-env"
              ? gitArgs[++i] ?? ""
              : arg.startsWith("--config-env=")
                ? arg.slice("--config-env=".length)
                : "";
          const equals = configEnv.indexOf("=");
          if (equals === -1) continue;
          const variable = configEnv.slice(equals + 1);
          if (!variable) continue;
          deleteEnvironmentName(env, variable);
          const value = environmentValue(commandEnv, variable);
          if (value !== undefined) env[variable] = value;
        }
        return { cwd: invocationCwd, env, ambiguous: false };
      }
    }
    return { cwd: invocationCwd, env, ambiguous: false };
  }

  interface GitAliasResolution {
    disposition: "none" | "safe" | "unsafe";
    command: string;
  }

  function gitPersistedAliasResolution(
    args: readonly string[],
    env: Record<string, string | undefined>,
    cwd: string,
  ): GitAliasResolution {
    const invocation = gitInvocation(args);
    let alias = invocation.subcommand;
    if (!alias) return { disposition: "none", command: "" };
    let resolvedAlias = false;
    const visited = new Set<string>();
    const readAlias = (name: string): string | null => {
      const query = (command: string[]): string | null => {
        const result = Bun.spawnSync(command, {
          cwd,
          env,
          stdout: "pipe",
          stderr: "ignore",
        });
        return result.exitCode === 0 ? result.stdout?.toString().trim() ?? "" : null;
      };
      const contextual = query([
        "git",
        ...invocation.prefix,
        "config",
        "--get",
        `alias.${name}`,
      ]);
      if (contextual !== null) return contextual;
      for (const file of [
        env.GIT_CONFIG_GLOBAL,
        env.HOME ? join(env.HOME, ".gitconfig") : undefined,
        env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "git", "config") : undefined,
      ]) {
        if (!file || !existsSync(file)) continue;
        const expansion = query(["git", "config", "--file", file, "--get", `alias.${name}`]);
        if (expansion !== null) return expansion;
      }
      return null;
    };
    for (let depth = 0; depth < 8; depth++) {
      const folded = alias.toLowerCase();
      if (visited.has(folded)) return { disposition: "unsafe", command: alias };
      visited.add(folded);
      const expansion = readAlias(alias);
      if (expansion === null) {
        return {
          disposition: resolvedAlias ? "safe" : "none",
          command: alias,
        };
      }
      resolvedAlias = true;
      if (!expansion || expansion.startsWith("!")) {
        return { disposition: "unsafe", command: alias };
      }
      const parsed = shellWords(expansion);
      if (parsed.ambiguous || parsed.words.length === 0) {
        return { disposition: "unsafe", command: alias };
      }
      alias =
        parsed.words[0].variants.find((variant) => variant.flavor === "posix")?.value ??
        parsed.words[0].variants[0]?.value ??
        "";
      if (!alias) return { disposition: "unsafe", command: "" };
    }
    return { disposition: "unsafe", command: alias };
  }

  function gitPagerMode(
    prefix: readonly string[],
    env: Record<string, string | undefined>,
  ): "default" | "disabled" | "enabled" {
    const pager = (env.GIT_PAGER ?? env.PAGER ?? "").trim();
    let mode: "default" | "disabled" | "enabled" =
      pager.length === 0
        ? "default"
        : /^(?:cat|false)$/i.test(pager)
          ? "disabled"
          : "enabled";
    for (const arg of prefix) {
      if (arg === "--no-pager" || arg === "-P") mode = "disabled";
      else if (arg === "--paginate" || arg === "-p") mode = "enabled";
    }
    return mode;
  }

  function gitStatusUsesExternalCommand(
    args: readonly string[],
    env: Record<string, string | undefined>,
    cwd: string,
  ): boolean {
    const invocation = gitInvocation(args);
    const prefix = invocation.prefix.filter((arg) => arg !== "--");
    const pagerMode = gitPagerMode(prefix, env);
    if (pagerMode === "enabled") return true;
    const commandArgs = args.slice(invocation.subcommandIndex + 1);
    const boundary = commandArgs.indexOf("--");
    const optionArgs = boundary === -1 ? commandArgs : commandArgs.slice(0, boundary);
    const positionalPathspecs = (): string[] => {
      for (let i = 0; i < commandArgs.length; i++) {
        const arg = commandArgs[i];
        if (!arg.startsWith("-") || arg === "-") {
          const pathspecs = commandArgs.slice(i);
          return pathspecs.some((pathspec) => pathspec.startsWith("-"))
            ? []
            : pathspecs;
        }
        if (
          /^-[vsbz]+$/.test(arg) ||
          /^-u(?:all|normal|no)?$/.test(arg) ||
          /^-M(?:\d+%?)?$/.test(arg) ||
          /^--(?:no-)?(?:verbose|short|branch|show-stash|ahead-behind|porcelain|long|null|untracked-files|ignored|ignore-submodules|column)(?:=.*)?$/.test(
            arg,
          ) ||
          arg === "--renames" ||
          arg === "--no-renames" ||
          /^--find-renames(?:=.*)?$/.test(arg)
        ) {
          continue;
        }
        return [];
      }
      return [];
    };
    const pathspecs =
      boundary === -1 ? positionalPathspecs() : commandArgs.slice(boundary + 1);
    const configuredCommand = (key: string, safeValues: RegExp): boolean => {
      const result = Bun.spawnSync(
        ["git", ...prefix, "config", "--get-all", key],
        {
          cwd,
          env,
          stdout: "pipe",
          stderr: "ignore",
        },
      );
      if (result.exitCode === 1) return false;
      if (result.exitCode !== 0) return true;
      return (result.stdout?.toString() ?? "")
        .split(/\r?\n/)
        .filter(Boolean)
        .some((value) => !safeValues.test(value.trim()));
    };
    if (configuredCommand("core.fsmonitor", /^(?:true|false)$/i)) return true;
    if (
      pagerMode !== "disabled" &&
      (configuredCommand("core.pager", /^(?:cat|false)$/i) ||
        configuredCommand("pager.status", /^(?:cat|false)$/i))
    ) return true;
    let submoduleMode: string | undefined;
    for (const arg of optionArgs) {
      if (arg === "--ignore-submodules") submoduleMode = "all";
      else if (arg.startsWith("--ignore-submodules=")) {
        submoduleMode = arg.slice("--ignore-submodules=".length).toLowerCase();
      }
    }
    if (submoduleMode === "all") return false;

    const rootResult = Bun.spawnSync(
      ["git", ...prefix, "rev-parse", "--show-toplevel"],
      {
        cwd,
        env,
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    if (rootResult.exitCode !== 0) return false;
    const root = rootResult.stdout?.toString().trim();
    if (!root) return true;
    const visited = new Set<string>();
    const childEnv: Record<string, string | undefined> = { ...env };
    for (const name of [
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_OBJECT_DIRECTORY",
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_IMPLICIT_WORK_TREE",
      "GIT_GRAFT_FILE",
      "GIT_INDEX_FILE",
      "GIT_NAMESPACE",
      "GIT_PREFIX",
      "GIT_INTERNAL_SUPER_PREFIX",
      "GIT_QUARANTINE_PATH",
      "GIT_REPLACE_REF_BASE",
      "GIT_SHALLOW_FILE",
      "GIT_COMMON_DIR",
    ]) {
      deleteEnvironmentName(childEnv, name);
    }
    const indexedGitlinks = (
      repository: string,
      repositoryEnv: Record<string, string | undefined>,
      repositoryPathspecs: readonly string[] = [],
      useRootInvocation = false,
    ): string[] | null => {
      const command = useRootInvocation
        ? ["git", ...prefix, "ls-files", "--stage", "--full-name", "-z"]
        : ["git", "-C", repository, "ls-files", "--stage", "--full-name", "-z"];
      const result = Bun.spawnSync(
        [
          ...command,
          ...(repositoryPathspecs.length > 0 ? ["--", ...repositoryPathspecs] : []),
        ],
        {
          ...(useRootInvocation ? { cwd } : {}),
          env: repositoryEnv,
          stdout: "pipe",
          stderr: "ignore",
        },
      );
      if (result.exitCode !== 0) return null;
      const paths: string[] = [];
      for (const record of (result.stdout?.toString() ?? "").split("\0")) {
        if (!record) continue;
        const tab = record.indexOf("\t");
        if (tab === -1 || !record.slice(0, tab).startsWith("160000 ")) continue;
        const path = record.slice(tab + 1);
        if (path) paths.push(path);
      }
      return paths;
    };
    const unsafeSubmodule = (repository: string, depth: number): boolean => {
      if (depth > 16 || visited.size >= 64) return true;
      let identity: string;
      try {
        identity = realpathSync.native(repository);
      } catch {
        return true;
      }
      if (visited.has(identity)) return false;
      visited.add(identity);
      const fsmonitor = Bun.spawnSync(
        ["git", "-C", repository, "config", "--get-all", "core.fsmonitor"],
        {
          env: childEnv,
          stdout: "pipe",
          stderr: "ignore",
        },
      );
      if (fsmonitor.exitCode !== 0 && fsmonitor.exitCode !== 1) return true;
      if (
        fsmonitor.exitCode === 0 &&
        (fsmonitor.stdout?.toString() ?? "")
          .split(/\r?\n/)
          .filter(Boolean)
          .some((value) => !/^(?:true|false)$/i.test(value.trim()))
      ) {
        return true;
      }
      const gitlinks = indexedGitlinks(repository, childEnv);
      if (gitlinks === null) return true;
      for (const path of gitlinks) {
        const submodule = resolve(repository, path);
        if (!existsSync(join(submodule, ".git"))) continue;
        if (unsafeSubmodule(submodule, depth + 1)) return true;
      }
      return false;
    };
    const gitlinks = indexedGitlinks(root, env, pathspecs, true);
    if (gitlinks === null) return true;
    for (const path of gitlinks) {
      const submodule = resolve(root, path);
      if (!existsSync(join(submodule, ".git"))) continue;
      if (unsafeSubmodule(submodule, 1)) return true;
    }
    return false;
  }

  function gitCommandIsUnsafe(
    command: string,
    args: readonly string[],
    env: Record<string, string | undefined>,
    cwd: string,
  ): boolean {
    if (!command) return false;
    const result = Bun.spawnSync(["git", "--list-cmds=builtins"], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return true;
    const builtins = new Set(
      (result.stdout?.toString() ?? "")
        .split(/\s+/)
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
    );
    const folded = command.toLowerCase();
    if (!builtins.has(folded)) return true;
    if (folded === "config") {
      const invocation = gitInvocation(args);
      const configArgs = args.slice(invocation.subcommandIndex + 1);
      const boundary = configArgs.indexOf("--");
      const optionArgs = boundary === -1 ? configArgs : configArgs.slice(0, boundary);
      return !optionArgs.some(
        (arg) =>
          arg === "--get" ||
          arg === "--get-all" ||
          arg === "--get-regexp" ||
          arg === "--get-urlmatch" ||
          arg === "--list" ||
          arg === "-l",
      );
    }
    const invocation = gitInvocation(args);
    const commandArgs = args.slice(invocation.subcommandIndex + 1);
    const boundary = commandArgs.indexOf("--");
    const optionArgs = boundary === -1 ? commandArgs : commandArgs.slice(0, boundary);
    const pagerDisabled = gitPagerMode(invocation.prefix, env) === "disabled";
    if (folded === "branch") {
      return !(pagerDisabled && optionArgs.includes("--list"));
    }
    if (folded === "tag") {
      return !(
        pagerDisabled &&
        (optionArgs.includes("--list") || optionArgs.includes("-l"))
      );
    }
    if (folded === "diff") {
      let cached = false;
      let externalDiff: boolean | undefined;
      let textconv: boolean | undefined;
      let submoduleMode: string | undefined;
      for (const arg of optionArgs) {
        if (arg === "--cached" || arg === "--staged") cached = true;
        else if (arg === "--no-index") cached = false;
        else if (arg === "--ext-diff") externalDiff = true;
        else if (arg === "--no-ext-diff") externalDiff = false;
        else if (arg === "--textconv") textconv = true;
        else if (arg === "--no-textconv") textconv = false;
        else if (arg === "--ignore-submodules") submoduleMode = "all";
        else if (arg.startsWith("--ignore-submodules=")) {
          submoduleMode = arg.slice("--ignore-submodules=".length).toLowerCase();
        }
      }
      return !(
        pagerDisabled &&
        cached &&
        externalDiff === false &&
        textconv === false &&
        submoduleMode === "all"
      );
    }
    const safeBuiltins = new Set([
      "status",
      "rev-parse",
      "show-ref",
      "for-each-ref",
      "ls-files",
      "ls-tree",
      "check-ignore",
      "check-attr",
      "check-mailmap",
      "merge-base",
      "name-rev",
      "count-objects",
      "version",
    ]);
    if (!safeBuiltins.has(folded)) return true;
    return folded === "status" && gitStatusUsesExternalCommand(args, env, cwd);
  }

  function gitInvocationUsesDynamicEvaluation(
    args: readonly string[],
    command: string,
    env: Record<string, string | undefined>,
    cwd: string,
  ): boolean {
    if (gitUsesIndirectShellAlias(args, command)) return true;
    const resolution = gitPersistedAliasResolution(args, env, cwd);
    if (resolution.disposition === "unsafe") return true;
    return gitCommandIsUnsafe(resolution.command, args, env, cwd);
  }

  async function shellInvokesDynamicEvaluation(
    command: string,
    cwd = projectDir,
  ): Promise<boolean> {
    if (shellUsesDynamicExpansion(command)) return true;
    if (shellUsesConstructedHostInvocation(command)) return true;
    const interpreter =
      /^(?:ba|da|fi|k|z)?sh$|^(?:bun|bunx|deno|node|nodejs|npm|npx|pnpm|yarn|corepack|tsx|ts-node|python(?:\d+(?:\.\d+)*)?|ruby|perl|php|lua|luajit|raku|julia|java|js|qjs|osascript|powershell|pwsh|cmd|cscript|wscript|mshta|awk|gawk|mawk|nawk)(?:\.(?:exe|com|cmd|bat))?$/i;
    const directPowerShellHost =
      /^(?:remove|clear|set|new|move|copy|rename)-item$|^(?:set|add|clear)-content$|^out-file$|^(?:ri|rm|rd|del|erase|rmdir|mi|mv|cp|cpi|ren|ni|sc|ac|clc)$/i;
    const dynamicPowerShellHost =
      /^(?:invoke-expression|iex|invoke-command|icm|invoke-item|ii|start-process|saps|start-job|sajb)$/i;
    const inspectableDelegatedCommands = new Set([
      ":",
      "[",
      "ac",
      "add-content",
      "basename",
      "cat",
      "cd",
      "chdir",
      "clear-content",
      "clear-item",
      "clc",
      "cli",
      "cmp",
      "copy",
      "copy-item",
      "cp",
      "cpi",
      "cut",
      "dd",
      "del",
      "dir",
      "dirname",
      "echo",
      "erase",
      "exist",
      "false",
      "file",
      "find",
      "get-childitem",
      "get-content",
      "get-item",
      "git",
      "grep",
      "head",
      "join-path",
      "jq",
      "ls",
      "md",
      "mi",
      "mkdir",
      "move",
      "move-item",
      "mv",
      "new-item",
      "ni",
      "out-file",
      "pop-location",
      "popd",
      "printf",
      "push-location",
      "pushd",
      "pwd",
      "rd",
      "readlink",
      "realpath",
      "remove-item",
      "ren",
      "rename",
      "rename-item",
      "resolve-path",
      "rg",
      "ri",
      "rmdir",
      "rm",
      "rni",
      "rsync",
      "sc",
      "select-string",
      "set-content",
      "set-item",
      "set-location",
      "sha1sum",
      "sha256sum",
      "sha512sum",
      "shred",
      "sl",
      "sort",
      "split-path",
      "stat",
      "tail",
      "tee",
      "test",
      "test-path",
      "touch",
      "tr",
      "true",
      "truncate",
      "type",
      "uniq",
      "unlink",
      "wc",
      "where",
      "which",
    ]);
    const uninspectableExecutableToken = (value: string): boolean => {
      const normalized = value.replaceAll("\\", "/");
      return (
        normalized.includes("/") ||
        /^[A-Za-z]:/.test(normalized) ||
        /\.(?:bat|cmd|ps1|psd1|psm1|sh|bash|dash|fish|ksh|zsh|cjs|js|mjs|cts|mts|ts|py|rb|pl|php|lua|jar|vbs|wsf|hta)$/i.test(
          normalized,
        )
      );
    };
    const isInterpreter = (name: string): boolean => {
      const candidates = [name, posix.basename(name), win32.basename(name)];
      if (candidates.some((candidate) => interpreter.test(candidate))) return true;
      return /(?:powershell|pwsh|cmd|cscript|wscript|mshta|awk|gawk|mawk|nawk)(?:\.(?:exe|com|cmd|bat))?$/i.test(
        name,
      );
    };
    try {
      const module = await loadReviewFreezeCommandModule();
      if (
        typeof module.shellCommandAltersExecutableResolution !== "function" ||
        typeof module.shellCommandInvocationDetails !== "function"
      ) {
        return true;
      }
      if (module.shellCommandAltersExecutableResolution(command)) return true;
      const hostExpression = shellUsesDirectHostExpression(command);
      const flavor: PathFlavor =
        process.platform === "win32" ? "win32" : "posix";
      let states: ShellCwdState[] = [
        { cwd, stack: [], status: "unknown", logicalAmbiguous: false },
      ];
      let operatorBefore: ShellCommandPart["operatorAfter"] = "";
      for (const part of shellCommandParts(command)) {
        const segment = part.text;
        const parsed = shellWords(segment);
        if (parsed.ambiguous) return true;
        const activeStates: ShellCwdState[] = [];
        const carriedStates: ShellCwdState[] = [];
        for (const state of states) {
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
            if (state.status !== "failure") activeStates.push(active);
            if (state.status !== "success") carriedStates.push(carried);
          } else if (operatorBefore === "||") {
            if (state.status !== "success") activeStates.push(active);
            if (state.status !== "failure") carriedStates.push(carried);
          } else {
            activeStates.push(active);
          }
        }

        const functionDefinition =
          /^\s*(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*(?:\(\s*\))?\s*\{/.test(
            segment,
          );
        const invocations = functionDefinition
          ? []
          : module.shellCommandInvocationDetails(segment);
        for (const state of activeStates) {
          const gitContext = gitCommandEnvironment(segment, state.cwd);
          for (const invocation of invocations) {
            const leaf = win32.basename(posix.basename(invocation.name));
            if (
              invocation.ambiguous ||
              invocation.dataDrivenMutation ||
              [invocation.executable, ...(invocation.launchers ?? [])].some(
                (value) =>
                  typeof value !== "string" ||
                  value.length === 0 ||
                  uninspectableExecutableToken(value),
              ) ||
              isInterpreter(invocation.name) ||
              dynamicPowerShellHost.test(invocation.name) ||
              (/^git(?:\.exe)?$/i.test(leaf) &&
                (gitContext.ambiguous ||
                  gitInvocationUsesDynamicEvaluation(
                    invocation.args,
                    segment,
                    gitContext.env,
                    gitContext.cwd,
                  ))) ||
              (hostExpression &&
                directPowerShellHost.test(invocation.name)) ||
              (invocation.name === "find" &&
                invocation.args.some((arg) =>
                  ["-exec", "-execdir", "-ok", "-okdir"].includes(arg)
                )) ||
              invocation.name === "eval" ||
              invocation.name === "source" ||
              invocation.name === "." ||
              !inspectableDelegatedCommands.has(invocation.name)
            ) {
              return true;
            }
          }
        }

        const isolatedSubshell = /^\s*\(.*\)\s*$/.test(segment);
        const nonPersistent =
          isolatedSubshell || ["|", "&"].includes(part.operatorAfter);
        const controlAmbiguous =
          /[{}]/.test(segment) ||
          /\b(?:if|elif|else|while|until|case|for|select|function|then|do)\b/i.test(
            segment,
          );
        const nextStates: ShellCwdState[] = [...carriedStates];
        for (const state of activeStates) {
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
            existing.stack.every(
              (path, index) => path === state.stack[index],
            );
          existing.logicalAmbiguous ||=
            state.logicalAmbiguous || !sameLogicalState;
          if (state.cwd.length < existing.cwd.length) {
            existing.cwd = state.cwd;
            existing.stack = [...state.stack];
          }
        }
        if (deduped.size > MAX_SHELL_CWD_STATES) return true;
        states = [...deduped.values()];
        operatorBefore = part.operatorAfter;
      }
      return false;
    } catch {
      return true;
    }
  }

  async function touchesProtectedReviewerState(): Promise<boolean> {
    const toolInput = cursor.tool_input ?? {};
    const serialized = JSON.stringify(toolInput).replaceAll("\\", "/");
    if (
      [
        ".aidlc-cursor-subagents",
        ".aidlc-reviewer-dispatch.json",
        "aidlc-cursor-subagent-",
      ].some((token) => serialized.includes(token))
    ) {
      return true;
    }

    const protectedPaths = protectedReviewerPaths();
    const cwd = effectiveCwd();
    const command = toolInput.command;
    if (toolName === "Bash" && typeof command === "string") {
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

  function blockedByGuard(file: string, input: string): boolean {
    const r = runCoreWithStderr(file, input);
    if (r.code === 0) return false;
    const reason =
      r.code === 2
        ? r.stderr.trim() || "blocked by AIDLC guard hook"
        : `AIDLC guard ${file} failed with exit ${r.code}; ` +
          "the operation was denied because its safety checks could not complete.";
    process.stdout.write(`${JSON.stringify({ permission: "deny", agent_message: reason })}\n`);
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
            }),
          );
          retireSpawn(record);
        }
        removeLedger(mainFile(cursor.conversation_id));
      }
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
      // A Cursor background agent submits prompts with no human present; its
      // turn must not mint HUMAN_TURN (the approval gates' presence evidence).
      if (cursor.is_background_agent === true) return 0;
      // A real human acted this turn.
      runCore(
        "aidlc-record-human-turn.ts",
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          ...(sessionId ? { session_id: sessionId } : {}),
          prompt: cursor.prompt ?? cursor.user_message ?? "",
        }),
      );
      // Cursor's sessionStart fires only for a new conversation and carries no
      // startup/resume discriminator. Probe the core resume-rebind logic here,
      // where the same session_id is available. beforeSubmitPrompt cannot
      // inject context, so block this one submission through its documented
      // user_message channel when the active intent drifted.
      if (sessionId) {
        const r = runCore(
          "aidlc-session-start.ts",
          JSON.stringify({
            hook_event_name: "SessionStart",
            source: "resume",
            session_id: sessionId,
            rebind_check: true,
          }),
        );
        try {
          const parsed = JSON.parse(r.stdout) as { additionalContext?: string };
          const offer = parsed.additionalContext
            ?.split(/\r?\n/)
            .find((line) => line.startsWith("INTENT REBIND OFFER:"));
          if (offer) {
            process.stdout.write(`${JSON.stringify({
              continue: false,
              user_message:
                `${offer} Submit the named /aidlc switch command to return, ` +
                "or resubmit your prompt to continue with the active intent.",
            })}\n`);
          }
        } catch {
          // no rebind offer — submission continues normally
        }
      }
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
        if (blockedByGuard("aidlc-plan-approval-guard.ts", claudeShaped("PreToolUse"))) {
          return 0;
        }
        const sub = cursor.tool_input?.subagent_type;
        if (
          typeof sub === "string" &&
          sub.length > 0 &&
          !recordSpawn(sub)
        ) {
          process.stdout.write(`${JSON.stringify({
            permission: "deny",
            agent_message:
              "AIDLC could not establish protected delegated-agent attribution, so the Task was not started.",
          })}\n`);
          return 0;
        }
        writeAllow();
        return 0;
      }
      const agent = attributed();
      const command = cursor.tool_input?.command;
      if (
        agent &&
        toolName === "Bash" &&
        typeof command === "string" &&
        await shellInvokesDynamicEvaluation(command, effectiveCwd())
      ) {
        process.stdout.write(`${JSON.stringify({
          permission: "deny",
          agent_message:
            "AIDLC delegated agents cannot use general-purpose interpreters, shell parameter " +
            "expansion, or dynamic command evaluation while delegated-agent attribution is active " +
            "because those paths can invalidate protected attribution state. " +
            "Use Cursor's native read/search tools and have the parent conversation run executable probes.",
        })}\n`);
        return 0;
      }
      if (agent && await touchesProtectedReviewerState()) {
        process.stdout.write(`${JSON.stringify({
          permission: "deny",
          agent_message:
            "AIDLC delegated agents cannot read, modify, or remove reviewer attribution state.",
        })}\n`);
        return 0;
      }
      if (agent === AMBIGUOUS_REVIEWER) {
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
      // condition, so spawning a second Bun process can add no decision value.
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
        if (blockedByGuard(guard.file, guard.input)) return 0;
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
      // preCompact: the core hook reads no stdin fields — self-contained.
      runCore("aidlc-validate-state.ts", rawInput);
      return 0;
    }

    case "stop": {
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
