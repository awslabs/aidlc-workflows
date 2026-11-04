#!/usr/bin/env bun
// aidlc-antigravity-adapter.ts — the Antigravity hook shim (AUTHORED shell
// file; the aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared
// with the Claude Code harness). Modeled on the Cursor adapter: ONE shim
// normalizes the Antigravity payload to the ClaudeCodeHookInput shape and
// subprocess-pipes into the named core hook.
//
// Antigravity payloads (live corpus, agy cli-2026.10.13 on macOS; the IDE and
// CLI share the hooks.json contract) differ from Claude Code's in these
// load-bearing ways:
//   1. Keys are camelCase protojson (conversationId, stepIdx, toolCall.name,
//      toolCall.args, workspacePaths, transcriptPath). There is no session id
//      beside the conversation id, no tool-use id (a tool call is identified
//      by conversation + stepIdx), and no subagent identity on any payload.
//   2. The events are SessionStart, PreInvocation (before every model call),
//      PreToolUse, PostToolUse (also for a failed tool, with `error` set),
//      PostInvocation and Stop. There is NO prompt-submit event, NO session
//      end and NO pre-compaction event.
//   3. PreToolUse answers with {"decision":"allow"|"deny","reason"} JSON on
//      stdout, and an EMPTY answer is a deny (live-verified: `{}` blocked the
//      call), so every allow path writes the allow JSON. Stop answers with
//      {"decision":"continue","reason"} to refuse a stop, so the forwarding
//      loop is enforceable here. SessionStart injects context through
//      {"injectSteps":[{"systemMessage":{"systemMessage":...}}]}.
//   4. Tool names are the host's step types: run_command (CommandLine, Cwd),
//      view_file (AbsolutePath), write_to_file (TargetFile, CodeContent),
//      replace_file_content / multi_replace_file_content / sed_file
//      (TargetFile), notebook_edit, invoke_subagent (Subagents[].TypeName and
//      Prompt, or TypeName/Prompt at the top level), and the search tools.
//      Another build may spell the same tools read_file / write_file /
//      edit_file (Path, Content); both spellings are mapped.
//   5. A hook's working directory is the directory holding hooks.json
//      (.agents/), so hooks.json steps up to the project root first; the
//      payload's workspacePaths[0] names it as well.
//   6. The human's turn is NOT a hook event. The transcript the payload names
//      (transcriptPath) is the deterministic record: a step with
//      type USER_INPUT and source USER_EXPLICIT is the person's own message,
//      and a completed ASK_QUESTION step is their answer in the ask_question
//      modal (its content carries the answers; the step before it carries the
//      questions); a parent woken by its delegate's message, and a delegate's
//      own first step, are SYSTEM_MESSAGE steps. PreInvocation reads the
//      transcript tail and mints HUMAN_TURN once per new human step;
//      PreToolUse repeats the cheap check so a transcript written after the
//      first PreInvocation is still read before the engine needs the record.
//   7. A delegate runs in its OWN conversation, whose hooks fire exactly like
//      a main chat's. Its transcript starts with a SYSTEM_MESSAGE (never a
//      USER_EXPLICIT step), which tells it apart; the parent's
//      invoke_subagent dispatch record (agent + prompt) attributes it to the
//      persona it runs, so the reviewer read scope can be enforced.
//
// Usage (wired in .agents/hooks.json, which steps up to the project root):
//   bun .agents/hooks/aidlc-antigravity-adapter.ts <target>
// where <target> ∈ session-start | turn | guards | audit-and-sensors |
//                  runtime-compile | stop

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decideFence,
  engineDirFor,
  enterHookWorkflow,
  promptMovesSelection,
  recordHookDrop,
  takeSessionSelectionNotice,
} from "../tools/aidlc-lib.ts";
import { aidlcInvocation, knownActiveSpace } from "../tools/aidlc-runtime-paths.ts";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

interface AntigravityToolCall {
  name?: string;
  args?: Record<string, unknown>;
}

interface AntigravityHookInput {
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  modelName?: string;
  stepIdx?: number;
  toolCall?: AntigravityToolCall;
  error?: string;
  result?: string;
  invocationNum?: number;
  initialNumSteps?: number;
  executionNum?: number;
  terminationReason?: string;
  fullyIdle?: boolean;
}

interface TranscriptStep {
  step_index?: number;
  type?: string;
  source?: string;
  status?: string;
  content?: string;
  tool_calls?: Array<{ name?: string; args?: unknown }>;
}

// The host tool name → Claude tool name the core hooks key on. Both spellings
// a build may use are listed; anything else keeps its own name, which the
// core hooks ignore.
const TOOL_NAMES: Record<string, string> = {
  run_command: "Bash",
  view_file: "Read",
  read_file: "Read",
  view_code_item: "Read",
  write_to_file: "Write",
  write_file: "Write",
  replace_file_content: "Edit",
  multi_replace_file_content: "MultiEdit",
  edit_file: "Edit",
  sed_file: "Edit",
  notebook_edit: "NotebookEdit",
  invoke_subagent: "Task",
  grep_search: "Grep",
  find_by_name: "Glob",
  list_dir: "Glob",
  codebase_search: "Grep",
};

