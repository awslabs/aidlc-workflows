// scope-hosts.ts - a scope run on another tool's tree, through that tool's own
// hook wiring and payloads.
//
// ScopeHost (scope-run.ts) plays Claude Code. A host here plays another tool
// the way it runs AI-DLC: the tree its install lays out, the variables it gives
// the agent's shell, and at each moment (a chat starts, the person types or
// picks, a shell or file tool runs, a helper is sent, the turn ends) every
// command that tool's shipped wiring file registers for it, fed the payload the
// tool sends. The payload shapes come from the recorded payloads in
// tests/fixtures/<tool>-hook-payloads and the adapters' own notes; each tool's
// answer is read in its own form (Codex refuses with exit 2 and stderr, Copilot
// with a deny decision, and Copilot runs the command its hook rewrote). Every
// tool call fires the tool's hooks, as the tool does, so a refusal stops the
// step (ScopeHost.fullHost) and a hook command that fails is listed.
//
// Not played: Codex delivers each event twice and its adapter replays the
// first answer (tests/unit/t149-codex-hook-adapter.test.ts owns that).

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { auditShardHostSegment, cloneIdFileContent, cloneIdPath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { copilotSkillPrompt } from "./aidlc-input-corpus.ts";
import { FIXTURES_DIR, REPO_ROOT } from "./fixtures.ts";
import {
  activeRecord,
  cleanupScopeProjects,
  clip,
  createScopeProject,
  expectedStages,
  type RunResult,
  runScope,
  SCOPE_RUN_TIMEOUT_MS,
  ScopeHost,
  RESUME_AGAIN,
  ScopeRunRefused,
  ScopeRunStuck,
  type ScopeRun,
  scopeRunProblems,
  scopeScratchDir,
  stopVerdict,
} from "./scope-run.ts";

export type HostName = "codex" | "copilot" | "kiro" | "kiro-ide" | "cursor" | "opencode";
export const HOSTS: readonly ("claude" | HostName)[] = ["claude", "codex", "copilot", "kiro", "kiro-ide", "cursor", "opencode"];

type Payload = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The wiring each tree ships
// ---------------------------------------------------------------------------

interface CodexWiring {
  hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
}

/** The commands `.codex/hooks.json` registers for an event and tool, in order (a matcher is a regex on the tool name). */
export function codexWired(wiring: CodexWiring, event: string, tool: string | null): string[] {
  return (wiring.hooks[event] ?? [])
    .filter((entry) => entry.matcher === undefined || (tool !== null && new RegExp(entry.matcher).test(tool)))
    .flatMap((entry) => entry.hooks.map((hook) => hook.command));
}

interface CopilotWiring {
  hooks: Record<string, { bash: string; powershell: string }[]>;
}

/** The commands `.github/hooks/aidlc.json` registers for an event (no matchers: each target reads the tool name). */
export function copilotWired(wiring: CopilotWiring, event: string, platform: NodeJS.Platform = process.platform): string[] {
  return (wiring.hooks[event] ?? []).map((entry) => (platform === "win32" ? entry.powershell : entry.bash));
}

interface KiroCliAgent {
  hooks?: Record<string, { matcher?: string; command: string }[]>;
}

/** Kiro CLI's tool families: an agent-v1 matcher selects a tool by its canonical name or its alias. */
const KIRO_CLI_ALIASES: readonly (readonly string[])[] = [["fs_write", "write"], ["fs_read", "read"], ["execute_bash", "shell"]];

/** Whether a Kiro CLI agent-v1 matcher (a glob) selects the tool the CLI names. */
export function kiroCliMatches(matcher: string, tool: string): boolean {
  const names = KIRO_CLI_ALIASES.find((family) => family.includes(tool)) ?? [tool];
  const glob = new Bun.Glob(matcher);
  return names.some((name) => glob.match(name));
}

/** The commands an agent JSON (`.kiro/agents/<agent>.json`) registers for an event and tool, in order. */
export function kiroCliWired(agent: KiroCliAgent, event: string, tool: string | null): string[] {
  return (agent.hooks?.[event] ?? [])
    .filter((hook) => hook.matcher === undefined || (tool !== null && kiroCliMatches(hook.matcher, tool)))
    .map((hook) => hook.command);
}

export interface KiroIdeCard {
  file: string;
  hooks: { trigger: string; matcher?: string; action: { command: string } }[];
}

/** The commands Kiro IDE's hook cards register for a trigger and tool: cards in file-name order, a matcher is an unanchored regex. */
export function kiroIdeWired(cards: readonly KiroIdeCard[], event: string, tool: string | null): string[] {
  return [...cards]
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .flatMap((card) => card.hooks)
    .filter((hook) => hook.trigger === event && (hook.matcher === undefined || (tool !== null && new RegExp(hook.matcher).test(tool))))
    .map((hook) => hook.action.command);
}

// ---------------------------------------------------------------------------
// The payloads each tool sends
// ---------------------------------------------------------------------------

/** What a payload knows about the moment: the chat, the turn, and the helper the call runs in. */
export interface Moment {
  proj: string;
  session: string;
  turn: string;
  /** The rollout or session record the tool keeps for the chat. */
  transcript: string;
  helper: { agent: string; id: string } | null;
}

/** A Codex payload: the fields its recorded payloads carry for the event, then the moment's own. */
export function codexPayload(event: string, at: Moment, fields: Payload): Payload {
  return {
    session_id: at.session,
    ...(event === "SessionStart" ? {} : { turn_id: at.turn }),
    transcript_path: at.transcript,
    cwd: at.proj,
    hook_event_name: event,
    model: "openai.gpt-5.5",
    ...(event === "PreCompact" ? {} : { permission_mode: "default" }),
    // A spawned helper's own calls carry its thread id and name.
    ...(at.helper ? { agent_id: at.helper.id, agent_type: at.helper.agent } : {}),
    ...fields,
  };
}

/**
 * A Copilot CLI payload. Most events arrive Claude-shaped and snake_case;
 * SubagentStart arrives camelCase, and the typed line arrives as the chat's
 * id, the prompt, a timestamp and the folder (captured on 1.0.95).
 */
export function copilotPayload(event: string, at: Moment, fields: Payload): Payload {
  if (event === "UserPromptSubmit") return { sessionId: at.session, timestamp: Date.now(), cwd: at.proj, ...fields };
  if (event === "SubagentStart") {
    return { sessionId: at.session, timestamp: Date.now(), cwd: at.proj, transcriptPath: at.transcript, ...fields };
  }
  return {
    hook_event_name: event,
    session_id: at.session,
    timestamp: new Date().toISOString(),
    cwd: at.proj,
    ...(event === "Stop" || event === "SubagentStop" ? { transcript_path: at.transcript } : {}),
    ...fields,
  };
}

/**
 * A Kiro CLI payload (captured on 2.29.0): camelCase events, the folder, and the
 * session the event belongs to on every event; a helper's events carry its own.
 */
export function kiroCliPayload(event: string, at: Moment, fields: Payload): Payload {
  return { hook_event_name: event, cwd: at.proj, session_id: at.helper?.id ?? at.session, ...fields };
}

/** A Kiro IDE payload (1.2.37): snake_case, the chat's session on every event, a helper's calls included. */
export function kiroIdePayload(event: string, at: Moment, fields: Payload): Payload {
  return { session_id: at.session, hook_event_name: event, cwd: at.proj, ...fields };
}

/**
 * A Cursor payload (cursor-agent 2026.07.23, tests/fixtures/cursor-hook-payloads):
 * every event carries the conversation, its generation and the workspace; a
 * helper's own calls carry the helper's conversation. `transcript_path` is
 * null, as on a chat's first turn.
 */
export function cursorPayload(event: string, at: Moment, generation: string, fields: Payload): Payload {
  const conversation = at.helper?.id ?? at.session;
  return {
    conversation_id: conversation,
    generation_id: generation,
    model: "claude-opus-5",
    session_id: conversation,
    hook_event_name: event,
    cursor_version: "2026.07.23-e383d2b",
    workspace_roots: [at.proj],
    user_email: "user@example.com",
    transcript_path: null,
    ...fields,
  };
}

/** A Codex apply_patch envelope that writes `content` to `rel` (whole-file replacement when it existed). */
export function codexPatch(rel: string, content: string, before: string | null): string {
  const lines = (text: string, mark: string) => text.split("\n").filter((line, i, all) => i < all.length - 1 || line !== "")
    .map((line) => `${mark}${line}\n`).join("");
  return before === null
    ? `*** Begin Patch\n*** Add File: ${rel}\n${lines(content, "+")}*** End Patch\n`
    : `*** Begin Patch\n*** Update File: ${rel}\n@@\n${lines(before, "-")}${lines(content, "+")}*** End Patch\n`;
}

// ---------------------------------------------------------------------------
// The hosts
// ---------------------------------------------------------------------------

let hostCount = 0;
let helpers = 0;
const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");

/** Another tool's host: fires that tool's wiring at every tool call; the payloads and answers are the subclass's. */
export abstract class NativeScopeHost extends ScopeHost {
  override readonly removesDispatch = false;
  /** Hook commands that failed (an exit that is neither an answer nor a refusal): the tool shows the person nothing, and the hook did not do its work. */
  readonly hookFailures: string[] = [];
  /** Every event fired, with the commands its wiring ran. */
  readonly fired: { event: string; tool: string | null; commands: string[] }[] = [];
  protected readonly hostNumber = ++hostCount;
  protected helper: { agent: string; id: string } | null = null;
  private turns = 0;
  private uses = 0;
  protected turn = "";

  constructor(proj: string, base?: NodeJS.ProcessEnv) {
    super(proj, base);
    // The tool gives its hooks and the agent's shell the project as their folder, and no Claude variable.
    delete this.env.CLAUDE_PROJECT_DIR;
    this.fullHost = true;
    this.session = this.sessionName(1);
  }

  /** The commands the tree's shipped wiring registers for an event and tool. */
  abstract wired(event: string, tool: string | null): string[];
  protected abstract payload(event: string, fields: Payload): Payload;
  /** The refusal a PreToolUse answer carries, or null. */
  protected abstract refusal(res: RunResult): string | null;

  /** The variables the tool gives the agent's shell. */
  protected shellEnv(): NodeJS.ProcessEnv {
    return this.env;
  }

  /** The variables the tool gives its hook commands. */
  protected hookEnv(): NodeJS.ProcessEnv {
    return this.env;
  }

  protected moment(): Moment {
    return { proj: this.proj, session: this.session, turn: this.turn, transcript: this.transcript(), helper: this.helper };
  }

  protected abstract transcript(): string;

  protected newTurn(): void {
    this.turn = `${hex(this.hostNumber, 4)}-turn-${++this.turns}`;
  }

  protected nextUse(): string {
    return `call_${this.hostNumber}_${++this.uses}`;
  }

  /** Fire one event: every command the wiring registers for it, each fed the same payload, as the tool runs them. */
  protected fire(event: string, tool: string | null, fields: Payload): RunResult[] {
    const commands = this.wired(event, tool);
    this.fired.push({ event, tool, commands });
    const input = JSON.stringify(this.payload(event, fields));
    return commands.map((line) => {
      const res = this.spawn(`${event}${tool ? ` ${tool}` : ""}: ${line}`, this.argv(line), input, this.hookEnv());
      if (res.status !== 0 && !(res.status === 2 && /^(PreToolUse|preToolUse|Stop|stop)$/.test(event))) {
        this.hookFailures.push(`${event}${tool ? ` ${tool}` : ""}: ${line} exited ${res.status}: ${clip(res.stderr || res.stdout, 400)}`);
      }
      return res;
    });
  }

  /** A PreToolUse answer that refused the call: the tool does not run it, and the run stops on it. */
  protected refuseOn(tool: string, input: Payload, results: RunResult[]): void {
    for (const res of results) {
      const said = this.refusal(res);
      if (said === null) continue;
      this.refusals.push(`${tool} ${clip(JSON.stringify(input), 200)}: ${clip(said, 600)}`);
      throw new ScopeRunRefused(`the guard refused ${tool} ${clip(JSON.stringify(input), 200)}`, said);
    }
  }

  protected run(line: string): RunResult {
    return this.spawn(line, this.argv(line), undefined, this.shellEnv());
  }

  override hook(name: string): RunResult {
    throw new Error(`${name} is a Claude Code hook name; this host fires its own wiring`);
  }

  /** The tool's name for the turn-end event. */
  protected readonly stopEvent: string = "Stop";

  override stop(): { blocked: boolean; reason: string } {
    const results = this.fire(this.stopEvent, null, this.stopFields());
    const blocked = results.find((res) => res.status === 2);
    if (blocked) return { blocked: true, reason: blocked.stderr };
    return stopVerdict(results.map((res) => res.stdout).join("\n"));
  }

  protected abstract stopFields(): Payload;
}

/** Codex CLI: `.codex/hooks.json` through `engine adapter codex`, apply_patch for files, spawn_agent for helpers. */
export class CodexScopeHost extends NativeScopeHost {
  override readonly dir = ".codex";
  override readonly skill = ".agents/skills/aidlc/SKILL.md";

  protected override sessionName(n: number): string {
    return `019ee000-${hex(this.hostNumber, 4)}-7000-8000-${hex(n, 12)}`;
  }

  wired(event: string, tool: string | null): string[] {
    return codexWired(JSON.parse(readFileSync(join(this.proj, ".codex", "hooks.json"), "utf-8")) as CodexWiring, event, tool);
  }

  protected payload(event: string, fields: Payload): Payload {
    return codexPayload(event, this.moment(), fields);
  }

  protected transcript(): string {
    return join(dirname(this.proj), "codex-home", "sessions", "2026", "10", "14", `rollout-2026-10-14T00-00-00-${this.session}.jsonl`);
  }

  // Codex gives every command it runs the chat's thread as CODEX_THREAD_ID; a helper's shell gets the helper's own.
  protected override shellEnv(): NodeJS.ProcessEnv {
    return { ...this.env, CODEX_THREAD_ID: this.helper?.id ?? this.session };
  }

  protected refusal(res: RunResult): string | null {
    return res.status === 2 ? res.stderr : null;
  }

  protected override startChat(source: "startup" | "resume"): void {
    this.fire("SessionStart", null, { source });
  }

  override typed(words: string): string {
    this.newTurn();
    this.fire("UserPromptSubmit", null, { prompt: words });
    return "";
  }

  /** request_user_input: the box's answer comes back to the agent in the same turn. */
  override picked(question: string, options: string[], label: string): void {
    const input = { questions: [{ id: "choice", header: "Choice", question, options: options.map((o) => ({ label: o, description: o })) }] };
    const use = this.nextUse();
    this.refuseOn("request_user_input", input, this.fire("PreToolUse", "request_user_input", { tool_name: "request_user_input", tool_input: input, tool_use_id: use }));
    this.fire("PostToolUse", "request_user_input", {
      tool_name: "request_user_input",
      tool_input: input,
      tool_response: JSON.stringify({ answers: { choice: { answers: [label] } } }),
      tool_use_id: use,
    });
  }

  override bash(line: string): RunResult {
    const input = { command: line };
    const use = this.nextUse();
    this.refuseOn("Bash", input, this.fire("PreToolUse", "Bash", { tool_name: "Bash", tool_input: input, tool_use_id: use }));
    const res = this.run(line);
    this.fire("PostToolUse", "Bash", { tool_name: "Bash", tool_input: input, tool_response: `${res.stdout}${res.stderr}`, tool_use_id: use });
    return res;
  }

  override write(rel: string, content: string): void {
    const abs = join(this.proj, rel);
    const before = existsSync(abs) ? readFileSync(abs, "utf-8") : null;
    const input = { command: codexPatch(rel, content, before) };
    const use = this.nextUse();
    this.refuseOn("apply_patch", input, this.fire("PreToolUse", "apply_patch", { tool_name: "apply_patch", tool_input: input, tool_use_id: use }));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    this.fire("PostToolUse", "apply_patch", {
      tool_name: "apply_patch",
      tool_input: input,
      tool_response: `Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess. Updated the following files:\n${before === null ? "A" : "M"} ${rel}\n`,
      tool_use_id: use,
    });
  }

  override remove(rel: string): void {
    const line = `rm ${rel}`;
    const use = this.nextUse();
    this.refuseOn("Bash", { command: line }, this.fire("PreToolUse", "Bash", { tool_name: "Bash", tool_input: { command: line }, tool_use_id: use }));
    rmSync(join(this.proj, rel), { force: true });
    this.fire("PostToolUse", "Bash", { tool_name: "Bash", tool_input: { command: line }, tool_response: "", tool_use_id: use });
  }

  /** spawn_agent: the helper gets the brief the hook rewrote; its own inputs and calls carry its thread id. */
  override task(agent: string, prompt: string, work: () => void): void {
    const asked = { agent_type: agent, message: prompt };
    const results = this.fire("PreToolUse", "spawn_agent", { tool_name: "spawn_agent", tool_input: asked, tool_use_id: this.nextUse() });
    this.refuseOn("spawn_agent", asked, results);
    const updated = results
      .map((res) => (parseJson(res.stdout)?.hookSpecificOutput as { updatedInput?: { message?: unknown } } | undefined)?.updatedInput)
      .find((value) => value !== undefined);
    const brief = typeof updated?.message === "string" ? updated.message : prompt;
    const id = `019ee000-${hex(this.hostNumber, 4)}-7000-9000-${hex(++helpers, 12)}`;
    this.helper = { agent, id };
    try {
      // Codex runs UserPromptSubmit for every input to a thread: the helper's brief too.
      this.fire("UserPromptSubmit", null, { prompt: brief });
      work();
    } finally {
      this.helper = null;
    }
    this.fire("SubagentStop", null, {
      agent_transcript_path: join(dirname(this.transcript()), `rollout-2026-10-14T00-00-01-${id}.jsonl`),
      stop_hook_active: false,
      agent_id: id,
      agent_type: agent,
      last_assistant_message: `${agent}: done`,
    });
  }

  protected stopFields(): Payload {
    return { stop_hook_active: false, last_assistant_message: "Over to you." };
  }
}

/**
 * GitHub Copilot CLI: `.github/hooks/aidlc.json` through the Copilot adapter.
 * Questions are numbered prose the person answers by typing; AI-DLC's own
 * workflow commands are claimed and rewritten by the PreToolUse hook, and the
 * CLI runs the rewritten command (modifiedArgs).
 */
export class CopilotScopeHost extends NativeScopeHost {
  override readonly dir = ".aidlc";
  override readonly skill = ".github/skills/aidlc/SKILL.md";
  override readonly picker = false;

  protected override sessionName(n: number): string {
    return `c0b11070-${hex(this.hostNumber, 4)}-4000-8000-${hex(n, 12)}`;
  }

  wired(event: string, tool: string | null): string[] {
    void tool;
    return copilotWired(JSON.parse(readFileSync(join(this.proj, ".github", "hooks", "aidlc.json"), "utf-8")) as CopilotWiring, event);
  }

  protected payload(event: string, fields: Payload): Payload {
    return copilotPayload(event, this.moment(), fields);
  }

  protected transcript(): string {
    return join(dirname(this.proj), "copilot-home", "session-state", this.session, "events.jsonl");
  }

  protected refusal(res: RunResult): string | null {
    const decision = this.decision(res);
    return decision?.permissionDecision === "deny" ? String(decision.permissionDecisionReason ?? "") : null;
  }

  private decision(res: RunResult): { permissionDecision?: string; permissionDecisionReason?: string } | undefined {
    const line = res.stdout.trim().split("\n").find((entry) => entry.startsWith("{"));
    return (parseJson(line ?? "")?.hookSpecificOutput ?? undefined) as { permissionDecision?: string } | undefined;
  }

  /** The tool input the CLI runs instead, when the PreToolUse answer rewrote it. */
  private rewritten(results: RunResult[]): Payload | undefined {
    for (const res of results) {
      const line = res.stdout.trim().split("\n").find((entry) => entry.startsWith("{"));
      const args = parseJson(line ?? "")?.modifiedArgs;
      if (args && typeof args === "object") return args as Payload;
    }
    return undefined;
  }

  protected override startChat(source: "startup" | "resume"): void {
    this.fire("SessionStart", null, { source: source === "startup" ? "new" : source });
  }

  // A slash skill reaches the hook as Copilot's skill-context block, not as the typed line.
  override typed(words: string): string {
    this.newTurn();
    const skill = /^\/aidlc(?:\s+|$)/.exec(words);
    this.fire("UserPromptSubmit", null, { prompt: skill ? copilotSkillPrompt(this.proj, words.slice(skill[0].length)) : words });
    return "";
  }

  override bash(line: string): RunResult {
    const asked = { command: line, description: "Run an AI-DLC command" };
    const results = this.fire("PreToolUse", "Bash", { tool_name: "Bash", tool_input: asked });
    this.refuseOn("Bash", asked, results);
    const input = { ...asked, ...this.rewritten(results) };
    const res = this.run(String(input.command));
    this.fire("PostToolUse", "Bash", {
      tool_name: "Bash",
      tool_input: input,
      tool_result: {
        result_type: "success",
        text_result_for_llm: `${`${res.stdout}${res.stderr}`.trimEnd()}\n<shellId: 0 completed with exit code ${res.status}>`,
      },
    });
    return res;
  }

  override write(rel: string, content: string): void {
    const abs = join(this.proj, rel);
    const before = existsSync(abs) ? readFileSync(abs, "utf-8") : null;
    const [tool, input] = before === null
      ? ["Write", { path: abs, file_text: content }] as const
      : ["Edit", { path: abs, old_str: before, new_str: content }] as const;
    this.refuseOn(tool, input, this.fire("PreToolUse", tool, { tool_name: tool, tool_input: input }));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    this.fire("PostToolUse", tool, {
      tool_name: tool,
      tool_input: input,
      tool_result: { result_type: "success", text_result_for_llm: before === null ? `Created file ${abs} with ${content.length} characters` : `File ${abs} updated with changes.` },
    });
  }

  override remove(rel: string): void {
    const line = `rm ${rel}`;
    this.refuseOn("Bash", { command: line }, this.fire("PreToolUse", "Bash", { tool_name: "Bash", tool_input: { command: line } }));
    rmSync(join(this.proj, rel), { force: true });
    this.fire("PostToolUse", "Bash", {
      tool_name: "Bash",
      tool_input: { command: line },
      tool_result: { result_type: "success", text_result_for_llm: "<shellId: 0 completed with exit code 0>" },
    });
  }

  /** The CLI's task tool, reported to the hooks as Agent; SubagentStart and SubagentStop bracket the helper. */
  override task(agent: string, prompt: string, work: () => void): void {
    const asked = { agent_type: agent, description: "stage work", prompt };
    const results = this.fire("PreToolUse", "Agent", { tool_name: "Agent", tool_input: asked });
    this.refuseOn("Agent", asked, results);
    const input = this.rewritten(results) ?? asked;
    this.fire("SubagentStart", null, { agentName: agent, agentDisplayName: agent, agentDescription: `The ${agent}.` });
    work();
    this.fire("SubagentStop", null, { agent_name: agent, agent_display_name: agent, stop_reason: "end_turn" });
    this.fire("PostToolUse", "Agent", { tool_name: "Agent", tool_input: input, tool_result: { result_type: "success", text_result_for_llm: "done" } });
  }

  protected stopFields(): Payload {
    return { stop_reason: "end_turn", stop_hook_active: false };
  }
}

/** The aidlc skill as Kiro expands `/aidlc <args>` into the prompt: the installed SKILL.md with every `$ARGUMENTS` replaced. */
export function kiroSkillPrompt(proj: string, args: string): string {
  return readFileSync(join(proj, ".kiro", "skills", "aidlc", "SKILL.md"), "utf-8").split("$ARGUMENTS").join(args);
}

/**
 * Kiro CLI (v2 agent engine): the conductor's agent JSON (`.kiro/agents/aidlc.json`)
 * through `engine adapter kiro`. Questions are numbered prose. The
 * person-turn hook may run the turn's first `next` itself, or name the exact
 * first call (AgentStandIn.fromTurn). A helper runs its own agent JSON's hooks
 * under a session of its own, while its shell keeps the chat's
 * KIRO_SESSION_ID (captured on 2.29.0, tmp/workshop-fixes/e2e-gaps/item3).
 */
export class KiroCliScopeHost extends NativeScopeHost {
  override readonly dir = ".kiro";
  override readonly skill = ".kiro/skills/aidlc/SKILL.md";
  override readonly picker = false;
  protected override readonly stopEvent = "stop";
  /** The agent whose JSON hooks fire: the conductor's, or a helper's own while it works. */
  private agent = "aidlc";

  protected override sessionName(n: number): string {
    return `0c11a000-${hex(this.hostNumber, 4)}-4000-8000-${hex(n, 12)}`;
  }

  wired(event: string, tool: string | null): string[] {
    const file = join(this.proj, ".kiro", "agents", `${this.agent}.json`);
    if (!existsSync(file)) throw new ScopeRunStuck(`Kiro CLI has no agent ${this.agent} to hand the work to: ${file} is not installed`);
    return kiroCliWired(JSON.parse(readFileSync(file, "utf-8")) as KiroCliAgent, event, tool);
  }

  protected payload(event: string, fields: Payload): Payload {
    return kiroCliPayload(event, this.moment(), fields);
  }

  protected transcript(): string {
    return "";
  }

  // Kiro names the chat in the hooks' and the agent's shell environment.
  protected override hookEnv(): NodeJS.ProcessEnv {
    return { ...this.env, KIRO_SESSION_ID: this.session };
  }

  protected override shellEnv(): NodeJS.ProcessEnv {
    return this.hookEnv();
  }

  protected refusal(res: RunResult): string | null {
    return res.status === 2 ? res.stderr : null;
  }

  protected override startChat(): void {
    this.fire("agentSpawn", null, {});
  }

  override typed(words: string): string {
    const skill = /^\/aidlc(?:\s+|$)/.exec(words);
    const prompt = skill ? kiroSkillPrompt(this.proj, words.slice(skill[0].length)) : words;
    return this.fire("userPromptSubmit", null, { prompt }).map((res) => res.stdout).join("");
  }

  override bash(line: string): RunResult {
    const input = { __tool_use_purpose: "Run the step AI-DLC named", command: line };
    const call = { tool_name: "shell", tool_tags: ["shell", "@builtin"], tool_input: input };
    this.refuseOn("shell", input, this.fire("preToolUse", "shell", call));
    const res = this.run(line);
    this.fire("postToolUse", "shell", {
      ...call,
      tool_response: { items: [{ Json: { exit_status: `exit status: ${res.status}`, stdout: res.stdout, stderr: res.stderr } }] },
    });
    return res;
  }

  override write(rel: string, content: string): void {
    const abs = join(this.proj, rel);
    const before = existsSync(abs) ? readFileSync(abs, "utf-8") : null;
    const purpose = "Write the stage's file";
    const input = before === null
      ? { __tool_use_purpose: purpose, command: "create", path: abs, content }
      : { __tool_use_purpose: purpose, command: "str_replace", path: abs, old_str: before, new_str: content };
    const call = { tool_name: "write", tool_tags: ["write", "@builtin"], tool_input: input };
    this.refuseOn("write", input, this.fire("preToolUse", "write", call));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    const said = before === null ? `Successfully created ${abs} (${content.split("\n").length} lines).` : `Successfully replaced text in ${abs}.`;
    this.fire("postToolUse", "write", { ...call, tool_response: { items: [{ Text: said }] } });
  }

  override remove(rel: string): void {
    const input = { __tool_use_purpose: "Remove a file", command: `rm ${rel}` };
    const call = { tool_name: "shell", tool_tags: ["shell", "@builtin"], tool_input: input };
    this.refuseOn("shell", input, this.fire("preToolUse", "shell", call));
    rmSync(join(this.proj, rel), { force: true });
    this.fire("postToolUse", "shell", { ...call, tool_response: { items: [{ Json: { exit_status: "exit status: 0", stdout: "", stderr: "" } }] } });
  }

  /** The subagent tool with one stage; the helper's own agent JSON fires for its spawn, its brief, each call, its report and its stop. */
  override task(agent: string, prompt: string, work: () => void): void {
    const input = { __tool_use_purpose: "Hand the stage to its agent", task: "stage work", mode: "blocking", stages: [{ name: "stage", role: agent, prompt_template: prompt }] };
    const call = { tool_name: "subagent", tool_tags: ["subagent", "@builtin"], tool_input: input };
    this.refuseOn("subagent", input, this.fire("preToolUse", "subagent", call));
    const conductor = this.agent;
    this.agent = agent;
    this.helper = { agent, id: `0c11a000-${hex(this.hostNumber, 4)}-4000-9000-${hex(++helpers, 12)}` };
    try {
      this.fire("agentSpawn", null, {});
      this.fire("userPromptSubmit", null, { prompt });
      work();
      const report = { tool_name: "summary", tool_tags: ["@builtin"], tool_input: { __tool_use_purpose: "Report back", taskDescription: prompt.slice(0, 200), taskResult: "Done." } };
      this.fire("preToolUse", "summary", report);
      this.fire("postToolUse", "summary", { ...report, tool_response: { items: [{ Text: "" }] } });
      this.fire("stop", null, { assistant_response: "DONE" });
    } finally {
      this.agent = conductor;
      this.helper = null;
    }
    this.fire("postToolUse", "subagent", { ...call, tool_response: { items: [{ Text: "Pipeline completed: 1 stages finished.\n\n## stage\n\nDone." }] } });
  }

  protected stopFields(): Payload {
    return { assistant_response: "Over to you." };
  }
}

/**
 * Kiro IDE (1.2.37): the hook cards in `.kiro/hooks/*.json` through `engine
 * adapter kiro-ide`. Questions are numbered prose. After a write or a command
 * no card runs; the next card does that work (its catch-up), so a write lands
 * between the guard card and whichever card comes next, as in Kiro. A helper's
 * calls fire the same cards under the chat's session. The agent's shell
 * carries `TERM_PROGRAM=kiro` and the chat's `KIRO_SESSION_ID`, the hooks
 * `VSCODE_IPC_HOOK` and `VSCODE_PID` (docs/reference/kiro-ide-hook-payload.md).
 */
export class KiroIdeScopeHost extends NativeScopeHost {
  override readonly dir = ".kiro";
  override readonly skill = ".kiro/skills/aidlc/SKILL.md";
  override readonly picker = false;
  private readonly shellTool = process.platform === "win32" ? "execute_pwsh" : "execute_bash";

  protected override sessionName(n: number): string {
    return `sess_c0de${hex(this.hostNumber, 4)}-0000-4000-8000-${hex(n, 12)}`;
  }

  wired(event: string, tool: string | null): string[] {
    const dir = join(this.proj, ".kiro", "hooks");
    const cards = readdirSync(dir).filter((file) => file.endsWith(".json"))
      .map((file) => ({ file, ...(JSON.parse(readFileSync(join(dir, file), "utf-8")) as { hooks: KiroIdeCard["hooks"] }) }));
    return kiroIdeWired(cards, event, tool);
  }

  protected payload(event: string, fields: Payload): Payload {
    return kiroIdePayload(event, this.moment(), fields);
  }

  protected transcript(): string {
    return "";
  }

  protected override hookEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...this.env,
      KIRO_SESSION_ID: this.session,
      VSCODE_IPC_HOOK: join(tmpdir(), "vscode-ipc-scope-host.sock"),
      VSCODE_PID: String(process.pid),
    };
    delete env.USER_PROMPT;
    return env;
  }

  protected override shellEnv(): NodeJS.ProcessEnv {
    return { ...this.env, KIRO_SESSION_ID: this.session, TERM_PROGRAM: "kiro" };
  }

  protected refusal(res: RunResult): string | null {
    return res.status === 2 ? res.stderr : null;
  }

  protected override startChat(): void {
    this.fire("SessionStart", null, {});
  }

  override typed(words: string): string {
    return this.fire("UserPromptSubmit", null, { prompt: words }).map((res) => res.stdout).join("");
  }

  override bash(line: string): RunResult {
    const input = { command: line, cwd: this.proj, run_in_background: false, timeout: 120000 };
    this.refuseOn(this.shellTool, input, this.fire("PreToolUse", this.shellTool, { tool_name: this.shellTool, tool_input: input }));
    const res = this.run(line);
    this.fire("PostToolUse", this.shellTool, {
      tool_name: this.shellTool,
      tool_input: {},
      tool_response: `Output:\n${res.stdout}${res.stderr}\n\nExit Code: ${res.status}`,
    });
    return res;
  }

  override write(rel: string, content: string): void {
    const abs = join(this.proj, rel);
    const before = existsSync(abs) ? readFileSync(abs, "utf-8") : null;
    const [tool, input, said] = before === null
      ? ["fs_write", { path: rel, text: content }, `Created the ${rel} file.`] as const
      : ["str_replace", { path: rel, oldStr: before, newStr: content }, `Replaced text in ${rel}`] as const;
    this.refuseOn(tool, input, this.fire("PreToolUse", tool, { tool_name: tool, tool_input: input }));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    this.fire("PostToolUse", tool, { tool_name: tool, tool_input: {}, tool_response: said });
  }

  override remove(rel: string): void {
    const input = { command: `rm ${rel}`, cwd: this.proj, run_in_background: false, timeout: 120000 };
    this.refuseOn(this.shellTool, input, this.fire("PreToolUse", this.shellTool, { tool_name: this.shellTool, tool_input: input }));
    rmSync(join(this.proj, rel), { force: true });
    this.fire("PostToolUse", this.shellTool, { tool_name: this.shellTool, tool_input: {}, tool_response: "Output:\n\n\nExit Code: 0" });
  }

  /** invoke_sub_agent; the helper's result comes back after Kiro's empty `subagent_response`, as `subagent_<agent>`. */
  override task(agent: string, prompt: string, work: () => void): void {
    const input = { name: agent, prompt, preset: null, contextFiles: [] };
    this.refuseOn("invoke_sub_agent", input, this.fire("PreToolUse", "invoke_sub_agent", { tool_name: "invoke_sub_agent", tool_input: input }));
    work();
    this.fire("PostToolUse", "subagent_response", { tool_name: "subagent_response", tool_input: {}, tool_response: "Response recorded." });
    this.fire("PostToolUse", `subagent_${agent}`, { tool_name: `subagent_${agent}`, tool_input: {}, tool_response: `**Agent:** ${agent}\n\nDone.` });
  }

  protected stopFields(): Payload {
    return {};
  }
}

