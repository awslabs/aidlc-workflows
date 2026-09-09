// Agent Client Protocol (ACP) client for the review daemon.
//
// The daemon drives one agent process per intent over ACP - JSON-RPC 2.0,
// newline-delimited, on the agent's stdio (https://agentclientprotocol.com).
// This module is the transport and the protocol handshake; what to do with the
// agent's questions is the run manager's business (aidlc-review-ui-runs.ts).
//
// Two inbound requests are answered here through caller-supplied bridges:
//   - `session/request_permission` — a tool call the agent wants approved
//     (every tool decision that the harness's own allow rules do not settle).
//   - `elicitation/create` (form mode) — the agent's structured question to the
//     human; for Claude this is how the built-in AskUserQuestion tool reaches
//     us, so the protocol's gates and confirmations can be answered from the
//     browser.
// Every OTHER inbound request is answered with JSON-RPC -32601. That reply is
// not optional: an unanswered request leaves the agent blocked forever on it,
// and the turn never ends (the review of Kiro Crew's client found exactly this
// hang). Notifications (`session/update`) stream to the caller's listener.
//
// Backend differences are confined to the profile table (`ACP_BACKENDS`): how
// each harness's agent is launched, what its first prompt is, and which
// extension requests (beyond the two standard ones) it asks the human with.
// Every harness the framework ships to speaks ACP - Kiro CLI, Cursor, opencode,
// and Copilot natively, Claude and Codex through their published adapters - so
// adding one is a profile row, not a branch elsewhere.

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ACP_PROTOCOL_VERSION = 1;
// Handshake steps must answer within this window; the Claude adapter's first
// `session/new` starts the SDK (about 6 s here) and a cold `bunx` fetch can add
// tens of seconds, so the bound is generous. A prompt turn has no bound of its
// own: the run manager owns turn ceilings.
export const ACP_HANDSHAKE_TIMEOUT_MS = 180_000;
// Pinned so an install does not silently move to a newer adapter with a
// different wire behaviour; bump deliberately with a test run.
export const CLAUDE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp@0.75.1";
export const CODEX_ACP_PACKAGE = "@agentclientprotocol/codex-acp@1.10.0";
export const ENV_ACP_CLAUDE_COMMAND = "AIDLC_ACP_CLAUDE_COMMAND";

export type AcpBackend = "claude" | "kiro" | "codex" | "cursor" | "opencode" | "copilot";

/** The session-level reasoning effort a run may pin (the harness's own dial). */
export const SESSION_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type SessionEffort = (typeof SESSION_EFFORT_LEVELS)[number];

/** One model the agent offers (ACP `session/new` `models.availableModels`). */
export interface AcpModelChoice {
  id: string;
  name: string;
  description: string | null;
}

function parseModelChoices(value: unknown): AcpModelChoice[] | null {
  const list = (value as { availableModels?: unknown } | null)?.availableModels;
  if (!Array.isArray(list)) return null;
  const choices: AcpModelChoice[] = [];
  for (const entry of list) {
    const record = entry as { modelId?: unknown; name?: unknown; description?: unknown };
    if (typeof record?.modelId !== "string" || !record.modelId) continue;
    choices.push({ id: record.modelId, name: typeof record.name === "string" && record.name ? record.name : record.modelId, description: typeof record.description === "string" ? record.description : null });
  }
  return choices;
}

/** How a backend takes a session effort: an ACP config option after `session/new`, a launch flag, or not at all. */
export type EffortControl = { kind: "config"; configId: string } | { kind: "flag"; flag: string };

