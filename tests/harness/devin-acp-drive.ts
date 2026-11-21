// devin-acp-drive.ts — the Devin ACP harness driver: the scripted "logic
// half" for the Devin harness over the Agent Client Protocol (`devin acp`:
// JSON-RPC 2.0, newline-delimited, over stdio). Scripted by default; the
// `human` CLI mode below is the explicit person-in-the-loop path — a file
// bridge where the person answers every question AND every host permission
// prompt (owner decision 2026-10-22).
//
// WIRE CONTRACT (verified against a captured full-intent run on devin
// 3000.11.3 and re-run on 3000.11.92):
//   - spawn `devin acp` (AIDLC_DEVIN_BIN override) in the project cwd;
//     initialize (protocolVersion 1, clientCapabilities.elicitation.form,
//     clientInfo aidlc-devin-acp-drive) returns agentInfo "affogato"/"Devin
//     Agent" plus authMethods [{id:"devin-browser"}]. authenticate is NEVER
//     called: devin-browser is a PKCE browser flow that fails headless
//     (-32603 "Could not open browser"), and the stored CLI credentials
//     already satisfy session/new.
//   - session/new {cwd, mcpServers: []} returns {sessionId} (a slug like
//     "jeweled-bronze"). SessionStart hooks fire on session/new.
//   - session/prompt {sessionId, prompt:[{type:"text",text}]} resolves with
//     {stopReason} when the turn ends; a whole intent can run in one turn.
//   - ask_user_question surfaces as a server→client elicitation/create
//     REQUEST (string-UUID id): params.requestedSchema.properties holds
//     q0..qN in order, each {type:"string"|"array", title:<header>,
//     description:<question text>, oneOf|items.anyOf:[{const:<label>,
//     title:<option description>}]}, required lists the keys that must be
//     answered, _meta["cognition.ai/allowOther"] permits free text. Reply
//     {action:"accept", content:{q0:"<label or free text>", q1:["<label>"]}}
//     | {action:"decline"} | {action:"cancel"}.
//   - tool_call {toolCallId, title, kind, rawInput, _meta:
//     {"cognition.ai/inferenceToolName": "exec"|"read"|"write"|"edit"|"grep"|
//     "find_file_by_name"|"ask_user_question"|"run_subagent", optionally
//     "cognition.ai/subagent_context":{parentAgentId}}}. exec's real command
//     is rawInput.command (the title is decorative).
//   - tool_call_update content is a SNAPSHOT, not a chunk: each update
//     carrying content[].content.text repeats the full output (identical
//     repeats, sometimes growing prefixes). Keep the LAST text snapshot;
//     never concatenate. Non-text content (diff, resource_link) is kept raw
//     in `content`. status goes in_progress … then "completed" (the
//     completed update usually carries no content) or "failed".
//   - Tool output text carries Devin's display wrap codes every ~120
//     columns — ESC(B ESC[0m<char>ESC(B ESC[0m\n mid-word — cleaned by
//     cleanDevinOutput.
//   - A declined/cancelled question ends its ask call as a tool_call_update
//     status:"failed" with _meta["cognition.ai/rejected"]:true and text
//     "Tool execution was rejected: …" — a rejection, not a tool failure.
//   - Subagent lifecycle arrives as tool_call_update WITHOUT a preceding
//     tool_call, toolCallId = agentId: _meta["cognition.ai/subagent_started"]
//     {agentId,title,task} then _meta["cognition.ai/subagent_completed"]
//     {agentId,success,summary}. Recorded under `subagents`, never orphans.
//   - session/request_permission params.options carry allow_once (kind
//     allow_once), allow_session/allow_always/allow_always_global/
//     switch_bypass (all kind allow_always — these WRITE the person's Devin
//     settings), reject_once. Reply {outcome:{outcome:"selected", optionId}}.
//     With a `permission` answerer the driver offers the whole list — which
//     option to take is the person's call, including the session/always
//     options. The default driver still only picks allow_once/reject_once.
//   - Any other server→client request gets a -32601 method-not-found reply
//     and is recorded. Vendor notifications (_cognition.ai/*) and the other
//     session/update kinds (usage_update, session_info_update,
//     config_option_update, current_mode_update, available_commands_update)
//     are traced by name, not depended on.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { PersonTurnLedger, unbackedFailure } from "./person-turns.ts";
import {
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  LIVE_STARTUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "./test-budget.ts";
import {
  compareTriples,
  DEVIN_MIN_VERSION,
  DEVIN_MIN_VERSION_STRING,
  parseVersionTriple,
} from "../../core/tools/aidlc-devin-version.ts";
import { REPO_ROOT } from "./fixtures.ts";

const DEVIN_DIST = join(REPO_ROOT, "dist", "devin");
export const DEVIN_BIN: string = process.env.AIDLC_DEVIN_BIN ?? "devin";

/** Why the live Devin ACP tier cannot run, or null when it can. */
export function devinAcpSkipReason(): string | null {
  if (process.env.AIDLC_DEVIN_ACP_LIVE !== "1") {
    return "set AIDLC_DEVIN_ACP_LIVE=1 to run the live Devin ACP tests (uses the signed-in Devin CLI and spends Devin credits)";
  }
  const probe = spawnSync(DEVIN_BIN, ["--version"], {
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: "Devin ACP version probe" }),
  });
  const version = parseVersionTriple(probe.stdout ?? "");
  if (probe.status !== 0 || version === null || compareTriples(version, DEVIN_MIN_VERSION) < 0) {
    return `devin >= ${DEVIN_MIN_VERSION_STRING} not found (AIDLC_DEVIN_BIN=${DEVIN_BIN})`;
  }
  if (!existsSync(DEVIN_DIST)) return `distributable missing: ${DEVIN_DIST}`;
  return null;
}

/** Strip Devin's display wrap codes: ESC(B ESC[0m<char>ESC(B ESC[0m\n wraps
 *  one char every ~120 columns; the newline is display-only. Leftover codes
 *  (unpaired) are removed after. */