/**
 * Cursor (cursor-agent): `.cursor/hooks.json` through the Cursor adapter, no
 * matchers (the adapter reads the tool). Every answer is JSON at exit 0: a
 * refusal is `{"permission":"deny","agent_message"}`, and with failClosed an
 * answer that is not an allow is a refusal too. The turn end cannot block; it
 * can only send `{"followup_message"}`, which Cursor hands the agent as the
 * next message, so the journey reads it as a blocked hand-off. Questions are
 * numbered prose. Git's own settings are kept out of the hooks, as t276 does,
 * so a developer's aliases cannot change what the adapter reads.
 */
export class CursorScopeHost extends NativeScopeHost {
  override readonly dir = ".cursor";
  override readonly skill = ".cursor/skills/aidlc/SKILL.md";
  override readonly picker = false;
  protected override readonly stopEvent = "stop";

  protected override sessionName(n: number): string {
    return `5d190fd9-${hex(this.hostNumber, 4)}-404e-bbae-${hex(n, 12)}`;
  }

  wired(event: string): string[] {
    const wiring = JSON.parse(readFileSync(join(this.proj, ".cursor", "hooks.json"), "utf-8")) as {
      hooks: Record<string, { command: string }[]>;
    };
    return (wiring.hooks[event] ?? []).map((hook) => hook.command);
  }