/** What a session runs at when Start pins nothing: the level and the file that says so. */
export interface DefaultSessionEffort {
  level: string;
  /** Where the default comes from, as a human would name it (a settings path). */
  source: string;
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** What a session uses when Start pins nothing: a setting's value and the file that says so. */
export interface DefaultSessionSetting {
  value: string;
  source: string;
}

/**
 * A Claude setting as the session will see it: local over project over user -
 * the same precedence the adapter's `--setting-sources user,project,local`
 * gives the CLI. Null when no settings file names it.
 */
function claudeSetting(projectDir: string, key: string, home: string): DefaultSessionSetting | null {
  const candidates: Array<[string, string]> = [
    [join(projectDir, ".claude", "settings.local.json"), ".claude/settings.local.json"],
    [join(projectDir, ".claude", "settings.json"), ".claude/settings.json"],
    [join(home, ".claude", "settings.json"), "~/.claude/settings.json"],
  ];
  for (const [path, source] of candidates) {
    const value = readJsonFile(path)?.[key];
    if (typeof value === "string" && value) return { value, source };
  }
  return null;
}

/** Claude's session effort when nothing pins it (`effortLevel`); null = the model's own default. */
export function claudeDefaultSessionEffort(projectDir: string, home: string = homedir()): DefaultSessionEffort | null {
  const setting = claudeSetting(projectDir, "effortLevel", home);
  return setting ? { level: setting.value, source: setting.source } : null;
}

/** Claude's session model when Start pins nothing (`model`: an alias or a model id); null = the harness's default. */
export function claudeDefaultSessionModel(projectDir: string, home: string = homedir()): DefaultSessionSetting | null {
  return claudeSetting(projectDir, "model", home);
}

/**
 * Set (or, with null, remove) Claude's personal default effort: the `effortLevel`
 * key of `.claude/settings.local.json` - the file the harness itself reads first,
 * so a terminal `/effort` and this agree. Every other key is kept as it was.
 *
 * Claude Code writes this file too (permission grants), and there is no lock
 * both writers honour, so this is NOT race-free: the merge is re-based if the
 * file changed while it was computed, but a write landing between that check
 * and the rename is overwritten. The exposure is one grant saved in that
 * instant, which Claude then asks for again; the key this writes is never
 * lost because the human sees the result immediately. Throws when the file
 * exists but is not a JSON object.
 */
export function writeClaudeDefaultSessionEffort(projectDir: string, level: SessionEffort | null): DefaultSessionEffort | null {
  writeClaudeLocalSetting(projectDir, "effortLevel", level);
  return claudeDefaultSessionEffort(projectDir);
}

/** Set (or, with null, remove) Claude's personal default model - the `model` key, same file and caveats as the effort. */
export function writeClaudeDefaultSessionModel(projectDir: string, model: string | null): DefaultSessionSetting | null {
  writeClaudeLocalSetting(projectDir, "model", model);
  return claudeDefaultSessionModel(projectDir);
}

function writeClaudeLocalSetting(projectDir: string, key: string, value: string | null): void {
  const path = join(projectDir, ".claude", "settings.local.json");
  // Re-base guard, not a CAS (a pathname cannot be swapped atomically against
  // a check): if the file changed while the merge was computed, start over.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = existsSync(path) ? readFileSync(path, "utf-8") : null;
    let settings: Record<string, unknown> = {};
    if (before !== null) {
      const parsed: unknown = JSON.parse(before);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(".claude/settings.local.json is not a JSON object");
      settings = parsed as Record<string, unknown>;
    }
    if (value === null) delete settings[key];
    else settings[key] = value;
    const tmp = `${path}.${process.pid}.${attempt}.tmp`;
    const fd = openSync(tmp, "wx");
    try {
      writeFileSync(fd, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
    } finally {
      closeSync(fd);
    }
    const now = existsSync(path) ? readFileSync(path, "utf-8") : null;
    if (now !== before) {
      unlinkSync(tmp);
      continue;
    }
    try {
      renameSync(tmp, path);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* the rename failed; nothing of ours to keep */ }
      throw error;
    }
    return;
  }
  throw new Error(".claude/settings.local.json kept changing underneath; try again");
}

/**
 * Kiro's session effort when `--effort` is not passed: the `output_config.effort`
 * of `chat.modelDefaults` in the project's `.kiro/settings/cli.json`, when the
 * defaults name exactly one model (the shipped file does). Null otherwise.
 */
