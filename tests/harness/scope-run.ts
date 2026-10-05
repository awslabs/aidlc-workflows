// scope-run.ts - drive a shipped scope from the first request to done with no
// model, and check what its scope file promises.
//
// Three parts, kept apart so the person is never played by the agent part:
//   - ScopeHost spawns the real CLI the way the Claude skill does
//     (`bun .claude/tools/aidlc.ts engine ...`, run from the project) and fires
//     the real hooks Claude Code would fire for the agent's tool calls, with
//     the production guard profile, so the engine itself refuses a decision
//     no person turn backs.
//   - AgentStandIn loops on `next` and does what the stage protocol asks of
//     the agent: it writes small artifacts, runs the commands the directive
//     names exactly as given, and at every question or gate ends its turn.
//   - PersonScript is the only part that answers. It types the person's words
//     through the human-turn hook and notes each turn in the PersonTurnLedger.
//
// Expectations come from the source: the scope file's frontmatter and the
// stage files' `scopes:` lists, read here with a small parser of their own, so
// an engine misread shows up as a difference.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AuditShardEvent } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { cleanupTestProject, REPO_ROOT, setupIntegrationProject } from "./fixtures.ts";
import { PersonTurnLedger } from "./person-turns.ts";
import { testGuardEnvironment } from "./runner-profile.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "./test-budget.ts";

export type Directive = Record<string, unknown> & { kind?: string };

type AuditReader = Pick<
  typeof import("../../dist/claude/.claude/tools/aidlc-lib.ts"),
  "auditBlockField" | "readAuditShardEvents" | "classifyRuntimeCompileCommand"
>;
let reader: AuditReader | undefined;
function lib(): AuditReader {
  reader ??= require("../../dist/claude/.claude/tools/aidlc-lib.ts") as AuditReader;
  return reader;
}
export const field = (block: string, name: string): string | null => lib().auditBlockField(block, name);

// ---------------------------------------------------------------------------
// Expectations, read from the source
// ---------------------------------------------------------------------------

const SCOPES_DIR = join(REPO_ROOT, "core", "scopes");
const STAGES_DIR = join(REPO_ROOT, "core", "aidlc-common", "stages");
const STAGE_GRAPH = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "data", "stage-graph.json");

function frontmatter(path: string): string[] {
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  if (lines[0] !== "---") return [];
  const end = lines.indexOf("---", 1);
  return end < 0 ? [] : lines.slice(1, end);
}

/** The shipped scope names, from `core/scopes/aidlc-<name>.md`. */
export function shippedScopes(): string[] {
  return readdirSync(SCOPES_DIR)
    .filter((f) => /^aidlc-.+\.md$/.test(f))
    .map((f) => f.replace(/^aidlc-/, "").replace(/\.md$/, ""))
    .sort();
}

export interface DeclaredScope {
  name: string;
  depth: string;
  testStrategy: string;
  skeleton: boolean;
  existingCode: boolean;
  reviewCap: string;
  guardPolicy: string;
  sensors: boolean;
  learnings: boolean;
  summaryConfirmation: boolean;
  planApproval: boolean;
  collaborators: boolean;
}

/** What the scope file declares. Absent switches take the documented defaults. */
export function declaredScope(scope: string): DeclaredScope {
  const values = new Map<string, string>();
  for (const line of frontmatter(join(SCOPES_DIR, `aidlc-${scope}.md`))) {
    const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (m) values.set(m[1], m[2].replace(/^"|"$/g, "").trim());
  }
  const on = (key: string, fallback: boolean) =>
    values.has(key) ? ["on", "true"].includes(values.get(key) ?? "") : fallback;
  const depth = values.get("depth") ?? "Standard";
  return {
    name: scope,
    depth,
    testStrategy: values.get("testStrategy") ?? depth,
    skeleton: on("skeleton", false),
    existingCode: on("existing_code", false),
    reviewCap: values.get("review_cap") ?? "adversarial",
    guardPolicy: values.get("guard_policy") ?? "strict",
    sensors: on("sensors", true),
    learnings: on("learnings", true),
    summaryConfirmation: on("summary_confirmation", true),
    planApproval: on("plan_approval", true),
    collaborators: on("collaborators", true),
  };
}

export interface SourceStage {
  slug: string;
  phase: string;
  scopes: string[];
  summaryConfirmation: boolean;
  forEachUnit: boolean;
  reviewer: string | null;
}

/** Every stage file's frontmatter, in stage-graph order. */
export function sourceStages(): SourceStage[] {
  const order = (JSON.parse(readFileSync(STAGE_GRAPH, "utf-8")) as { slug: string }[]).map((s) => s.slug);
  const stages: SourceStage[] = [];
  for (const phase of readdirSync(STAGES_DIR)) {
    for (const file of readdirSync(join(STAGES_DIR, phase))) {
      if (!file.endsWith(".md")) continue;
      const lines = frontmatter(join(STAGES_DIR, phase, file));
      const scalar = (key: string) => {
        const line = lines.find((l) => l.startsWith(`${key}:`));
        return line === undefined ? null : line.slice(key.length + 1).trim();
      };
      const scopes: string[] = [];
      const at = lines.findIndex((l) => l === "scopes:");
      if (at >= 0) {
        for (const l of lines.slice(at + 1)) {
          const m = /^\s+-\s+(\S+)/.exec(l);
          if (!m) break;
          scopes.push(m[1]);
        }
      }
      stages.push({
        slug: scalar("slug") ?? file.replace(/\.md$/, ""),
        phase: scalar("phase") ?? phase,
        scopes,
        summaryConfirmation: scalar("summary_confirmation") === "required",
        forEachUnit: scalar("for_each") === "unit-of-work",
        reviewer: scalar("reviewer"),
      });
    }
  }
  return stages.sort((a, b) => order.indexOf(a.slug) - order.indexOf(b.slug));
}

/**
 * The stages a scope runs, in order: a stage runs when its `scopes:` list names
 * the scope, and the initialization stages always run. On a project with no code
 * the engine marks reverse-engineering skipped.
 */
export function expectedStages(scope: string, projectHasCode: boolean): string[] {
  return sourceStages()
    .filter((s) => s.phase === "initialization" || s.scopes.includes(scope))
    .filter((s) => projectHasCode || s.slug !== "reverse-engineering")
    .map((s) => s.slug);
}

// ---------------------------------------------------------------------------
// Host: the real CLI and the real hooks
// ---------------------------------------------------------------------------

export interface CallRecord {
  what: string;
  ms: number;
  status: number;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Split a command line the engine printed into its words (double and single quotes). */
export function commandWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < line.length && ['"', "\\", "$", "`"].includes(line[i + 1])) word += line[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) throw new Error(`unclosed quote in command: ${line}`);
  if (started) words.push(word);
  return words;
}

export class ScopeHost {
  readonly calls: CallRecord[] = [];
  readonly trace: string[] = [];
  readonly env: NodeJS.ProcessEnv;
  session = "scope-run-session-1";

  constructor(readonly proj: string) {
    const env = testGuardEnvironment({ ...process.env, CLAUDE_PROJECT_DIR: proj }, "production");
    delete env.AWS_AIDLC_DEFAULT_SCOPE;
    delete env.AIDLC_UNATTENDED;
    env.GIT_AUTHOR_NAME = "Scope Run";
    env.GIT_AUTHOR_EMAIL = "scope-run@example.invalid";
    env.GIT_COMMITTER_NAME = "Scope Run";
    env.GIT_COMMITTER_EMAIL = "scope-run@example.invalid";
    this.env = env;
  }

