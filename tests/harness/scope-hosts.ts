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
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { auditShardHostSegment, cloneIdFileContent, cloneIdPath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { copilotSkillPrompt } from "./aidlc-input-corpus.ts";
import { FIXTURES_DIR, REPO_ROOT } from "./fixtures.ts";
import {
  activeRecord,
  cleanupScopeProjects,
  clip,
  commandWords,
  createScopeProject,
  expectedStages,
  type RunResult,
  runScope,
  SCOPE_RUN_TIMEOUT_MS,
  ScopeHost,
  RESUME_AGAIN,
  ScopeRunRefused,
  type ScopeRun,
  scopeRunProblems,
  scopeScratchDir,
  stopVerdict,
} from "./scope-run.ts";

export type HostName = "codex" | "copilot";
export const HOSTS: readonly ("claude" | HostName)[] = ["claude", "codex", "copilot"];

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

  constructor(proj: string) {
    super(proj);
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
      const words = commandWords(line);
      const res = this.spawn(`${event}${tool ? ` ${tool}` : ""}: ${line}`, [words[0] === "bun" ? process.execPath : words[0], ...words.slice(1)], input);
      if (res.status !== 0 && !(res.status === 2 && (event === "PreToolUse" || event === "Stop"))) {
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
    const words = commandWords(line);
    if (words[0] !== "bun") throw new Error(`the stand-in runs only bun commands, got: ${line}`);
    return this.spawn(line, [process.execPath, ...words.slice(1)], undefined, this.shellEnv());
  }

  override hook(name: string): RunResult {
    throw new Error(`${name} is a Claude Code hook name; this host fires its own wiring`);
  }

  override stop(): { blocked: boolean; reason: string } {
    const results = this.fire("Stop", null, this.stopFields());
    const blocked = results.find((res) => res.status === 2);
    if (blocked) return { blocked: true, reason: blocked.stderr };
    return stopVerdict(results.map((res) => res.stdout).join("\n"));
  }

  protected abstract stopFields(): Payload;
}

/** Codex CLI: `.codex/hooks.json` through `engine adapter codex`, apply_patch for files, spawn_agent for helpers. */
export class CodexScopeHost extends NativeScopeHost {
  override readonly dir = ".codex";

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

  override typed(words: string): void {
    this.newTurn();
    this.fire("UserPromptSubmit", null, { prompt: words });
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
  override typed(words: string): void {
    this.newTurn();
    const skill = /^\/aidlc(?:\s+|$)/.exec(words);
    this.fire("UserPromptSubmit", null, { prompt: skill ? copilotSkillPrompt(this.proj, words.slice(skill[0].length)) : words });
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

function hostFor(name: "claude" | HostName, proj: string): ScopeHost {
  return name === "claude" ? new ScopeHost(proj) : name === "codex" ? new CodexScopeHost(proj) : new CopilotScopeHost(proj);
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
      const problems = hostJourneyProblems(journey);
      console.log(`scope host ${name}: ${journey.run.ms} ms, ${journey.run.host.calls.length} calls, ${journey.run.person.said.length} person turns`);
      expect(problems).toEqual([]);
    }, SCOPE_RUN_TIMEOUT_MS);
  });
}