export function kiroDefaultSessionEffort(projectDir: string): DefaultSessionEffort | null {
  const settings = readJsonFile(join(projectDir, ".kiro", "settings", "cli.json"));
  const defaults = settings?.["chat.modelDefaults"];
  if (!defaults || typeof defaults !== "object") return null;
  const levels = new Set<string>();
  for (const entry of Object.values(defaults as Record<string, unknown>)) {
    const effort = (entry as { output_config?: { effort?: unknown } } | null)?.output_config?.effort;
    if (typeof effort === "string" && effort) levels.add(effort);
  }
  return levels.size === 1 ? { level: [...levels][0], source: ".kiro/settings/cli.json" } : null;
}

export interface AcpLaunch {
  backend: AcpBackend;
  command: string[];
  env: Record<string, string>;
  /** The prompt a human would type to start or resume the workflow in this harness. */
  startPrompt: string;
  /** How this backend takes a session effort, when it does. */
  effort?: EffortControl;
  /** What a session runs at when Start pins nothing, or null when the harness's own model default applies. */
  defaultEffort?(projectDir: string): DefaultSessionEffort | null;
  /** Change that default in the harness's own settings, when the file's shape is ours to write. */
  setDefaultEffort?(projectDir: string, level: SessionEffort | null): DefaultSessionEffort | null;
  /** The session's default model from the harness's settings; null = the harness decides. */
  defaultModel?(projectDir: string): DefaultSessionSetting | null;
  /** Change that default model in the harness's own settings, when the file's shape is ours to write. */
  setDefaultModel?(projectDir: string, model: string | null): DefaultSessionSetting | null;
}

export interface AcpBackendProfile {
  backend: AcpBackend;
  /** `harness.json` names this profile serves. */
  harnesses: readonly string[];
  /** `AIDLC_ACP_<BACKEND>_COMMAND`: a whitespace-split command line that replaces resolution. */
  envCommand: string;
  startPrompt: string;
  /** Null when the harness is not usable on this machine; the reason is shown to the human. */
  resolve(env: NodeJS.ProcessEnv, which: (name: string) => string | null, vendored: string | null): { command: string[]; env: Record<string, string> } | null;
  /** What is missing when `resolve` returns null. */
  requirement: string;
  /** The published adapter package (pinned) when the agent is not the harness CLI itself. */
  vendorPackage?: string;
  /** The adapter's bin name under node_modules/.bin. */
  vendorBin?: string;
  /** How this backend takes a session effort; absent when it has no such dial over ACP. */
  effort?: EffortControl;
  /** The session effort when nothing is pinned, read from the harness's settings; null = its model default. */
  defaultEffort?(projectDir: string): DefaultSessionEffort | null;
  /** Writes that default into the harness's settings; absent when the browser does not own that file's shape. */
  setDefaultEffort?(projectDir: string, level: SessionEffort | null): DefaultSessionEffort | null;
  defaultModel?(projectDir: string): DefaultSessionSetting | null;
  setDefaultModel?(projectDir: string, model: string | null): DefaultSessionSetting | null;
}

/** `<toolsDir>/vendor/acp`: where `vendor-agent` installs the pinned adapter. */
export function vendorAcpDir(toolsDir: string): string {
  return join(toolsDir, "vendor", "acp");
}

export function splitPinned(spec: string): [string, string] {
  const at = spec.lastIndexOf("@");
  return at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, "latest"];
}

/** The vendored adapter's executable when `vendor-agent` has run for this profile. */
export function vendoredAcpBin(toolsDir: string, profile: AcpBackendProfile): string | null {
  if (!profile.vendorBin) return null;
  const bin = join(vendorAcpDir(toolsDir), "node_modules", ".bin", profile.vendorBin);
  return existsSync(bin) ? bin : null;
}

function bunx(which: (name: string) => string | null): string {
  return which("bunx") ?? "bunx";
}