  private spawn(what: string, argv: string[], stdin?: string): RunResult {
    const started = Date.now();
    const res = spawnSync(argv[0], argv.slice(1), {
      cwd: this.proj,
      env: this.env,
      encoding: "utf-8",
      input: stdin ?? "",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: "scope run" }),
    });
    const result = { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    this.calls.push({ what, ms: Date.now() - started, status: result.status });
    this.trace.push(`$ ${what}\n  -> ${result.status} ${clip(result.stdout)}${result.stderr ? ` | err: ${clip(result.stderr)}` : ""}`);
    return result;
  }

  /** Refusals by the one PreToolUse guard the host fires (see preTool). */
  readonly refusals: string[] = [];

  /**
   * The PreToolUse guard the host fires before Bash, Write and Task calls. Of
   * the five Claude Code runs there, only the plan-approval guard is fired: its
   * heartbeat is what tells the engine the host runs hooks, and a refusal of a
   * command the engine directed is a finding. The others guard reads and
   * direct state edits the stand-in never makes, and have their own owners.
   */
  private preTool(tool: string, input: Record<string, unknown>): void {
    const res = this.hook("plan-approval-guard", { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });
    if (res.status === 2) this.refusals.push(`${tool} ${clip(JSON.stringify(input), 200)}: ${clip(res.stderr, 600)}`);
  }

  /** Run a command line as the agent's Bash tool would, with the host's Bash hooks. */
  bash(line: string): RunResult {
    const words = commandWords(line);
    if (words[0] !== "bun") throw new Error(`the stand-in runs only bun commands, got: ${line}`);
    // The guard is fired on the engine's loop commands, where a refusal would
    // stop the person's run; logging and read-only helpers skip it.
    if (/\borchestrate(?:\.ts)? (?:next|continue|report)\b|\borchestrate-?\.?ts continue\b|aidlc-orchestrate\.ts /.test(line)) {
      this.preTool("Bash", { command: line });
    }
    const res = this.spawn(line, [process.execPath, ...words.slice(1)]);
    // The Bash PostToolUse hook acts only on transition commands, on work being
    // created (it joins the session to it) and on an engine error it relays;
    // for anything else it exits at once, so the host's call is skipped.
    const acts = lib().classifyRuntimeCompileCommand(line) === "fire" ||
      /\bintent create\b/.test(line) || /"kind"\s*:\s*"error"/.test(res.stdout);
    if (acts) this.hook("rebuild-stage-graph", {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: line },
      tool_response: { stdout: res.stdout, stderr: res.stderr },
    });
    return res;
  }

  /** `bun .claude/tools/aidlc.ts engine <args>`, the skill's dispatcher form. */
  engine(...args: string[]): RunResult {
    return this.bash(["bun", ".claude/tools/aidlc.ts", "engine", ...args].map(shellQuote).join(" "));
  }

  /** Write a file as the agent's Write tool would, then the host's Write hook. */
  write(rel: string, content: string): void {
    const abs = join(this.proj, rel);
    // Record files are the agent's own stage output; the guard watches code.
    if (!RECORD_PREFIX.test(rel)) this.preTool("Write", { file_path: abs, content });
    mkdirSync(dirname(abs), { recursive: true });
    const existed = existsSync(abs);
    writeFileSync(abs, content);
    this.hook("write-audit-log", {
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: abs, content },
      tool_response: { type: existed ? "update" : "create", filePath: abs },
    });
  }

  hook(name: string, payload: Record<string, unknown>): RunResult {
    return this.spawn(
      `hook ${name}`,
      [process.execPath, join(this.proj, ".claude", "tools", "aidlc.ts"), "engine", "hook", name],
      JSON.stringify({ session_id: this.session, cwd: this.proj, ...payload }),
    );
  }

  private sessions = new Set<string>();

  sessionStart(source: "startup" | "resume"): void {
    this.sessions.add(this.session);
    this.hook("session-start", { hook_event_name: "SessionStart", source });
  }

  /** A new chat: a fresh session id, started the way Claude Code starts one. */
  newSession(): void {
    this.session = `scope-run-session-${this.sessions.size + 1}`;
    this.sessionStart("startup");
  }

  sessionStartIfNew(): void {
    if (!this.sessions.has(this.session)) this.sessionStart("startup");
  }

  /** The agent ends its turn. The Stop hook must let it end when a person is asked. */
  stop(): { blocked: boolean; reason: string } {
    const res = this.hook("continue-workflow", { hook_event_name: "Stop", stop_hook_active: false });
    const out = res.stdout.trim();
    if (!out) return { blocked: false, reason: "" };
    try {
      const parsed = JSON.parse(out) as { decision?: string; reason?: string };
      return { blocked: parsed.decision === "block", reason: parsed.reason ?? "" };
    } catch {
      return { blocked: false, reason: out };
    }
  }

  /** The agent dispatches a subagent with the Task tool: the host's Task hooks. */
  task(agent: string, prompt: string, work: () => void): void {
    const input = { subagent_type: agent, description: "stage work", prompt };
    this.hook("deliver-stage-rules", { hook_event_name: "PreToolUse", tool_name: "Task", tool_input: input });
    this.preTool("Task", input);
    work();
    this.hook("log-subagent", { hook_event_name: "SubagentStop", agent_type: agent, stop_hook_active: false });
    this.hook("deliver-stage-rules", {
      hook_event_name: "PostToolUse",
      tool_name: "Task",
      tool_input: input,
      tool_response: { content: [{ type: "text", text: "done" }] },
    });
  }

  git(...args: string[]): RunResult {
    return this.spawn(`git ${args.join(" ")}`, ["git", ...args]);
  }
}

const clip = (s: string, n = 400) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}...` : flat;
};

export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `"${word.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * A project as a person brings it: the Claude install with its shipped
 * .gitignore, in a git repository with one commit. "code" adds the brownfield
 * fixture's source; "empty" has none.
 */
const projects: string[] = [];

export function createScopeProject(shape: "code" | "empty"): { proj: string; host: ScopeHost } {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true, withBrownfieldStub: shape === "code" });
  projects.push(proj);
  copyFileSync(join(REPO_ROOT, "dist", "claude", ".gitignore"), join(proj, ".gitignore"));
  const host = new ScopeHost(proj);
  host.git("init", "-q", "-b", "main");
  host.git("add", "-A");
  host.git("commit", "-q", "-m", "Before AI-DLC");
  return { proj, host };
}

// ---------------------------------------------------------------------------
// The person
// ---------------------------------------------------------------------------

export class PersonScript {
  readonly ledger: PersonTurnLedger;
  readonly said: string[] = [];

  constructor(readonly host: ScopeHost) {
    this.ledger = new PersonTurnLedger(host.proj);
  }

  /** The person types a reply in the chat. */
  say(words: string): void {
    this.ledger.sent(words);
    this.said.push(words);
    this.host.hook("record-human-turn", { hook_event_name: "UserPromptSubmit", prompt: words });
  }

  /** The person picks an option in an AskUserQuestion picker. */
  pick(question: string, options: string[], label: string): void {
    // A picker submission carries exactly one pick.
    this.ledger.sent(label, 1);
    this.said.push(label);
    const questions = [{
      question,
      header: "Choice",
      multiSelect: false,
      options: options.map((o) => ({ label: o, description: o })),
    }];
    this.host.hook("record-human-turn", {
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      tool_input: { questions },
      tool_response: { questions, answers: { [question]: label } },
    });
  }
}

// ---------------------------------------------------------------------------
// The agent stand-in
// ---------------------------------------------------------------------------

/** A step the run could not take: the message names it, the trace shows how it got there. */
export class ScopeRunStuck extends Error {}

/** Where the agent handed the turn to the person, and whether the Stop hook let it. */
export interface Handoff {
  what: string;
  stage: string;
  blocked: boolean;
  reason: string;
}

/**
 * What the person answers at each kind of question. Overridable per run. An
 * answer that is one of the offered options is a pick; anything else is the
 * person typing their own words.
 */
