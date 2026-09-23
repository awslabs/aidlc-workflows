// kiro-acp-drive.ts — the Kiro ACP harness driver: sdk-drive.ts's structured
// "logic half" for the Kiro harness, over the Agent Client Protocol instead of
// the Claude Agent SDK (Kiro ships no SDK package; `kiro-cli acp` is its
// programmatic surface — JSON-RPC 2.0, newline-delimited, over stdio).
//
// SPIKE-VERIFIED contract (live against kiro-cli 2.6.1, 2026-06-12; probes in
// tmp/kiro-acp-spike/ of the spike branch, transcripts in the spike findings):
//   - spawn `kiro-cli acp --agent <name> [--trust-all-tools]` in the project
//     cwd; `initialize` (protocolVersion 1) returns agentInfo + capabilities.
//   - `session/new {cwd, mcpServers: []}` returns {sessionId, modes:{...}} —
//     modes.currentModeId is the ACTIVE AGENT (proved the shipped `aidlc`
//     agent loads: availableModes listed our delegation targets).
//   - `session/prompt {sessionId, prompt:[{type:"text",text}]}` runs ONE full
//     agentic turn; the reply resolves with {stopReason} when the turn ends.
//   - While the turn runs, the agent streams `session/update` notifications:
//       agent_message_chunk          — assistant prose tokens (NON-deterministic)
//       tool_call                    — {toolCallId, title, kind, rawInput}
//                                      title carries the real command, e.g.
//                                      "Running: bun .kiro/tools/aidlc-utility.ts status"
//       tool_call_update             — content[].content.text = the tool's
//                                      VERBATIM output (byte-stable, the thing
//                                      tests assert on), then status:"completed"
//     plus _kiro.dev/* vendor notifications (metadata, command lists) we keep
//     but do not depend on.
//   - `session/request_permission` arrives as a server→client REQUEST when a
//     tool needs approval (only without --trust-all-tools); reply
//     {outcome:{outcome:"selected", optionId}} — the programmatic gate-answer
//     channel (ACP's canUseTool analogue).
//
// Like sdk-drive.ts this is a MEASURING INSTRUMENT: it scripts the transport
// and returns structure; assertions belong to tests, and the assistant prose
// is exposed for debugging only — never assert on it. Unlike the TUI driver
// there is no screen: tool outputs arrive byte-verbatim, so tests assert the
// same surfaces the SDK twin does (toolResults / stateFile / auditEvents).
//
// Questions/gates: AIDLC structured questions on Kiro render as numbered
// prose INSIDE agent_message_chunk text (the question-rendering annex), not
// as a protocol object — so multi-turn gate answering means calling drive()
// again with the answer text on the same session (sessionId is returned).
// This driver supports that via opts.sessionId + opts.keepAlive.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { parseLiteralShellInvocation } from "../../core/tools/aidlc-lib.ts";

// --- Debug trace (parity with sdk-drive.ts) ---------------------------------
//
// sdk-drive.ts writes a per-event ndjson trace under AIDLC_TEST_LOG_DIR when
// the runner is in --debug mode, so a failed (or timed-out) SDK turn can be
// reconstructed after the fact. The ACP driver historically wrote NOTHING and
// spawned `kiro-cli acp` with stderr:"ignore", so a `session/prompt` timeout
// surfaced only as the bare reject — no record of whether the turn was making
// real tool calls (running, just slow) or stalled. That blind spot is the one
// this trace closes: every ACP event (start, tool_call, tool_call_update,
// permission, result, timeout, end) plus the spawned process's stderr lands in
// `kiro-acp-drive-<pid>.ndjson`, the ACP analogue of sdk-drive's trace.
function acpTracePath(): string | undefined {
  if (process.env.AIDLC_ACP_TRACE_FILE) return process.env.AIDLC_ACP_TRACE_FILE;
  if (process.env.AIDLC_TEST_DEBUG === "true" && process.env.AIDLC_TEST_LOG_DIR) {
    return join(process.env.AIDLC_TEST_LOG_DIR, `kiro-acp-drive-${process.pid}.ndjson`);
  }
  return undefined;
}