export const ACP_BACKENDS: readonly AcpBackendProfile[] = [
  {
    backend: "claude",
    harnesses: ["claude"],
    envCommand: ENV_ACP_CLAUDE_COMMAND,
    startPrompt: "/aidlc",
    requirement: "the `claude` CLI",
    vendorPackage: CLAUDE_ACP_PACKAGE,
    vendorBin: "claude-agent-acp",
    // The adapter exposes Claude's effort as a session config option (verified
    // live: values default/low/medium/high/xhigh/max).
    effort: { kind: "config", configId: "effort" },
    defaultEffort: (projectDir) => claudeDefaultSessionEffort(projectDir),
    setDefaultEffort: (projectDir, level) => writeClaudeDefaultSessionEffort(projectDir, level),
    defaultModel: (projectDir) => claudeDefaultSessionModel(projectDir),
    setDefaultModel: (projectDir, model) => writeClaudeDefaultSessionModel(projectDir, model),
    // Zed's adapter over the Agent SDK. The SDK needs the local `claude`
    // executable and does not search PATH for it, so it travels in the env.
    resolve(env, which, vendored) {
      const claude = env.CLAUDE_CODE_EXECUTABLE || which("claude");
      if (!claude) return null;
      const onPath = vendored ?? which("claude-agent-acp");
      return { command: onPath ? [onPath] : [bunx(which), CLAUDE_ACP_PACKAGE], env: { CLAUDE_CODE_EXECUTABLE: claude } };
    },
  },
  {
    backend: "kiro",
    harnesses: ["kiro", "kiro-ide"],
    envCommand: "AIDLC_ACP_KIRO_COMMAND",
    startPrompt: "/aidlc",
    requirement: "the `kiro-cli` CLI",
    // `kiro-cli acp --effort <level>` sets the first session's effort.
    effort: { kind: "flag", flag: "--effort" },
    defaultEffort: (projectDir) => kiroDefaultSessionEffort(projectDir),
    // Native. The shipped `aidlc` agent carries the framework's hooks, so the
    // session must run as that agent.
    resolve(_env, which, _vendored) {
      const kiro = which("kiro-cli");
      return kiro ? { command: [kiro, "acp", "--agent", "aidlc"], env: {} } : null;
    },
  },
  {
    backend: "codex",
    harnesses: ["codex"],
    envCommand: "AIDLC_ACP_CODEX_COMMAND",
    startPrompt: "$aidlc",
    requirement: "the `codex` CLI (or a `~/.codex` login)",
    vendorPackage: CODEX_ACP_PACKAGE,
    vendorBin: "codex-acp",
    // The ACP project's adapter bundles its own Codex; auth comes from the
    // user's `~/.codex`, so a login is the real requirement.
    resolve(env, which, vendored) {
      const home = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
      if (!which("codex") && !existsSync(home)) return null;
      const onPath = vendored ?? which("codex-acp");
      return { command: onPath ? [onPath] : [bunx(which), CODEX_ACP_PACKAGE], env: {} };
    },
  },
  {
    backend: "cursor",
    harnesses: ["cursor"],
    envCommand: "AIDLC_ACP_CURSOR_COMMAND",
    startPrompt: "/aidlc",
    requirement: "the Cursor CLI (`agent` or `cursor-agent`)",
    resolve(_env, which, _vendored) {
      const agent = which("cursor-agent") ?? which("agent");
      return agent ? { command: [agent, "acp"], env: {} } : null;
    },
  },
  {
    backend: "opencode",
    harnesses: ["opencode"],
    envCommand: "AIDLC_ACP_OPENCODE_COMMAND",
    startPrompt: "/aidlc",
    requirement: "the `opencode` CLI",
    resolve(_env, which, _vendored) {
      const opencode = which("opencode");
      return opencode ? { command: [opencode, "acp"], env: {} } : null;
    },
  },
  {
    backend: "copilot",
    harnesses: ["copilot"],
    envCommand: "AIDLC_ACP_COPILOT_COMMAND",
    startPrompt: "/aidlc",
    requirement: "the `copilot` CLI",
    resolve(_env, which, _vendored) {
      const copilot = which("copilot");
      return copilot ? { command: [copilot, "--acp"], env: {} } : null;
    },
  },
];