export interface PersonAnswers {
  approve(stage: string, unit: string | null): string;
  questionMode(stage: string): string;
  question(stage: string): string;
  summary(stage: string): string;
  learnings(stage: string): string;
  plan(unit: string | null): string;
  autonomy(): "Continue automatically" | "Review each checkpoint";
  verificationCommand(): string;
  checkpoint(unit: string, kind: string): string;
  /** The answer to "where does this new work go?": unset means the run never expects it. */
  newWork?(description: string): string;
  /** The person stops at this open gate for today instead of answering it. */
  stopAt?(stage: string): boolean;
}

export const PLAIN_ANSWERS: PersonAnswers = {
  approve: () => "Approve",
  questionMode: () => "Guide me",
  question: () => "A",
  summary: () => "Looks correct",
  learnings: () => "Nothing to add",
  plan: () => "Approve Plan",
  autonomy: () => "Review each checkpoint",
  verificationCommand: () => "Approve",
  checkpoint: () => "Approve",
};

const RECORD_PREFIX = /^aidlc\/spaces\/[^/]+\/intents\/[^/]+\//;

export interface StandInOptions {
  answers?: Partial<PersonAnswers>;
  /** The Units Units Generation writes, in dependency order. */
  units?: string[];
  /**
   * A person move after a stage's approval: the person types something new.
   * Return the directive the agent then acts on, or nothing to carry on.
   */
  afterApproval?: (stage: string, agent: AgentStandIn) => Directive | undefined;
}

/**
 * How the stand-in reads typed words against the offered choices: the choice
 * the words name (ignoring case), else the first choice. The person's words
 * themselves reach the record through the human-turn hook, not this reading.
 */
export function readChoice(words: string, options: string[]): string {
  if (options.includes(words)) return words;
  const number = /^\s*(\d+)\b/.exec(words);
  if (number && Number(number[1]) >= 1 && Number(number[1]) <= options.length) return options[Number(number[1]) - 1];
  const lower = words.toLowerCase();
  return options.find((o) => lower.includes(o.toLowerCase())) ?? options[0];
}

export class AgentStandIn {
  readonly directives: Directive[] = [];
  /** The run-stage directives whose stage body the stand-in ran. */
  readonly worked: Directive[] = [];
  readonly handoffs: Handoff[] = [];
  readonly started: string[] = [];
  readonly units: string[];
  answers: PersonAnswers;
  readonly afterApproval?: StandInOptions["afterApproval"];
  private steps = 0;
  /** A directive a person move produced, acted on before the next `next`. */
  private pending: Directive | undefined;
  private stopped = new Set<string>();
  /** What `park` answered each time the person stopped for the day. */
  readonly parks: Directive[] = [];

  constructor(
    readonly host: ScopeHost,
    readonly person: PersonScript,
    options: StandInOptions = {},
  ) {
    this.answers = { ...PLAIN_ANSWERS, ...options.answers };
    this.units = options.units ?? ["core"];
    this.afterApproval = options.afterApproval;
  }