export function cleanDevinOutput(text: string): string {
  return text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the display wrap codes are what this strips.
    .replace(/\x1b\(B\x1b\[0m([\s\S])\x1b\(B\x1b\[0m\n/g, "$1")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: same — leftover unpaired codes.
    .replace(/\x1b\(B\x1b\[0m/g, "");
}

/** The subprocess surface the driver needs — satisfied by Bun.spawn's
 *  subprocess and by the in-process fake the protocol unit test injects. */
export interface DevinAcpProcess {
  stdin: { write(bytes: Uint8Array): unknown };
  stdout: AsyncIterable<Uint8Array>;
  stderr?: AsyncIterable<Uint8Array> | null;
  pid?: number;
  kill(): void;
}

export interface DevinQuestion {
  /** The schema property key the reply addresses ("q0", "q1", …). */
  key: string;
  /** requestedSchema title — Devin's `header`. */
  header: string;
  /** requestedSchema description — the question text as asked. */
  question: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  minItems?: number;
  /** In requestedSchema.required — an answer that leaves it out is invalid. */
  required: boolean;
}

export interface DevinElicitation {
  id: string;
  message: string;
  questions: DevinQuestion[];
  allowOther: boolean;
  raw: unknown;
}

export type DevinAnswer =
  | { action: "accept"; answers: Record<string, string | string[]> }
  | { action: "decline" }
  | { action: "cancel" };

export type DevinAnswerer = (
  e: DevinElicitation,
  ctx: { turn: number; previous: DevinElicitationRecord[] },
) => DevinAnswer | undefined | Promise<DevinAnswer | undefined>;

export interface DevinElicitationRecord {
  elicitation: DevinElicitation;
  /** The answer actually sent (a generated cancel for unanswered/after-stop). */
  answer: DevinAnswer;
  outcome: "answered" | "declined" | "cancelled" | "unanswered" | "after-stop";
  turn: number;
  /** The answerer's thrown error message, when it produced one (test bug signal). */
  error?: string;
}

export interface DevinToolCall {
  toolCallId: string;
  /** e.g. "Ran bun" / "Asked user <question>" — decorative, never authoritative. */
  title: string;
  kind: string;
  /** _meta["cognition.ai/inferenceToolName"] — exec, read, ask_user_question, … */
  tool: string;
  rawInput: unknown;
  /** The last text snapshot the host sent (updates repeat full output). */
  output: string;
  /** The last raw content array the host sent (all content types). */
  content: unknown[];
  status: string;
  /** Set for a subagent child's call (_meta subagent_context.parentAgentId). */
  parentAgentId?: string;
  /** _meta["cognition.ai/rejected"] — the person declined/cancelled the call. */
  rejected: boolean;
}

export interface DevinSubagent {
  agentId: string;
  title?: string;
  success?: boolean;
  summary?: string;
}

export interface DevinPermissionRequest {
  options: Array<{ optionId: string; name?: string; kind?: string }>;
  /** The optionId the driver answered with, or "(cancelled)" when no safe option existed. */
  answered: string;
  /** The exec call's rawInput.command when the request names one. */
  command?: string;
  /** Who picked: the injected answerer or the driver's default policy. */
  by: "answerer" | "driver";
  /** Set when the answerer returned an optionId the request did not offer. */
  error?: string;
}

/** One permission prompt offered to the person: the params the host sent
 *  plus the tool name and exec command the driver recorded for the call. */
export interface DevinPermissionAsk {
  toolCallId?: string;
  /** _meta inferenceToolName of the named tool call (exec, read, …). */
  tool?: string;
  title?: string;
  /** rawInput.command for an exec call. */
  command?: string;
  options: Array<{ optionId: string; name?: string; kind?: string }>;
}

/** Answers a permission request with one of the OFFERED optionIds — the
 *  person's choice, session/always options included. May be async. */
export type DevinPermissionAnswerer = (
  ask: DevinPermissionAsk,
) => string | Promise<string>;

export interface DevinAcpDriveOptions {
  projectDir: string;
  prompt: string;
  /** Reuse a live session (never closed by drive — caller closes it). */
  session?: DevinAcpSession;
  /** Injected spawn (the unit test's fake); defaults to Bun.spawn devin acp. */
  spawn?: (args: string[], cwd: string) => DevinAcpProcess;
  /** Per-turn timeout (the whole session/prompt round-trip). */
  timeoutMs?: number;
  /** Answers the elicitation/create requests; undefined return = no answer. */
  answer?: DevinAnswerer;
  /** Answers session/request_permission with an offered optionId. Without
   *  it the driver's default policy (allow_once, else reject_once) stands. */
  permission?: DevinPermissionAnswerer;
  /** Observer: called for EVERY session/update of the turn, before the
   *  driver's own handling. Pure side-channel (chat logs, progress). */
  onUpdate?: (update: Record<string, unknown>) => void;
  /** Send session/cancel once an exec call whose rawInput.command matches
   *  reaches status "completed". Devin honours it: the turn ends and
   *  session/prompt resolves with stopReason "cancelled" (verified live on
   *  3000.11.92 — both stopAfterCommand turns resolved "cancelled"). */
  stopAfterCommand?: RegExp;
}

export interface DevinAcpDriveResult {
  sessionId: string;
  stopReason?: string;
  toolCalls: DevinToolCall[];
  /** Calls that failed WITHOUT the person's rejection — real issues. */
  toolCallIssues: DevinToolCall[];
  /** Calls the person rejected (declined/cancelled question). */
  rejectedToolCalls: DevinToolCall[];
  /** tool_call_updates with no tool_call and no recognized lifecycle meta. */
  orphanUpdates: unknown[];
  subagents: DevinSubagent[];
  elicitations: DevinElicitationRecord[];
  permissionRequests: DevinPermissionRequest[];
  unhandledRequests: { method: string }[];
  availableCommands: string[];
  /** Concatenated assistant prose. Debugging only — never assert on it. */
  assistantText: string;
  /** aidlc state file contents after the turn, if present. */
  stateFile?: string;
  /** Audit **Event**: types, in file order across the record's shards. */
  auditEvents?: string[];
}

// --- Debug trace (parity with kiro-acp-drive.ts) ----------------------------

function acpTracePath(): string | undefined {
  if (process.env.AIDLC_ACP_TRACE_FILE) return process.env.AIDLC_ACP_TRACE_FILE;
  if (process.env.AIDLC_TEST_DEBUG === "true" && process.env.AIDLC_TEST_LOG_DIR) {
    return join(process.env.AIDLC_TEST_LOG_DIR, `devin-acp-drive-${process.pid}.ndjson`);
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

interface Pending {
  resolve: (msg: { result?: unknown; error?: unknown }) => void;
}

/** A live `devin acp` process + session, reusable across drive() turns. */
export class DevinAcpSession {
  readonly proc: DevinAcpProcess;
  readonly projectDir: string;
  sessionId = "";
  /** Latest available_commands_update names ("aidlc", "aidlc-init", …). */
  availableCommands: string[] = [];
  /** Elicitation records across every drive on this session. */
  readonly elicitationHistory: DevinElicitationRecord[] = [];
  /** How many drive() calls this session has run. */
  turnCount = 0;
  readonly tracePath: string | undefined;
  /** Per-turn sinks, swapped by drive(). */
  onUpdate: (update: Record<string, unknown>) => void = () => {};
  /** The drive answers elicitations through this; the default records an
   *  unanswered record and cancels (a question with no drive is never left
   *  hanging the wire). */
  onElicitation: (
    params: Record<string, unknown>,
    id: string | number,
    respond: (result: unknown) => void,
  ) => void = (params, id, respond) => {
    const elicitation = parseDevinElicitation(id, params);
    this.elicitationHistory.push({
      elicitation,
      answer: { action: "cancel" },
      outcome: "unanswered",
      turn: this.turnCount,
    });
    respond({ action: "cancel" });
  };
  onPermission: (params: Record<string, unknown>) => string | Promise<string> = (params) =>
    choosePermissionOption(
      (params.options as Array<{ optionId: string; kind?: string }>) ?? [],
    );
  onUnhandledRequest: (method: string) => void = () => {};

  private nextId = 1;
  private pending = new Map<string | number, Pending>();
  private buf = "";
  private dec = new TextDecoder();
  private enc = new TextEncoder();

  constructor(
    projectDir: string,
    spawn?: (args: string[], cwd: string) => DevinAcpProcess,
  ) {
    remainingOperationTimeoutMs(undefined, { phase: "Devin ACP launch" });
    this.projectDir = projectDir;
    this.tracePath = acpTracePath();
    const launcher = spawn ?? ((args: string[], cwd: string) => {
      const proc = Bun.spawn(args, {
        cwd,
        stdin: "pipe",
        stdout: "pipe",
        // In --debug, PIPE stderr and tee it into the trace; otherwise
        // ignore it (devin's stderr carries the diagnostics that explain a
        // timeout).
        stderr: this.tracePath ? "pipe" : "ignore",
      });
      return proc as unknown as DevinAcpProcess;
    });
    const args = [DEVIN_BIN, "acp"];
    writeAcpTrace(this.tracePath, "spawn", { args, cwd: projectDir });
    this.proc = launcher(args, projectDir);
    void this.readLoop();
    if (this.tracePath) void this.stderrLoop();
  }

  private async stderrLoop(): Promise<void> {
    const stderr = this.proc.stderr;
    if (!stderr) return;
    let sbuf = "";
    try {
      for await (const chunk of stderr) {
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
    for await (const chunk of this.proc.stdout) {
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
          writeAcpTrace(this.tracePath, "parse_error", { byteLength: line.length });
          continue;
        }
        this.dispatch(msg);
      }
    }
  }

  private replyResult(id: string | number, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  private replyError(id: string | number, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = msg.id as string | number | undefined;
    const method = msg.method as string | undefined;
    // A response to one of our requests (id only, no method).
    if (method === undefined && id !== undefined && ("result" in msg || "error" in msg) && this.pending.has(id)) {
      writeAcpTrace(this.tracePath, "reply", {
        id,
        ok: !("error" in msg),
        error: "error" in msg ? msg.error : undefined,
      });
      this.pending.get(id)!.resolve(msg as { result?: unknown; error?: unknown });
      this.pending.delete(id);
      return;
    }
    if (method === undefined) return;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    // Server→client request (has an id — a reply is owed).
    if (id !== undefined) {
      if (method === "elicitation/create") {
        this.onElicitation(params, id, (result) => this.replyResult(id, result));
        return;
      }
      if (method === "session/request_permission") {
        // The answerer may be async (a person writing an answer file); the
        // reply still goes on the wire exactly once.
        void Promise.resolve(this.onPermission(params)).then((optionId) => {
          writeAcpTrace(this.tracePath, "permission", {
            optionId,
            options: params.options,
          });
          if (optionId === "") {
            this.replyResult(id, { outcome: { outcome: "cancelled" } });
          } else {
            this.replyResult(id, { outcome: { outcome: "selected", optionId } });
          }
        });
        return;
      }
      // Anything else we did not advertise: log in full, refuse method-not-found.
      writeAcpTrace(this.tracePath, "unhandled_request", { id, method, params });
      this.onUnhandledRequest(method);
      this.replyError(id, -32601, `Method not found: ${method}`);
      return;
    }
    // Notification (no id).
    if (method === "session/update") {
      const update = (params.update ?? {}) as Record<string, unknown>;
      if (update.sessionUpdate === "available_commands_update") {
        const commands = update.availableCommands;
        this.availableCommands = Array.isArray(commands)
          ? commands
              .map((c) => (c !== null && typeof c === "object" ? (c as { name?: unknown }).name : undefined))
              .filter((name): name is string => typeof name === "string")
          : [];
      }
      this.traceUpdate(update);
      this.onUpdate(update);
      return;
    }
    // Vendor and other notifications: traced by method name only.
    writeAcpTrace(this.tracePath, "notification", { method });
  }

  /** Trace a session/update, condensing the noisy/non-deterministic kinds. */
  private traceUpdate(u: Record<string, unknown>): void {
    if (!this.tracePath) return;
    const kind = u.sessionUpdate as string;
    if (kind === "tool_call") {
      const rawInput = u.rawInput;
      const inputKeys =
        rawInput !== null && typeof rawInput === "object" && !Array.isArray(rawInput)
          ? Object.keys(rawInput).sort()
          : [];
      const meta = (u._meta ?? {}) as Record<string, unknown>;
      writeAcpTrace(this.tracePath, "tool_call", {
        toolCallId: u.toolCallId,
        title: u.title,
        toolKind: u.kind,
        tool: meta["cognition.ai/inferenceToolName"],
        parentAgentId: (meta["cognition.ai/subagent_context"] as { parentAgentId?: unknown } | undefined)?.parentAgentId,
        inputKeys,
        command: typeof (rawInput as { command?: unknown } | null)?.command === "string"
          ? (rawInput as { command: string }).command.slice(0, 240)
          : undefined,
      });
    } else if (kind === "tool_call_update") {
      const content = (u.content ?? []) as Array<{ content?: { type?: string; text?: string } }>;
      const text = content.map((c) => c.content?.text ?? "").join("");
      const meta = (u._meta ?? {}) as Record<string, unknown>;
      writeAcpTrace(this.tracePath, "tool_call_update", {
        toolCallId: u.toolCallId,
        status: u.status,
        byteLength: text.length,
        preview: cleanDevinOutput(text).slice(0, 240),
        subagentStarted: meta["cognition.ai/subagent_started"] !== undefined || undefined,
        subagentCompleted: meta["cognition.ai/subagent_completed"] !== undefined || undefined,
        rejected: meta["cognition.ai/rejected"] === true || undefined,
      });
    } else {
      writeAcpTrace(this.tracePath, "update", { kind });
    }
  }

  private send(obj: unknown): void {
    this.proc.stdin.write(this.enc.encode(`${JSON.stringify(obj)}\n`));
  }

  /** Fire-and-forget JSON-RPC notification (no id, no reply expected). */
  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(
    method: string,
    params: unknown,
    timeoutMs: number,
    deadlineMs?: number,
  ): Promise<{ result?: unknown; error?: unknown }> {
    const allocation = remainingOperationTimeoutMs(timeoutMs, { deadlineMs, phase: `Devin ACP ${method}` });
    if (allocation === undefined) throw new Error("Invalid test budget: ACP requests require a positive timeout");
    timeoutMs = allocation;
    const id = this.nextId++;
    writeAcpTrace(this.tracePath, "request", { id, method, params });
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[devin-acp-drive] ${method} timed out after ${timeoutMs}ms`));
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

/** Spawn + handshake (initialize with the elicitation form capability, then
 *  session/new; never authenticate — stored credentials carry it). */
export async function openDevinAcpSession(
  projectDir: string,
  opts?: {
    spawn?: (args: string[], cwd: string) => DevinAcpProcess;
    timeoutMs?: number;
  },
): Promise<DevinAcpSession> {
  const session = new DevinAcpSession(projectDir, opts?.spawn);
  const handshake = opts?.timeoutMs ?? LIVE_STARTUP_TIMEOUT_MS;
  const init = await session.request(
    "initialize",
    {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
      clientInfo: { name: "aidlc-devin-acp-drive", version: "1" },
    },
    handshake,
  );
  if (init.error) {
    session.close();
    throw new Error(`[devin-acp-drive] initialize failed: ${JSON.stringify(init.error)}`);
  }
  const sess = await session.request(
    "session/new",
    { cwd: projectDir, mcpServers: [] },
    handshake,
  );
  if (sess.error) {
    session.close();
    throw new Error(`[devin-acp-drive] session/new failed: ${JSON.stringify(sess.error)}`);
  }
  session.sessionId = String((sess.result as { sessionId?: string } | undefined)?.sessionId ?? "");
  if (!session.sessionId) {
    session.close();
    throw new Error("[devin-acp-drive] session/new returned no sessionId");
  }
  return session;
}

/** Parse an elicitation/create params object into the driver's question list. */
function parseDevinElicitation(id: string | number, params: Record<string, unknown>): DevinElicitation {
  const schema = (params.requestedSchema ?? {}) as {
    properties?: Record<string, unknown>;
    required?: unknown;
  };
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((k): k is string => typeof k === "string")
      : [],
  );
  const questions: DevinQuestion[] = [];
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const p = (prop ?? {}) as Record<string, unknown>;
    const multiSelect = p.type === "array";
    const rawOptions = multiSelect
      ? (p.items as { anyOf?: unknown[] } | undefined)?.anyOf
      : p.oneOf;
    const options = (Array.isArray(rawOptions) ? rawOptions : [])
      .map((o) => {
        const opt = (o ?? {}) as { const?: unknown; title?: unknown };
        return {
          label: typeof opt.const === "string" ? opt.const : String(opt.const ?? ""),
          ...(typeof opt.title === "string" ? { description: opt.title } : {}),
        };
      });
    const question: DevinQuestion = {
      key,
      header: typeof p.title === "string" ? p.title : "",
      question: typeof p.description === "string" ? p.description : "",
      options,
      multiSelect,
      ...(typeof p.minItems === "number" ? { minItems: p.minItems } : {}),
      required: required.has(key),
    };
    questions.push(question);
  }
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  return {
    id: String(id),
    message: typeof params.message === "string" ? params.message : "",
    questions,
    allowOther: meta["cognition.ai/allowOther"] === true,
    raw: params,
  };
}

/** The one option a driver may pick: allow_once, else reject_once. The
 *  allow_always-kind options and switch_bypass write the person's Devin
 *  settings — never chosen. Returns "" when neither safe option exists. */
function choosePermissionOption(
  options: Array<{ optionId: string; kind?: string }>,
): string {
  const once = options.find((o) => o.kind === "allow_once" || o.optionId === "allow_once");
  if (once) return once.optionId;
  const reject = options.find((o) => o.kind === "reject_once" || o.optionId === "reject_once");
  if (reject) return reject.optionId;
  return "";
}

/** Is this accept structurally valid against the schema? Free text (a string
 *  that names no offered label) is only legal when allowOther. */
function validAnswer(elicitation: DevinElicitation, answer: DevinAnswer): boolean {
  if (answer.action !== "accept") return true;
  const answers = answer.answers;
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) return false;
  const byKey = new Map(elicitation.questions.map((q) => [q.key, q]));
  for (const q of elicitation.questions) {
    const value = answers[q.key];
    const empty =
      value === undefined || value === null ||
      (typeof value === "string" && value.trim() === "") ||
      (Array.isArray(value) && value.length === 0);
    if (q.required && empty) return false;
  }
  for (const [key, value] of Object.entries(answers)) {
    const q = byKey.get(key);
    if (!q) return false;
    const labels = new Set(q.options.map((o) => o.label));
    const itemOk = (item: unknown): boolean => {
      if (typeof item !== "string" || item.trim() === "") return false;
      return labels.has(item) || elicitation.allowOther;
    };
    if (q.multiSelect) {
      if (!Array.isArray(value)) return false;
      if (value.length < (q.minItems ?? 0)) return false;
      if (!value.every(itemOk)) return false;
    } else {
      if (typeof value !== "string") return false;
      if (!itemOk(value)) return false;
    }
  }
  return true;
}

/** The ledger words for an accept: the single reply, or one
 *  `<question>: <reply>` line per question for a batch (the same layout the
 *  message store writes). */
function acceptWords(elicitation: DevinElicitation, answers: Record<string, string | string[]>): string {
  const joined = elicitation.questions
    .filter((q) => answers[q.key] !== undefined)
    .map((q) => {
      const value = answers[q.key];
      return { question: q.question, reply: Array.isArray(value) ? value.join(", ") : String(value) };
    });
  if (joined.length <= 1) return joined[0]?.reply ?? "";
  return joined.map((entry) => `${entry.question}: ${entry.reply}`).join("\n");
}

// P4 per-intent record resolution (mirrors kiro-acp-drive's copy): state at
// aidlc/spaces/<space>/intents/<slug>-<id8>/aidlc-state.md, audit as per-clone
// shards at <record>/audit/*.md — falling back to a flat aidlc-docs/ layout.
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

function parseAuditEvents(projectDir: string): string[] | undefined {
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

/** Run one agentic turn through `devin acp` and return structure. Opens its
 *  own session when none is passed and closes it at the end; a passed-in
 *  session is never closed here (caller closes it in `finally`). */
export async function driveDevinAcp(opts: DevinAcpDriveOptions): Promise<DevinAcpDriveResult> {
  const timeoutMs = opts.timeoutMs ?? LIVE_LONG_OPERATION_TIMEOUT_MS;
  const deadlineMs = Date.now() + remainingOperationTimeoutMs(timeoutMs, { phase: "Devin ACP turn" })!;
  const ownSession = opts.session === undefined;
  const session = opts.session ??
    (await openDevinAcpSession(opts.projectDir, {
      spawn: opts.spawn,
      timeoutMs: remainingOperationTimeoutMs(LIVE_STARTUP_TIMEOUT_MS, {
        deadlineMs,
        phase: "Devin ACP handshake",
      }),
    }));
  session.turnCount += 1;
  const turn = session.turnCount;
  const trace = session.tracePath;
  const personTurns = new PersonTurnLedger(opts.projectDir);
  writeAcpTrace(trace, "start", {
    turn,
    prompt: opts.prompt,
    projectDir: opts.projectDir,
    timeoutMs,
    reusedSession: !ownSession,
    stopAfterCommand: opts.stopAfterCommand?.source,
  });

  const toolCalls: DevinToolCall[] = [];
  const byId = new Map<string, DevinToolCall>();
  const toolCallIssues: DevinToolCall[] = [];
  const rejectedToolCalls: DevinToolCall[] = [];
  const orphanUpdates: unknown[] = [];
  const subagents: DevinSubagent[] = [];
  const subagentById = new Map<string, DevinSubagent>();
  const elicitations: DevinElicitationRecord[] = [];
  const permissionRequests: DevinPermissionRequest[] = [];
  const unhandledRequests: { method: string }[] = [];
  let assistantText = "";
  let cancelled = false;

  session.onUpdate = (u) => {
    try {
      opts.onUpdate?.(u);
    } catch {
      /* an observer's bug never eats the driver's own handling */
    }
    const kind = u.sessionUpdate as string;
    if (kind === "agent_message_chunk") {
      const c = u.content as { type?: string; text?: string } | undefined;
      if (c?.type === "text" && c.text) assistantText += c.text;
      return;
    }
    if (kind === "tool_call") {
      const meta = (u._meta ?? {}) as Record<string, unknown>;
      const parent = (meta["cognition.ai/subagent_context"] as { parentAgentId?: unknown } | undefined)?.parentAgentId;
      const tc: DevinToolCall = {
        toolCallId: String(u.toolCallId ?? ""),
        title: String(u.title ?? ""),
        kind: String(u.kind ?? ""),
        tool: String(meta["cognition.ai/inferenceToolName"] ?? ""),
        rawInput: u.rawInput,
        output: "",
        content: [],
        status: "started",
        rejected: false,
        ...(typeof parent === "string" && parent !== "root" ? { parentAgentId: parent } : {}),
      };
      toolCalls.push(tc);
      byId.set(tc.toolCallId, tc);
      return;
    }
    if (kind !== "tool_call_update") return;
    const meta = (u._meta ?? {}) as Record<string, unknown>;
    const toolCallId = String(u.toolCallId ?? "");
    // Subagent lifecycle rides bare tool_call_updates keyed by agentId —
    // never a tool_call and never an orphan.
    const started = meta["cognition.ai/subagent_started"] as
      { agentId?: string; title?: string; task?: string } | undefined;
    const completed = meta["cognition.ai/subagent_completed"] as
      { agentId?: string; success?: boolean; summary?: string } | undefined;
    if (started || completed) {
      const agentId = String(started?.agentId ?? completed?.agentId ?? toolCallId);
      let entry = subagentById.get(agentId);
      if (!entry) {
        entry = { agentId };
        subagentById.set(agentId, entry);
        subagents.push(entry);
      }
      if (started?.title !== undefined) entry.title = started.title;
      if (completed?.success !== undefined) entry.success = completed.success;
      if (completed?.summary !== undefined) entry.summary = completed.summary;
      writeAcpTrace(trace, started ? "subagent_start" : "subagent_complete", {
        agentId,
        title: started?.title,
        success: completed?.success,
      });
      return;
    }
    const rejected = meta["cognition.ai/rejected"] === true;
    let tc = byId.get(toolCallId);
    if (!tc) {
      if (rejected) {
        // A rejected call the host never announced (rejection before start):
        // the person said no — keep it visible, never an issue or an orphan.
        tc = {
          toolCallId,
          title: String(u.title ?? ""),
          kind: String(u.kind ?? ""),
          tool: String(meta["cognition.ai/inferenceToolName"] ?? ""),
          rawInput: u.rawInput,
          output: "",
          content: [],
          status: String(u.status ?? ""),
          rejected: true,
        };
        rejectedToolCalls.push(tc);
      } else {
        orphanUpdates.push(u);
      }
      return;
    }
    // Snapshot semantics: the LAST content array wins; the last text-bearing
    // snapshot is the output (a completed update usually carries none).
    if (Array.isArray(u.content)) {
      tc.content = u.content;
      const texts = (u.content as Array<{ content?: { type?: string; text?: string } }>)
        .map((item) => (item.content?.type === "text" ? item.content.text : undefined))
        .filter((text): text is string => typeof text === "string" && text !== "");
      if (texts.length > 0) tc.output = texts.join("");
    }
    const status = u.status !== undefined ? String(u.status) : "";
    const alreadyFailed = tc.status === "failed";
    if (status) tc.status = status;
    if (rejected) tc.rejected = true;
    if (status === "failed" && !alreadyFailed) {
      (rejected ? rejectedToolCalls : toolCallIssues).push(tc);
    }
    // Stop as soon as the matched command COMPLETED — its output is already
    // captured; waiting longer lets the turn roll into unrelated work.
    if (
      opts.stopAfterCommand &&
      !cancelled &&
      status === "completed" &&
      (tc.kind === "execute" || tc.tool === "exec") &&
      typeof (tc.rawInput as { command?: unknown } | null)?.command === "string" &&
      opts.stopAfterCommand.test((tc.rawInput as { command: string }).command)
    ) {
      cancelled = true;
      writeAcpTrace(trace, "stop_after_command", {
        command: (tc.rawInput as { command: string }).command,
      });
      session.notify("session/cancel", { sessionId: session.sessionId });
    }
  };

  session.onElicitation = (params, id, respond) => {
    const elicitation = parseDevinElicitation(id, params);
    writeAcpTrace(trace, "elicitation", {
      id: elicitation.id,
      message: elicitation.message,
      allowOther: elicitation.allowOther,
      questions: elicitation.questions,
    });
    const finish = (
      answer: DevinAnswer,
      outcome: DevinElicitationRecord["outcome"],
      error?: string,
    ): void => {
      const record: DevinElicitationRecord = { elicitation, answer, outcome, turn, ...(error !== undefined ? { error } : {}) };
      elicitations.push(record);
      session.elicitationHistory.push(record);
      writeAcpTrace(trace, "elicitation_reply", { id: elicitation.id, answer, error });
      respond(
        answer.action === "accept"
          ? { action: "accept", content: answer.answers }
          : { action: answer.action },
      );
    };
    if (cancelled) {
      finish({ action: "cancel" }, "after-stop");
      return;
    }
    void (async () => {
      let answer: DevinAnswer | undefined;
      let answerError: string | undefined;
      try {
        answer = opts.answer
          ? await opts.answer(elicitation, { turn, previous: [...session.elicitationHistory] })
          : undefined;
      } catch (e) {
        // A throwing answerer is a test bug, not silence: still cancel (the
        // wire must be replied), but record the error on the record and trace.
        answerError = e instanceof Error ? e.message : String(e);
        writeAcpTrace(trace, "answerer_error", { id: elicitation.id, error: answerError });
        answer = undefined;
      }
      if (!answer || !validAnswer(elicitation, answer)) {
        finish({ action: "cancel" }, "unanswered", answerError);
        return;
      }
      if (answer.action === "accept") {
        // The pick is a person turn: record it BEFORE the reply reaches the
        // wire so its audit cursor predates every row the answer produces.
        personTurns.sent(
          acceptWords(elicitation, answer.answers),
          Object.keys(answer.answers).length,
        );
        finish(answer, "answered");
        return;
      }
      finish(answer, answer.action === "decline" ? "declined" : "cancelled");
    })();
  };

  session.onPermission = async (params) => {
    const options = (params.options as DevinPermissionRequest["options"]) ?? [];
    const toolCall = (params.toolCall ?? {}) as { toolCallId?: unknown; id?: unknown; title?: unknown };
    const toolCallId = typeof toolCall.toolCallId === "string"
      ? toolCall.toolCallId
      : typeof toolCall.id === "string" ? toolCall.id : undefined;
    const named = toolCallId !== undefined ? byId.get(toolCallId) : undefined;
    const ask: DevinPermissionAsk = {
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      ...(named?.tool ? { tool: named.tool } : {}),
      ...(typeof toolCall.title === "string" ? { title: toolCall.title } : {}),
      ...(typeof (named?.rawInput as { command?: unknown } | null)?.command === "string"
        ? { command: (named!.rawInput as { command: string }).command }
        : {}),
      options,
    };
    if (opts.permission) {
      let optionId = "";
      let error: string | undefined;
      try {
        optionId = await opts.permission(ask);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      if (optionId === "" || !options.some((o) => o.optionId === optionId)) {
        // A non-offered optionId can never be selected — cancel and record.
        const why = error ?? `answerer returned unoffered optionId "${optionId}"`;
        permissionRequests.push({
          options,
          answered: "(cancelled)",
          ...(ask.command !== undefined ? { command: ask.command } : {}),
          by: "answerer",
          error: why,
        });
        return "";
      }
      permissionRequests.push({
        options,
        answered: optionId,
        ...(ask.command !== undefined ? { command: ask.command } : {}),
        by: "answerer",
      });
      return optionId;
    }
    const answered = choosePermissionOption(options);
    permissionRequests.push({
      options,
      answered: answered === "" ? "(cancelled)" : answered,
      ...(ask.command !== undefined ? { command: ask.command } : {}),
      by: "driver",
    });
    return answered;
  };
  session.onUnhandledRequest = (method) => {
    unhandledRequests.push({ method });
  };

  try {
    let reply: { result?: unknown; error?: unknown };
    // This turn's prompt is the person's only turn in it.
    personTurns.sent(opts.prompt);
    try {
      reply = await session.request(
        "session/prompt",
        { sessionId: session.sessionId, prompt: [{ type: "text", text: opts.prompt }] },
        timeoutMs,
        deadlineMs,
      );
    } catch (e) {
      // Turn overran the budget — cancel so the agent stops burning credits,
      // then rethrow: a timeout is a finding, not a soft pass.
      writeAcpTrace(trace, "timeout", {
        timeoutMs,
        toolCallsSoFar: toolCalls.length,
        lastToolTitle: toolCalls.at(-1)?.title,
        cancelled,
      });
      session.notify("session/cancel", { sessionId: session.sessionId });
      throw e;
    }
    if (reply.error) {
      throw new Error(`[devin-acp-drive] session/prompt failed: ${JSON.stringify(reply.error)}`);
    }
    const stopReason = (reply.result as { stopReason?: string } | undefined)?.stopReason;
    writeAcpTrace(trace, "result", {
      stopReason,
      toolCalls: toolCalls.length,
      elicitations: elicitations.length,
      cancelled,
      assistantTextTail: assistantText.slice(-2000),
    });
    // Trailing updates can stream after the cancelled reply resolves; give
    // them a beat before snapshotting.
    if (cancelled) await new Promise((r) => setTimeout(r, 1500));

    const statePath = join(recordDirOf(opts.projectDir), "aidlc-state.md");
    const unbacked = personTurns.unbacked();
    if (unbacked.length > 0) {
      writeAcpTrace(trace, "unbacked_decision", { decisions: unbacked });
      throw unbackedFailure("The Devin ACP turn", unbacked);
    }
    return {
      sessionId: session.sessionId,
      stopReason,
      toolCalls,
      toolCallIssues,
      rejectedToolCalls,
      orphanUpdates,
      subagents,
      elicitations,
      permissionRequests,
      unhandledRequests,
      availableCommands: [...session.availableCommands],
      assistantText,
      stateFile: existsSync(statePath) ? readFileSync(statePath, "utf-8") : undefined,
      auditEvents: parseAuditEvents(opts.projectDir),
    };
  } finally {
    writeAcpTrace(trace, "end", { turn, ownSession, cancelled });
    if (ownSession) session.close();
  }
}

/** The person-turn message records this project stored, oldest first
 *  (`aidlc/.aidlc-sessions/messages/*.json`, sorted by `at` then file name).
 *  On disk a picker's reply is a string or null (never an array — a
 *  multi-select arrives joined ", "); the wider type only admits what a
 *  fixture could plant. */
export function storedPersonMessages(projectDir: string): {
  id: string;
  at: string;
  source: string;
  text: string;
  picker: { question: string; reply: string | string[] | null }[] | null;
}[] {
  const dir = join(projectDir, "aidlc", ".aidlc-sessions", "messages");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      let rec: Record<string, unknown> = {};
      try {
        rec = JSON.parse(readFileSync(join(dir, name), "utf-8")) as Record<string, unknown>;
      } catch {
        /* unreadable file — keep a placeholder so the sort still sees it */
      }
      return {
        name,
        id: typeof rec.id === "string" ? rec.id : name.replace(/\.json$/, ""),
        at: typeof rec.at === "string" ? rec.at : "",
        source: typeof rec.source === "string" ? rec.source : "",
        text: typeof rec.text === "string" ? rec.text : "",
        picker: Array.isArray(rec.picker)
          ? (rec.picker as { question: string; reply: string | string[] | null }[])
          : null,
      };
    })
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name: _name, ...rest }) => rest);
}


// --- Human mode: the person-in-the-loop file bridge --------------------------
//
// `human start` spawns a live `devin acp` session and exposes the whole
// conversation as files in an io dir: the person reads chat.log, and answers
// questions/permissions by writing answer files (`human answer`), and drives
// turns by writing prompt files (`human say` / `human stop`). Every pending
// file is written atomically (tmp + rename) so the other side never reads a
// half-written file.

export interface DevinHumanBridge {
  answer: DevinAnswerer;
  permission: DevinPermissionAnswerer;
  onUpdate: (update: Record<string, unknown>) => void;
  /** Block until prompt-<turn>.txt appears; returns its text ("STOP" ends). */
  nextPrompt: (turn: number) => Promise<string>;
  log: (line: string) => void;
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

async function waitForFile(path: string): Promise<string> {
  while (!existsSync(path)) await new Promise((r) => setTimeout(r, 1000));
  return readFileSync(path, "utf-8");
}

export function createFileHumanBridge(ioDir: string): DevinHumanBridge {
  mkdirSync(ioDir, { recursive: true });
  const log = (line: string): void =>
    appendFileSync(join(ioDir, "events.log"), `${new Date().toISOString()} ${line}\n`);
  const chat = (text: string): void => appendFileSync(join(ioDir, "chat.log"), text);
  let questionCount = 0;
  let permissionCount = 0;

  const answer: DevinAnswerer = async (elicitation) => {
    const n = ++questionCount;
    const pending = join(ioDir, `question-${n}.json`);
    const answerFile = join(ioDir, `question-${n}.answer.json`);
    const errorFile = join(ioDir, `question-${n}.error.txt`);
    writeAtomic(pending, JSON.stringify({
      message: elicitation.message,
      allowOther: elicitation.allowOther,
      questions: elicitation.questions,
    }, null, 2));
    log(`QUESTION ${n} waiting (${elicitation.questions.length} keys)`);
    for (;;) {
      const raw = await waitForFile(answerFile);
      let reply: DevinAnswer;
      try {
        reply = JSON.parse(raw) as DevinAnswer;
      } catch (e) {
        writeAtomic(errorFile, `question-${n}.answer.json is not JSON: ${e instanceof Error ? e.message : String(e)}\n`);
        rmSilently(answerFile);
        continue;
      }
      if (!validAnswer(elicitation, reply)) {
        writeAtomic(errorFile, `question-${n}.answer.json is not a valid DevinAnswer for this elicitation\n`);
        rmSilently(answerFile);
        continue;
      }
      rmSilently(errorFile);
      log(`QUESTION ${n} answered -> ${reply.action}`);
      return reply;
    }
  };

  const permission: DevinPermissionAnswerer = async (ask) => {
    const n = ++permissionCount;
    const pending = join(ioDir, `permission-${n}.json`);
    const answerFile = join(ioDir, `permission-${n}.answer`);
    const errorFile = join(ioDir, `permission-${n}.error.txt`);
    writeAtomic(pending, JSON.stringify({
      tool: ask.tool,
      command: ask.command,
      title: ask.title,
      options: ask.options,
    }, null, 2));
    log(`PERMISSION ${n} waiting tool=${ask.tool ?? "?"} command=${ask.command?.slice(0, 120) ?? "-"}`);
    for (;;) {
      const optionId = (await waitForFile(answerFile)).trim();
      if (!ask.options.some((o) => o.optionId === optionId)) {
        writeAtomic(errorFile, `permission-${n}.answer names "${optionId}", which was not offered (${ask.options.map((o) => o.optionId).join(", ")})\n`);
        rmSilently(answerFile);
        continue;
      }
      rmSilently(errorFile);
      log(`PERMISSION ${n} answered -> ${optionId}`);
      return optionId;
    }
  };

  const onUpdate = (u: Record<string, unknown>): void => {
    const kind = u.sessionUpdate as string;
    if (kind === "agent_message_chunk") {
      const c = u.content as { type?: string; text?: string } | undefined;
      if (c?.type === "text" && c.text) chat(c.text);
      return;
    }
    if (kind === "tool_call") {
      const meta = (u._meta ?? {}) as Record<string, unknown>;
      const tool = String(meta["cognition.ai/inferenceToolName"] ?? "");
      const raw = u.rawInput as Record<string, unknown> | undefined;
      const detail = tool === "exec"
        ? String(raw?.command ?? "").slice(0, 200)
        : tool === "run_subagent"
        ? `profile=${String(raw?.profile ?? "")}`
        : String(u.title ?? "");
      chat(`\n  [tool ${tool}] ${detail}\n`);
    }
  };

  const nextPrompt = async (turn: number): Promise<string> => {
    const path = join(ioDir, `prompt-${turn}.txt`);
    const text = (await waitForFile(path)).trim();
    if (text === "STOP") return "STOP";
    chat(`\n\n===== PERSON (turn ${turn}): ${text}\n\n`);
    log(`TURN ${turn} prompt: ${text.slice(0, 200)}`);
    return text;
  };

  return { answer, permission, onUpdate, nextPrompt, log };
}

function rmSilently(path: string): void {
  rmSync(path, { force: true });
}

// --- human CLI ---------------------------------------------------------------
//
//   bun tests/harness/devin-acp-drive.ts human <verb>
//
// Runs OUTSIDE tests/run-tests.ts on the production guard profile — no
// AIDLC_SKIP_*/AIDLC_DISABLE_* bypasses. It spends real Devin credits on the
// person's own signed-in devin CLI.

const HUMAN_HELP = `bun tests/harness/devin-acp-drive.ts human <verb>

Drive a Devin acp session as a person through files in an io dir.

verbs:
  start [--io DIR] [--project DIR]   spawn the session (io default:
                                     tests/logs/devin-acp-human-<UTC>/)
  next  [--io DIR] [--wait-s N=270]  block until the person is needed; prints
                                     new chat + the pending item.
                                     exit 0 pending / 2 timeout / 3 ended
  answer <question-N|permission-N> <value> [--io DIR]
                                     write the answer file (question value is
                                     a DevinAnswer JSON, permission an optionId)
  say "<text>" [--io DIR]            write the next prompt-<N>.txt
  stop [--io DIR]                    write STOP as the next prompt

question-N.answer.json is a DevinAnswer, one of:
  {"action":"accept","answers":{"q0":"<option label or your own words>",
                                "q1":["<label>"]}}
  {"action":"decline"}
  {"action":"cancel"}
(the wire to Devin uses content, the answer file uses answers: a single
question's reply is an option label or your own words, a multi-select's is
an array of labels)

The person sees chat.log (assistant prose + [tool] lines), pending files
question-N.json / permission-N.json, and events.log. The project is left in
place when the session ends. This spends Devin credits and runs the
production guard profile — no test bypasses.
`;

interface HumanArgs { verb: string; io?: string; project?: string; waitS: number; rest: string[] }

function humanArgs(argv: string[]): HumanArgs {
  const out: HumanArgs = { verb: "", waitS: 270, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--io") { out.io = argv[++i]; continue; }
    if (a === "--project") { out.project = argv[++i]; continue; }
    if (a === "--wait-s") { out.waitS = Number(argv[++i] ?? "270"); continue; }
    if (!out.verb) { out.verb = a; continue; }
    out.rest.push(a);
  }
  return out;
}

// The default io dir is the newest devin-acp-human-* BY MTIME, not by name:
// a hand-named dir (devin-acp-human-issue6-B) sorts past a fresh timestamped
// one, and lexical order would drive the stale session.
export function newestIoDir(): string | undefined {
  const logs = join(REPO_ROOT, "tests", "logs");
  if (!existsSync(logs)) return undefined;
  const dirs = readdirSync(logs)
    .filter((d) => d.startsWith("devin-acp-human-"))
    .map((d) => {
      try {
        return { path: join(logs, d), mtimeMs: statSync(join(logs, d)).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((d): d is { path: string; mtimeMs: number } => d !== undefined)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  return dirs.length > 0 ? dirs[dirs.length - 1]!.path : undefined;
}

function humanIo(given: string | undefined): string {
  const io = given ?? newestIoDir();
  if (!io || !existsSync(io)) {
    throw new Error(`no io dir — pass --io DIR or run 'human start' first (newest tests/logs/devin-acp-human-*)`);
  }
  return io;
}

function nextPromptNumber(io: string): number {
  const files = readdirSync(io).filter((f) => /^prompt-\d+\.txt$/.test(f));
  return files.length + 1;
}

async function humanStart(io: string, projectArg: string | undefined): Promise<void> {
  const { setupDevinProject } = await import("./exec-drive.ts");
  const { testGuardEnvironment } = await import("./runner-profile.ts");
  mkdirSync(io, { recursive: true });
  // Human mode runs the production profile: any AIDLC_SKIP_*/DISABLE_* the
  // caller's env carries is forced off before devin is spawned.
  Object.assign(process.env, testGuardEnvironment(process.env, "production"));
  if (!process.env.AIDLC_ACP_TRACE_FILE) {
    process.env.AIDLC_ACP_TRACE_FILE = join(io, "trace.ndjson");
  }
  let projectDir = projectArg;
  if (!projectDir) {
    if (!existsSync(join(REPO_ROOT, "dist", "devin"))) {
      throw new Error("dist/devin missing — run `bun scripts/package.ts` first");
    }
    projectDir = setupDevinProject().proj;
  }
  const bridge = createFileHumanBridge(io);
  bridge.log(`project ${projectDir}`);
  const session = await openDevinAcpSession(projectDir, { timeoutMs: 10 * 60_000 });
  const ver = spawnSync(DEVIN_BIN, ["--version"], { encoding: "utf-8" });
  writeAtomic(join(io, "session.json"), JSON.stringify({
    project: projectDir,
    sessionId: session.sessionId,
    devinVersion: (ver.stdout ?? "").trim() || null,
    guardProfile: "production",
    startedAt: new Date().toISOString(),
  }, null, 2));
  bridge.log(`session ${session.sessionId} guardProfile=production`);
  for (let turn = 1; ; turn++) {
    bridge.log(`TURN ${turn} waiting for prompt-${turn}.txt`);
    const prompt = await bridge.nextPrompt(turn);
    if (prompt === "STOP") break;
    const r = await driveDevinAcp({
      projectDir,
      session,
      prompt,
      timeoutMs: 3 * 60 * 60_000,
      answer: bridge.answer,
      permission: bridge.permission,
      onUpdate: bridge.onUpdate,
    });
    writeAtomic(join(io, `turn-${turn}.result.json`), JSON.stringify({
      turn,
      stopReason: r.stopReason,
      tools: r.toolCalls.length,
      toolCallIssues: r.toolCallIssues.map((c) => ({ tool: c.tool, status: c.status, out: c.output.slice(0, 300) })),
      subagents: r.subagents,
      elicitations: r.elicitations.map((x) => ({ outcome: x.outcome, headers: x.elicitation.questions.map((q) => q.header), error: x.error })),
      permissionRequests: r.permissionRequests,
      unhandledRequests: r.unhandledRequests,
      auditTail: (r.auditEvents ?? []).slice(-15),
    }, null, 2));
    bridge.log(`TURN ${turn} ended stopReason=${r.stopReason}`);
  }
  session.close();
  writeAtomic(join(io, "session-end.json"), `${JSON.stringify({ endedAt: new Date().toISOString() })}\n`);
  bridge.log("closed");
  console.log(`session ended. project left in place: ${projectDir}`);
}

async function humanNext(io: string, waitS: number): Promise<number> {
  const offsetFile = join(io, ".chat-offset");
  const chatPath = join(io, "chat.log");
  const stat = () => (existsSync(chatPath) ? readFileSync(chatPath, "utf-8").length : 0);
  const pending = (): { file: string; kind: string } | null => {
    if (existsSync(join(io, "session-end.json"))) return { file: "session-end.json", kind: "ended" };
    // An asked file stays as the record; it is pending until its answer exists.
    for (const f of readdirSync(io).filter((n) => /^question-\d+\.json$/.test(n)).sort()) {
      if (!existsSync(join(io, f.replace(/\.json$/, ".answer.json")))) return { file: f, kind: "question" };
    }
    for (const f of readdirSync(io).filter((n) => /^permission-\d+\.json$/.test(n)).sort()) {
      if (!existsSync(join(io, f.replace(/\.json$/, ".answer")))) return { file: f, kind: "permission" };
    }
    const turns = readdirSync(io)
      .filter((n) => /^turn-\d+\.result\.json$/.test(n))
      .map((n) => Number(n.replace(/^turn-/, "").replace(/\.result\.json$/, "")))
      .sort((a, b) => a - b);
    const last = turns.at(-1) ?? 0;
    if (!existsSync(join(io, `prompt-${last + 1}.txt`))) {
      return { file: last === 0 ? "prompt-1.txt (write the first prompt with 'human say')" : `turn-${last}.result.json (next: 'human say' or 'human stop')`, kind: "prompt" };
    }
    return null;
  };
  const deadline = Date.now() + waitS * 1000;
  let hit = pending();
  while (!hit && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    hit = pending();
  }
  const off = existsSync(offsetFile) ? Number(readFileSync(offsetFile, "utf-8").trim()) : 0;
  const size = stat();
  const fresh = existsSync(chatPath) ? readFileSync(chatPath, "utf-8").slice(off) : "";
  const lines = fresh.split("\n");
  const toolLines = lines.filter((l) => l.startsWith("  [tool "));
  const prose = lines.filter((l) => !l.startsWith("  [tool ")).join("\n");
  writeAtomic(offsetFile, `${size}`);
  console.log("===== CHAT (new) =====");
  console.log(prose.slice(-6000));
  console.log("===== TOOLS (new, last 12) =====");
  for (const l of toolLines.slice(-12)) console.log(l);
  if (!hit) {
    console.log("===== nothing pending yet =====");
    const events = join(io, "events.log");
    if (existsSync(events)) console.log(readFileSync(events, "utf-8").split("\n").filter(Boolean).slice(-3).join("\n"));
    return 2;
  }
  if (hit.kind === "ended") {
    console.log("===== SESSION ENDED =====");
    return 3;
  }
  console.log(`===== PENDING: ${hit.file} =====`);
  if (existsSync(join(io, hit.file))) {
    console.log(readFileSync(join(io, hit.file), "utf-8"));
  }
  return 0;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "human" && (argv.includes("--help") || argv[1] === undefined)) {
    console.log(HUMAN_HELP);
    process.exit(argv[1] === undefined ? 1 : 0);
  }
  if (argv[0] === "human") {
    const args = humanArgs(argv.slice(1));
    try {
      if (args.verb === "start") {
        const io = args.io ?? join(
          REPO_ROOT, "tests", "logs",
          `devin-acp-human-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z")}`,
        );
        await humanStart(io, args.project);
        process.exit(0);
      }
      const io = humanIo(args.io);
      if (args.verb === "next") process.exit(await humanNext(io, args.waitS));
      if (args.verb === "answer") {
        const [name, value] = args.rest;
        if (!name || value === undefined) throw new Error("usage: human answer <question-N|permission-N> <value>");
        const target = name.startsWith("question-")
          ? join(io, `${name}.answer.json`)
          : join(io, `${name}.answer`);
        const asked = join(io, `${name}.json`);
        if (!existsSync(asked)) throw new Error(`${name}.json is not pending in ${io}`);
        writeAtomic(target, `${value}\n`);
        console.log(`${target} written`);
        process.exit(0);
      }
      if (args.verb === "say") {
        const text = args.rest.join(" ");
        if (!text) throw new Error("usage: human say \"<text>\"");
        const n = nextPromptNumber(io);
        writeAtomic(join(io, `prompt-${n}.txt`), `${text}\n`);
        console.log(`prompt-${n}.txt written to ${io}`);
        process.exit(0);
      }
      if (args.verb === "stop") {
        const n = nextPromptNumber(io);
        writeAtomic(join(io, `prompt-${n}.txt`), "STOP\n");
        console.log(`prompt-${n}.txt (STOP) written to ${io}`);
        process.exit(0);
      }
      console.error(`unknown verb: ${args.verb}`);
      console.log(HUMAN_HELP);
      process.exit(1);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }
}
