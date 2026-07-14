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

export interface AcpPermissionRequest {
  toolCallId?: string;
  options: Array<{ optionId: string; name?: string; kind?: string }>;
  /** The optionId the driver answered with. */
  answered: string;
}

export interface AcpDriveResult {
  sessionId: string;
  stopReason: string | undefined;
  /** Every tool call with its verbatim output — the assertable surface. */
  toolCalls: AcpToolCall[];
  /** Concatenated assistant prose. Debugging only — never assert on this. */
  assistantText: string;
  permissionRequests: AcpPermissionRequest[];
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
          continue; // non-JSON noise: ignore (none observed in the spike)
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
      writeAcpTrace(this.tracePath, "tool_call", {
        toolCallId: u.toolCallId,
        title: u.title,
        toolKind: u.kind,
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
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<{ result?: unknown; error?: unknown }> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[kiro-acp-drive] ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(t);
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

// P4: birth writes the workflow record per-intent — state at
// aidlc/spaces/<space>/intents/<slug>-<id8>/aidlc-state.md, audit as per-clone
// shards at <record>/audit/<host>-<clone>.md — NOT the flat aidlc-docs/. Resolve
// the born record from the active-space + active-intent cursors, falling back to
// the flat layout for a not-yet-born (pre-migration) fixture.
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
      const tc = byId.get(String(u.toolCallId ?? ""));
      if (!tc) return;
      const content = (u.content ?? []) as Array<{ content?: { type?: string; text?: string } }>;
      for (const item of content) {
        if (item.content?.type === "text" && item.content.text) tc.output.push(item.content.text);
      }
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

    const statePath = stateFilePathOf(opts.projectDir);
    return {
      sessionId: session.sessionId,
      stopReason,
      toolCalls,
      assistantText,
      permissionRequests,
      stateFile: existsSync(statePath) ? readFileSync(statePath, "utf-8") : undefined,
      auditEvents: parseAuditEvents(opts.projectDir),
    };
  } finally {
    writeAcpTrace(trace, "end", { keepAlive: opts.keepAlive === true, cancelled });
    if (!opts.keepAlive) session.close();
  }
}
