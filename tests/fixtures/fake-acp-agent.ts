// A scripted ACP agent for tests: JSON-RPC 2.0 over stdio, the shape the review
// daemon drives (aidlc-review-ui-acp.ts). One prompt turn runs a fixed script -
// text, a tool call, a permission request, a form question, an unknown
// server->client request - so a test can assert each bridge from the outside.
//
// Sessions persist under `<cwd>/.fake-acp-sessions/` so `session/load` across a
// process restart can be exercised. Environment knobs:
//   FAKE_ACP_SCRIPT=quiet     one text chunk, then end_turn (no questions)
//   FAKE_ACP_SCRIPT=hang      the turn never ends until session/cancel
//   FAKE_ACP_EXIT_AFTER_INIT  exit(3) on session/new instead of answering (process death mid-request)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const script = process.env.FAKE_ACP_SCRIPT ?? "full";
let buffer = "";
let nextId = 1;
const pending = new Map<number, (message: Rpc) => void>();
let cancelled = false;
let sessionCwd = process.cwd();

interface Rpc {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

function send(message: Rpc): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function request(method: string, params: unknown): Promise<Rpc> {
  const id = nextId++;
  const { promise, resolve } = Promise.withResolvers<Rpc>();
  pending.set(id, resolve);
  send({ id, method, params: params as Record<string, unknown> });
  return promise;
}

function update(sessionId: string, body: Record<string, unknown>): void {
  send({ method: "session/update", params: { sessionId, update: body } });
}

function sessionsDir(): string {
  return join(sessionCwd, ".fake-acp-sessions");
}

async function prompt(id: number | string, params: Record<string, unknown>): Promise<void> {
  const sessionId = String(params.sessionId);
  const text = Array.isArray(params.prompt) ? (params.prompt as Array<{ text?: string }>).map((block) => block.text ?? "").join("") : "";
  cancelled = false;
  const finish = (stopReason: string): void => send({ id, result: { stopReason } });

  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Working on: ${text}` } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ` (run=${process.env.AIDLC_REVIEW_RUN ?? "unset"})` } });
  if (script === "quiet") {
    finish("end_turn");
    return;
  }
  if (script === "hang") {
    const tick = setInterval(() => {
      if (cancelled) {
        clearInterval(tick);
        finish("cancelled");
      }
    }, 20);
    return;
  }

  update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Read aidlc-state.md", kind: "read", status: "in_progress" });
  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" });

  const permission = await request("session/request_permission", {
    sessionId,
    toolCall: { toolCallId: "call-2", title: "Run `bun test`", kind: "execute", status: "pending", rawInput: { command: "bun test" } },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject", name: "Deny", kind: "reject_once" },
    ],
  });
  const outcome = (permission.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
  if (cancelled || outcome?.outcome === "cancelled") {
    finish("cancelled");
    return;
  }
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `permission=${outcome?.optionId ?? "none"}` } });
  if (outcome?.optionId === "reject") {
    finish("end_turn");
    return;
  }

  const unknown = await request("fs/read_text_file", { sessionId, path: "/etc/passwd" });
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `unknown-request=${unknown.error ? unknown.error.code : "answered"}` },
  });

  const question = await request("elicitation/create", {
    sessionId,
    mode: "form",
    toolCallId: "call-3",
    message: "Which database should the todo app use?",
    requestedSchema: {
      type: "object",
      properties: {
        question_0: { type: "string", title: "Database", oneOf: [{ const: "SQLite", title: "SQLite" }, { const: "Postgres", title: "Postgres", description: "Needs a server" }] },
        question_0_custom: { type: "string", title: "Other" },
      },
    },
  });
  const answer = question.result as { action?: string; content?: Record<string, unknown> } | undefined;
  if (cancelled || answer?.action === "cancel") {
    finish("cancelled");
    return;
  }
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `answer=${answer?.action}:${String(answer?.content?.question_0_custom || answer?.content?.question_0 || "")}` },
  });
  finish("end_turn");
}

function onMessage(message: Rpc): void {
  if (message.method === undefined && message.id !== undefined) {
    const resolve = typeof message.id === "number" ? pending.get(message.id) : undefined;
    if (resolve) {
      pending.delete(message.id as number);
      resolve(message);
    }
    return;
  }
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      send({
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-acp-agent", version: "1.0.0" },
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false, embeddedContext: false } },
        },
      });
      return;
    case "session/new": {
      if (process.env.FAKE_ACP_EXIT_AFTER_INIT) process.exit(3);
      sessionCwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
      const sessionId = `fake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      mkdirSync(sessionsDir(), { recursive: true });
      writeFileSync(join(sessionsDir(), `${sessionId}.json`), JSON.stringify({ created: new Date().toISOString() }));
      send({ id: message.id, result: { sessionId, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
      return;
    }
    case "session/load": {
      sessionCwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
      const sessionId = String(params.sessionId ?? "");
      const path = join(sessionsDir(), `${sessionId}.json`);
      if (!existsSync(path)) {
        send({ id: message.id, error: { code: -32602, message: `unknown session ${sessionId}` } });
        return;
      }
      // Replay: the adapter streams the prior transcript before answering.
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `restored ${readFileSync(path, "utf-8").length} bytes` } });
      send({ id: message.id, result: { modes: { currentModeId: "default", availableModes: [] } } });
      return;
    }
    case "session/prompt":
      void prompt(message.id!, params);
      return;
    case "session/cancel":
      cancelled = true;
      for (const [id, resolve] of pending) {
        pending.delete(id);
        resolve({ result: { outcome: { outcome: "cancelled" }, action: "cancel" } });
      }
      return;
    default:
      if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      try {
        onMessage(JSON.parse(line) as Rpc);
      } catch {
        // ignore malformed input
      }
    }
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