export function acpBackendForHarness(harness: string | null): AcpBackendProfile | null {
  if (!harness) return null;
  return ACP_BACKENDS.find((profile) => profile.harnesses.includes(harness)) ?? null;
}

/**
 * How to launch the installed harness's agent on this machine, or null when it
 * cannot run here. `AIDLC_ACP_<BACKEND>_COMMAND` replaces the whole command
 * line (whitespace-split) and skips the requirement check, so a vendored
 * adapter or a test double can stand in.
 */
export function resolveAcpLaunch(harness: string | null, env: NodeJS.ProcessEnv = process.env, toolsDir: string = import.meta.dir): AcpLaunch | null {
  const profile = acpBackendForHarness(harness);
  if (!profile) return null;
  const which = (name: string): string | null => Bun.which(name, env.PATH !== undefined ? { PATH: env.PATH } : undefined);
  const override = (env[profile.envCommand] ?? "").trim();
  if (override) {
    const extra: Record<string, string> = {};
    if (profile.backend === "claude" && env.CLAUDE_CODE_EXECUTABLE) extra.CLAUDE_CODE_EXECUTABLE = env.CLAUDE_CODE_EXECUTABLE;
    return { backend: profile.backend, command: override.split(/\s+/), env: extra, startPrompt: profile.startPrompt, effort: profile.effort, defaultEffort: profile.defaultEffort, setDefaultEffort: profile.setDefaultEffort, defaultModel: profile.defaultModel, setDefaultModel: profile.setDefaultModel };
  }
  // A vendored adapter (vendor-agent) beats PATH and bunx: it is the pinned
  // copy an offline host carries.
  const resolved = profile.resolve(env, which, vendoredAcpBin(toolsDir, profile));
  return resolved ? { backend: profile.backend, ...resolved, startPrompt: profile.startPrompt, effort: profile.effort, defaultEffort: profile.defaultEffort, setDefaultEffort: profile.setDefaultEffort, defaultModel: profile.defaultModel, setDefaultModel: profile.setDefaultModel } : null;
}

/** The launch with a session effort applied where the backend takes it as a flag. */
export function launchWithEffort(launch: AcpLaunch, effort: SessionEffort | null): AcpLaunch {
  if (!effort || launch.effort?.kind !== "flag") return launch;
  return { ...launch, command: [...launch.command, launch.effort.flag, effort] };
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface AcpToolCall {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  locations?: Array<{ path: string; line?: number | null }>;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
}

export type AcpPermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string };

export interface AcpElicitationRequest {
  sessionId: string;
  mode: "form";
  message: string;
  requestedSchema: { type: "object"; properties?: Record<string, unknown> };
  toolCallId?: string;
}

export type AcpElicitationResponse =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

export interface AcpSessionUpdate {
  sessionId: string;
  update: { sessionUpdate: string } & Record<string, unknown>;
}

export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export interface AcpClientBridges {
  onUpdate: (update: AcpSessionUpdate) => void;
  onPermission: (request: AcpPermissionRequest) => Promise<AcpPermissionOutcome>;
  onElicitation: (request: AcpElicitationRequest) => Promise<AcpElicitationResponse>;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface AcpInitializeResult {
  agentInfo?: { name?: string; title?: string; version?: string };
  agentCapabilities?: { loadSession?: boolean } & Record<string, unknown>;
}

interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
    readonly data: unknown = undefined,
  ) {
    super(message);
  }
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** One agent process, one JSON-RPC connection. Sessions are created on it. */
export class AcpClient {
  private child: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  readonly stderrTail: string[] = [];

  constructor(
    readonly launch: AcpLaunch,
    readonly cwd: string,
    private readonly bridges: AcpClientBridges,
  ) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get exited(): boolean {
    return this.exitInfo !== null;
  }