function writeAcpTrace(
  tracePath: string | undefined,
  event: string,
  data: Record<string, unknown>,
): void {
  if (!tracePath) return;
  mkdirSync(dirname(tracePath), { recursive: true });
  appendFileSync(tracePath, `${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`);
}


// Opt-in diagnostic sidecar for one reviewed synthetic workspace run.
// No agent-prose events, prompt/request bodies, RPC auth responses or process
// environment are copied. Tool-input payloads remain private diagnostic data.
const ACP_DIAGNOSTIC = process.env.AIDLC_ACP_DIAGNOSTIC_TRACE === "1";
const ACP_DIAGNOSTIC_MAX_EVENT = 1_048_576;
const ACP_DIAGNOSTIC_MAX_FILE = 67_108_864;
let diagnosticInstance = 0;
const diagnosticFiles = new Map<string, { bytes: number; sequence: number; capped: boolean }>();

function diagnosticInputShape(value: unknown): Record<string, unknown> {
  const object = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  const command = object?.command;
  return {
    type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
    keys: object ? Object.keys(object).sort() : [],
    commandPresent: object ? Object.hasOwn(object, "command") : false,
    commandType: typeof command,
    commandBytes: typeof command === "string" ? Buffer.byteLength(command) : undefined,
    commandSha256: typeof command === "string"
      ? createHash("sha256").update(command).digest("hex") : undefined,
  };
}

function diagnosticToolUpdate(update: Record<string, unknown>): Record<string, unknown> {
  // The vendor chunk's schema is the missing evidence: preserve that update
  // losslessly under this event-kind allowlist instead of guessing its fields.
  if (update.sessionUpdate === "tool_call_chunk") return update;
  const keys = ["sessionUpdate", "toolCallId", "title", "kind", "status", "rawInput"];
  if (update.status === "failed") keys.push("content", "rawOutput");
  return Object.fromEntries(keys.filter(key => Object.hasOwn(update, key)).map(key => [key, update[key]]));
}

export interface AcpToolCall {
  toolCallId: string;
  /** e.g. "Running: bun .kiro/tools/aidlc-utility.ts status" */
  title: string;
  kind: string;
  rawInput: unknown;
  /** Verbatim tool output text chunks, in arrival order (byte-stable). */
  output: string[];
  status: string;
}