const DELEGATION_TOOLS = new Set([
  "invoke_subagent",
  "define_subagent",
  "manage_subagents",
  "send_message",
  "swarm",
  "run_workflow",
  "browser_subagent",
]);

export async function run(
  target: string,
  input: string,
  _extraArgs: string[] = [],
): Promise<number> {
  let rawInput = "";
  let host: AntigravityHookInput = {};
  if (!process.stdin.isTTY) {
    try {
      rawInput = input;
      if (rawInput.length > 0) host = JSON.parse(rawInput) as AntigravityHookInput;
    } catch {
      if (target === "guards") {
        process.stdout.write(`${JSON.stringify({
          decision: "deny",
          reason:
            "AIDLC could not read this tool call's hook input, so its safety checks could not run and the call " +
            "was stopped. Retry it once; if it is stopped again, tell the person to reload the Antigravity " +
            "window (or start agy again) in this folder, since Antigravity sends this input itself.",
        })}\n`);
      }
      return 0;
    }
  }

  // The project root: the engine's own variable first, then the workspace the
  // host names, then the directory above a .agents/ cwd (hooks.json runs with
  // cwd set to the directory holding it).
  const workspace = Array.isArray(host.workspacePaths) ? host.workspacePaths[0] : undefined;
  const cwd = process.cwd();
  const projectDirRaw =
    process.env.AIDLC_PROJECT_DIR ??
    process.env.CLAUDE_PROJECT_DIR ??
    (typeof workspace === "string" && workspace.length > 0
      ? workspace
      : basename(cwd) === ".agents"
        ? dirname(cwd)
        : cwd);
  const projectDir = isAbsolute(projectDirRaw) ? projectDirRaw : resolve(cwd, projectDirRaw);
  const conversation = host.conversationId ?? process.env.ANTIGRAVITY_CONVERSATION_ID ?? "";
  const sessionId = conversation || undefined;
  const projectEnv = {
    ...process.env,
    AIDLC_PROJECT_DIR: projectDir,
    CLAUDE_PROJECT_DIR: projectDir,
  };

  // --- Core-hook subprocess plumbing ------------------------------------------

  function coreCommand(hookFile: string): { command: string[]; token: string } {
    const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
    const hook = hookFile.replace(/^aidlc-|\.ts$/g, "");
    const token = hook === "record-human-turn" ? randomUUID() : "";
    const command = executable
      ? token
        ? [executable, "--internal-aidlc-record-human-turn", join(HOOKS_DIR, hookFile)]
        : [executable, "engine", "hook", hook]
      : token
        ? [
            process.execPath,
            join(HOOKS_DIR, "..", "tools", "aidlc.ts"),
            "--internal-aidlc-record-human-turn",
            join(HOOKS_DIR, hookFile),
          ]
        : [process.execPath, join(HOOKS_DIR, hookFile)];
    return { command, token };
  }

  function runCore(hookFile: string, stdinText: string): { stdout: string; code: number } {
    const { command, token } = coreCommand(hookFile);
    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(stdinText, "utf-8"),
      stdout: "pipe",
      stderr: "ignore",
      cwd: projectDir,
      env: token ? { ...projectEnv, AIDLC_INTERNAL_HUMAN_TURN_TOKEN: token } : projectEnv,
    });
    return { stdout: r.stdout?.toString() ?? "", code: r.exitCode ?? 0 };
  }

  function runCoreWithStderr(
    hookFile: string,
    stdinText: string,
  ): { stdout: string; stderr: string; code: number; signal: string | null } {
    const { command, token } = coreCommand(hookFile);
    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(stdinText, "utf-8"),
      stdout: "pipe",
      stderr: "pipe",
      cwd: projectDir,
      env: token ? { ...projectEnv, AIDLC_INTERNAL_HUMAN_TURN_TOKEN: token } : projectEnv,
    });
    return {
      stdout: r.stdout?.toString() ?? "",
      stderr: r.stderr?.toString() ?? "",
      code: r.exitCode ?? 1,
      signal: r.exitCode === null ? (r.signalCode ?? "a signal") : null,
    };
  }

  // --- Transcript reading ---------------------------------------------------------
  //
  // The host writes each conversation's steps to transcriptPath as JSON lines.
  // Only the first line (the conversation's kind) and the tail (the newest
  // steps) are read, never the whole file.

  const TAIL_BYTES = 512 * 1024;

  function transcriptPath(): string | null {
    const path = host.transcriptPath;
    if (typeof path !== "string" || path.length === 0) return null;
    return path;
  }

  function parseSteps(text: string, dropFirstPartial: boolean): TranscriptStep[] {
    const lines = text.split("\n");
    if (dropFirstPartial) lines.shift();
    const steps: TranscriptStep[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const step = JSON.parse(trimmed) as TranscriptStep;
        if (step && typeof step === "object") steps.push(step);
      } catch {
        // a line still being written
      }
    }
    return steps;
  }

  function transcriptTail(): TranscriptStep[] {
    const path = transcriptPath();
    if (!path) return [];
    try {
      const size = statSync(path).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const length = size - start;
      const buffer = Buffer.alloc(length);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buffer, 0, length, start);
      } finally {
        closeSync(fd);
      }
      return parseSteps(buffer.toString("utf-8"), start > 0);
    } catch {
      return [];
    }
  }

  function transcriptHead(): TranscriptStep | null {
    const path = transcriptPath();
    if (!path) return null;
    try {
      const fd = openSync(path, "r");
      let text = "";
      try {
        const chunk = Buffer.alloc(64 * 1024);
        let offset = 0;
        while (!text.includes("\n") && offset < 8 * 1024 * 1024) {
          const read = readSync(fd, chunk, 0, chunk.length, offset);
          if (read <= 0) break;
          text += chunk.subarray(0, read).toString("utf-8");
          offset += read;
        }
      } finally {
        closeSync(fd);
      }
      const first = text.split("\n")[0]?.trim();
      if (!first) return null;
      return JSON.parse(first) as TranscriptStep;
    } catch {
      return null;
    }
  }

  function isHumanStep(step: TranscriptStep): boolean {
    return step.type === "USER_INPUT" && step.source === "USER_EXPLICIT";
  }

  function parseObject(value: unknown): Record<string, unknown> {
    if (typeof value === "string") {
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return {};
      }
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  function parseArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      try {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        return [];
      }
    }
    return [];
  }

  // Antigravity options fold `<label> - <description>` (or `—`) into one
  // string; split back into label + description when each label stays distinct.
  function splitOptionString(option: string): { label: string; description: string } {
    const sep = /\s+(?:-|—)\s+/.exec(option);
    if (sep && sep.index > 0) {
      const label = option.slice(0, sep.index).trim();
      const description = option.slice(sep.index + sep[0].length).trim();
      if (label) return { label, description: description || label };
    }
    return { label: option, description: option };
  }

  function askQuestionCall(
    steps: TranscriptStep[],
    answer: TranscriptStep,
  ): { name?: string; args?: unknown } | undefined {
    const index = steps.indexOf(answer);
    if (index < 0) return undefined;
    for (let i = index - 1; i >= 0 && i >= index - 5; i--) {
      if (steps[i].type === "ASK_QUESTION") break;
      if (i < index - 1 && isPickerStep(steps, steps[i])) break;
      const call = (steps[i].tool_calls ?? []).find((entry) => entry.name === "ask_question");
      if (call) return call;
    }
    return undefined;
  }

  // The person's answer in the ask_question modal: the step is complete and
  // its content carries at least one answer line. Newer Antigravity builds
  // record completed ask_question steps with type GENERIC instead of
  // ASK_QUESTION, paired with the preceding planner ask_question tool call.
  function isPickerStep(steps: TranscriptStep[], step: TranscriptStep): boolean {
    if (step.status !== "DONE" || typeof step.content !== "string" || !/^A\d+:/m.test(step.content)) {
      return false;
    }
    if (step.type === "ASK_QUESTION") return true;
    if (step.type === "GENERIC") return askQuestionCall(steps, step) !== undefined;
    return false;
  }

  // The questions the ask_question call asked, from the preceding planner
  // step, and the answers it carries, as the core hook's picker payload.
  function pickerPayload(steps: TranscriptStep[], answer: TranscriptStep): Record<string, unknown> {
    const call = askQuestionCall(steps, answer);
    const args = parseObject(call?.args);
    const asked = parseArray(args.questions);
    const labelMaps: Array<Map<string, string>> = [];
    const questions = asked.map((entry) => {
      const q = parseObject(entry);
      const multiSelect = q.is_multi_select === true;
      const rawOptions = parseArray(q.options).filter((option): option is string => typeof option === "string");
      const split = rawOptions.map(splitOptionString);
      const distinct = new Set(split.map((item) => item.label.toLowerCase())).size === split.length;
      const options = distinct
        ? split
        : rawOptions.map((label) => ({ label, description: label }));
      labelMaps.push(
        new Map<string, string>(
          !multiSelect && distinct ? rawOptions.map((raw, idx) => [raw.trim(), split[idx].label]) : [],
        ),
      );
      return {
        question: typeof q.question === "string" ? q.question : "",
        header: "Choice",
        multiSelect,
        options,
      };
    });
    const answers: Record<string, string> = {};
    for (const match of (answer.content ?? "").matchAll(/^A(\d+):\s*(.*)$/gm)) {
      const n = Number(match[1]) - 1;
      const text = match[2].trim();
      if (!text) continue;
      const question = questions[n]?.question || `question ${n + 1}`;
      answers[question] = labelMaps[n]?.get(text) ?? text;
    }
    return {
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      tool_input: { questions },
      tool_response: { questions, answers },
    };
  }

  // The person's words: the USER_REQUEST element when the host wraps them,
  // else the step content.
  function humanWords(step: TranscriptStep): string {
    const content = typeof step.content === "string" ? step.content : "";
    const m = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
    return (m ? m[1] : content).trim();
  }

  // --- Conversation ledger --------------------------------------------------------
  //
  // Antigravity delivers NO agent identity on a delegate's own tool calls and
  // NO prompt-submit event. The adapter keeps a protected project-local
  // ledger: one record per invoke_subagent dispatch (agent + parent + prompt
  // digest), one marker per conversation whose kind is known (main or the
  // delegate it was attributed to), and the index of the last human step it
  // minted per conversation. The store lives in the project runtime tree, and
  // delegated tools cannot write it: the review-freeze and plan-approval
  // guards treat aidlc/ as protected for a delegate.
  const LEDGER_TTL_MS = 30 * 60 * 1000;
  const REVIEWER_DISPATCH_TTL_MS = 6 * 60 * 60 * 1000;
  const AMBIGUOUS_REVIEWER = "__aidlc_ambiguous_reviewer__";
  const REVIEW_AGENT_RE = /^aidlc-(architecture-reviewer|product-lead)-agent$/;
  const LEDGER_DIR = join(projectDir, "aidlc", ".aidlc-antigravity-subagents");
  const spawnPrefix = "spawn-";

  interface SpawnRecord {
    agent: string;
    parent: string;
    task: string;
    promptHead: string;
    promptDigest: string;
    /** The delegate conversation once one was attributed to this spawn. */
    conversation?: string;
  }

  interface ConversationRecord {
    kind: "main" | "delegate";
    agent?: string;
    spawn?: string;
    lastHumanStep?: number;
    continueAt?: number;
  }

  function digest(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
  }

  function spawnFile(parent: string, task: string): string {
    return join(LEDGER_DIR, `${spawnPrefix}${digest(parent)}-${digest(task)}.json`);
  }

  function conversationFile(id: string): string {
    return join(LEDGER_DIR, `conversation-${digest(id)}.json`);
  }

  function writeJson(path: string, value: unknown): void {
    mkdirSync(LEDGER_DIR, { recursive: true });
    const pending = `${path}.${process.pid}.tmp`;
    writeFileSync(pending, JSON.stringify(value), "utf-8");
    renameSync(pending, path);
  }

  function removeFile(path: string): void {
    try {
      rmSync(path, { force: true });
    } catch {
      // best-effort; stale records also expire via TTL
    }
  }

  function readSpawn(path: string): SpawnRecord | null {
    try {
      if (Date.now() - statSync(path).mtimeMs > LEDGER_TTL_MS) {
        removeFile(path);
        return null;
      }
      const record = JSON.parse(readFileSync(path, "utf-8")) as Partial<SpawnRecord>;
      if (!record.agent || !record.parent || !record.task) return null;
      return {
        agent: record.agent,
        parent: record.parent,
        task: record.task,
        promptHead: record.promptHead ?? "",
        promptDigest: record.promptDigest ?? "",
        ...(record.conversation ? { conversation: record.conversation } : {}),
      };
    } catch {
      return null;
    }
  }

  function spawnFiles(): string[] {
    try {
      return readdirSync(LEDGER_DIR)
        .filter((name) => name.startsWith(spawnPrefix) && name.endsWith(".json"))
        .sort()
        .map((name) => join(LEDGER_DIR, name));
    } catch {
      return [];
    }
  }

  function liveSpawns(): Array<{ path: string; record: SpawnRecord }> {
    const live: Array<{ path: string; record: SpawnRecord }> = [];
    for (const path of spawnFiles()) {
      const record = readSpawn(path);
      if (record) live.push({ path, record });
    }
    return live;
  }

  function readConversation(id: string): ConversationRecord | null {
    if (!id) return null;
    try {
      const record = JSON.parse(readFileSync(conversationFile(id), "utf-8")) as ConversationRecord;
      return record && (record.kind === "main" || record.kind === "delegate") ? record : null;
    } catch {
      return null;
    }
  }

  function writeConversation(id: string, record: ConversationRecord): void {
    if (!id) return;
    try {
      writeJson(conversationFile(id), record);
    } catch {
      // best-effort; the next event classifies again from the transcript
    }
  }

  function touch(path: string): void {
    const now = new Date();
    try {
      utimesSync(path, now, now);
    } catch {
      // gone; nothing to refresh
    }
  }

  let activeReviewerDispatchCache: string | null | undefined;
  function activeReviewerDispatch(): string | null {
    if (activeReviewerDispatchCache !== undefined) return activeReviewerDispatchCache;
    try {
      const spacePointer = join(projectDir, "aidlc", "active-space");
      const space = existsSync(spacePointer)
        ? knownActiveSpace(join(projectDir, "aidlc"), readFileSync(spacePointer, "utf-8"))
        : "default";
      const intentsDir = join(projectDir, "aidlc", "spaces", space, "intents");
      const activeIntent = readFileSync(join(intentsDir, "active-intent"), "utf-8").trim();
      if (!activeIntent || activeIntent.includes("/") || activeIntent.includes("\\")) return null;
      const dispatch = join(engineDirFor(join(intentsDir, activeIntent)), "reviewer-dispatch.json");
      const stat = statSync(dispatch);
      activeReviewerDispatchCache =
        stat.isFile() && Date.now() - stat.mtimeMs <= REVIEWER_DISPATCH_TTL_MS ? dispatch : null;
    } catch {
      activeReviewerDispatchCache = null;
    }
    return activeReviewerDispatchCache;
  }

  // Classify this conversation: a main chat (its transcript holds the
  // person's own message) or a delegate (its transcript opens with the
  // dispatch, a SYSTEM_MESSAGE). The result is remembered; a transcript not
  // written yet leaves it unknown for now.
  let kindCache: ConversationRecord | null | undefined;
  function conversationRecord(): ConversationRecord | null {
    if (kindCache !== undefined) return kindCache;
    const known = readConversation(conversation);
    if (known) {
      kindCache = known;
      return known;
    }
    const head = transcriptHead();
    if (head === null) {
      kindCache = null;
      return null;
    }
    if (isHumanStep(head)) {
      const record: ConversationRecord = { kind: "main" };
      writeConversation(conversation, record);
      kindCache = record;
      return record;
    }
    if (head.type === "SYSTEM_MESSAGE" || head.type === "USER_INPUT") {
      // A delegate's first step is the dispatch. Attribute it to the spawn
      // whose prompt it carries; with one live spawn, to that one.
      const live = liveSpawns().filter(({ record }) => !record.conversation);
      const content = typeof head.content === "string" ? head.content : "";
      const matching = live.filter(({ record }) =>
        record.promptHead.length > 0 && content.includes(record.promptHead)
      );
      const chosen = matching.length === 1 ? matching[0] : live.length === 1 ? live[0] : null;
      const record: ConversationRecord = {
        kind: "delegate",
        ...(chosen ? { agent: chosen.record.agent, spawn: basename(chosen.path) } : {}),
      };
      if (chosen) {
        try {
          writeJson(chosen.path, { ...chosen.record, conversation });
        } catch {
          // the spawn stays attributable to the next delegate event
        }
      }
      writeConversation(conversation, record);
      kindCache = record;
      return record;
    }
    kindCache = null;
    return null;
  }

  function isDelegate(): boolean {
    const record = conversationRecord();
    if (record) return record.kind === "delegate";
    // Unknown while a dispatch is live: treat as the delegate it may be, so a
    // workflow note never reaches a delegate and no human turn is minted for
    // it. Unknown with no dispatch live: a main chat.
    return liveSpawns().length > 0;
  }

  // The persona a delegate conversation runs, "" for a main chat, or the
  // ambiguity marker when a live dispatch exists and the identity cannot be
  // settled, so reviewer enforcement never silently disappears.
  let attributedCache: string | undefined;
  function attributed(): string {
    if (attributedCache !== undefined) return attributedCache;
    const record = conversationRecord();
    if (record?.kind === "main") {
      attributedCache = "";
      return "";
    }
    const live = liveSpawns();
    if (record?.kind === "delegate") {
      if (record.agent) {
        for (const { path } of live) if (basename(path) === record.spawn) touch(path);
        attributedCache = record.agent;
        return record.agent;
      }
      attributedCache = AMBIGUOUS_REVIEWER;
      return attributedCache;
    }
    // Unknown conversation.
    if (live.length === 0 && activeReviewerDispatch() === null) {
      attributedCache = "";
      return "";
    }
    const agents = new Set(live.map(({ record }) => record.agent));
    const reviewers = [...agents].filter((agent) => REVIEW_AGENT_RE.test(agent));
    if (activeReviewerDispatch() !== null && reviewers.length === 0) {
      attributedCache = AMBIGUOUS_REVIEWER;
    } else if (agents.size === 1) {
      attributedCache = live[0].record.agent;
    } else if (reviewers.length === 1) {
      attributedCache = reviewers[0];
    } else {
      attributedCache = AMBIGUOUS_REVIEWER;
    }
    return attributedCache;
  }

  // A delegate's identity serves two checks: the reviewer read scope and the
  // state-transition check. When both stand aside for this work, as Guard
  // Policy off makes them, the identity checks protect nothing, so a delegate
  // runs its builds, tests and searches as the main chat does.
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

  function readHookAdditionalContext(stdout: string): string | null {
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as {
          additionalContext?: unknown;
          hookSpecificOutput?: { additionalContext?: unknown };
        };
        const note = parsed.hookSpecificOutput?.additionalContext ?? parsed.additionalContext;
        if (typeof note === "string" && note.trim().length > 0) return note.trim();
      } catch {
        // non-JSON output line
      }
    }
    return null;
  }

  // --- Human turns -------------------------------------------------------------
  //
  // Mint HUMAN_TURN for every USER_EXPLICIT step, and every answered
  // ask_question step, newer than the last minted one. Idempotent:
  // PreInvocation and PreToolUse both call it.
  function mintHumanTurns(): string[] {
    if (!conversation) return [];
    const record = conversationRecord();
    if (record?.kind === "delegate") return [];
    const tail = transcriptTail();
    const steps = tail.filter((step) => isHumanStep(step) || isPickerStep(tail, step));
    if (steps.length === 0) return [];
    const current = readConversation(conversation) ?? { kind: "main" as const };
    const last = typeof current.lastHumanStep === "number" ? current.lastHumanStep : -1;
    const fresh = steps
      .filter((step) => typeof step.step_index === "number" && step.step_index > last)
      .sort((a, b) => (a.step_index ?? 0) - (b.step_index ?? 0));
    if (fresh.length === 0) return [];
    // A main chat's identity is settled by its own message.
    const next: ConversationRecord = { ...current, kind: "main", lastHumanStep: fresh[fresh.length - 1].step_index };
    writeConversation(conversation, next);
    kindCache = next;
    const notes: string[] = [];
    for (const step of fresh) {
      if (isPickerStep(tail, step)) {
        const r = runCore(
          "aidlc-record-human-turn.ts",
          JSON.stringify({ session_id: conversation, ...pickerPayload(tail, step) }),
        );
        const note = readHookAdditionalContext(r.stdout);
        if (note) notes.push(note);
        continue;
      }
      const prompt = humanWords(step);
      // The core resume-rebind probe, where the same conversation id is
      // available, BEFORE the turn is recorded, so the turn lands on this
      // chat's own work.
      runCore(
        "aidlc-session-start.ts",
        JSON.stringify({
          hook_event_name: "SessionStart",
          source: "resume",
          session_id: conversation,
          rebind_check: true,
        }),
      );
      if (promptMovesSelection(prompt)) takeSessionSelectionNotice(projectDir, conversation);
      const r = runCore(
        "aidlc-record-human-turn.ts",
        JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: conversation, prompt }),
      );
      const note = readHookAdditionalContext(r.stdout);
      if (note) notes.push(note);
    }
    return notes;
  }

  // --- Tool-call normalisation ------------------------------------------------------

  const hostToolName = host.toolCall?.name ?? "";
  const args: Record<string, unknown> = host.toolCall?.args ?? {};
  const toolName = TOOL_NAMES[hostToolName] ?? hostToolName;

  function stringArg(...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
  }

  // The dispatched personas of an invoke_subagent call: the batch form
  // (Subagents[]) or the single form (TypeName at the top level).
  function dispatchedAgents(): Array<{ type: string; prompt: string }> {
    const out: Array<{ type: string; prompt: string }> = [];
    const batch = args.Subagents;
    if (Array.isArray(batch)) {
      for (const entry of batch) {
        if (entry && typeof entry === "object") {
          const type = (entry as Record<string, unknown>).TypeName;
          const prompt = (entry as Record<string, unknown>).Prompt;
          if (typeof type === "string" && type.length > 0) {
            out.push({ type, prompt: typeof prompt === "string" ? prompt : "" });
          }
        }
      }
    }
    const single = stringArg("TypeName");
    if (single) out.push({ type: single, prompt: stringArg("Prompt") ?? "" });
    return out;
  }

  function filePath(): string | undefined {
    return stringArg("TargetFile", "AbsolutePath", "Path", "file_path", "NotebookPath");
  }

  let effectiveCwdCache: string | undefined;
  function effectiveCwd(): string {
    if (effectiveCwdCache !== undefined) return effectiveCwdCache;
    const nested = stringArg("Cwd", "cwd", "WorkingDirectory");
    effectiveCwdCache = nested
      ? isAbsolute(nested) ? nested : resolve(projectDir, nested)
      : projectDir;
    return effectiveCwdCache;
  }

  function claudeToolInput(): Record<string, unknown> {
    const input: Record<string, unknown> = {};
    const command = stringArg("CommandLine", "command", "Command");
    if (command !== undefined) input.command = command;
    const path = filePath();
    if (path !== undefined) {
      input.file_path = isAbsolute(path) ? path : resolve(effectiveCwd(), path);
      if (toolName === "NotebookEdit") input.notebook_path = input.file_path;
    }
    const content = stringArg("CodeContent", "Content", "content");
    if (content !== undefined) input.content = content;
    const chunks = Array.isArray(args.ReplacementChunks)
      ? args.ReplacementChunks.filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      : [];
    const chunkText = (field: "TargetContent" | "ReplacementContent"): string | undefined => {
      if (chunks.length === 0) return undefined;
      const joined = chunks
        .map((c) => (typeof c[field] === "string" ? c[field] : ""))
        .filter((s) => s.length > 0)
        .join("\n");
      return joined.length > 0 ? joined : undefined;
    };
    const oldString = stringArg("TargetContent", "Target", "old_string") ?? chunkText("TargetContent");
    if (oldString !== undefined) input.old_string = oldString;
    const newString = stringArg("ReplacementContent", "Replacement", "new_string") ?? chunkText("ReplacementContent");
    if (newString !== undefined) input.new_string = newString;
    const dispatched = dispatchedAgents();
    if (dispatched.length > 0) {
      input.subagent_type = dispatched[0].type;
      input.prompt = dispatched[0].prompt;
    }
    return input;
  }

  function claudeShaped(eventName: string, nameOverride?: string): string {
    const agent = attributed();
    return JSON.stringify({
      hook_event_name: eventName,
      ...(sessionId ? { session_id: sessionId } : {}),
      cwd: effectiveCwd(),
      tool_name: nameOverride ?? toolName,
      tool_input: claudeToolInput(),
      ...(typeof host.stepIdx === "number" ? { tool_use_id: `${conversation}:${host.stepIdx}` } : {}),
      ...(agent && agent !== AMBIGUOUS_REVIEWER ? { agent_type: agent } : {}),
    });
  }

  function deny(reason: string): void {
    process.stdout.write(`${JSON.stringify({ decision: "deny", reason })}\n`);
  }

  // An empty PreToolUse answer is a deny on this host, so every allow path
  // says so.
  function writeAllow(): void {
    process.stdout.write(`${JSON.stringify({ decision: "allow" })}\n`);
  }

  // Exit 2 is a guard's refusal. A guard that fails on its own (it throws, its
  // file is missing, it is killed) refuses nothing, as in the core hook group;
  // its error line goes where doctor reads hook drops, with a severity tag in
  // it neutralized so only the hook that writes a drop decides doctor's verdict.
  function blockedByGuard(file: string, input: string): boolean {
    const r = runCoreWithStderr(file, input);
    if (r.code === 0) return false;
    if (r.code !== 2) {
      const hook = file.replace(/^aidlc-|\.ts$/g, "");
      const lines = r.stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
      const line = (lines.find((entry) => entry.startsWith("error:")) ??
        lines.filter((entry) => !/^Bun v\d/.test(entry)).at(-1) ?? "no error output")
        .replace(/\[(degraded|advisory)\]/gi, "($1)");
      const how = r.signal === null ? `exited ${r.code}` : `was stopped by ${r.signal}`;
      recordHookDrop(projectDir, hook, `${hook} ${how} under the Antigravity adapter: ${line.slice(0, 240)}`);
      return false;
    }
    deny(r.stderr.trim() || "blocked by AIDLC guard hook");
    return true;
  }

  function recordSpawns(): boolean {
    const task = typeof host.stepIdx === "number" ? String(host.stepIdx) : "";
    if (!conversation || !task) return false;
    let ok = true;
    for (const [index, { type, prompt }] of dispatchedAgents().entries()) {
      const record: SpawnRecord = {
        agent: type,
        parent: conversation,
        task: `${task}:${index}`,
        promptHead: prompt.slice(0, 160),
        promptDigest: digest(prompt),
      };
      try {
        writeJson(spawnFile(record.parent, record.task), record);
      } catch {
        ok = false;
        continue;
      }
      try {
        runCore(
          "aidlc-log-subagent.ts",
          JSON.stringify({
            hook_event_name: "SubagentStart",
            agent_type: type,
            ...(sessionId ? { session_id: sessionId } : {}),
          }),
        );
      } catch {
        // Subagent audit logging is advisory; the spawn record carries identity.
      }
    }
    return ok;
  }

  function retireDelegate(): void {
    const record = conversationRecord();
    if (record?.kind !== "delegate") return;
    runCore(
      "aidlc-log-subagent.ts",
      JSON.stringify({
        hook_event_name: "SubagentStop",
        ...(record.agent ? { agent_type: record.agent } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
      }),
    );
    if (record.spawn) removeFile(join(LEDGER_DIR, record.spawn));
    // Keep the delegate's attributed persona on disk across Idle -> re-awakened
    // turns in the same conversationId so follow-up messages retain reviewer
    // read-scope and nested-delegation enforcement.
    if (record.agent) {
      writeConversation(conversation, { kind: "delegate", agent: record.agent });
      kindCache = { kind: "delegate", agent: record.agent };
    } else {
      removeFile(conversationFile(conversation));
    }
  }

  // --- Targets ------------------------------------------------------------------

  switch (target) {
    case "session-start": {
      // A delegate's conversation starts here too (live-verified): it gets
      // no workflow context, which would tell it to resume the workflow.
      if (isDelegate()) {
        process.stdout.write("{}\n");
        return 0;
      }
      const fwd = JSON.stringify({
        hook_event_name: "SessionStart",
        source: "startup",
        ...(sessionId ? { session_id: sessionId } : {}),
      });
      const r = runCore("aidlc-session-start.ts", fwd);
      // Core prints {"additionalContext"} (Claude's key); Antigravity consumes
      // an injected system message.
      try {
        const parsed = JSON.parse(r.stdout) as { additionalContext?: string };
        if (parsed.additionalContext) {
          process.stdout.write(`${JSON.stringify({
            injectSteps: [{ systemMessage: { systemMessage: parsed.additionalContext } }],
          })}\n`);
          return 0;
        }
      } catch {
        // no context payload
      }
      process.stdout.write("{}\n");
      return 0;
    }

    case "turn": {
      // PreInvocation: before every model call. A person's message is the
      // newest USER_EXPLICIT or completed ask_question step of the transcript;
      // its model-only context (--message id, unanswered-box prose, review hold)
      // rides an ephemeral message that neither persists nor reaches the user.
      const notes = mintHumanTurns();
      if (notes.length > 0) {
        process.stdout.write(`${JSON.stringify({
          injectSteps: [{ ephemeralMessage: notes.join("\n\n") }],
        })}\n`);
        return 0;
      }
      process.stdout.write("{}\n");
      return 0;
    }

    case "guards": {
      // PreToolUse: the state-transition, reviewer read-scope, and review-freeze
      // guards (the Claude settings.json registration order); plan approval
      // runs for workspace mutations and for a dispatch before the spawn feeds
      // the identity ledger. Block contract conversion: core exit 2 + stderr
      // becomes {"decision":"deny","reason"} JSON.
      mintHumanTurns();
      if (DELEGATION_TOOLS.has(hostToolName)) {
        const parentAgent = attributed();
        if (parentAgent) {
          const identity =
            parentAgent === AMBIGUOUS_REVIEWER ? "an ambiguously attributed reviewer" : parentAgent;
          deny(
            `AIDLC nested delegation is not allowed: ${identity} must complete ` +
              `its delegated task directly and cannot use ${hostToolName}.`,
          );
          return 0;
        }
        if (hostToolName !== "invoke_subagent") {
          writeAllow();
          return 0;
        }
        if (blockedByGuard("aidlc-plan-approval-guard.ts", claudeShaped("PreToolUse", "Task"))) return 0;
        if (dispatchedAgents().length > 0 && !recordSpawns() && !delegateChecksStandAside()) {
          deny(
            "AI-DLC could not start this specialist. Start it again; if it is stopped again, tell the person " +
              `to run \`${aidlcInvocation()} doctor\` in a terminal, which names what is broken.`,
          );
          return 0;
        }
        writeAllow();
        return 0;
      }
      const agent = attributed();
      if (agent === AMBIGUOUS_REVIEWER && !delegateChecksStandAside()) {
        deny(
          "AIDLC delegated-agent identity is unavailable or ambiguous while delegation state is active; " +
            "the operation was denied rather than losing attribution enforcement.",
        );
        return 0;
      }
      const guards = [
        { file: "aidlc-state-transition-guard.ts", input: claudeShaped("PreToolUse") },
        { file: "aidlc-reviewer-scope.ts", input: claudeShaped("PreToolUse") },
        { file: "aidlc-review-freeze.ts", input: claudeShaped("PreToolUse") },
      ];
      if (["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) {
        guards.push({ file: "aidlc-plan-approval-guard.ts", input: claudeShaped("PreToolUse") });
      }
      for (const guard of guards) {
        if (blockedByGuard(guard.file, guard.input)) return 0;
      }
      writeAllow();
      return 0;
    }

    case "audit-and-sensors": {
      // PostToolUse Write|Edit → audit THEN sensors (Claude registration
      // order). A failed call carries `error`; a failed write is not audited.
      const failed = typeof host.error === "string" && host.error.length > 0;
      if (!failed && (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit")) {
        const fwd = claudeShaped("PostToolUse", toolName === "MultiEdit" ? "Edit" : toolName);
        runCore("aidlc-write-audit-log.ts", fwd);
        runCore("aidlc-run-sensors.ts", fwd);
      } else if (failed && hostToolName === "invoke_subagent") {
        // The dispatch never started: its spawn records go.
        const task = typeof host.stepIdx === "number" ? String(host.stepIdx) : "";
        for (const { path, record } of liveSpawns()) {
          if (record.parent === conversation && record.task.startsWith(`${task}:`)) removeFile(path);
        }
      }
      process.stdout.write("{}\n");
      return 0;
    }

    case "runtime-compile": {
      // PostToolUse run_command → the runtime-graph compile watcher (keys on
      // Bash + tool_input.command — the mapped payload is its exact contract).
      if (toolName === "Bash" && !(typeof host.error === "string" && host.error.length > 0)) {
        runCore("aidlc-rebuild-stage-graph.ts", claudeShaped("PostToolUse"));
      }
      process.stdout.write("{}\n");
      return 0;
    }

    case "stop": {
      // A delegate's stop is its completion: log it, retire its dispatch
      // record, and never enter the forwarding loop, whose nudge would tell
      // it to run `next` and reset the foreground's steering.
      if (isDelegate()) {
        retireDelegate();
        process.stdout.write("{}\n");
        return 0;
      }
      // The conductor ending its turn while a delegate it dispatched is still
      // working is a legitimate wait: the delegate's result wakes it.
      if (host.fullyIdle === false) {
        process.stdout.write("{}\n");
        return 0;
      }
      const current = readConversation(conversation);
      const stopHookActive =
        typeof current?.continueAt === "number" && Date.now() - current.continueAt < 10 * 60 * 1000;
      const r = runCore(
        "aidlc-continue-workflow.ts",
        JSON.stringify({
          hook_event_name: "Stop",
          ...(sessionId ? { session_id: sessionId } : {}),
          stop_hook_active: stopHookActive,
        }),
      );
      try {
        const parsed = JSON.parse(r.stdout) as { decision?: string; reason?: string };
        if (parsed.decision === "block" && parsed.reason) {
          writeConversation(conversation, { ...(current ?? { kind: "main" }), continueAt: Date.now() });
          process.stdout.write(`${JSON.stringify({ decision: "continue", reason: parsed.reason })}\n`);
          return 0;
        }
      } catch {
        // allow
      }
      if (current?.continueAt !== undefined) {
        const { continueAt: _dropped, ...rest } = current;
        writeConversation(conversation, rest);
      }
      process.stdout.write("{}\n");
      return 0;
    }

    default:
      return 0;
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv[2] ?? "", await Bun.stdin.text(), process.argv.slice(3)));
}
