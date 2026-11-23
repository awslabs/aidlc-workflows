// covers: file:../harness/devin-acp-drive.ts
//
// t-devin-acp-protocol — token-free protocol tests for the Devin ACP driver.
// A fake `devin acp` server is injected through the `spawn` option: it speaks
// newline-delimited JSON-RPC 2.0 over the same stdin/stdout surface the real
// process exposes, replaying the exact wire shapes captured from devin acp
// 3000.11.3/3000.11.92 (run2 trace). No devin binary, no network, no credits.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanDevinOutput,
  createFileHumanBridge,
  driveDevinAcp,
  newestIoDir,
  storedPersonMessages,
  type DevinAcpProcess,
  type DevinAnswerer,
  type DevinPermissionAsk,
} from "../harness/devin-acp-drive.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

type Packet = Record<string, unknown>;

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "t-devin-acp-"));
  scratch.push(dir);
  return dir;
}

interface FakeCtx {
  /** Push a server→client message (notification or request) onto stdout. */
  emit(msg: Packet): void;
  /** Emit a server→client request and await the client's reply message. */
  requestClient(method: string, params: unknown): Promise<Packet>;
  /** Reply to a client request. */
  respond(id: string | number, result: unknown): void;
}

/** A fake `devin acp` server. `script` runs when session/prompt arrives; the
 *  prompt reply is sent when the script resolves. `sent` captures every line
 *  the client wrote (requests, notifications, and replies). */
function fakeAcpServer(script: (ctx: FakeCtx) => unknown) {
  const sent: Packet[] = [];
  const outbuf: string[] = [];
  const waiters: Array<() => void> = [];
  const pendingClientReplies = new Map<string | number, (msg: Packet) => void>();
  let nextServerId = 1;
  const push = (msg: Packet): void => {
    outbuf.push(`${JSON.stringify(msg)}\n`);
    for (const wake of waiters.splice(0)) wake();
  };
  const ctx: FakeCtx = {
    emit: push,
    requestClient(method, params) {
      const id = `srv-${nextServerId++}`;
      return new Promise((resolve) => {
        pendingClientReplies.set(id, resolve);
        push({ jsonrpc: "2.0", id, method, params });
      });
    },
    respond(id, result) {
      push({ jsonrpc: "2.0", id, result });
    },
  };
  const stdout: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      let i = 0;
      const enc = new TextEncoder();
      for (;;) {
        while (i < outbuf.length) yield enc.encode(outbuf[i++]);
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
  const proc: DevinAcpProcess = {
    pid: 4321,
    stdout,
    stderr: null,
    kill() {},
    stdin: {
      write(bytes: Uint8Array) {
        for (const line of new TextDecoder().decode(bytes).split("\n")) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as Packet;
          sent.push(msg);
          if (msg.method === undefined && msg.id !== undefined) {
            // A reply to a server→client request.
            pendingClientReplies.get(msg.id as string | number)?.(msg);
            pendingClientReplies.delete(msg.id as string | number);
            continue;
          }
          if (msg.method === "initialize") {
            ctx.respond(msg.id as string | number, {
              protocolVersion: 1,
              agentInfo: { name: "affogato", title: "Devin Agent", version: "0.0.0-test" },
              authMethods: [{ id: "devin-browser", name: "Log in with browser" }],
              agentCapabilities: {},
            });
          } else if (msg.method === "session/new") {
            ctx.respond(msg.id as string | number, { sessionId: "fake-session" });
          } else if (msg.method === "session/prompt") {
            void Promise.resolve()
              .then(() => script(ctx))
              .then(() => ctx.respond(msg.id as string | number, { stopReason: "end_turn" }));
          }
          // session/cancel and other notifications: recorded in `sent`.
        }
        return bytes.length;
      },
    },
  };
  return {
    spawn: () => proc,
    sent,
    ctx,
    /** Every elicitation/create reply the client wrote, in order. */
    elicitationReplies: () =>
      sent.filter(
        (m) =>
          m.method === undefined &&
          typeof m.id === "string" &&
          String(m.id).startsWith("srv-") &&
          m.result !== undefined &&
          typeof (m.result as { action?: unknown }).action === "string",
      ),
  };
}