/** Decode a literal invocation regardless of outcome, so refused attempts remain visible. */
export function decodeKiroOrchestrateInvocation(
  call: AcpToolCall,
): { verb: string; args: string[] } | null {
  if (call.kind !== "execute") return null;
  const input = call.rawInput;
  if (input != null && (typeof input !== "object" || Array.isArray(input))) return null;
  const object = input as Record<string, unknown> | null | undefined;
  const command = object && Object.hasOwn(object, "command")
    ? object.command
    : call.title.startsWith("Running: ") && !call.title.endsWith("...")
      ? call.title.slice("Running: ".length)
      : undefined;
  if (typeof command !== "string") return null;
  const parsed = parseLiteralShellInvocation(command);
  // Without a project-path argument, a CD prefix cannot prove the same workspace.
  if (!parsed || parsed.directory !== null) return null;
  const [runtime, script, ...args] = parsed.argv;
  if (runtime !== "bun" && runtime !== "bun.exe") return null;
  const path = script?.replaceAll("\\", "/").replace(/^\.\//, "");
  const invocation = path === ".kiro/tools/aidlc.ts" && args[0] === "engine" && args[1] === "orchestrate"
    ? args.slice(2)
    : path === ".kiro/tools/aidlc-orchestrate.ts" ? args : [];
  const [verb, ...forwarded] = invocation;
  return verb ? { verb, args: forwarded } : null;
}

/** Locate a completed next invocation and its own matching output, never a prose mention. */
export function findKiroOrchestrateNextCall(
  calls: readonly AcpToolCall[],
  outputNeedle: string,
): number {
  return calls.findIndex((call) =>
    call.status === "completed" &&
    decodeKiroOrchestrateInvocation(call)?.verb === "next" &&
    call.output.join("").includes(outputNeedle)
  );
}

export interface AcpPermissionRequest {
  toolCallId?: string;
  options: Array<{ optionId: string; name?: string; kind?: string }>;
  /** The optionId the driver answered with. */
  answered: string;
}

export interface AcpToolCallIssue {
  toolCallId: string;
  status: string;
  output: string[];
  /** True when Kiro emitted an update without a preceding tool_call event. */
  orphan: boolean;
}

export interface AcpDriveResult {
  sessionId: string;
  stopReason: string | undefined;
  /** Every tool call with its verbatim output — the assertable surface. */
  toolCalls: AcpToolCall[];
  /** Concatenated assistant prose. Debugging only — never assert on this. */
  assistantText: string;
  permissionRequests: AcpPermissionRequest[];
  /** Failed or orphaned tool updates; a later retry does not erase them. */
  toolCallIssues: AcpToolCallIssue[];
  /** aidlc-docs/aidlc-state.md after the turn, if present. */
  stateFile?: string;
  /** Audit **Event**: types parsed from aidlc-docs/audit.md, in file order. */
  auditEvents?: string[];
}

export interface AcpDriveOptions {
  projectDir: string;
  prompt: string;
  /** Agent name; default "aidlc" (the shipped conductor). */
  agent?: string;
  /** Pass --trust-all-tools (default true — journeys are about the workflow,
   *  not permission dialogs; set false to exercise request_permission). */
  trustAllTools?: boolean;
  /** Per-turn timeout (the whole session/prompt round-trip). */
  timeoutMs?: number;
  /** Reuse a live session from a prior keepAlive drive. */
  session?: AcpSession;
  /** Keep the process + session alive and return it on the result for
   *  follow-up turns (caller must close() it). */
  keepAlive?: boolean;
  /** Abort the turn (session/cancel) as soon as a tool_call_update completes
   *  for a tool whose title matches — the ACP analogue of sdk-drive's
   *  stopAfterToolResult: prove the deterministic contract, then stop the
   *  model before it can roll into unrelated workflow execution (the
   *  turn-boundary edge). The completed tool's output is already captured
   *  when the cancel fires; stopReason will reflect the cancellation. */
  stopAfterToolTitle?: RegExp;
}

interface Pending {
  resolve: (msg: { result?: unknown; error?: unknown }) => void;
}

/** A live ACP process + session, reusable across drive() turns. */
export class AcpSession {
  proc: ReturnType<typeof Bun.spawn>;
  sessionId = "";
  private readonly diagnosticInstance = ++diagnosticInstance;
  private diagnosticTurn = 0;

  beginDiagnosticTurn(): void {
    this.diagnosticTurn++;
  }

  traceDiagnostic(event: string, data: Record<string, unknown>): void {
    if (!ACP_DIAGNOSTIC || !this.tracePath) return;
    const path = `${this.tracePath}.protocol.ndjson`;
    const state = diagnosticFiles.get(path) ?? { bytes: 0, sequence: 0, capped: false };
    diagnosticFiles.set(path, state);
    if (state.capped) return;
    const envelope = {
      ts: new Date().toISOString(), sequence: ++state.sequence,
      clientPid: process.pid, cliPid: this.proc.pid, instance: this.diagnosticInstance,
      turn: this.diagnosticTurn, sessionId: this.sessionId, event, ...data,
    };
    let line = JSON.stringify(envelope) + "\n";
    const bytes = Buffer.byteLength(line);
    if (bytes > ACP_DIAGNOSTIC_MAX_EVENT || state.bytes + bytes > ACP_DIAGNOSTIC_MAX_FILE) {
      line = JSON.stringify({
        ts: envelope.ts, sequence: envelope.sequence, instance: this.diagnosticInstance,
        event: "diagnostic_incomplete", reason: "capture budget exceeded",
        omittedBytes: bytes, omittedSha256: createHash("sha256").update(line).digest("hex"),
      }) + "\n";
      state.capped = true; // The diagnostic is inconclusive; never silently truncate.
    }
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line, { mode: 0o600 });
    state.bytes += Buffer.byteLength(line);
  }

  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private dec = new TextDecoder();
  private enc = new TextEncoder();
  /** Debug trace file (ndjson), or undefined outside --debug. Public so
   *  driveKiroAcp can append turn-level events (start/result/timeout/end) to
   *  the same file the session writes its protocol events to. */
  readonly tracePath: string | undefined;
  /** Per-turn sinks, swapped by drive(). */
  onUpdate: (update: Record<string, unknown>) => void = () => {};
  onPermission: (params: Record<string, unknown>) => string = (p) => {
    const opts = (p.options as Array<{ optionId: string; kind?: string }>) ?? [];
    const allow = opts.find((o) => /allow/i.test(o.kind ?? o.optionId ?? "")) ?? opts[0];
    return allow?.optionId ?? "allow";
  };

  constructor(projectDir: string, agent: string, trustAllTools: boolean) {
    this.tracePath = acpTracePath();
    const args = ["kiro-cli", "acp", "--agent", agent];
    if (trustAllTools) args.push("--trust-all-tools");
    writeAcpTrace(this.tracePath, "spawn", { args, cwd: projectDir });
    this.proc = Bun.spawn(args, {
      cwd: projectDir,
      stdin: "pipe",
      stdout: "pipe",
      // In --debug, PIPE stderr and tee it into the trace; otherwise ignore it.
      // kiro-cli's stderr carries the diagnostics that explain a timeout (the
      // old stderr:"ignore" is why an ACP timeout was previously undiagnosable).
      stderr: this.tracePath ? "pipe" : "ignore",
    });
    this.traceDiagnostic("spawn", { agent, trustAllTools });
    void this.readLoop();
    if (this.tracePath) void this.stderrLoop();
  }

  /** Tee the spawned process's stderr into the debug trace (--debug only). */
  private async stderrLoop(): Promise<void> {
    const stderr = this.proc.stderr;
    if (!stderr || typeof stderr === "number") return;
    let sbuf = "";
    try {
      for await (const chunk of stderr as AsyncIterable<Uint8Array>) {
        sbuf += this.dec.decode(chunk);
        let nl = sbuf.indexOf("\n");
        while (nl >= 0) {
          const line = sbuf.slice(0, nl);
          sbuf = sbuf.slice(nl + 1);
          if (line.trim()) writeAcpTrace(this.tracePath, "stderr", { line });
          nl = sbuf.indexOf("\n");
        }
      }
    } catch {
      /* stream closed on process exit — expected */
    }
  }

  private async readLoop(): Promise<void> {
    for await (const chunk of this.proc.stdout as AsyncIterable<Uint8Array>) {
      this.buf += this.dec.decode(chunk);
      let nl = this.buf.indexOf("\n");
      while (nl >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        nl = this.buf.indexOf("\n");
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          if (ACP_DIAGNOSTIC) this.traceDiagnostic("json_parse_error", {
            bytes: Buffer.byteLength(line),
            sha256: createHash("sha256").update(line).digest("hex"),
          });
          continue; // Preserve existing behavior; diagnostic coverage is incomplete.
        }
        this.dispatch(msg);
      }
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = msg.id as number | undefined;
    if (id !== undefined && ("result" in msg || "error" in msg) && this.pending.has(id)) {
      writeAcpTrace(this.tracePath, "reply", {
        id,
        ok: !("error" in msg),
        error: "error" in msg ? msg.error : undefined,
      });
      this.pending.get(id)!.resolve(msg as { result?: unknown; error?: unknown });
      this.pending.delete(id);
      return;
    }
    const method = msg.method as string | undefined;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (method === "session/request_permission") {
      const optionId = this.onPermission(params);
      writeAcpTrace(this.tracePath, "permission", {
        optionId,
        options: params.options,
      });
      this.send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId } } });
      return;
    }
    // Both the spec channel (session/update) and Kiro's vendor channel
    // (_kiro.dev/session/update) carry update objects of the same shape.
    if (method === "session/update" || method === "_kiro.dev/session/update") {
      const update = (params.update ?? {}) as Record<string, unknown>;
      if (ACP_DIAGNOSTIC && ["tool_call", "tool_call_update", "tool_call_chunk"].includes(String(update.sessionUpdate))) {
        this.traceDiagnostic("wire_tool_update", {
          channel: method, wireSessionId: params.sessionId,
          update: diagnosticToolUpdate(update),
        });
      }
      this.traceUpdate(update);
      this.onUpdate(update);
    }
    // other _kiro.dev/* notifications: metadata, command lists — ignored.
  }

  /** Trace a session/update, condensing the noisy/non-deterministic kinds.
   *  tool_call/tool_call_update carry the diagnostic signal (which tool ran,
   *  what it returned); message/thought chunks are summarized by count so the
   *  trace shows progress vs stall without drowning in token-level prose. */
  private traceUpdate(u: Record<string, unknown>): void {
    if (!this.tracePath) return;
    const kind = u.sessionUpdate as string;
    if (kind === "tool_call") {
      const rawInput = u.rawInput;
      const inputKeys =
        rawInput !== null &&
          typeof rawInput === "object" &&
          !Array.isArray(rawInput)
          ? Object.keys(rawInput).sort()
          : [];
      writeAcpTrace(this.tracePath, "tool_call", {
        toolCallId: u.toolCallId,
        title: u.title,
        toolKind: u.kind,
        inputKeys,
      });
    } else if (kind === "tool_call_update") {
      const content = (u.content ?? []) as Array<{ content?: { type?: string; text?: string } }>;
      const text = content.map((c) => c.content?.text ?? "").join("");
      writeAcpTrace(this.tracePath, "tool_call_update", {
        toolCallId: u.toolCallId,
        status: u.status,
        byteLength: text.length,
        preview: text.slice(0, 240),
      });
    } else {
      // agent_message_chunk / agent_thought_chunk / mode updates: record the
      // kind so the trace shows the turn is alive (progress, not a stall)
      // without logging every non-deterministic token.
      writeAcpTrace(this.tracePath, "update", { kind });
    }
  }

  private send(obj: unknown): void {
    (this.proc.stdin as { write(d: Uint8Array): void }).write(
      this.enc.encode(`${JSON.stringify(obj)}\n`),
    );
  }

  /** Fire-and-forget JSON-RPC notification (no id, no reply expected). */
  notify(method: string, params: unknown): void {
    if (method === "session/cancel") {
      this.traceDiagnostic("outbound_cancel", {
        wireSessionId: (params as { sessionId?: unknown } | null)?.sessionId,
      });
    }
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<{ result?: unknown; error?: unknown }> {
    const id = this.nextId++;
    this.traceDiagnostic("outbound_request", { id, method }); // No prompt/body.
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[kiro-acp-drive] ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(t);
          if (method === "initialize") {
            const result = m.result as { protocolVersion?: unknown; agentInfo?: Record<string, unknown> } | undefined;
            this.traceDiagnostic("initialize_metadata", {
              protocolVersion: result?.protocolVersion,
              agentInfo: result?.agentInfo ? Object.fromEntries(
                ["name", "title", "version"].filter(key => Object.hasOwn(result.agentInfo!, key))
                  .map(key => [key, result.agentInfo![key]]),
              ) : undefined,
            });
          }
          resolve(m);
        },
      });
    });
  }

  close(): void {
    try {
      this.proc.kill();
    } catch {
      /* already dead */
    }
  }
}

