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
// Backend quirks are confined to `acpBackendProfile`: the Claude adapter
// (`@agentclientprotocol/claude-agent-acp`, built on the Agent SDK) takes the
// integer protocol version and `optionId`-shaped permission options. Phase 1
// ships Claude only; a second backend adds a profile, not a branch elsewhere.

import { spawn, type ChildProcess } from "node:child_process";

export const ACP_PROTOCOL_VERSION = 1;
// Handshake steps must answer within this window; the Claude adapter's first
// `session/new` starts the SDK (about 6 s here) and a cold `bunx` fetch can add
// tens of seconds, so the bound is generous. A prompt turn has no bound of its
// own: the run manager owns turn ceilings.
export const ACP_HANDSHAKE_TIMEOUT_MS = 180_000;
// Pinned so an install does not silently move to a newer adapter with a
// different wire behaviour; bump deliberately with a test run.
export const CLAUDE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp@0.75.1";
export const ENV_ACP_CLAUDE_COMMAND = "AIDLC_ACP_CLAUDE_COMMAND";

export type AcpBackend = "claude";

export interface AcpLaunch {
  backend: AcpBackend;
  command: string[];
  env: Record<string, string>;
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

/**
 * Resolve how to launch the Claude ACP agent on this machine, or null when it
 * cannot run here (no `claude` binary). Resolution: `AIDLC_ACP_CLAUDE_COMMAND`
 * (a whitespace-split command line) > `claude-agent-acp` on PATH > `bunx` with
 * the pinned package. The adapter delegates the model turn to the Agent SDK,
 * which needs the local `claude` executable and does not search PATH for it,
 * so `CLAUDE_CODE_EXECUTABLE` is set unless the caller already did.
 */
export function resolveClaudeAcpLaunch(env: NodeJS.ProcessEnv = process.env): AcpLaunch | null {
  const which = (name: string): string | null => Bun.which(name, env.PATH !== undefined ? { PATH: env.PATH } : undefined);
  const claude = env.CLAUDE_CODE_EXECUTABLE || which("claude");
  if (!claude) return null;
  const override = (env[ENV_ACP_CLAUDE_COMMAND] ?? "").trim();
  let command: string[];
  if (override) {
    command = override.split(/\s+/);
  } else {
    const onPath = which("claude-agent-acp");
    command = onPath ? [onPath] : [which("bunx") ?? "bunx", CLAUDE_ACP_PACKAGE];
  }
  return {
    backend: "claude",
    command,
    env: { CLAUDE_CODE_EXECUTABLE: claude },
  };
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

  async newSession(): Promise<{ sessionId: string }> {
    const result = (await this.request("session/new", { cwd: this.cwd, mcpServers: [] }, ACP_HANDSHAKE_TIMEOUT_MS)) as { sessionId?: unknown };
    if (typeof result?.sessionId !== "string" || !result.sessionId) throw new AcpError("session/new returned no sessionId");
    return { sessionId: result.sessionId };
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