  private generation = "";

  protected payload(event: string, fields: Payload): Payload {
    return cursorPayload(event, this.moment(), this.generation || (this.helper?.id ?? this.session), fields);
  }

  protected transcript(): string {
    return "";
  }

  protected override hookEnv(): NodeJS.ProcessEnv {
    return {
      ...this.env,
      GIT_CONFIG_GLOBAL: join(this.proj, ".absent-global-gitconfig"),
      GIT_CONFIG_SYSTEM: join(this.proj, ".absent-system-gitconfig"),
    };
  }

  protected refusal(res: RunResult): string | null {
    return cursorRefusal(res.stdout);
  }

  protected override startChat(): void {
    this.fire("sessionStart", null, { is_background_agent: false });
  }

  override typed(words: string): string {
    this.fire("beforeSubmitPrompt", null, { prompt: words, is_background_agent: false });
    return "";
  }

  private call(tool: string, input: Payload, extra: Payload = {}): { use: string; fields: Payload } {
    const use = `toolu_${hex(this.hostNumber, 4)}${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    return { use, fields: { tool_name: tool, tool_input: input, tool_use_id: use, ...extra } };
  }

  override bash(line: string): RunResult {
    const input = { command: line, cwd: "", timeout: 30000 };
    const { fields } = this.call("Shell", input, { cwd: "" });
    this.refuseOn("Shell", input, this.fire("preToolUse", "Shell", fields));
    const started = Date.now();
    const res = this.run(line);
    this.fire("postToolUse", "Shell", { ...fields, tool_output: `${res.stdout}${res.stderr}`, duration: Date.now() - started });
    return res;
  }

  override write(rel: string, content: string): void {
    const abs = join(this.proj, rel);
    const before = existsSync(abs) ? readFileSync(abs, "utf-8") : null;
    const [tool, input] = before === null
      ? ["Write", { file_path: abs, content }] as const
      : ["Edit", { file_path: abs, old_string: before, new_string: content }] as const;
    const { fields } = this.call(tool, input);
    this.refuseOn(tool, input, this.fire("preToolUse", tool, fields));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    this.fire("postToolUse", tool, { ...fields, tool_output: before === null ? "File created" : "File updated", duration: 1 });
  }

  override remove(rel: string): void {
    const input = { command: `rm ${rel}`, cwd: "", timeout: 30000 };
    const { fields } = this.call("Shell", input, { cwd: "" });
    this.refuseOn("Shell", input, this.fire("preToolUse", "Shell", fields));
    rmSync(join(this.proj, rel), { force: true });
    this.fire("postToolUse", "Shell", { ...fields, tool_output: "", duration: 1 });
  }

  /** The Task tool; the helper's own calls carry a conversation of their own and no identity. */
  override task(agent: string, prompt: string, work: () => void): void {
    const input = { description: "stage work", prompt, subagent_type: agent };
    this.generation = randomUUID();
    const { fields } = this.call("Task", input, { model: "" });
    try {
      this.refuseOn("Task", input, this.fire("preToolUse", "Task", fields));
    } finally {
      this.generation = "";
    }
    this.helper = { agent, id: randomUUID() };
    try {
      work();
    } finally {
      this.helper = null;
    }
    this.fire("postToolUse", "Task", { ...fields, model: "", tool_output: "done", duration: 1 });
  }

  override stop(): { blocked: boolean; reason: string } {
    return cursorStopVerdict(this.fire(this.stopEvent, null, this.stopFields()).map((res) => res.stdout).join("\n"));
  }

  protected stopFields(): Payload {
    return { status: "completed" };
  }
}

/** A Cursor preToolUse answer: null for an allow, else the refusal (with failClosed, anything but an allow refuses). */
export function cursorRefusal(stdout: string): string | null {
  const line = stdout.trim().split("\n").find((entry) => entry.startsWith("{"));
  const answer = parseJson(line ?? "") as { permission?: string; agent_message?: string } | null;
  if (answer?.permission === "allow") return null;
  return answer?.permission === "deny"
    ? String(answer.agent_message ?? "")
    : `no allow came back, which Cursor refuses under failClosed: ${clip(stdout, 300)}`;
}

/** A Cursor stop answer: a follow-up message is the next message Cursor hands the agent, so the turn did not end. */
export function cursorStopVerdict(stdout: string): { blocked: boolean; reason: string } {
  const followup = (parseJson(stdout) as { followup_message?: string } | null)?.followup_message;
  return typeof followup === "string" ? { blocked: true, reason: followup } : { blocked: false, reason: "" };
}

/** What the plugin answered for one hook call: a refusal (its thrown message), the output it changed, the nudges it sent. */
interface PluginAnswer {
  ok: boolean;
  error?: string;
  refused?: string | null;
  output?: Record<string, unknown> | null;
  nudges?: string[];
}

/**
 * opencode: AI-DLC's plugin (`.opencode/plugin/aidlc-opencode-adapter.ts`)
 * loaded into one opencode process, here a worker thread the host waits on
 * (tests/harness/opencode-plugin-worker.ts), with the production guard profile
 * in its environment, which the plugin's hooks inherit. A refusal is the hook's
 * thrown error; a turn end that blocks sends a nudge through
 * `client.session.prompt`. A helper is a child session whose parent the client
 * names. A new chat after a stop for the day is a new opencode process, which
 * loads the plugin again. The agent's shell carries `OPENCODE=1`.
 */
export class OpencodeScopeHost extends ScopeHost {
  override readonly dir = ".aidlc";
  override readonly skill = ".aidlc/skills/aidlc/SKILL.md";
  override readonly picker = false;
  override readonly removesDispatch = false;
  private readonly sab = new SharedArrayBuffer(8 + (16 << 20));
  private readonly flag = new Int32Array(this.sab, 0, 2);
  private worker!: Worker;
  private readonly hostNumber = ++hostCount;
  private child: string | null = null;
  private uses = 0;

  constructor(proj: string, base?: NodeJS.ProcessEnv) {
    super(proj, base);
    delete this.env.CLAUDE_PROJECT_DIR;
    this.fullHost = true;
    this.session = this.sessionName(1);
    this.launch();
  }

  /** An opencode process: the plugin loaded from the project as it is now, with state of its own. */
  private launch(): void {
    this.worker = new Worker(join(import.meta.dir, "opencode-plugin-worker.ts"), { workerData: { sab: this.sab, env: this.env } });
    this.worker.unref();
    this.startPlugin();
  }

  protected override sessionName(n: number): string {
    return `ses_${hex(this.hostNumber, 4)}c0de${hex(n, 16)}`;
  }

  /** One request to the plugin's process, waited on as opencode waits on a hook. */
  private request(message: Record<string, unknown>): PluginAnswer {
    const started = Date.now();
    Atomics.store(this.flag, 0, 0);
    this.worker.postMessage(message);
    const waited = Atomics.wait(this.flag, 0, 0, SCOPE_RUN_TIMEOUT_MS);
    if (waited === "timed-out") throw new ScopeRunStuck(`the opencode plugin did not answer ${JSON.stringify(message).slice(0, 200)}`);
    const answer = JSON.parse(new TextDecoder().decode(new Uint8Array(this.sab, 8, Atomics.load(this.flag, 1)).slice())) as PluginAnswer;
    const what = message.op === "hook" ? `plugin ${String(message.name)}` : `plugin ${String(message.op)}`;
    this.calls.push({ what, ms: Date.now() - started, status: answer.ok ? (answer.refused ? 2 : 0) : -1 });
    this.trace.push(`$ ${what}\n  -> ${answer.refused ? `refused: ${clip(answer.refused)}` : answer.ok ? "ok" : `error: ${clip(answer.error ?? "")}`}`);
    if (!answer.ok) throw new ScopeRunStuck(`the opencode plugin failed: ${answer.error}`);
    return answer;
  }

  private startPlugin(): void {
    this.request({ op: "start", plugin: join(this.proj, ".opencode", "plugin", "aidlc-opencode-adapter.ts"), directory: this.proj });
  }

  private hookCall(name: string, input: Record<string, unknown>, output?: Record<string, unknown>): PluginAnswer {
    return this.request({ op: "hook", name, input, output });
  }

  /** A tool call through the plugin: before (a throw refuses it, as in opencode), the call, then after. */
  private tool<T>(tool: string, args: Record<string, unknown>, act: (args: Record<string, unknown>) => T, result: (value: T) => string): T {
    const sessionID = this.child ?? this.session;
    const callID = `call_${hex(this.hostNumber, 4)}_${++this.uses}`;
    const before = this.hookCall("tool.execute.before", { tool, sessionID, callID }, { args });
    if (before.refused) {
      this.refusals.push(`${tool} ${clip(JSON.stringify(args), 200)}: ${clip(before.refused, 600)}`);
      throw new ScopeRunRefused(`the plugin refused ${tool} ${clip(JSON.stringify(args), 200)}`, before.refused);
    }
    const ran = (before.output?.args as Record<string, unknown> | undefined) ?? args;
    const value = act(ran);
    this.hookCall("tool.execute.after", { tool, sessionID, callID, args: ran }, { output: result(value) });
    return value;
  }

  override hook(name: string): RunResult {
    throw new Error(`${name} is a Claude Code hook name; opencode runs AI-DLC's plugin`);
  }