// P4: creation writes the workflow record per-intent - state at
// aidlc/spaces/<space>/intents/<slug>-<id8>/aidlc-state.md, audit as per-clone
// shards at <record>/audit/<host>-<clone>.md — NOT the flat aidlc-docs/. Resolve
// the created record from the active-space + active-intent cursors, falling back to
// the flat layout for a not-yet-created (pre-migration) fixture.
function recordDirOf(projectDir: string): string {
  const spaceCursor = join(projectDir, "aidlc", "active-space");
  const space = existsSync(spaceCursor)
    ? readFileSync(spaceCursor, "utf-8").trim() || "default"
    : "default";
  const intentsDir = join(projectDir, "aidlc", "spaces", space, "intents");
  const intentCursor = join(intentsDir, "active-intent");
  if (existsSync(intentCursor)) {
    const rec = readFileSync(intentCursor, "utf-8").trim();
    if (rec && existsSync(join(intentsDir, rec, "aidlc-state.md"))) {
      return join(intentsDir, rec);
    }
  }
  return join(projectDir, "aidlc-docs");
}

function stateFilePathOf(projectDir: string): string {
  return join(recordDirOf(projectDir), "aidlc-state.md");
}

function parseAuditEvents(projectDir: string): string[] | undefined {
  // Audit is sharded per clone under <record>/audit/; concat every shard, else
  // fall back to a flat aidlc-docs/audit.md (pre-migration fixture).
  const auditDir = join(recordDirOf(projectDir), "audit");
  let body: string;
  if (existsSync(auditDir)) {
    const shards = readdirSync(auditDir).filter((f) => f.endsWith(".md"));
    if (shards.length === 0) return undefined;
    body = shards.map((f) => readFileSync(join(auditDir, f), "utf-8")).join("\n");
  } else {
    const flat = join(projectDir, "aidlc-docs", "audit.md");
    if (!existsSync(flat)) return undefined;
    body = readFileSync(flat, "utf-8");
  }
  return [...body.matchAll(/^\*\*Event\*\*:\s*([A-Z_]+)\s*$/gm)].map((m) => m[1]);
}