function elicitationParams(questions: Record<string, unknown>, opts: { allowOther?: boolean; required?: string[] } = {}): Packet {
  return {
    mode: "form",
    sessionId: "fake-session",
    message: "fixture message",
    requestedSchema: {
      type: "object",
      properties: questions,
      required: opts.required ?? Object.keys(questions),
    },
    ...(opts.allowOther === false ? {} : { _meta: { "cognition.ai/allowOther": true } }),
  };
}

async function waitFor(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
  if (!cond()) throw new Error("waitFor timed out");
}

const UPDATE = (u: Packet) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: "fake-session", update: u },
});

describe("t-devin-acp-protocol — scripted fake ACP server", () => {
  test("1. handshake advertises elicitation, never authenticates, and keeps available commands", async () => {
    const dir = directory();
    const fake = fakeAcpServer((ctx) => {
      ctx.emit(UPDATE({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "login" }, { name: "aidlc" }, { name: "aidlc-init" }],
      }));
    });
    const r = await driveDevinAcp({ projectDir: dir, prompt: "probe", spawn: fake.spawn });
    const methods = fake.sent.map((m) => m.method).filter(Boolean);
    expect(methods).toEqual(["initialize", "session/new", "session/prompt"]);
    const init = fake.sent.find((m) => m.method === "initialize")!;
    expect(init.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
    });
    expect(methods).not.toContain("authenticate");
    expect(r.sessionId).toBe("fake-session");
    expect(r.availableCommands).toEqual(["login", "aidlc", "aidlc-init"]);
    expect(r.stopReason).toBe("end_turn");
  });

  test("2. single-select accepts an offered label; free text needs allowOther", async () => {
    const dir = directory();
    const questions = {
      q0: {
        type: "string",
        title: "Colour",
        description: "Pick a colour",
        oneOf: [
          { const: "Red", title: "Warm" },
          { const: "Blue", title: "Cool" },
        ],
      },
    };
    let variant: "label" | "free" | "forbidden" = "label";
    const answerer: DevinAnswerer = () =>
      variant === "label"
        ? { action: "accept", answers: { q0: "Blue" } }
        : { action: "accept", answers: { q0: "green please" } };

    // offered label
    let fake = fakeAcpServer((ctx) => ctx.requestClient("elicitation/create", elicitationParams(questions)));
    let r = await driveDevinAcp({ projectDir: dir, prompt: "p1", spawn: fake.spawn, answer: answerer });
    expect(fake.elicitationReplies().map((m) => m.result)).toEqual([
      { action: "accept", content: { q0: "Blue" } },
    ]);
    expect(r.elicitations[0].outcome).toBe("answered");

    // free text with allowOther
    variant = "free";
    fake = fakeAcpServer((ctx) => ctx.requestClient("elicitation/create", elicitationParams(questions)));
    r = await driveDevinAcp({ projectDir: dir, prompt: "p2", spawn: fake.spawn, answer: answerer });
    expect(fake.elicitationReplies().map((m) => m.result)).toEqual([
      { action: "accept", content: { q0: "green please" } },
    ]);
    expect(r.elicitations[0].outcome).toBe("answered");

    // free text without allowOther → cancel + unanswered
    variant = "forbidden";
    fake = fakeAcpServer((ctx) =>
      ctx.requestClient("elicitation/create", elicitationParams(questions, { allowOther: false })));
    r = await driveDevinAcp({ projectDir: dir, prompt: "p3", spawn: fake.spawn, answer: answerer });
    expect(fake.elicitationReplies().map((m) => m.result)).toEqual([{ action: "cancel" }]);
    expect(r.elicitations[0].outcome).toBe("unanswered");
  });

  test("3. a batch with a multi-select array replies with arrays and lands one answered record", async () => {
    const dir = directory();
    const questions = {
      q0: {
        type: "string",
        title: "Colour",
        description: "Pick a colour",
        oneOf: [{ const: "Red" }, { const: "Blue" }],
      },
      q1: {
        type: "array",
        title: "Sizes",
        description: "Pick sizes",
        minItems: 1,
        items: { anyOf: [{ const: "Small" }, { const: "Medium" }, { const: "Large" }] },
      },
    };
    const fake = fakeAcpServer((ctx) =>
      ctx.requestClient("elicitation/create", elicitationParams(questions)));
    const answerer: DevinAnswerer = (e) => {
      expect(e.questions.map((q) => q.key)).toEqual(["q0", "q1"]);
      expect(e.questions[1].multiSelect).toBe(true);
      expect(e.questions[1].minItems).toBe(1);
      return { action: "accept", answers: { q0: "Red", q1: ["Small", "Large"] } };
    };
    const r = await driveDevinAcp({ projectDir: dir, prompt: "p", spawn: fake.spawn, answer: answerer });
    expect(fake.elicitationReplies().map((m) => m.result)).toEqual([
      { action: "accept", content: { q0: "Red", q1: ["Small", "Large"] } },
    ]);
    expect(r.elicitations).toHaveLength(1);
    expect(r.elicitations[0].outcome).toBe("answered");
    // The ledger is exercised implicitly: a picker turn that minted no
    // backing would throw from drive() (unbackedFailure) before returning.
  });

  test("4. decline and cancel replies; the failed+rejected ask call is a rejection, not an issue", async () => {
    const dir = directory();
    const actions: Array<"decline" | "cancel"> = ["decline", "cancel"];
    const fake = fakeAcpServer(async (ctx) => {
      for (const [index, action] of actions.entries()) {
        const toolCallId = `ask-${index}`;
        ctx.emit(UPDATE({
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Asked user fixture",
          kind: "other",
          rawInput: { questions: [{ question: "fixture?", header: "h", options: [{ label: "x" }] }] },
          _meta: { "cognition.ai/inferenceToolName": "ask_user_question" },
        }));
        const reply = await ctx.requestClient(
          "elicitation/create",
          elicitationParams({
            q0: { type: "string", title: "h", description: "fixture?", oneOf: [{ const: "x" }] },
          }),
        );
        expect((reply.result as { action?: string }).action).toBe(action);
        ctx.emit(UPDATE({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
          content: [{ type: "content", content: { type: "text", text: "Tool execution was rejected" } }],
          _meta: { "cognition.ai/inferenceToolName": "ask_user_question", "cognition.ai/rejected": true },
        }));
      }
    });
    let n = 0;
    const answerer: DevinAnswerer = () => ({ action: actions[n++] });
    const r = await driveDevinAcp({ projectDir: dir, prompt: "p", spawn: fake.spawn, answer: answerer });
    expect(r.elicitations.map((e) => e.outcome)).toEqual(["declined", "cancelled"]);
    expect(r.rejectedToolCalls.map((c) => c.toolCallId)).toEqual(["ask-0", "ask-1"]);
    expect(r.toolCallIssues).toEqual([]);
    expect(r.toolCalls.every((c) => c.rejected)).toBe(true);
  });

  test("5. no answerer answers with cancel and records unanswered", async () => {
    const dir = directory();
    const fake = fakeAcpServer((ctx) =>
      ctx.requestClient(
        "elicitation/create",
        elicitationParams({ q0: { type: "string", title: "h", description: "q?", oneOf: [{ const: "x" }] } }),
      ));
    const r = await driveDevinAcp({ projectDir: dir, prompt: "p", spawn: fake.spawn });
    expect(fake.elicitationReplies().map((m) => m.result)).toEqual([{ action: "cancel" }]);
    expect(r.elicitations).toHaveLength(1);
    expect(r.elicitations[0].outcome).toBe("unanswered");
  });

  test("6. permission picks allow_once, else reject_once, never an allow_always kind", async () => {
    const dir = directory();
    const full = [
      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      { optionId: "allow_session", name: "allow session", kind: "allow_always" },
      { optionId: "allow_always", name: "always", kind: "allow_always" },
      { optionId: "allow_always_global", name: "global", kind: "allow_always" },
      { optionId: "switch_bypass", name: "bypass", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ];
    const withoutOnce = full.filter((o) => o.optionId !== "allow_once");
    const fake = fakeAcpServer(async (ctx) => {
      for (const options of [full, withoutOnce]) {
        const reply = await ctx.requestClient("session/request_permission", {
          sessionId: "fake-session",
          toolCall: { toolCallId: `exec:${options.length}` },
          options,
        });
        expect((reply.result as { outcome: { outcome: string } }).outcome.outcome).toBe("selected");
      }
    });
    const r = await driveDevinAcp({ projectDir: dir, prompt: "p", spawn: fake.spawn });
    expect(r.permissionRequests.map((p) => p.answered)).toEqual(["allow_once", "reject_once"]);
    for (const p of r.permissionRequests) {
      const chosen = p.options.find((o) => o.optionId === p.answered);
      expect(chosen?.kind).not.toBe("allow_always");
      expect(p.answered).not.toBe("switch_bypass");
    }
  });

  test("7. tool_call_update content is a snapshot: last copy wins; wrap codes clean byte-exact", async () => {
    const dir = directory();
    const text = "full snapshot output body";
    const fake = fakeAcpServer((ctx) => {
      ctx.emit(UPDATE({
        sessionUpdate: "tool_call",
        toolCallId: "toolu_x",
        title: "Ran bun",
        kind: "execute",
        rawInput: { command: "bun thing.ts" },
        _meta: { "cognition.ai/inferenceToolName": "exec" },
      }));
      for (const status of ["in_progress", "in_progress", "completed"]) {
        ctx.emit(UPDATE({
          sessionUpdate: "tool_call_update",
          toolCallId: "toolu_x",
          status,
          // identical repeats — the last snapshot, never a concatenation
          ...(status === "completed" ? {} : { content: [{ type: "content", content: { type: "text", text } }] }),
        }));
      }
    });
    const r = await driveDevinAcp({ projectDir: dir, prompt: "p", spawn: fake.spawn });
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].output).toBe(text);
    expect(r.toolCalls[0].status).toBe("completed");
    // The 120-col display wrap: ESC(B ESC[0m<char>ESC(B ESC[0m\n mid-word.
    expect(cleanDevinOutput("expenses in a\x1b(B\x1b[0m \x1b(B\x1b[0m\nCSV file")).toBe("expenses in a CSV file");
    expect(cleanDevinOutput("category f\x1b(B\x1b[0mo\x1b(B\x1b[0m\nr a month")).toBe("category for a month");
  });

  test("8. subagent lifecycle lands in subagents, unknown updates in orphanUpdates", async () => {
    const dir = directory();
    const fake = fakeAcpServer((ctx) => {
      ctx.emit(UPDATE({
        sessionUpdate: "tool_call_update",
        toolCallId: "agent-1",
        status: "in_progress",
        _meta: { "cognition.ai/subagent_started": { agentId: "agent-1", title: "Review intent", task: "…" } },
      }));
      ctx.emit(UPDATE({
        sessionUpdate: "tool_call_update",
        toolCallId: "agent-1",
        status: "completed",
        _meta: { "cognition.ai/subagent_completed": { agentId: "agent-1", success: true, summary: "done" } },
      }));
      ctx.emit(UPDATE({
        sessionUpdate: "tool_call_update",
        toolCallId: "nobody-announced-me",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "mystery" } }],
      }));
    });
    const r = await driveDevinAcp({ projectDir: dir, prompt: "p", spawn: fake.spawn });
    expect(r.subagents).toEqual([{ agentId: "agent-1", title: "Review intent", success: true, summary: "done" }]);
    expect(r.orphanUpdates).toHaveLength(1);
    expect((r.orphanUpdates[0] as { toolCallId?: string }).toolCallId).toBe("nobody-announced-me");
  });

  test("9. stopAfterCommand cancels once; a later elicitation is after-stop", async () => {
    const dir = directory();
    const fake = fakeAcpServer(async (ctx) => {
      ctx.emit(UPDATE({
        sessionUpdate: "tool_call",
        toolCallId: "toolu_intent",
        title: "Ran bun",
        kind: "execute",
        rawInput: { command: "bun .devin/tools/aidlc.ts engine intent create --scope poc" },
        _meta: { "cognition.ai/inferenceToolName": "exec" },
      }));
      ctx.emit(UPDATE({
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_intent",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "created" } }],
      }));
      const reply = await ctx.requestClient(
        "elicitation/create",
        elicitationParams({ q0: { type: "string", title: "h", description: "q?", oneOf: [{ const: "x" }] } }),
      );
      expect(reply.result).toEqual({ action: "cancel" });
    });
    const r = await driveDevinAcp({
      projectDir: dir,
      prompt: "p",
      spawn: fake.spawn,
      stopAfterCommand: /\bintent\s+create\b/,
      answer: () => ({ action: "accept", answers: { q0: "x" } }),
    });
    const cancels = fake.sent.filter((m) => m.method === "session/cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].params).toEqual({ sessionId: "fake-session" });
    expect(r.elicitations).toHaveLength(1);
    expect(r.elicitations[0].outcome).toBe("after-stop");
  });

  test("10. an unknown server request gets -32601 and is recorded", async () => {
    const dir = directory();
    const fake = fakeAcpServer(async (ctx) => {
      const reply = await ctx.requestClient("fs/read_text_file", { path: "/etc/hostname" });
      expect((reply.error as { code: number }).code).toBe(-32601);
    });
    const r = await driveDevinAcp({ projectDir: dir, prompt: "p", spawn: fake.spawn });
    expect(r.unhandledRequests).toEqual([{ method: "fs/read_text_file" }]);
  });

  test("11b. a throwing answerer still cancels, records unanswered, and keeps the error", async () => {
    const dir = directory();
    const fake = fakeAcpServer((ctx) =>
      ctx.requestClient(
        "elicitation/create",
        elicitationParams({ q0: { type: "string", title: "h", description: "q?", oneOf: [{ const: "x" }] } }),
      ));
    const r = await driveDevinAcp({
      projectDir: dir,
      prompt: "p",
      spawn: fake.spawn,
      answer: () => {
        throw new Error("answerer bug: index out of range");
      },
    });
    expect(fake.elicitationReplies().map((m) => m.result)).toEqual([{ action: "cancel" }]);
    expect(r.elicitations).toHaveLength(1);
    expect(r.elicitations[0].outcome).toBe("unanswered");
    expect(r.elicitations[0].error).toContain("answerer bug: index out of range");
  });

  test("11. storedPersonMessages reads and sorts planted prompt and picker records", () => {
    const dir = directory();
    const messagesDir = join(dir, "aidlc", ".aidlc-sessions", "messages");
    mkdirSync(messagesDir, { recursive: true });
    const base = {
      session: "s", settings: [],
      route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
    };
    const write = (name: string, rec: Record<string, unknown>) =>
      writeFileSync(join(messagesDir, name), `${JSON.stringify(rec)}\n`);
    // planted out of filename order to prove the sort is on `at` then name
    write("b1111111.json", { ...base, id: "b1111111", at: "2026-10-15T04:52:30Z", source: "prompt", text: "later words", picker: null });
    write("a2222222.json", { ...base, id: "a2222222", at: "2026-10-15T04:19:57Z", source: "picker", text: "Pick?: Blue", picker: [{ question: "Pick?", reply: "Blue" }] });
    write("c3333333.json", { ...base, id: "c3333333", at: "2026-10-15T04:19:57Z", source: "picker", text: "Same at, later name", picker: [{ question: "Pick?", reply: null }] });
    write("d4444444.json", { ...base, id: "d4444444", at: "2026-10-15T04:19:57Z", source: "prompt", text: "tie last", picker: null });
    const messages = storedPersonMessages(dir);
    expect(messages.map((m) => m.id)).toEqual(["a2222222", "c3333333", "d4444444", "b1111111"]);
    expect(messages[0]).toMatchObject({ source: "picker", text: "Pick?: Blue" });
    expect(messages[0].picker).toEqual([{ question: "Pick?", reply: "Blue" }]);
    expect(messages[1].picker).toEqual([{ question: "Pick?", reply: null }]);
    expect(messages[3]).toMatchObject({ source: "prompt", text: "later words" });
    expect(storedPersonMessages(join(dir, "nope"))).toEqual([]);
  });
});

  test("12. an async permission answerer sees the exec command, toolCallId and options, and its pick goes on the wire", async () => {
    const dir = directory();
    const seen: DevinPermissionAsk[] = [];
    const fake = fakeAcpServer(async (ctx) => {
      ctx.emit(UPDATE({
        sessionUpdate: "tool_call",
        toolCallId: "tc-exec-1",
        title: "Ran bun",
        kind: "execute",
        rawInput: { command: "bun .devin/tools/aidlc.ts engine next" },
        _meta: { "cognition.ai/inferenceToolName": "exec" },
      }));
      const reply = await ctx.requestClient("session/request_permission", {
        sessionId: "fake-session",
        toolCall: { toolCallId: "tc-exec-1", title: "Ran bun" },
        options: [
          { optionId: "allow_once", kind: "allow_once" },
          { optionId: "allow_session", kind: "allow_always" },
          { optionId: "reject_once", kind: "reject_once" },
        ],
      });
      expect((reply.result as { outcome: { outcome: string; optionId?: string } }).outcome)
        .toEqual({ outcome: "selected", optionId: "allow_session" });
    });
    const r = await driveDevinAcp({
      projectDir: dir,
      prompt: "p",
      spawn: fake.spawn,
      permission: async (ask) => {
        seen.push(ask);
        await new Promise((res) => setTimeout(res, 50));
        return "allow_session";
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolCallId).toBe("tc-exec-1");
    expect(seen[0]!.tool).toBe("exec");
    expect(seen[0]!.command).toBe("bun .devin/tools/aidlc.ts engine next");
    expect(seen[0]!.options.map((o) => o.optionId)).toContain("allow_session");
    expect(r.permissionRequests).toHaveLength(1);
    expect(r.permissionRequests[0]).toMatchObject({
      answered: "allow_session", by: "answerer",
      command: "bun .devin/tools/aidlc.ts engine next",
    });
  });

  test("13. an answerer's non-offered optionId replies cancelled and records the error", async () => {
    const dir = directory();
    const fake = fakeAcpServer(async (ctx) => {
      const reply = await ctx.requestClient("session/request_permission", {
        sessionId: "fake-session",
        toolCall: { toolCallId: "tc-1", title: "Ran rm" },
        options: [{ optionId: "allow_once", kind: "allow_once" }],
      });
      expect((reply.result as { outcome: { outcome: string } }).outcome.outcome).toBe("cancelled");
    });
    const r = await driveDevinAcp({
      projectDir: dir,
      prompt: "p",
      spawn: fake.spawn,
      permission: () => "bogus_option",
    });
    expect(r.permissionRequests[0]).toMatchObject({
      answered: "(cancelled)", by: "answerer",
    });
    expect(r.permissionRequests[0]!.error).toContain("bogus_option");
  });

  test("14. with no answerer the default still picks allow_once and marks by: driver", async () => {
    const dir = directory();
    const fake = fakeAcpServer(async (ctx) => {
      const reply = await ctx.requestClient("session/request_permission", {
        sessionId: "fake-session",
        toolCall: { toolCallId: "tc-1", title: "Ran ls" },
        options: [{ optionId: "allow_once", kind: "allow_once" }, { optionId: "allow_session", kind: "allow_always" }],
      });
      expect((reply.result as { outcome: { outcome: string; optionId?: string } }).outcome)
        .toEqual({ outcome: "selected", optionId: "allow_once" });
    });
    const r = await driveDevinAcp({ projectDir: dir, prompt: "p", spawn: fake.spawn });
    expect(r.permissionRequests[0]).toMatchObject({ answered: "allow_once", by: "driver" });
  });

  test("15. the onUpdate observer sees every update before the driver handles it", async () => {
    const dir = directory();
    const seen: string[] = [];
    const fake = fakeAcpServer((ctx) => {
      ctx.emit(UPDATE({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello " },
      }));
      ctx.emit(UPDATE({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "world" },
      }));
    });
    const r = await driveDevinAcp({
      projectDir: dir,
      prompt: "p",
      spawn: fake.spawn,
      onUpdate: (u) => seen.push(String(u.sessionUpdate)),
    });
    expect(seen.filter((k) => k === "agent_message_chunk")).toHaveLength(2);
    expect(r.assistantText).toBe("hello world");
  });

  test("16. the file bridge answers a question (bad file then good), a permission, and prompts", async () => {
    const io = join(directory(), "io");
    const bridge = createFileHumanBridge(io);
    const elicitation = {
      id: "srv-1",
      message: "msg",
      allowOther: false,
      raw: {},
      questions: [{
        key: "q0", header: "H", question: "Pick", required: true, multiSelect: false,
        options: [{ label: "Red" }, { label: "Blue" }],
      }],
    };
    const pending = bridge.answer(elicitation, { turn: 1, previous: [] });
    await waitFor(() => existsSync(join(io, "question-1.json")));
    // An invalid answer file: error file appears, answer file removed, still waiting.
    writeFileSync(join(io, "question-1.answer.json"), "{not json");
    await waitFor(() => existsSync(join(io, "question-1.error.txt")));
    expect(existsSync(join(io, "question-1.answer.json"))).toBe(false);
    writeFileSync(join(io, "question-1.answer.json"), JSON.stringify({ action: "accept", answers: { q0: "Blue" } }));
    const reply = await pending;
    expect(reply).toEqual({ action: "accept", answers: { q0: "Blue" } });
    // The asked file and the answer stay as the record; the error file goes.
    expect(existsSync(join(io, "question-1.json"))).toBe(true);
    expect(existsSync(join(io, "question-1.error.txt"))).toBe(false);

    // Permission round trip: the ask is written, the offered optionId returns.
    const perm = bridge.permission({
      tool: "exec", command: "rm -rf x", title: "Ran rm",
      options: [{ optionId: "allow_once" }, { optionId: "reject_once" }],
    });
    await waitFor(() => existsSync(join(io, "permission-1.json")));
    const asked = JSON.parse(readFileSync(join(io, "permission-1.json"), "utf-8")) as { command?: string };
    expect(asked.command).toBe("rm -rf x");
    writeFileSync(join(io, "permission-1.answer"), "reject_once\n");
    expect(await perm).toBe("reject_once");
    expect(existsSync(join(io, "permission-1.json"))).toBe(true);

    // Prompts: text then STOP.
    writeFileSync(join(io, "prompt-1.txt"), "build it\n");
    expect(await bridge.nextPrompt(1)).toBe("build it");
    writeFileSync(join(io, "prompt-2.txt"), "STOP\n");
    expect(await bridge.nextPrompt(2)).toBe("STOP");
  });

  test("17. the human io default is the newest devin-acp-human-* by mtime, not by name", () => {
    // A hand-named dir (issue6-B) sorts past a fresh timestamped one
    // lexically; the resolver must follow modification time so a stale
    // session is never driven.
    const logs = join(REPO_ROOT, "tests", "logs");
    const early = join(logs, "devin-acp-human-20000101T000000Z");
    const lateNamed = join(logs, "devin-acp-human-zz-mtime-check");
    mkdirSync(early, { recursive: true });
    mkdirSync(lateNamed, { recursive: true });
    scratch.push(early, lateNamed);
    try {
      const past = new Date("2020-01-01T00:00:00Z");
      const now = new Date();
      utimesSync(early, now, now);
      utimesSync(lateNamed, past, past);
      expect(lateNamed > early).toBe(true); // lexical order picks the stale dir
      expect(newestIoDir()).toBe(early);
    } finally {
      rmSync(early, { recursive: true, force: true });
      rmSync(lateNamed, { recursive: true, force: true });
    }
  });