  // A chat's first message starts it in the plugin; there is no session-start event of its own.
  protected override startChat(): void {}

  override newSession(): void {
    // The next day is a new opencode process, which loads the plugin again.
    void this.worker.terminate();
    this.launch();
    super.newSession();
  }

  override typed(words: string): string {
    const skill = /^\/aidlc(?:\s+|$)/.exec(words);
    if (skill) {
      // opencode expands the command template, and the plugin shows what the person typed.
      const args = words.slice(skill[0].length);
      const template = readFileSync(join(this.proj, ".opencode", "command", "aidlc.md"), "utf-8")
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").split("$ARGUMENTS").join(args);
      const command = this.hookCall("command.execute.before", { command: "aidlc", sessionID: this.session, arguments: args }, { parts: [{ type: "text", text: template }] });
      this.hookCall("chat.message", { sessionID: this.session, agent: "build" }, { parts: (command.output?.parts as unknown[]) ?? [] });
      return "";
    }
    this.hookCall("chat.message", { sessionID: this.session, agent: "build" }, { parts: [{ type: "text", text: words }] });
    return "";
  }

  override bash(line: string): RunResult {
    return this.tool("bash", { command: line, description: "Run the step AI-DLC named" }, (args) => {
      const ran = String(args.command ?? line);
      return this.spawn(ran, this.argv(ran), undefined, { ...this.env, OPENCODE: "1" });
    }, (res) => `${res.stdout}${res.stderr}`);
  }