  /**
   * Act on a print the engine answered a person's line with: run the command it
   * names exactly as given. Returns true when the print says to stop, so the
   * turn ends there and the person speaks next.
   */
  actOnPrint(d: Directive): boolean {
    const message = String(d.message ?? "");
    const command = /`(bun \.claude\/tools\/[^`]+)`/.exec(message);
    if (command) {
      const res = this.host.bash(command[1]);
      const out = parseJson(res.stdout);
      if (res.status !== 0 || out?.kind === "error") this.fail(`${command[1]} was refused: ${clip(res.stdout + res.stderr, 1200)}`, d);
    }
    return /\bstop\b/i.test(message);
  }

  /** The person types a line into the chat; a slash command goes to `next` as the skill forwards it. */
  personTypes(line: string): Directive {
    this.host.sessionStartIfNew();
    this.person.say(line);
    const args = line.trim().startsWith("/aidlc") ? commandWords(line.trim().slice("/aidlc".length)) : [line];
    return this.next(...args);
  }

  fail(message: string, directive?: Directive): never {
    const tail = this.host.trace.slice(-25).join("\n");
    const shown = directive ? `\nlast directive: ${clip(JSON.stringify(directive), 1500)}` : "";
    throw new ScopeRunStuck(`${message}${shown}\n--- last host calls ---\n${tail}`);
  }

  /** Kinds of hand-off whose turn-ending Stop check already ran, per phase. */
  private stopChecked = new Set<string>();
  /** Check every hand-off's Stop, not one per kind and phase. */
  checkEveryStop = false;

  /**
   * The agent asks the person. On Claude Code a structured question is an
   * AskUserQuestion picker whose answer comes back inside the same turn, so
   * the person picks (or types their own words) with no Stop between.
   * Harnesses that show numbered prose (Kiro CLI, Copilot, opencode, Codex
   * without request_user_input) end the turn at the question instead, and the
   * same Stop hook must let it end. That turn-ending check runs once per kind
   * of question in each phase: the Stop hook's own rules are owned by
   * tests/integration/t121-stop-hook-enforce.test.ts; here it is the wiring.
   */
  askPerson(what: string, stage: string, question: string, options: string[], words: string): string {
    const phase = sourceStage(stage)?.phase ?? "";
    const key = `${what} ${phase}`;
    if (this.checkEveryStop || !this.stopChecked.has(key)) {
      this.stopChecked.add(key);
      this.handoffs.push({ what, stage, ...this.host.stop() });
    }
    if (options.includes(words)) this.person.pick(question, options, words);
    else this.person.say(words);
    return readChoice(words, options);
  }

  /** Engine command that must succeed; returns parsed JSON when it printed JSON. */
  must(...args: string[]): Record<string, unknown> {
    const res = this.host.engine(...args);
    const out = parseJson(res.stdout);
    if (res.status !== 0 || out?.kind === "error") {
      this.fail(`engine ${args.slice(0, 3).join(" ")} was refused (${res.status}): ${clip(res.stdout + res.stderr, 1200)}`);
    }
    return out ?? {};
  }

  /**
   * `orchestrate report`: the engine either records it (print or done) or
   * answers with something the stand-in must act on, which a scope run treats
   * as a refusal and stops on, showing what the engine said.
   */
  report(stage: string, ...args: string[]): Record<string, unknown> {
    const res = this.host.engine("orchestrate", "report", "--stage", stage, ...args);
    const out = parseJson(res.stdout);
    if (res.status !== 0 || !out || (out.kind !== "print" && out.kind !== "done")) {
      this.fail(`report ${stage} ${args.join(" ")} was refused (${res.status}): ${clip(res.stdout + res.stderr, 1500)}`);
    }
    return out;
  }

  /** `next`, following load-steering continuations as the skill does. */
  next(...args: string[]): Directive {
    let res = this.host.engine("orchestrate", "next", ...args);
    for (let i = 0; i < 50; i++) {
      const d = parseJson(res.stdout) as Directive | null;
      if (!d) this.fail(`next printed no directive (${res.status}): ${clip(res.stdout + res.stderr, 1200)}`);
      if (d.kind !== "load-steering") {
        this.directives.push(d);
        return d;
      }
      const cont = typeof d.next === "string" ? d.next : null;
      if (!cont) this.fail("load-steering without a continue command", d);
      res = this.host.bash(cont);
    }
    this.fail("load-steering did not end");
  }

  /** The person's first message: a request, perhaps with flags, typed into /aidlc. */
  begin(request: string, flags: string[]): Directive {
    this.host.sessionStart("startup");
    this.person.say(`/aidlc ${[...flags, request].join(" ")}`);
    return this.createFromPrint(this.next(...flags, request));
  }

  /** A print that names `intent create`: create the work with a short label, then `next`. */
  createFromPrint(first: Directive): Directive {
    let d = first;
    for (let i = 0; i < 5 && d.kind === "print"; i++) {
      const message = String(d.message ?? "");
      const create = /`(bun \.claude\/tools\/aidlc\.ts engine intent create [^`]+)`/.exec(message);
      if (!create) break;
      const line = create[1].replace(/--label "[^"]*"/, '--label "scope run"');
      const res = this.host.bash(line);
      if (res.status !== 0) this.fail(`intent create failed: ${clip(res.stdout + res.stderr, 1200)}`, d);
      d = this.next();
    }
    return d;
  }

  /** Drive until the engine says done with nothing more to do. */
  drive(first: Directive): Directive {
    let d = first;
    const seen = new Map<string, number>();
    while (true) {
      if (++this.steps > 600) this.fail("over 600 directives without done", d);
      const key = `${String(d.kind)} ${String(d.stage ?? d.ask_type ?? "")} ${String(d.unit ?? "")} ${JSON.stringify(d.construction_checkpoint ?? d.plan_approval ?? d.gate ?? "")}`;
      const times = (seen.get(key) ?? 0) + 1;
      seen.set(key, times);
      if (times > 3) this.fail(`the same step came back ${times} times without progress`, d);
      switch (d.kind) {
        case "run-stage":
          this.runStage(d);
          break;
        case "ask":
          this.ask(d);
          break;
        case "done":
          if (d.workflow_continues !== true) return d;
          break;
        case "print": {
          // A print mid-run names one command to run exactly as given, then
          // the `next` to run again (for example, unpark then `next --resume`).
          const message = String(d.message ?? "");
          if (/intent create/.test(message)) {
            this.pending = this.createFromPrint(d);
            break;
          }
          if (!/`bun \.claude\/tools\/[^`]+`/.test(message)) this.fail("a print mid-run named no step to take", d);
          this.actOnPrint(d);
          this.pending = /next --resume/.test(message) ? this.next("--resume") : this.next();
          break;
        }
        default:
          this.fail(`no stand-in step for directive kind ${String(d.kind)}`, d);
      }
      d = this.pending ?? this.next();
      this.pending = undefined;
    }
  }

  // --- stages -------------------------------------------------------------

  runStage(d: Directive): void {
    const stage = String(d.stage);
    const unit = typeof d.unit === "string" ? d.unit : null;
    if (!this.started.includes(stage)) this.started.push(stage);
    const policy = d.construction_policy as Record<string, unknown> | undefined;
    if (d.unit_gate) this.fail("a team-owned Unit gate is outside what the scope run drives", d);
    if (d.swarm_checkpoint) this.fail("a swarm checkpoint is outside what the scope run drives", d);
    if (d.construction_checkpoint) {
      this.checkpoint(d);
      return;
    }
    if (policy?.completion_only === true) {
      this.report(stage, "--result", "awaiting-approval");
      this.report(stage, "--result", "approved");
      return;
    }
    if (policy?.offer_autonomy === true) {
      const choice = this.answers.autonomy();
      this.askPerson("autonomy", stage, "How should I continue building the remaining work?",
        ["Continue automatically", "Review each checkpoint"], choice);
      this.must("bolt", "set-autonomy", "--mode", choice === "Continue automatically" ? "autonomous" : "gated");
      return;
    }
    if (d.gate === "unresolved") {
      // The walking-skeleton stance is the agent's reading of the team's
      // practice; the stand-in's practice defers to the scope's own switch.
      this.report(stage, "--skeleton-stance", "scope-dependent");
      return;
    }
    const plan = d.plan_approval as { status?: string } | undefined;
    if (stage === "code-generation" && plan?.status && plan.status !== "approved") {
      this.writeCodePlan(d);
      return;
    }
    const produces = (d.produces as string[] | undefined) ?? [];
    const lead = String(d.lead_agent ?? "aidlc-developer-agent");
    const work = () => {
      // A stage interviews the person through its questions file; a stage that
      // requires summary confirmation has one even when produces does not list it.
      const listed = produces.find((p) => p.endsWith(`${stage}-questions.md`));
      const summaryStage = sourceStage(stage)?.summaryConfirmation === true;
      const questions = listed ?? (summaryStage && produces[0] ? `${dirname(produces[0])}/${stage}-questions.md` : undefined);
      if (questions && stage !== "code-generation") this.askQuestions(d, questions);
      if (stage === "code-generation") this.writeCode(d);
      for (const p of produces) {
        if (p === questions || existsSync(join(this.host.proj, p))) continue;
        this.host.write(p, unitArtifactText(p, this.units) ?? artifactText(p, stage));
      }
      if (stage === "practices-discovery") {
        this.must("state", "practices-event", "--type", "discovered", "--field", "Sources Scanned: none",
          "--field", "Drafts: team-practices.md, discovered-rules.md");
      }
    };
    if (d.gate_only === true) {
      // The gate is re-presented: the body and its review are settled.
      if ((d.protocol_modules as string[] | undefined)?.includes("learnings")) this.learnings(d);
      this.gate(d);
      return;
    }
    this.worked.push(d);
    if (unit) this.must("state", "unit", "start", "--stage", stage, "--unit", unit);
    if (stage === "reverse-engineering") this.reverseEngineering(d);
    else if (d.mode === "subagent") this.host.task(lead, this.handoffPrompt(d), work);
    else work();
    this.contributions(d);
    if (typeof d.reviewer === "string") this.review(d);
    if (unit) {
      this.must("state", "unit", "complete", "--stage", stage, "--unit", unit);
      if (d.gate !== true) return;
    }
    const routine = policy !== undefined && policy.human_completion_required === false;
    if (!routine && (d.protocol_modules as string[] | undefined)?.includes("learnings")) this.learnings(d);
    if (routine && d.gate === true) {
      this.report(stage, "--result", "awaiting-approval");
      this.report(stage, "--result", "approved");
      return;
    }
    this.gate(d);
  }

  /** A Unit or skeleton checkpoint: the person approves the verified, completed Unit. */
  checkpoint(d: Directive): void {
    const cp = d.construction_checkpoint as Record<string, unknown>;
    const stage = String(d.stage);
    const unit = String(cp.unit);
    const kind = String(cp.kind);
    const session = this.host.session;
    if (cp.command_authorized !== true) {
      const { intent, space } = activeRecord(this.host.proj);
      this.host.write(`aidlc/spaces/${space}/intents/${intent}/verification-command.txt`, "bun test test/\n");
      this.must("log", "decision", "--stage", stage, "--checkpoint", "verification-command",
        "--command-file", "verification-command.txt", "--session", session,
        "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes");
      const words = this.answers.verificationCommand();
      this.askPerson("verification command", stage, "Use this command to verify each completed Unit? `bun test test/`",
        ["Approve", "Request Changes"], words);
      this.must("log", "answer", "--stage", stage, "--checkpoint", "verification-command",
        "--command-file", "verification-command.txt", "--session", session, "--details", "Approve");
      this.must("state", "set-construction-verification-command", "--command-file", "verification-command.txt");
      return;
    }
    if (cp.verified !== true) {
      this.must("bolt", "checkpoint", "--action", "verify", "--unit", unit, "--kind", kind);
      return;
    }
    if (cp.ready !== true) this.fail(`checkpoint for ${unit} is not ready: ${clip(JSON.stringify(cp.errors ?? []))}`, d);
    if (cp.human_required === false) {
      this.must("bolt", "checkpoint", "--action", "approve", "--unit", unit, "--kind", kind);
      return;
    }
    if ((d.protocol_modules as string[] | undefined)?.includes("learnings")) this.learnings(d);
    this.must("bolt", "checkpoint", "--action", "ask", "--unit", unit, "--kind", kind, "--session", session);
    const words = this.answers.checkpoint(unit, kind);
    this.askPerson(`${kind} checkpoint`, stage, `Verified with \`bun test test/\` (exit 0). Approve this completed ${unit}?`,
      ["Approve", "Request Changes"], words);
    this.must("bolt", "checkpoint", "--action", "approve", "--unit", unit, "--kind", kind,
      "--session", session, "--user-input", "Approve");
  }

  /**
   * Reverse Engineering's pipeline: snapshot the source, the developer's scan
   * handoff, then the code knowledge base staged, checked and published, with
   * a link receipt for each agent the directive lists.
   */
  reverseEngineering(d: Directive): void {
    const produces = (d.produces as string[] | undefined) ?? [];
    const store = produces[0]?.match(/codekb\/([^/]+)\//);
    if (!store) this.fail("reverse-engineering names no code knowledge base", d);
    const repo = store[1];
    const links = ((d.pipeline as { links?: string[] } | undefined)?.links) ?? ["aidlc-developer-agent"];
    const { intent, space } = activeRecord(this.host.proj);
    const record = `aidlc/spaces/${space}/intents/${intent}`;
    this.host.engine("workspace", "codekb-scope-diff", "--repo", repo);
    const snap = parseJson(this.host.bash(`bun .claude/tools/aidlc-utility.ts codekb-snapshot --repo ${repo} --paths ./ --json`).stdout);
    if (!snap?.source_fingerprint) this.fail("codekb snapshot printed no source fingerprint", d);
    const scan = `${record}/inception/reverse-engineering/developer-scan.md`;
    const synthesise = () => {
      const minted = this.host.engine("workspace", "codekb-scope-diff", "--repo", repo, "--mint", "--paths", "./").stdout.trim();
      const staged = `${record}/.aidlc-engine/codekb-stage-${repo}`;
      for (const p of produces) {
        const name = basename(p);
        this.host.write(`${staged}/${name}`, codekbText(name, intent, minted));
      }
      const check = this.host.engine("workspace", "codekb-scope-diff", "--repo", repo, "--check", `${staged}/reverse-engineering-timestamp.md`);
      if (!/VALID/.test(check.stdout)) this.fail(`staged timestamp is not VALID: ${clip(check.stdout + check.stderr)}`, d);
      this.host.engine("workspace", "codekb", "--repo", repo);
      const published = this.host.bash(
        `bun .claude/tools/aidlc-utility.ts codekb-publish --repo ${repo} --staged ${staged}/ --paths ./ ` +
          `--expect-store ${String(snap.store_generation)} --expect-source ${String(snap.source_fingerprint)} --json`,
      );
      if (published.status !== 0) this.fail(`codekb publish refused: ${clip(published.stdout + published.stderr, 1200)}`, d);
    };
    const [first, ...rest] = links;
    this.host.task(first, "Scan the code", () => {
      this.host.write(scan, DEVELOPER_SCAN);
      if (rest.length === 0) synthesise();
    });
    this.host.bash(`bun .claude/tools/aidlc-log.ts link --stage reverse-engineering --link ${first} --artifact "${scan}"`);
    for (const link of rest) {
      this.host.task(link, "Write the code knowledge base", synthesise);
      this.host.bash(`bun .claude/tools/aidlc-log.ts link --stage reverse-engineering --link ${link}`);
    }
  }

  /**
   * On a subagent or mob stage with collaborators, each support agent is
   * dispatched and writes its contribution file beside the stage's outputs.
   */
  contributions(d: Directive): void {
    const supports = (d.support_agents as string[] | undefined) ?? [];
    const produces = (d.produces as string[] | undefined) ?? [];
    if (supports.length === 0 || (d.mode !== "subagent" && d.mode !== "mob") || !produces[0]) return;
    for (const agent of supports) {
      this.host.task(agent, `Contribute to ${String(d.stage)}`, () =>
        this.host.write(`${dirname(produces[0])}/contributions/${agent}.md`,
          `**Collaborator:** ${agent}\n\n## Contribution\n\n- Reviewed the draft; nothing to add.\n\n## Positions\n\nNone\n`));
    }
  }

  /** Practices Discovery promotes the approved drafts before the approval is reported. */
  promotePractices(d: Directive): void {
    const produces = (d.produces as string[] | undefined) ?? [];
    const team = produces.find((p) => p.endsWith("team-practices.md"));
    const rules = produces.find((p) => p.endsWith("discovered-rules.md"));
    if (!team || !rules) this.fail("practices-discovery names no drafts", d);
    this.must("state", "practices-promote", "--team-practices", team, "--discovered-rules", rules,
      "--affirming-user", "the person");
  }

  askQuestions(d: Directive, questions: string): void {
    const stage = String(d.stage);
    const unit = typeof d.unit === "string" ? ["--unit", d.unit] : [];
    this.host.write(questions, questionsText(stage, ""));
    this.must("log", "decision", "--stage", stage, "--decision", "How would you like to answer the questions?",
      "--options", "Guide me,I'll edit the file,Chat", ...unit);
    const mode = this.askPerson("question mode", stage, "How would you like to answer the questions?",
      ["Guide me", "I'll edit the file", "Chat"], this.answers.questionMode(stage));
    this.must("log", "answer", "--stage", stage, "--details", mode, ...unit);
    this.must("log", "decision", "--stage", stage, "--decision", "Question 1", "--options", "A,B,X", ...unit);
    const answer = this.askPerson("question", stage, "Which option fits?", ["A", "B", "X"], this.answers.question(stage));
    this.host.write(questions, questionsText(stage, answer));
    this.must("log", "answer", "--stage", stage, "--details", answer, ...unit);
    const ceremony = d.ceremony as Record<string, string> | undefined;
    if (ceremony?.summary_confirmation === "on" && sourceStage(stage)?.summaryConfirmation) {
      this.host.write(questions, questionsText(stage, answer, ""));
      this.must("log", "decision", "--stage", stage, "--checkpoint", "summary-confirmation",
        "--questions-file", questions, "--decision", "Does this all look correct before I generate the artifact?",
        "--options", "Looks correct,Request changes", ...unit);
      const words = this.answers.summary(stage);
      this.askPerson("summary confirmation", stage, "Does this all look correct before I generate the artifact?",
        ["Looks correct", "Request changes"], words);
      this.host.write(questions, questionsText(stage, answer, "Looks correct"));
      this.must("log", "answer", "--stage", stage, "--checkpoint", "summary-confirmation",
        "--questions-file", questions, "--details", "Looks correct", ...unit);
    }
  }

  review(d: Directive): void {
    const stage = String(d.stage);
    const reviewer = String(d.reviewer);
    const unit = typeof d.unit === "string" ? ["--unit", d.unit] : [];
    const request = this.must("log", "review", "--stage", stage, "--reviewer", reviewer, "--iteration", "1", ...unit);
    const file = typeof request.reviewFile === "string" ? request.reviewFile : null;
    if (!file) this.fail("review request named no review file", d);
    this.host.task(reviewer, `Review ${stage}`, () => this.host.write(file, reviewText(reviewer)));
    this.must("log", "review", "--stage", stage, "--reviewer", reviewer, "--iteration", "1", "--verdict", "READY", ...unit);
  }

  learnings(d: Directive): void {
    const stage = String(d.stage);
    const unit = typeof d.unit === "string" ? ["--unit", d.unit] : [];
    this.must("learnings", "surface", "--slug", stage);
    this.must("log", "decision", "--stage", stage, "--decision", "Anything to add for next time?",
      "--options", "Nothing to add,Add a note", ...unit);
    const words = this.answers.learnings(stage);
    this.askPerson("learnings", stage, "Anything to add for next time?", ["Nothing to add", "Add a note"], words);
    this.must("log", "answer", "--stage", stage, "--details", "Nothing to add", ...unit);
  }

  gate(d: Directive): void {
    const stage = String(d.stage);
    if (d.gate !== true) {
      this.report(stage, "--result", "completed");
      return;
    }
    if (d.gate_only !== true) this.report(stage, "--result", "awaiting-approval");
    if (this.answers.stopAt?.(stage) && !this.stopped.has(stage)) {
      this.stopped.add(stage);
      this.person.say("let's stop here for today");
      const parked = this.must("orchestrate", "park");
      this.parks.push(parked as Directive);
      this.host.newSession();
      this.pending = this.personTypes("/aidlc --resume");
      return;
    }
    const words = this.answers.approve(stage, typeof d.unit === "string" ? d.unit : null);
    const choice = this.askPerson("approval", stage, `${stage} is ready for your review. How would you like to proceed?`,
      ["Approve", "Request Changes"], words);
    if (choice !== "Approve") this.fail(`the person chose ${choice} at ${stage}; the scope run only approves`, d);
    if (stage === "practices-discovery") this.promotePractices(d);
    this.report(stage, "--result", "approved", "--user-input", choice);
    this.pending = this.afterApproval?.(stage, this);
  }

  // --- code generation ----------------------------------------------------

  writeCodePlan(d: Directive): void {
    const produces = (d.produces as string[] | undefined) ?? [];
    const planPath = produces.find((p) => p.endsWith("code-generation-plan.md"));
    const tests = produces.find((p) => p.endsWith("unit-test-instructions.md"));
    if (!planPath || !tests) this.fail("code-generation names no plan or test instructions", d);
    const contract = this.host.bash("bun .claude/tools/aidlc-testing-posture.ts render");
    if (contract.status !== 0) this.fail(`testing posture render failed: ${clip(contract.stderr)}`, d);
    this.host.write(planPath, codePlanText(contract.stdout));
    const name = typeof d.unit === "string" ? d.unit : "scope-run";
    this.host.write(tests, `# Unit Test Instructions\n\n- Run: \`bun test test/${name}.test.ts\`\n`);
  }

  /** The brief a subagent gets: Code Generation's developer gets the testing-posture brief, verbatim. */
  handoffPrompt(d: Directive): string {
    if (d.stage !== "code-generation") return `Run ${String(d.stage)}`;
    const unit = typeof d.unit === "string" ? d.unit : null;
    const brief = this.host.bash(unit
      ? `bun .claude/tools/aidlc-testing-posture.ts brief --unit ${unit}`
      : "bun .claude/tools/aidlc-testing-posture.ts brief --stage-level");
    if (brief.status !== 0) this.fail(`testing posture brief failed: ${clip(brief.stdout + brief.stderr)}`, d);
    return brief.stdout;
  }

  writeCode(d: Directive): void {
    const produces = (d.produces as string[] | undefined) ?? [];
    const unit = typeof d.unit === "string" ? d.unit : null;
    const name = unit ?? "scope-run";
    const source = `src/${name}.ts`;
    const test = `test/${name}.test.ts`;
    this.host.write(source, `export const ${camel(name)} = (): number => 42;\n`);
    this.host.write(
      test,
      `import { expect, test } from "bun:test";\nimport { ${camel(name)} } from "../${source}";\n\ntest("${name}", () => expect(${camel(name)}()).toBe(42));\n`,
    );
    const summary = produces.find((p) => p.endsWith("code-summary.md"));
    const trace = produces.find((p) => p.endsWith("traceability.json"));
    if (summary) this.host.write(summary, `# Code Summary\n\n## Files\n\n- ${source} (created)\n- ${test} (created)\n`);
    if (trace) {
      this.host.write(trace, `${JSON.stringify({
        stage: "code-generation",
        upstream_ids: ["FR1"],
        coverage: [{ id: "FR1", status: "OK", target: source }],
      }, null, 2)}\n`);
    }
    if (unit) {
      const { intent, space } = activeRecord(this.host.proj);
      this.host.write(
        `aidlc/spaces/${space}/intents/${intent}/construction/${unit}/code-generation/source-manifest.json`,
        `${JSON.stringify({ stage: "code-generation", unit, version: 1, writes: [{ path: source }, { path: test }] }, null, 2)}\n`,
      );
    }
  }

  // --- asks ---------------------------------------------------------------

  ask(d: Directive): void {
    const type = String(d.ask_type ?? "");
    if (type === "plan-approval") {
      const unit = typeof d.unit === "string" ? d.unit : null;
      const question = String(d.question ?? d.prompt ?? "Approve the code plan?");
      const offered = ((d.options as { label?: string }[] | undefined) ?? []).map((o) => String(o.label ?? o));
      this.askPerson("plan approval", "code-generation", question,
        offered.length ? offered : ["Approve Plan", "Request Changes"], this.answers.plan(unit));
      return;
    }
    if (type === "new-work-routing" && this.answers.newWork) {
      const description = String(d.new_work_description ?? "");
      const words = this.answers.newWork(description);
      const choice = this.askPerson("new work", String(d.stage ?? ""), String(d.question ?? ""),
        ["Part of the active work", "Separate new piece of work", "Reshape the active work"], words);
      if (choice !== "Separate new piece of work") this.fail(`the scope run only starts new work here, read ${choice}`, d);
      const scopes = (d.scope_commands as { scope: string; command: string }[] | undefined) ?? [];
      const named = scopes.find((c) => new RegExp(`\\b${c.scope}\\b`, "i").test(words));
      const command = named?.command ?? String(d.new_intent_command ?? "");
      const res = this.host.bash(command);
      const out = parseJson(res.stdout) as Directive | null;
      if (!out) this.fail(`${command} printed no directive: ${clip(res.stdout + res.stderr)}`, d);
      this.pending = this.createFromPrint(out);
      return;
    }
    this.fail(`no person answer for ask ${type}`, d);
  }
}

const camel = (name: string) => name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function sourceStage(slug: string): SourceStage | undefined {
  return sourceStages().find((s) => s.slug === slug);
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

/** Artifacts whose shape a later tool reads; every other one gets the generic text. */
const SHAPED_ARTIFACTS: Record<string, string> = {
  "team-practices.md": `# Team Practices

## Way of Working

- Trunk-based development with short-lived branches.

## Walking Skeleton

- Scope-dependent: follow the scope's walking-skeleton setting.

## Testing Posture

- **Methodology**: test-after
- **Ordering**: implement each testable layer, then write and run its tests.

## Deployment

- Deploy from main after the build passes.

## Code Style

- Follow the project's formatter.
`,
  "discovered-rules.md": "# Discovered Rules\n\n## Mandated\n\n- ALWAYS keep the test suite green.\n\n## Forbidden\n\n- NEVER commit secrets.\n",
  "practices-discovery-timestamp.md": "Discovered: 2026-01-01T00:00:00Z at commit 0000000\n",
};

/** Units Generation's three Unit files, written from the stand-in's Unit list. */
function unitArtifactText(path: string, units: string[]): string | null {
  const name = path.split("/").pop() ?? path;
  const rows = units.map((u, i) => ({ id: `U${i + 1}`, dir: `u${i + 1}-${u}`, name: u }));
  if (name === "unit-of-work.md") {
    return "# Units of Work\n\n## Units\n\n| Unit ID | Directory | Name | Kind | Responsibility |\n|---|---|---|---|---|\n" +
      rows.map((r) => `| ${r.id} | ${r.dir} | ${r.name} | library | ${r.name} code |`).join("\n") + "\n";
  }
  if (name === "unit-of-work-dependency.md") {
    return "# Unit Dependencies\n\n## Dependency DAG\n\n" +
      rows.map((r, i) => `- ${r.name}${i > 0 ? ` depends on ${rows[i - 1].name}` : " depends on nothing"}`).join("\n") +
      "\n\n```yaml\nunits:\n" +
      rows.map((r, i) => `  - name: ${r.name}\n    kind: library\n    depends_on: [${i > 0 ? rows[i - 1].name : ""}]`).join("\n") +
      "\n```\n";
  }
  if (name === "unit-of-work-story-map.md") {
    return "# Story Map\n\n## Map\n\n| Item | Unit ID | Directory |\n|---|---|---|\n" +
      rows.map((r, i) => `| FR${i + 1} | ${r.id} | ${r.dir} |`).join("\n") + "\n";
  }
  return null;
}

function artifactText(path: string, stage: string): string {
  const name = path.split("/").pop() ?? path;
  if (SHAPED_ARTIFACTS[name]) return SHAPED_ARTIFACTS[name];
  if (name.endsWith(".json")) return "{}\n";
  return `# ${name.replace(/\.md$/, "")}\n\n## Overview\n\nWritten by the scope run for ${stage}.\n\n## Details\n\n- Covers FR1.\n`;
}

function questionsText(stage: string, answer: string, summary?: string): string {
  let text = `# ${stage} questions\n\n## Question 1\n\nWhich option fits?\n\nA. The first option\nB. The second option\nX. Other (please specify)\n\n[Answer]: ${answer}\n`;
  if (summary !== undefined) {
    text += `\n## Consolidated Summary Confirmation\n\nDoes this all look correct before I generate the artifact?\n\n- Looks correct\n- Request changes\n\n[Answer]: ${summary}\n`;
  }
  return text;
}

const DEVELOPER_SCAN = `# Developer Scan

## Developer Code Scan Results

### Scan Coverage
- **Analyzed deeply**: ./
- **Skimmed only**: none
- **Left out**: none

### Packages Found
- app - TypeScript - the project's source

## Handoff Summary

- The project's source lives under src/.
`;

function codekbText(name: string, intent: string, fingerprint: string): string {
  const title = name.replace(/\.md$/, "");
  if (name === "reverse-engineering-timestamp.md") {
    return `# Reverse Engineering Timestamp\n\n## Run Record\n\n- Date: 2026-01-01\n\n## Scope of Analysis\n\n` +
      "```yaml\n" +
      `scope_version: 1\nkind: full\nintent: ${intent}\nfingerprint: ${fingerprint}\nanalyzed:\n  paths:\n    - ./\n  components:\n    - app\nshallow:\n  paths: []\n` +
      "```\n";
  }
  let text = `# ${title}\n\n## Overview\n\nThe project's source lives under src/.\n\n## Details\n\n- One application component.\n`;
  if (name === "architecture.md") text += "\n## Interaction Diagrams\n\n```mermaid\nflowchart LR\n  user --> app\n```\n";
  if (name === "component-inventory.md") text += "\n## app\n\n- the application\n";
  return text;
}

function reviewText(reviewer: string): string {
  return `## Review\n\n**Verdict:** READY\n**Reviewer:** ${reviewer}\n**Date:** 2026-01-01T00:00:00Z\n**Iteration:** 1\n\n### Findings\n\n**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n### Summary\n\nReady.\n`;
}

function codePlanText(contract: string): string {
  return `# Code Generation Plan\n\n## Summary\n\n- Builds: one function and its test\n- Touches: src/scope-run.ts, test/scope-run.test.ts\n- Tests: 1 unit test\n\n## Steps\n\n- [ ] Step 1: Write src/scope-run.ts (FR1)\n- [ ] Step 2: Write and run test/scope-run.test.ts (FR1)\n\n${contract.trim()}\n`;
}

/** The active intent's record dir and state file. */
export function activeRecord(proj: string): { space: string; intent: string; dir: string; state: string } {
  const spaceFile = join(proj, "aidlc", "active-space");
  const space = existsSync(spaceFile) ? readFileSync(spaceFile, "utf-8").trim() || "default" : "default";
  const intents = join(proj, "aidlc", "spaces", space, "intents");
  const intent = readFileSync(join(intents, "active-intent"), "utf-8").trim();
  const dir = join(intents, intent);
  return { space, intent, dir, state: join(dir, "aidlc-state.md") };
}

export function auditEvents(proj: string): AuditShardEvent[] {
  const { space, intent } = activeRecord(proj);
  return lib().readAuditShardEvents(proj, intent, space);
}

export { RECORD_PREFIX };

// ---------------------------------------------------------------------------
// One scope run, and what it must show
// ---------------------------------------------------------------------------

export interface ScopeRunOptions extends StandInOptions {
  /** The project the person brings; defaults to code for existing_code scopes. */
  shape?: "code" | "empty";
  /** Flags typed with the request, after `--scope <scope>`. */
  flags?: string[];
  request?: string;
}

export interface ScopeRun {
  scope: string;
  declared: DeclaredScope;
  shape: "code" | "empty";
  proj: string;
  host: ScopeHost;
  person: PersonScript;
  agent: AgentStandIn;
  final: Directive;
  ms: number;
}

/** Drive one shipped scope from the person's first request to done. */
export function runScope(scope: string, options: ScopeRunOptions = {}): ScopeRun {
  const declared = declaredScope(scope);
  const shape = options.shape ?? (declared.existingCode ? "code" : "empty");
  const { proj, host } = createScopeProject(shape);
  const person = new PersonScript(host);
  const agent = new AgentStandIn(host, person, options);
  const started = Date.now();
  const first = agent.begin(options.request ?? `build the ${scope} work`, ["--scope", scope, ...(options.flags ?? [])]);
  const final = agent.drive(first);
  return { scope, declared, shape, proj, host, person, agent, final, ms: Date.now() - started };
}

/**
 * Hand-offs the shared Stop hook is known to block today. Each one has a
 * test.todo named after it; the fix that lets the turn end removes it here.
 */
export const KNOWN_STOP_BLOCKS: readonly string[] = ["autonomy"];

const STATE_LINE = /^- \[(.)\] ([a-z0-9-]+) \u2014 (EXECUTE|SKIP)/;

function stateField(text: string, name: string): string | null {
  const m = new RegExp(`^- \\*\\*${name}\\*\\*: ?(.*)$`, "m").exec(text);
  return m ? m[1].trim() : null;
}

const onOff = (on: boolean) => (on ? "on" : "off");

/**
 * Everything the run must show, read from state, audit records, directives and
 * files. Returns the problems; an empty list is a pass.
 */
export interface ProblemOptions {
  /** The stages that should have run, when a person move changed the plan. */
  stages?: string[];
  /** Stages that ran before a person move took them out of the plan. */
  ranBefore?: string[];
  /** Switch checks a person move changed on purpose; the caller checks those itself. */
  skip?: Array<"learnings" | "switches">;
}

export function scopeRunProblems(run: ScopeRun, options: ProblemOptions = {}): string[] {
  const problems: string[] = [];
  const skip = new Set(options.skip ?? []);
  const { agent, person, proj } = run;
  const record = activeRecord(proj);
  const state = readFileSync(record.state, "utf-8");
  const events = auditEvents(proj);
  const count = (event: string) => events.filter((e) => e.event === event).length;
  const runStages = agent.directives.filter((d) => d.kind === "run-stage");

  // 1. The stages that ran, and the ones skipped, are the scope's.
  const expected = options.stages ?? expectedStages(run.scope, run.shape === "code");
  const lines = state.split(/\r?\n/).map((l) => STATE_LINE.exec(l)).filter((m): m is RegExpExecArray => m !== null);
  const ticked = lines.filter((m) => m[1] === "x" && m[3] === "EXECUTE").map((m) => m[2]);
  const skipped = lines.filter((m) => m[3] === "SKIP").map((m) => m[2]);
  if (JSON.stringify(ticked) !== JSON.stringify(expected)) {
    problems.push(`stages done ${JSON.stringify(ticked)}, the scope runs ${JSON.stringify(expected)}`);
  }
  const all = sourceStages().map((s) => s.slug);
  const notRun = all.filter((s) => !expected.includes(s));
  if (JSON.stringify(skipped) !== JSON.stringify(notRun)) {
    problems.push(`stages skipped ${JSON.stringify(skipped)}, the scope skips ${JSON.stringify(notRun)}`);
  }
  const startedEvents = new Set(events.filter((e) => e.event === "STAGE_STARTED").map((e) => field(e.block, "Stage")));
  for (const s of notRun) {
    if (startedEvents.has(s) && !(options.ranBefore ?? []).includes(s)) problems.push(`${s} was started but the scope skips it`);
  }

  // 2. Every decision recorded as the person's came from the person.
  for (const line of person.ledger.unbacked()) problems.push(line);
  for (const e of events.filter((e) => e.event === "GATE_APPROVED")) {
    const reply = field(e.block, "Person Reply");
    if (reply !== null && !person.said.includes(reply)) {
      problems.push(`GATE_APPROVED ${field(e.block, "Stage")} records ${JSON.stringify(reply)}, which the person never sent`);
    }
  }
  for (const h of agent.handoffs) {
    if (h.blocked && !KNOWN_STOP_BLOCKS.includes(h.what)) {
      problems.push(`the turn could not end at the ${h.what} question for ${h.stage}: ${clip(h.reason, 300)}`);
    }
  }
  for (const r of run.host.refusals) problems.push(`a guard refused a step the engine directed: ${r}`);

  // 3. The scope's switches, as declared.
  if (!skip.has("switches")) problems.push(...switchProblems(run, expected, skip.has("learnings"), runStages, state, count));

  // 4. A clean done, with the files on disk.
  if (run.final.kind !== "done" || run.final.workflow_continues === true) problems.push(`the run ended on ${JSON.stringify(run.final).slice(0, 200)}`);
  if (count("WORKFLOW_COMPLETED") !== 1) problems.push(`WORKFLOW_COMPLETED recorded ${count("WORKFLOW_COMPLETED")} times`);
  if (stateField(state, "Status") !== "Completed") problems.push(`state Status is ${JSON.stringify(stateField(state, "Status"))}`);
  for (const d of agent.worked) {
    for (const p of (d.produces as string[] | undefined) ?? []) {
      if (!existsSync(join(proj, p))) problems.push(`${String(d.stage)} output ${p} is not on disk`);
    }
  }
  if (expected.includes("code-generation")) {
    for (const unit of expected.includes("units-generation") ? agent.units : ["scope-run"]) {
      if (!existsSync(join(proj, "src", `${unit}.ts`))) problems.push(`the code for ${unit} is not at the project root`);
    }
  }
  return problems;
}

/** A whole scope run takes minutes, and several times longer on Windows. */
export const SCOPE_RUN_TIMEOUT_MS = 60 * 60_000;

/** The test a scope-run file declares: one run, every check. */
export function scopeRunSuite(scope: string, options: ScopeRunOptions = {}): void {
  describe(`the ${scope} scope, from the person's first request to done`, () => {
    afterAll(() => {
      while (projects.length > 0) cleanupTestProject(projects.pop());
    });
    test("runs its stages, asks the person at every gate, keeps its switches, and ends done", () => {
      const run = runScope(scope, options);
      const problems = scopeRunProblems(run);
      console.log(`scope run ${scope}: ${run.ms} ms, ${run.host.calls.length} calls, ${run.person.said.length} person turns`);
      expect(problems).toEqual([]);
    }, SCOPE_RUN_TIMEOUT_MS);
  });
}

/** The shipped scopes that have their own t-scope-run-<scope> file. */
export function scopesWithOwnFile(): string[] {
  const dir = join(REPO_ROOT, "tests", "integration");
  return readdirSync(dir)
    .map((f) => /^t-scope-run-(.+)\.test\.ts$/.exec(f)?.[1])
    .filter((s): s is string => s !== undefined && shippedScopes().includes(s));
}

function switchProblems(
  run: ScopeRun,
  expected: string[],
  skipLearnings: boolean,
  runStages: Directive[],
  state: string,
  count: (event: string) => number,
): string[] {
  const problems: string[] = [];
  const { declared, agent } = run;
  const want: Record<string, string> = {
    Depth: declared.depth,
    "Test Strategy": declared.testStrategy,
    "Guard Policy": `${declared.guardPolicy} (from scope ${run.scope})`,
    Sensors: `${onOff(declared.sensors)} (from scope ${run.scope})`,
    ...(skipLearnings ? {} : { Learnings: `${onOff(declared.learnings)} (from scope ${run.scope})` }),
    "Summary Confirmation": `${onOff(declared.summaryConfirmation)} (from scope ${run.scope})`,
    "Plan Approval": `${onOff(declared.planApproval)} (from scope ${run.scope})`,
    Collaborators: `${onOff(declared.collaborators)} (from scope ${run.scope})`,
  };
  for (const [name, value] of Object.entries(want)) {
    const got = stateField(state, name);
    if (got !== value) problems.push(`state ${name} is ${JSON.stringify(got)}, the scope declares ${JSON.stringify(value)}`);
  }
  const ceremony: Record<string, string> = {
    sensors: onOff(declared.sensors),
    learnings: onOff(declared.learnings),
    summary_confirmation: onOff(declared.summaryConfirmation),
    plan_approval: onOff(declared.planApproval),
    collaborators: onOff(declared.collaborators),
  };
  if (skipLearnings) delete ceremony.learnings;
  for (const d of runStages) {
    const got = { ...(d.ceremony as Record<string, string> | undefined) };
    if (skipLearnings) delete got.learnings;
    if (d.ceremony && JSON.stringify(got) !== JSON.stringify(ceremony)) {
      problems.push(`${String(d.stage)} carried ceremony ${JSON.stringify(got)}, the scope declares ${JSON.stringify(ceremony)}`);
    }
  }
  const has = (pred: (d: Directive) => boolean) => runStages.some(pred);
  const sensorRows = count("SENSOR_FIRED");
  if (declared.sensors && sensorRows === 0) problems.push("sensors are on but no sensor fired");
  if (!declared.sensors && sensorRows > 0) problems.push(`sensors are off but ${sensorRows} fired`);
  const learnings = has((d) => ((d.protocol_modules as string[] | undefined) ?? []).includes("learnings"));
  if (!skipLearnings && declared.learnings !== learnings) problems.push(`learnings ${onOff(declared.learnings)}, but stages ${learnings ? "asked" : "never asked"} for them`);
  const summaryStages = expected.filter((s) => sourceStage(s)?.summaryConfirmation);
  const summaries = count("SUMMARY_CONFIRMATION_RECORDED");
  if (declared.summaryConfirmation && summaryStages.length > 0 && summaries === 0) problems.push("summary confirmation is on but none was recorded");
  if (!declared.summaryConfirmation && summaries > 0) problems.push(`summary confirmation is off but ${summaries} were recorded`);
  if (expected.includes("code-generation")) {
    const asked = count("PLAN_APPROVAL_RECORDED");
    const skippedPlan = count("PLAN_APPROVAL_SKIPPED");
    if (declared.planApproval && (asked === 0 || skippedPlan > 0)) problems.push(`plan approval is on: ${asked} recorded, ${skippedPlan} skipped`);
    if (!declared.planApproval && (asked > 0 || skippedPlan === 0)) problems.push(`plan approval is off: ${asked} recorded, ${skippedPlan} skipped`);
  }
  const supported = has((d) => ((d.support_agents as string[] | undefined) ?? []).length > 0);
  if (declared.collaborators !== supported) problems.push(`collaborators ${onOff(declared.collaborators)}, but support agents ${supported ? "were" : "were never"} brought in`);
  if (expected.includes("units-generation") && expected.includes("code-generation")) {
    const skeleton = agent.directives.some((d) => (d.construction_checkpoint as { kind?: string } | undefined)?.kind === "skeleton");
    if (declared.skeleton !== skeleton) problems.push(`skeleton ${onOff(declared.skeleton)}, but a skeleton checkpoint ${skeleton ? "was" : "was never"} asked`);
  }
  for (const d of runStages.filter((d) => typeof d.reviewer === "string")) {
    if (declared.reviewCap === "none") problems.push(`review_cap none, but ${String(d.stage)} named a reviewer`);
    if (declared.reviewCap === "advisory" && d.reviewer_max_iterations !== 1) {
      problems.push(`review_cap advisory, but ${String(d.stage)} allows ${String(d.reviewer_max_iterations)} review passes`);
    }
  }
  return problems;
}