// NOTE: there is deliberately NO multi-turn gate-loop here. Calibration proved
// the conductor does not reliably end its ACP turn by WAITING for it to
// VOLUNTARILY stop at a gate (it can keep executing the forwarding loop for many
// minutes inside one turn) — so turn-per-gate pacing that relies on a voluntary
// turn-end is NOT a dependable ACP primitive. But multi-turn journeys ARE
// dependable when each turn STOPS at a deterministic tool boundary via
// stopAfterToolTitle (which fires session/cancel the moment the named tool's
// output lands) rather than waiting for end_turn: the workspace journey leg
// (t-acp-kiro-journey-workspace) reuses one keepAlive AcpSession across turns and
// drives the conductor's offer→confirm flow this way, spike-verified 3/3. Gate
// loops that need a HUMAN-shaped voluntary stop still belong to the TUI driver;
// ACP's lane is single-turn contracts (and bounded multi-turn sequences) anchored
// by stopAfterToolTitle.

/** Run one agentic turn through `kiro-cli acp` and return structure. */
export async function driveKiroAcp(opts: AcpDriveOptions): Promise<AcpDriveResult> {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const session =
    opts.session ?? new AcpSession(opts.projectDir, opts.agent ?? "aidlc", opts.trustAllTools ?? true);

  session.beginDiagnosticTurn();
  const trace = session.tracePath;
  writeAcpTrace(trace, "start", {
    prompt: opts.prompt,
    projectDir: opts.projectDir,
    agent: opts.agent ?? "aidlc",
    trustAllTools: opts.trustAllTools ?? true,
    timeoutMs,
    reusedSession: opts.session !== undefined,
    stopAfterToolTitle: opts.stopAfterToolTitle?.source,
  });

  const toolCalls: AcpToolCall[] = [];
  const byId = new Map<string, AcpToolCall>();
  const toolCallIssues: AcpToolCallIssue[] = [];
  const permissionRequests: AcpPermissionRequest[] = [];
  let assistantText = "";
  let cancelled = false;

  session.onUpdate = (u) => {
    const kind = u.sessionUpdate as string;
    if (kind === "agent_message_chunk") {
      const c = u.content as { type?: string; text?: string } | undefined;
      if (c?.type === "text" && c.text) assistantText += c.text;
    } else if (kind === "tool_call") {
      const tc: AcpToolCall = {
        toolCallId: String(u.toolCallId ?? ""),
        title: String(u.title ?? ""),
        kind: String(u.kind ?? ""),
        rawInput: u.rawInput,
        output: [],
        status: "started",
      };
      toolCalls.push(tc);
      byId.set(tc.toolCallId, tc);
    } else if (kind === "tool_call_update") {
      const toolCallId = String(u.toolCallId ?? "");
      const tc = byId.get(toolCallId);
      const content = (u.content ?? []) as Array<{ content?: { type?: string; text?: string } }>;
      const output: string[] = [];
      for (const item of content) {
        if (item.content?.type === "text" && item.content.text) {
          output.push(item.content.text);
        }
      }
      const status = String(u.status ?? "");
      if (!tc || status === "failed") {
        toolCallIssues.push({
          toolCallId,
          status,
          output,
          orphan: !tc,
        });
      }
      if (!tc) return;
      tc.output.push(...output);
      if (u.status) tc.status = String(u.status);
      // Cancel as soon as the matched tool's OUTPUT BYTES are captured — the
      // contract surface is in hand; waiting for status:"completed" raced the
      // cancel against the content update (calibration 2 failed that way).
      if (
        opts.stopAfterToolTitle &&
        tc.output.length > 0 &&
        opts.stopAfterToolTitle.test(tc.title) &&
        !cancelled
      ) {
        cancelled = true;
        writeAcpTrace(trace, "stop_after_tool", { title: tc.title });
        session.notify("session/cancel", { sessionId: session.sessionId });
      }
    }
  };
  const basePermission = session.onPermission;
  session.onPermission = (p) => {
    const answered = basePermission(p);
    permissionRequests.push({
      toolCallId: (p.toolCall as { toolCallId?: string } | undefined)?.toolCallId,
      options: (p.options as AcpPermissionRequest["options"]) ?? [],
      answered,
    });
    return answered;
  };

  try {
    if (!session.sessionId) {
      await session.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        },
        30_000,
      );
      const sess = await session.request("session/new", { cwd: opts.projectDir, mcpServers: [] }, 60_000);
      session.sessionId = String((sess.result as { sessionId?: string } | undefined)?.sessionId ?? "");
      if (!session.sessionId) throw new Error("[kiro-acp-drive] session/new returned no sessionId");
    }

    let reply: { result?: unknown; error?: unknown };
    try {
      reply = await session.request(
        "session/prompt",
        { sessionId: session.sessionId, prompt: [{ type: "text", text: opts.prompt }] },
        timeoutMs,
      );
    } catch (e) {
      // Turn overran the budget — cancel it so the agent stops burning
      // credits, then rethrow: a timeout is a finding, not a soft pass. The
      // trace's tool_call events up to this point show whether the turn was
      // progressing (real tool calls) or stalled — the diagnosis the old
      // stderr:"ignore" + no-trace driver could not give.
      writeAcpTrace(trace, "timeout", {
        timeoutMs,
        toolCallsSoFar: toolCalls.length,
        lastToolTitle: toolCalls.at(-1)?.title,
        cancelled,
      });
      session.notify("session/cancel", { sessionId: session.sessionId });
      throw e;
    }
    const stopReason = (reply.result as { stopReason?: string } | undefined)?.stopReason;
    writeAcpTrace(trace, "result", {
      stopReason,
      toolCalls: toolCalls.length,
      cancelled,
    });
    // Trailing updates can stream after the cancelled reply resolves; give
    // them a beat before snapshotting.
    if (cancelled) await new Promise((r) => setTimeout(r, 1500));

    if (ACP_DIAGNOSTIC) session.traceDiagnostic("aggregate_at_return", {
      stopReason, internalTitleCancel: cancelled,
      calls: toolCalls.map(call => ({
        toolCallId: call.toolCallId, status: call.status,
        input: diagnosticInputShape(call.rawInput), outputChunks: call.output.length,
      })),
      issues: toolCallIssues.map(issue => ({
        toolCallId: issue.toolCallId, status: issue.status, orphan: issue.orphan,
        outputBytes: Buffer.byteLength(issue.output.join("")),
      })),
    });
    const statePath = stateFilePathOf(opts.projectDir);
    return {
      sessionId: session.sessionId,
      stopReason,
      toolCalls,
      assistantText,
      permissionRequests,
      toolCallIssues,
      stateFile: existsSync(statePath) ? readFileSync(statePath, "utf-8") : undefined,
      auditEvents: parseAuditEvents(opts.projectDir),
    };
  } finally {
    writeAcpTrace(trace, "end", { keepAlive: opts.keepAlive === true, cancelled });
    if (!opts.keepAlive) session.close();
  }
}