  override write(rel: string, content: string): void {
    const abs = join(this.proj, rel);
    const before = existsSync(abs) ? readFileSync(abs, "utf-8") : null;
    const [tool, args] = before === null
      ? ["write", { filePath: abs, content }] as const
      : ["edit", { filePath: abs, oldString: before, newString: content }] as const;
    this.tool(tool, args, () => {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }, () => (before === null ? "Wrote file successfully." : "Edit applied successfully."));
  }

  override remove(rel: string): void {
    this.tool("bash", { command: `rm ${rel}`, description: "Remove a file" }, () => rmSync(join(this.proj, rel), { force: true }), () => "");
  }

  /** The task tool: the helper's brief is the one the plugin hands it; its own calls run in a child session. */
  override task(agent: string, prompt: string, work: () => void): void {
    this.tool("task", { subagent_type: agent, prompt, description: "stage work" }, (args) => {
      const child = `${this.session}_child${++this.uses}`;
      this.request({ op: "parent", child, parent: this.session });
      this.hookCall("chat.message", { sessionID: child, agent }, { parts: [{ type: "text", text: String(args.prompt ?? prompt) }] });
      this.child = child;
      try {
        work();
      } finally {
        this.child = null;
      }
    }, () => "done");
  }

  override stop(): { blocked: boolean; reason: string } {
    const idle = this.hookCall("event", { event: { type: "session.idle", properties: { sessionID: this.session } } });
    const nudge = idle.nudges?.[0];
    return nudge === undefined ? { blocked: false, reason: "" } : { blocked: true, reason: nudge };
  }

