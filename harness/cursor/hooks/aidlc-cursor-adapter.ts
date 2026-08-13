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
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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
  // project runtime tree, and delegated tools cannot access it. If it becomes
  // unreadable or disappears while a reviewer dispatch record is live, unknown
  // conversations fail closed as an ambiguous reviewer rather than losing
  // enforcement.
  const LEDGER_TTL_MS = 30 * 60 * 1000;
  const REVIEWER_DISPATCH_TTL_MS = 6 * 60 * 60 * 1000;
  const AMBIGUOUS_REVIEWER = "__aidlc_ambiguous_reviewer__";
  const REVIEW_AGENT_RE = /^aidlc-(architecture-reviewer|product-lead)-agent$/;
  const LEDGER_DIR = join(projectDir, "aidlc", ".aidlc-cursor-subagents");
  const ledgerPrefix = "spawn-";

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

  function ledgerFiles(): string[] {
    try {
      return readdirSync(LEDGER_DIR)
        .filter((name) => name.startsWith(ledgerPrefix) && name.endsWith(".json"))
        .map((name) => join(LEDGER_DIR, name));
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

  function activeReviewerDispatch(): string | null {
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
      if (!stat.isFile() || Date.now() - stat.mtimeMs > REVIEWER_DISPATCH_TTL_MS) return null;
      return dispatch;
    } catch {
      return null;
    }
  }

  function recordSpawn(subagentType: string): void {
    const parent = cursor.conversation_id ?? "";
    const task = taskIdentity();
    if (!parent || !task) return;
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
      removeLedger(priorPath);
    }
    const path = ledgerFile(parent, task);
    const pending = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(LEDGER_DIR, { recursive: true });
      writeFileSync(pending, JSON.stringify({ agent: subagentType, parent, task }), "utf-8");
      renameSync(pending, path);
    } catch {
      removeLedger(pending);
      // activeSubagent() fails closed while a reviewer dispatch is live
    }
  }

  function clearSpawn(): void {
    const parent = cursor.conversation_id ?? "";
    const task = taskIdentity();
    if (!parent) return;
    if (task) {
      removeLedger(ledgerFile(parent, task));
      return;
    }
    // Defensive fallback for a completion payload that omits tool_use_id:
    // clear only this parent conversation's records.
    for (const path of ledgerFiles()) {
      if (readRecord(path)?.parent === parent) removeLedger(path);
    }
  }

  function activeSubagent(): string {
    const conversation = cursor.conversation_id ?? "";
    if (!conversation || isKnownMain(conversation)) return "";
    const reviewerDispatch = activeReviewerDispatch();
    const live: Array<{ path: string; record: SubagentRecord }> = [];
    for (const path of ledgerFiles()) {
      const record = readRecord(path);
      if (record) live.push({ path, record });
    }
    if (live.length === 0) {
      return reviewerDispatch === null ? "" : AMBIGUOUS_REVIEWER;
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
        } catch {
          // expiry only widens back to fail-open
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
      return "";
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

  function effectiveCwd(): string {
    const nested =
      cursor.tool_input?.working_directory ??
      cursor.tool_input?.cwd;
    for (const candidate of [nested, cursor.cwd]) {
      if (typeof candidate !== "string" || candidate.length === 0) continue;
      return isAbsolute(candidate) ? candidate : resolve(projectDir, candidate);
    }
    return projectDir;
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

  function shellWords(command: string): string[] {
    const words: string[] = [];
    let word = "";
    let quote: "'" | '"' | null = null;
    let escaped = false;
    const push = () => {
      if (word.length > 0) words.push(word);
      word = "";
    };
    for (const ch of command) {
      if (escaped) {
        word += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\" && quote !== "'") {
        escaped = true;
        continue;
      }
      if (quote !== null) {
        if (ch === quote) quote = null;
        else word += ch;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (/\s/.test(ch) || ";|&()<>".includes(ch)) {
        push();
        continue;
      }
      word += ch;
    }
    push();
    return words;
  }

  interface ReviewFreezeShellModule {
    shellWriteTargets?: (command: string, cwd?: string) => string[];
    shellCommandInvocations?: (command: string) => Array<{ name: string; args: string[] }>;
  }

  let reviewFreezeShellModule: Promise<ReviewFreezeShellModule> | null = null;
  function loadReviewFreezeShellModule(): Promise<ReviewFreezeShellModule> {
    reviewFreezeShellModule ??= import(
      join(HOOKS_DIR, "aidlc-review-freeze.ts")
    ) as Promise<ReviewFreezeShellModule>;
    return reviewFreezeShellModule;
  }

  function protectedReviewerPaths(): string[] {
    const dispatch = activeReviewerDispatch();
    return dispatch === null ? [LEDGER_DIR] : [LEDGER_DIR, dispatch];
  }

  function overlapsProtectedPath(candidate: string, protectedPaths: readonly string[]): boolean {
    const normalized = resolve(candidate);
    return protectedPaths.some(
      (path) =>
        normalized === path ||
        normalized.startsWith(`${path}${sep}`) ||
        path.startsWith(`${normalized}${sep}`),
    );
  }

  function globPrefixTouchesProtected(
    raw: string,
    cwd: string,
    protectedPaths: readonly string[],
  ): boolean {
    if (["{", "}", "(", ")"].includes(raw)) return false;
    const glob = raw.search(/[*?[\]{}]/);
    if (glob === -1) return false;
    let prefix = raw.slice(0, glob);
    const equals = prefix.lastIndexOf("=");
    if (equals !== -1) prefix = prefix.slice(equals + 1);
    const bracedPwd = "$" + "{PWD}";
    if (prefix === "$PWD" || prefix === bracedPwd) {
      prefix = cwd;
    } else if (prefix.startsWith("$PWD/")) {
      prefix = join(cwd, prefix.slice("$PWD/".length));
    } else if (prefix.startsWith(`${bracedPwd}/`)) {
      prefix = join(cwd, prefix.slice(`${bracedPwd}/`.length));
    }
    const normalized = isAbsolute(prefix) ? resolve(prefix) : resolve(cwd, prefix);
    return protectedPaths.some((path) => path.startsWith(normalized));
  }

  function concreteWordTouchesProtected(
    raw: string,
    cwd: string,
    protectedPaths: readonly string[],
  ): boolean {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) return false;
    const equals = raw.lastIndexOf("=");
    const candidate = (equals === -1 ? raw : raw.slice(equals + 1))
      .replace(/^[,:[\]{}()]+|[,:[\]{}()]+$/g, "");
    if (
      candidate.length === 0 ||
      candidate.startsWith("-") ||
      /[$`*?[\]{}]/.test(candidate) ||
      (!candidate.includes("/") && !candidate.includes("\\") && !candidate.startsWith("."))
    ) {
      return false;
    }
    const normalized = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
    return overlapsProtectedPath(normalized, protectedPaths);
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
        if (ch !== "$") continue;
        const next = command[i + 1] ?? "";
        if (/[\w@*#?$!{('"_-]/.test(next)) return true;
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
      if (ch !== "$") continue;
      const next = command[i + 1] ?? "";
      if (/[\w@*#?$!{('"_-]/.test(next)) return true;
    }
    return false;
  }

  async function shellInvokesDynamicEvaluation(command: string): Promise<boolean> {
    if (shellUsesDynamicExpansion(command)) return true;
    const interpreter =
      /^(?:ba|da|fi|k|z)?sh$|^(?:bun|bunx|deno|node|nodejs|npm|npx|pnpm|yarn|corepack|tsx|ts-node|python(?:\d+(?:\.\d+)*)?|ruby|perl|php|lua|luajit|raku|julia|java|js|qjs|osascript|powershell|pwsh)$/i;
    try {
      const module = await loadReviewFreezeShellModule();
      if (typeof module.shellCommandInvocations !== "function") return true;
      return module.shellCommandInvocations(command).some(
        (invocation) =>
          interpreter.test(invocation.name) ||
          invocation.name === "eval" ||
          invocation.name === "source" ||
          invocation.name === ".",
      );
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
      try {
        const module = await loadReviewFreezeShellModule();
        const concrete = module.shellWriteTargets?.(command, cwd) ?? [];
        if (concrete.some((path) => overlapsProtectedPath(path, protectedPaths))) return true;
      } catch {
        // The registered review-freeze guard will fail closed if its module is unavailable.
      }
      if (
        shellWords(command).some((word) =>
          globPrefixTouchesProtected(word, cwd, protectedPaths) ||
          concreteWordTouchesProtected(word, cwd, protectedPaths)
        )
      ) {
        return true;
      }
    }

    return pathOperandValues(toolInput).some(
      (value) =>
        (globPrefixTouchesProtected(value, cwd, protectedPaths) ||
          (!/[\s*?[\]{}]/.test(value) &&
            overlapsProtectedPath(
              isAbsolute(value) ? value : resolve(cwd, value),
              protectedPaths,
            ))),
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
          removeLedger(path);
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
      runCore("aidlc-record-human-turn.ts", JSON.stringify({ hook_event_name: "UserPromptSubmit" }));
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
      // self-filter by tool; a Task spawn runs the plan-approval guard before
      // it feeds the identity ledger. Block contract conversion: core exit 2 + stderr becomes
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
        if (typeof sub === "string" && sub.length > 0) recordSpawn(sub);
        writeAllow();
        return 0;
      }
      const agent = attributed();
      if (agent && await touchesProtectedReviewerState()) {
        process.stdout.write(`${JSON.stringify({
          permission: "deny",
          agent_message:
            "AIDLC delegated agents cannot read, modify, or remove reviewer attribution state.",
        })}\n`);
        return 0;
      }
      const command = cursor.tool_input?.command;
      if (
        agent &&
        toolName === "Bash" &&
        typeof command === "string" &&
        (REVIEW_AGENT_RE.test(agent) || activeReviewerDispatch() !== null) &&
        await shellInvokesDynamicEvaluation(command)
      ) {
        process.stdout.write(`${JSON.stringify({
          permission: "deny",
          agent_message:
            "AIDLC delegated agents cannot use general-purpose interpreters, shell parameter " +
            "expansion, or dynamic command evaluation while reviewer attribution is active " +
            "because those paths can bypass attribution-state protection. " +
            "Use Cursor's native read/search tools and have the parent conversation run executable probes.",
        })}\n`);
        return 0;
      }
      if (agent === AMBIGUOUS_REVIEWER) {
        process.stdout.write(`${JSON.stringify({
          permission: "deny",
          agent_message:
            "AIDLC reviewer identity is unavailable or ambiguous during an active review dispatch; " +
            "the operation was denied rather than bypassing reviewer-scope enforcement.",
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
        {
          file: "aidlc-review-freeze.ts",
          input: claudeShaped("PreToolUse", reviewerToolName),
        },
      ];
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