  /** Spawn the agent and complete `initialize`. */
  async start(extraEnv: Record<string, string> = {}): Promise<AcpInitializeResult> {
    if (this.child) throw new AcpError("agent already started");
    const [command, ...args] = this.launch.command;
    const child = spawn(command, args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.launch.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.onData(chunk));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
        this.bridges.onStderr?.(line);
      }
    });
    child.on("error", (error) => this.failAll(new AcpError(`agent process failed: ${error.message}`)));
    child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      this.failAll(new AcpError(`agent process exited (code ${code ?? "null"}${signal ? `, ${signal}` : ""})`));
      this.bridges.onExit?.(code, signal);
    });
    const result = await this.request(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          // Form elicitation is what lets the Claude adapter forward the
          // built-in AskUserQuestion tool; without it the adapter disables the
          // tool and the protocol's structured questions have nowhere to go.
          elicitation: { form: {} },
        },
        clientInfo: { name: "aidlc-review-ui", version: "1" },
      },
      ACP_HANDSHAKE_TIMEOUT_MS,
    );
    return (result ?? {}) as AcpInitializeResult;
  }

  async newSession(): Promise<{ sessionId: string; models: AcpModelChoice[] | null }> {
    const result = (await this.request("session/new", { cwd: this.cwd, mcpServers: [] }, ACP_HANDSHAKE_TIMEOUT_MS)) as { sessionId?: unknown; models?: unknown };
    if (typeof result?.sessionId !== "string" || !result.sessionId) throw new AcpError("session/new returned no sessionId");
    return { sessionId: result.sessionId, models: parseModelChoices(result.models) };
  }

  /**
   * Resume a session the agent persisted. The adapter replays the transcript as
   * `session/update` notifications before it answers, so the bound is the
   * handshake bound; a refusal (unknown id, capability absent) is an AcpError
   * the caller turns into `newSession`.
   */
  async loadSession(sessionId: string): Promise<void> {
    await this.request("session/load", { sessionId, cwd: this.cwd, mcpServers: [] }, ACP_HANDSHAKE_TIMEOUT_MS);
  }

  /** One turn. Resolves when the agent stops; rejects if the process dies. */
  async prompt(sessionId: string, text: string): Promise<AcpStopReason> {
    const result = (await this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    })) as { stopReason?: unknown };
    const reason = result?.stopReason;
    return typeof reason === "string" ? (reason as AcpStopReason) : "end_turn";
  }

  /** Set a session config option (ACP `session/set_config_option`), e.g. the Claude adapter's effort. */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    await this.request("session/set_config_option", { sessionId, configId, value }, ACP_HANDSHAKE_TIMEOUT_MS);
  }

  /** Ask the agent to stop the current turn; the in-flight prompt resolves `cancelled`. */
  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  /** Terminate the process. In-flight requests reject. */
  close(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child || this.exitInfo) return;
    try {
      child.stdin?.end();
    } catch {
      // already gone
    }
    child.kill(signal);
    // A process that ignores SIGTERM is not allowed to outlive the daemon.
    const escalate = setTimeout(() => {
      if (!this.exitInfo) child.kill("SIGKILL");
    }, 5_000);
    child.once("exit", () => clearTimeout(escalate));
  }

  private request(method: string, params: unknown, timeoutMs: number | null = null): Promise<unknown> {
    if (!this.child || this.exitInfo) return Promise.reject(new AcpError("agent is not running"));
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = timeoutMs === null
      ? null
      : setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpError(`${method} timed out after ${Math.round(timeoutMs / 1000)}s${this.stderrHint()}`));
        }, timeoutMs);
    this.pending.set(id, { method, resolve, reject, timer });
    this.send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  private notify(method: string, params: unknown): void {
    if (!this.child || this.exitInfo) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: JsonRpcMessage): void {
    try {
      this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.failAll(new AcpError(`agent stdin write failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private stderrHint(): string {
    const last = this.stderrTail[this.stderrTail.length - 1];
    return last ? ` (agent stderr: ${last.slice(0, 200)})` : "";
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer ?? undefined);
      this.pending.delete(id);
      entry.reject(error);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.bridges.onStderr?.(`[acp] non-JSON line from agent: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof message !== "object" || message === null) return;
    // A response never carries `method`; an inbound request always does. The
    // two id namespaces are independent and DO collide on small integers, so
    // the method check is what keeps a permission request from being mistaken
    // for the in-flight prompt's completion.
    if (message.method === undefined && message.id !== undefined) {
      const entry = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (!entry) return;
      this.pending.delete(message.id as number);
      clearTimeout(entry.timer ?? undefined);
      if (message.error) entry.reject(new AcpError(`${entry.method}: ${message.error.message}`, message.error.code, message.error.data));
      else entry.resolve(message.result);
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      void this.onInboundRequest(message.id, message.method, message.params);
      return;
    }
    if (message.method === "session/update") {
      const params = message.params as AcpSessionUpdate | undefined;
      if (params && typeof params.sessionId === "string" && params.update && typeof params.update.sessionUpdate === "string") {
        this.bridges.onUpdate(params);
      }
    }
  }

  private async onInboundRequest(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      if (method === "session/request_permission") {
        const request = normalizePermissionRequest(params);
        const outcome = await this.bridges.onPermission(request);
        this.send({ jsonrpc: "2.0", id, result: { outcome } });
        return;
      }
      if (method === "elicitation/create") {
        const request = normalizeElicitationRequest(params);
        if (!request) {
          this.send({ jsonrpc: "2.0", id, error: { code: -32602, message: "only form elicitations are supported" } });
          return;
        }
        const response = await this.bridges.onElicitation(request);
        this.send({ jsonrpc: "2.0", id, result: response });
        return;
      }
      // Cursor asks the human through two blocking extension methods. Both are
      // presented as the same form question the standard elicitation uses, and
      // the answer is mapped back to Cursor's own response shape.
      if (method === "cursor/ask_question") {
        const ask = cursorAskToElicitation(params);
        if (!ask) {
          this.send({ jsonrpc: "2.0", id, error: { code: -32602, message: "no questions" } });
          return;
        }
        const response = await this.bridges.onElicitation(ask.request);
        this.send({ jsonrpc: "2.0", id, result: { outcome: ask.toOutcome(response) } });
        return;
      }
      if (method === "cursor/create_plan") {
        const plan = cursorPlanToElicitation(params);
        const response = await this.bridges.onElicitation(plan.request);
        this.send({ jsonrpc: "2.0", id, result: { outcome: plan.toOutcome(response) } });
        return;
      }
      this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    } catch (error) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}

function normalizePermissionRequest(params: unknown): AcpPermissionRequest {
  const raw = (params ?? {}) as Record<string, unknown>;
  const toolCall = (raw.toolCall ?? {}) as Record<string, unknown>;
  const options = Array.isArray(raw.options) ? (raw.options as Array<Record<string, unknown>>) : [];
  return {
    sessionId: String(raw.sessionId ?? ""),
    toolCall: {
      toolCallId: String(toolCall.toolCallId ?? ""),
      title: typeof toolCall.title === "string" ? toolCall.title : "Tool call",
      kind: typeof toolCall.kind === "string" ? toolCall.kind : undefined,
      status: typeof toolCall.status === "string" ? toolCall.status : undefined,
      rawInput: toolCall.rawInput,
      locations: Array.isArray(toolCall.locations) ? (toolCall.locations as AcpToolCall["locations"]) : undefined,
    },
    options: options
      .map((option) => ({
        // kiro-cli spells these `id`/`label`; the ACP schema (and the Claude
        // adapter) `optionId`/`name`. Read both so the profile stays one line.
        optionId: String(option.optionId ?? option.id ?? ""),
        name: String(option.name ?? option.label ?? option.optionId ?? option.id ?? ""),
        kind: (typeof option.kind === "string" ? option.kind : "allow_once") as AcpPermissionOption["kind"],
      }))
      .filter((option) => option.optionId.length > 0),
  };
}

function normalizeElicitationRequest(params: unknown): AcpElicitationRequest | null {
  const raw = (params ?? {}) as Record<string, unknown>;
  if (raw.mode !== "form") return null;
  const schema = (raw.requestedSchema ?? {}) as Record<string, unknown>;
  return {
    sessionId: String(raw.sessionId ?? ""),
    mode: "form",
    message: typeof raw.message === "string" ? raw.message : "",
    requestedSchema: {
      type: "object",
      properties: typeof schema.properties === "object" && schema.properties !== null ? (schema.properties as Record<string, unknown>) : {},
    },
    toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : undefined,
  };
}

// ---- Cursor extension asks -------------------------------------------------------
//
// https://cursor.com/docs/cli/acp: `cursor/ask_question` carries one or more
// multiple-choice questions (option ids + labels, optional multi-select);
// `cursor/create_plan` carries a plan to accept or reject. Both block the agent
// until answered.

interface CursorQuestion {
  id: string;
  prompt: string;
  options: Array<{ id: string; label: string }>;
  allowMultiple?: boolean;
}

export function cursorAskToElicitation(params: unknown): {
  request: AcpElicitationRequest;
  toOutcome: (response: AcpElicitationResponse) => Record<string, unknown>;
} | null {
  const raw = (params ?? {}) as Record<string, unknown>;
  const questions = (Array.isArray(raw.questions) ? raw.questions : [])
    .filter((entry): entry is CursorQuestion => {
      const candidate = entry as Partial<CursorQuestion>;
      return typeof candidate?.id === "string" && typeof candidate.prompt === "string" && Array.isArray(candidate.options);
    })
    .map((question) => ({ ...question, options: question.options.filter((option) => typeof option?.id === "string" && typeof option.label === "string") }));
  if (questions.length === 0) return null;
  const properties: Record<string, unknown> = {};
  questions.forEach((question, index) => {
    const options = question.options.map((option) => ({ const: option.label, title: option.label }));
    properties[`question_${index}`] = question.allowMultiple
      ? { type: "array", title: question.prompt, items: { anyOf: options } }
      : { type: "string", title: question.prompt, oneOf: options };
  });
  const single = questions.length === 1;
  return {
    request: {
      sessionId: "",
      mode: "form",
      message: typeof raw.title === "string" && raw.title ? raw.title : single ? questions[0].prompt : "Please answer the following questions.",
      requestedSchema: { type: "object", properties },
      toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : undefined,
    },
    toOutcome(response) {
      if (response.action === "cancel") return { outcome: "cancelled" };
      if (response.action === "decline") return { outcome: "skipped" };
      const answers = questions.map((question, index) => {
        const value = response.content[`question_${index}`];
        const labels = Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : [];
        return {
          questionId: question.id,
          selectedOptionIds: labels.map((label) => question.options.find((option) => option.label === label)?.id).filter((id): id is string => typeof id === "string"),
        };
      });
      return { outcome: "answered", answers };
    },
  };
}

export function cursorPlanToElicitation(params: unknown): {
  request: AcpElicitationRequest;
  toOutcome: (response: AcpElicitationResponse) => Record<string, unknown>;
} {
  const raw = (params ?? {}) as Record<string, unknown>;
  const name = typeof raw.name === "string" && raw.name ? raw.name : "the plan";
  const overview = typeof raw.overview === "string" ? raw.overview : "";
  const plan = typeof raw.plan === "string" ? raw.plan : "";
  const message = [`Approve ${name}?`, overview, plan].filter(Boolean).join("\n\n");
  return {
    request: {
      sessionId: "",
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties: {
          question_0: { type: "string", title: "Plan", oneOf: [{ const: "Accept", title: "Accept" }, { const: "Reject", title: "Reject" }] },
          question_0_custom: { type: "string", title: "Other", description: "Why, if rejecting (optional)." },
        },
      },
      toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : undefined,
    },
    toOutcome(response) {
      if (response.action === "cancel") return { outcome: "cancelled" };
      if (response.action === "decline") return { outcome: "rejected", reason: "Skipped by the human" };
      const choice = String(response.content.question_0 ?? "");
      const reason = typeof response.content.question_0_custom === "string" ? response.content.question_0_custom.trim() : "";
      if (choice === "Accept") return { outcome: "accepted" };
      return { outcome: "rejected", ...(reason ? { reason } : {}) };
    },
  };
}