  /** End the plugin's process. */
  dispose(): void {
    void this.worker.terminate();
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** The host that plays a tool on a project; `base` is the environment the person's machine gives it. */
export function hostFor(name: "claude" | HostName, proj: string, base?: NodeJS.ProcessEnv): ScopeHost {
  switch (name) {
    case "claude": return new ScopeHost(proj, base);
    case "codex": return new CodexScopeHost(proj, base);
    case "copilot": return new CopilotScopeHost(proj, base);
    case "kiro": return new KiroCliScopeHost(proj, base);
    case "kiro-ide": return new KiroIdeScopeHost(proj, base);
    case "cursor": return new CursorScopeHost(proj, base);
    case "opencode": return new OpencodeScopeHost(proj, base);
  }
}

/** A project as a person brings it with that tool's tree installed as it ships, in a git repository with one commit. */
export function createHostProject(name: HostName, shape: "code" | "empty"): { proj: string; host: ScopeHost } {
  const proj = join(realpathSync(scopeScratchDir(`scope-host-${name}-`)), "proj");
  cpSync(join(REPO_ROOT, "dist", name), proj, { recursive: true });
  if (shape === "code") cpSync(join(FIXTURES_DIR, "brownfield-todo"), proj, { recursive: true });
  const host = hostFor(name, proj);
  host.git("init", "-q", "-b", "main");
  host.git("add", "-A");
  host.git("commit", "-q", "-m", "Before AI-DLC");
  return { proj, host };
}

// ---------------------------------------------------------------------------
// The journey every tree runs
// ---------------------------------------------------------------------------

/** The stages the person skips with the request: design stages that add no wiring the kept ones do not. */
export const SKIPPED = [
  "user-stories", "refined-mockups", "domain-design", "contract-design", "delivery-planning",
  "nfr-requirements", "nfr-design", "infrastructure-design",
];
export const UNITS = ["core", "api"];

/**
 * Detours the journey meets today, each with a test.todo named after it in
 * tests/integration/t-scope-host-claude.test.ts; the fix removes it here.
 */
export const KNOWN_JOURNEY_DETOURS: readonly string[] = [RESUME_AGAIN];

export interface HostJourney {
  run: ScopeRun;
  /** The first clone's audit shard: every row before the fresh clone. */
  firstShard: string;
  /** The chats the person used, in order. */
  chats: string[];
}

/**
 * The first machine's clone id, minted before AI-DLC first runs there. Its
 * token sorts after any other, so the shard holding every older row sorts last
 * once a fresh clone writes a shard of its own.
 */
function firstCloneId(proj: string): string {
  const host = auditShardHostSegment();
  mkdirSync(dirname(cloneIdPath(proj)), { recursive: true });
  writeFileSync(cloneIdPath(proj), cloneIdFileContent("ffffffffffff", host));
  return `${host}-ffffffffffff.md`;
}

/**
 * The person picks the work up from a fresh clone of the repository: they
 * commit, and the folder is left with only what a clone holds (every file git
 * ignores is gone: the chats, the work's cursor, the clone id and the engine's
 * own scratch).
 */
function freshClone(host: ScopeHost): void {
  host.git("add", "-A");
  host.git("commit", "-q", "-m", "First Unit approved");
  const cleaned = host.git("clean", "-q", "-f", "-d", "-X");
  if (cleaned.status !== 0) throw new Error(`git clean failed: ${cleaned.stderr}`);
}

/**
 * The classic scope on one tree, with two Units built one at a time and a
 * checkpoint each. After the first Unit's checkpoint the person stops for the
 * day, picks the work up from a fresh clone, and carries on in a second chat
 * with `/aidlc --resume`.
 */
export function hostJourney(name: "claude" | HostName): HostJourney {
  let firstShard = "";
  let cloned = false;
  const chats: string[] = [];
  const run = runScope("classic", {
    project: (shape) => {
      const made = name === "claude" ? createScopeProject(shape) : createHostProject(name, shape);
      firstShard = firstCloneId(made.proj);
      chats.push(made.host.session);
      return made;
    },
    units: UNITS,
    flags: ["--skip", SKIPPED.join(",")],
    afterCheckpoint: (unit, kind, agent) => {
      if (unit !== UNITS[0] || kind !== "unit" || cloned) return;
      cloned = true;
      agent.stopForTheDay(() => freshClone(agent.host));
      chats.push(agent.host.session);
    },
  });
  return { run, firstShard: join(activeRecord(run.proj).dir, "audit", firstShard), chats };
}

/** What the journey must show beyond a clean scope run. */
export function hostJourneyProblems(journey: HostJourney): string[] {
  const { run, firstShard, chats } = journey;
  const problems = scopeRunProblems(run, { stages: expectedStages("classic", run.shape === "code").filter((s) => !SKIPPED.includes(s)) });
  const shards = existsSync(dirname(firstShard)) ? readdirSync(dirname(firstShard)).filter((f) => f.endsWith(".md")).sort() : [];
  if (shards.length !== 2 || shards.at(-1) !== basename(firstShard)) {
    problems.push(`the work's audit shards are ${JSON.stringify(shards)}: not the first clone's, sorting last, and one from the fresh clone`);
  }
  for (const detour of run.agent.detours) {
    if (!KNOWN_JOURNEY_DETOURS.includes(detour)) problems.push(`the person was sent round a detour: ${detour}`);
  }
  if (new Set(chats).size !== 2) problems.push(`the person used chats ${JSON.stringify(chats)}, not two`);
  const checkpoints = run.agent.asked.filter((a) => a.what === "unit checkpoint").map((a) => a.unit);
  if (JSON.stringify(checkpoints) !== JSON.stringify(UNITS)) problems.push(`Unit checkpoints asked for ${JSON.stringify(checkpoints)}, not each Unit once`);
  if (run.host instanceof NativeScopeHost) problems.push(...run.host.hookFailures.map((f) => `a hook failed: ${f}`));
  return problems;
}

/** The test a t-scope-host-<tool> file declares. */
export function hostJourneySuite(name: "claude" | HostName): void {
  describe(`the classic scope on the ${name} tree, through its own hooks`, () => {
    afterAll(cleanupScopeProjects);
    test("two Units one at a time, a fresh clone and a second chat: every step is the person's and the run ends done", () => {
      const journey = hostJourney(name);
      if (journey.run.host instanceof OpencodeScopeHost) journey.run.host.dispose();
      const problems = hostJourneyProblems(journey);
      console.log(`scope host ${name}: ${journey.run.ms} ms, ${journey.run.host.calls.length} calls, ${journey.run.person.said.length} person turns`);
      expect(problems).toEqual([]);
    }, SCOPE_RUN_TIMEOUT_MS);
  });
}

