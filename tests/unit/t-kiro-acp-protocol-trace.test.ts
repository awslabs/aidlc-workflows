// Token-free ACP protocol fixtures. The injected AcpSession adapter uses the
// real dispatch/request/diagnostic methods without constructing a CLI process.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AcpSession as Session, AcpToolCall } from "../harness/kiro-acp-drive.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const savedDiagnostic = process.env.AIDLC_ACP_DIAGNOSTIC_TRACE;
process.env.AIDLC_ACP_DIAGNOSTIC_TRACE = "1";
const {
  AcpSession, driveKiroAcp, decodeKiroOrchestrateInvocation, findKiroOrchestrateNextCall,
} = await import("../harness/kiro-acp-drive.ts");
afterAll(() => {
  if (savedDiagnostic === undefined) delete process.env.AIDLC_ACP_DIAGNOSTIC_TRACE;
  else process.env.AIDLC_ACP_DIAGNOSTIC_TRACE = savedDiagnostic;
});
const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "aidlc-acp-protocol-"));
  scratch.push(path);
  return path;
}
type Packet = Record<string, unknown>;
type Internal = { dispatch(packet: Packet): void; readLoop(): Promise<void> };
let nextInstance = 0;
function adapter(
  trace: string,
  respond: (packet: Packet, emit: (packet: Packet) => void, session: Session) => unknown = () => ({}),
) {
  const sent: Packet[] = [];
  const session = Object.create(AcpSession.prototype) as Session;
  const internal = session as unknown as Internal;
  const emit = (packet: Packet) => internal.dispatch(packet);
  const instance = ++nextInstance;
  Object.assign(session, {
    sessionId: `fixture-session-${instance}`,
    diagnosticInstance: instance, diagnosticTurn: 0,
    tracePath: trace, nextId: 1, pending: new Map(),
    buf: "", dec: new TextDecoder(), enc: new TextEncoder(),
    onUpdate: () => {}, onPermission: () => "allow_once",
    proc: {
      pid: 10_000 + instance,
      stdin: {
        write(bytes: Uint8Array) {
          const packet = JSON.parse(new TextDecoder().decode(bytes)) as Packet;
          sent.push(packet);
          if (packet.id !== undefined) queueMicrotask(() => {
            const result = respond(packet, emit, session);
            emit({ jsonrpc: "2.0", id: packet.id, result });
          });
          return bytes.length;
        },
      },
      kill() {},
    },
  });
  return { session, internal, emit, sent };
}
function update(value: Packet, sessionId: string, method = "session/update"): Packet {
  return { jsonrpc: "2.0", method, params: { sessionId, update: value } };
}
interface DiagnosticRow {
  event: string;
  sequence?: number;
  instance?: number;
  cliPid?: number;
  turn?: number;
  wireSessionId?: string;
  channel?: string;
  update?: Record<string, unknown>;
  calls?: Array<{ input: { commandPresent: boolean } }>;
  internalTitleCancel?: boolean;
  bytes?: number;
  sha256?: string;
  omittedBytes?: number;
  omittedSha256?: string;
}
function records(trace: string): DiagnosticRow[] {
  return readFileSync(`${trace}.protocol.ndjson`, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

const PUBLIC_NEXT = "bun .kiro/tools/aidlc.ts engine orchestrate next build a metrics dashboard";
const ASK_NEEDLE = '"ask_type":"new-work-routing"';
const ROUTING_ASK = JSON.stringify({
  kind: "ask", ask_type: "new-work-routing", response_route: "next",
  available_intents: ["first", "second"],
});
function commandCall(command: string, overrides: Partial<AcpToolCall> = {}): AcpToolCall {
  return {
    toolCallId: "command-fixture", title: `Running: ${command}`, kind: "execute",
    rawInput: { command }, output: [ROUTING_ASK], status: "completed", ...overrides,
  };
}

test.each([
  "bun .kiro/tools/aidlc.ts engine orchestrate",
  "bun .kiro/tools/aidlc-orchestrate.ts",
])("report attempts stay visible and next arguments stay literal: %s", (entry) => {
  const alternative = "Treat this as a documentation update for the active work instead.";
  const forward = commandCall(`${entry} next "${alternative}"`, { title: "opaque display title" });
  expect(decodeKiroOrchestrateInvocation(forward)).toEqual({ verb: "next", args: [alternative] });
  const calls = [
    forward,
    ...["completed", "failed", "started"].map(status =>
      commandCall(`${entry} report --result awaiting-approval`, { status })
    ),
    commandCall(`echo '${entry} report --result completed'`),
  ];
  const decoded = calls.map(decodeKiroOrchestrateInvocation);
  expect(decoded.filter(invocation => invocation?.verb === "report")).toHaveLength(3);
  expect(decoded.filter(invocation => invocation?.verb === "next")).toHaveLength(1);
  expect(decoded.at(-1)).toBeNull();
  expect(findKiroOrchestrateNextCall(calls.slice(1), ASK_NEEDLE)).toBe(-1);
  expect(decodeKiroOrchestrateInvocation(commandCall(`${entry} report --result completed`, {
    status: "failed", rawInput: {},
  }))?.verb).toBe("report");
  expect(decodeKiroOrchestrateInvocation(commandCall("echo harmless", {
    status: "failed", title: `Running: ${entry} report --result completed`,
  }))).toBeNull();
});

test("count every literal next attempt without selecting only the first completed call", () => {
  const calls = [
    commandCall(PUBLIC_NEXT),
    commandCall("bun .kiro/tools/aidlc-orchestrate.ts next dashboard", { status: "failed" }),
    commandCall("bun .kiro/tools/aidlc.ts engine orchestrate next dashboard", { status: "started" }),
    commandCall(`echo '${PUBLIC_NEXT}'`),
    commandCall("bun unrelated.ts next dashboard"),
  ];
  expect(calls.map(decodeKiroOrchestrateInvocation).filter(invocation => invocation?.verb === "next"))
    .toHaveLength(3);
  expect(findKiroOrchestrateNextCall(calls.slice(1), ASK_NEEDLE)).toBe(-1);
});

test("forwarding uses CLI text joining while preserving decoded argument boundaries", () => {
  const alternative = "Treat this as a documentation update for the active work instead.";
  for (const entry of [
    "bun .kiro/tools/aidlc.ts engine orchestrate next",
    "bun .kiro/tools/aidlc-orchestrate.ts next",
  ]) {
    const quoted = decodeKiroOrchestrateInvocation(commandCall(`${entry} "${alternative}"`));
    const unquoted = decodeKiroOrchestrateInvocation(commandCall(`${entry} ${alternative}`));
    expect(quoted?.args).toEqual([alternative]);
    expect(unquoted?.args).toEqual(alternative.split(" "));
    for (const decoded of [quoted, unquoted]) {
      expect(decoded?.verb).toBe("next");
      expect(decoded?.args.join(" ")).toBe(alternative);
    }
    for (const suffix of [
      `"${alternative} changed"`,
      `"${alternative}" extra`,
      `"${alternative.replace("documentation", "implementation")}"`,
    ]) {
      const decoded = decodeKiroOrchestrateInvocation(commandCall(`${entry} ${suffix}`));
      expect(decoded?.verb).toBe("next");
      expect(decoded?.args.join(" ")).not.toBe(alternative);
    }
    expect(decodeKiroOrchestrateInvocation(commandCall(
      `echo '${entry} "${alternative}"'`, { title: `Running: ${entry} "${alternative}"` },
    ))).toBeNull();
  }
});

test.each([
  PUBLIC_NEXT,
  'bun "./.kiro/tools/aidlc.ts" engine orchestrate next "a task; with literal data"',
  String.raw`bun.exe ".kiro\tools\aidlc.ts" engine orchestrate next dashboard`,
  "bun .kiro/tools/aidlc-orchestrate.ts next dashboard",
  String.raw`bun.exe ".kiro\tools\aidlc-orchestrate.ts" next dashboard`,
])("literal Kiro next command correlates with its own typed output: %s", (command) => {
  const call = commandCall(command, { title: "display title is not command authority" });
  expect(findKiroOrchestrateNextCall([call], ASK_NEEDLE)).toBe(0);
  expect(findKiroOrchestrateNextCall([call], '"available_intents":')).toBe(0);
});

test.each([
  `echo '${PUBLIC_NEXT}'`,
  `printf '%s' '${PUBLIC_NEXT}'`,
  `bun --eval '${PUBLIC_NEXT}'`,
  `"${PUBLIC_NEXT}"`,
  "bun .kiro/tools/aidlc.ts engine orchestrate report next",
  "bun .kiro/tools/aidlc.ts engine workspace next",
  "bun .kiro/tools/aidlc.ts engine orchestrate nextish",
  "bun .kiro/tools/aidlc-orchestrate.ts help next",
  "bun .kiro/tools/unrelated.ts engine orchestrate next",
  "bun .kiro/tools/aidlc.ts.backup engine orchestrate next",
  "bun .claude/tools/aidlc.ts engine orchestrate next",
  `${PUBLIC_NEXT}; echo later`,
  `${PUBLIC_NEXT} && echo later`,
  `echo earlier | ${PUBLIC_NEXT}`,
  `cd /another-project && ${PUBLIC_NEXT}`,
  'bun "$tool" engine orchestrate next',
])("a typed ask and matching display title cannot bless another command: %s", (command) => {
  const call = commandCall(command, { title: `Running: ${PUBLIC_NEXT}` });
  expect(findKiroOrchestrateNextCall([call], ASK_NEEDLE)).toBe(-1);
});

test("title fallback requires a complete literal invocation and absent command input", () => {
  for (const command of [PUBLIC_NEXT, "bun .kiro/tools/aidlc-orchestrate.ts next dashboard"]) {
    expect(findKiroOrchestrateNextCall([commandCall(command, { rawInput: {} })], ASK_NEEDLE)).toBe(0);
  }
  for (const rawInput of [{ command: null }, { command: "" }, { command: 42 }, [], PUBLIC_NEXT]) {
    expect(findKiroOrchestrateNextCall([commandCall(PUBLIC_NEXT, { rawInput })], ASK_NEEDLE)).toBe(-1);
  }
  for (const title of [
    `Running: ${PUBLIC_NEXT}...`,
    `Running: echo '${PUBLIC_NEXT}'`,
    `The assistant mentioned ${PUBLIC_NEXT}`,
  ]) {
    expect(findKiroOrchestrateNextCall([commandCall(PUBLIC_NEXT, { rawInput: undefined, title })], ASK_NEEDLE)).toBe(-1);
  }
  expect(findKiroOrchestrateNextCall([
    commandCall(PUBLIC_NEXT, { title: `Running: ${PUBLIC_NEXT}...` }),
  ], ASK_NEEDLE)).toBe(0);
});

test("only a completed execute call can supply the correlated ask", () => {
  for (const overrides of [{ kind: "read" }, { kind: "edit" }, { status: "failed" }, { status: "started" }]) {
    expect(findKiroOrchestrateNextCall([commandCall(PUBLIC_NEXT, overrides)], ASK_NEEDLE)).toBe(-1);
  }
  expect(findKiroOrchestrateNextCall([
    commandCall(PUBLIC_NEXT, { output: ['{"kind":"ask","ask_type":"another-question"}'] }),
  ], ASK_NEEDLE)).toBe(-1);
});

test("the protocol keeps the intended command and typed output on the same tool call", async () => {
  const project = directory(), trace = join(project, "correlation.ndjson");
  const { session } = adapter(trace, (_request, emit, current) => {
    for (const [id, command, output] of [
      ["next", PUBLIC_NEXT, '{"kind":"print","message":"no ask here"}'],
      ["unrelated", `echo '${PUBLIC_NEXT}'`, ROUTING_ASK],
    ]) {
      emit(update({ sessionUpdate: "tool_call", toolCallId: id,
        title: `Running: ${command}`, kind: "execute", rawInput: { command } }, current.sessionId));
      emit(update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed",
        content: [{ content: { type: "text", text: output } }] }, current.sessionId));
    }
    return { stopReason: "end_turn" };
  });
  const result = await driveKiroAcp({ projectDir: project, session, prompt: "fixture-only", keepAlive: true });
  expect(result.toolCallIssues).toEqual([]);
  expect(result.toolCalls.map(call => call.toolCallId)).toEqual(["next", "unrelated"]);
  expect(findKiroOrchestrateNextCall(result.toolCalls, ASK_NEEDLE)).toBe(-1);
  expect(findKiroOrchestrateNextCall([
    ...result.toolCalls,
    commandCall(PUBLIC_NEXT, { output: [ROUTING_ASK.slice(0, 25), ROUTING_ASK.slice(25)] }),
  ], ASK_NEEDLE)).toBe(2);
});

test("raw vendor chunks and input updates remain visible without changing aggregation", async () => {
  const project = directory(), trace = join(project, "trace.ndjson");
  const chunk = {
    sessionUpdate: "tool_call_chunk", toolCallId: "call-a",
    vendorFragment: { index: 3, partial_json: '{"command":"create","path":"artifact.md"}' },
  };
  const finalInput = { command: "create", path: "artifact.md", content: "fixture body" };
  const { session } = adapter(trace, (_request, emit, current) => {
    emit(update({ sessionUpdate: "tool_call", toolCallId: "call-a", title: "initial", kind: "edit", rawInput: {} }, current.sessionId));
    emit(update(chunk, current.sessionId, "_kiro.dev/session/update"));
    emit(update({
      sessionUpdate: "tool_call_update", toolCallId: "call-a",
      title: "updated", kind: "edit", rawInput: finalInput, status: "completed",
    }, current.sessionId));
    return { stopReason: "end_turn" };
  });
  const result = await driveKiroAcp({ projectDir: project, session, prompt: "fixture-only", keepAlive: true });
  expect(result.toolCallIssues).toEqual([]);
  expect(result.toolCalls[0].rawInput).toEqual({}); // Existing aggregation is deliberately unchanged.
  expect(result.toolCalls[0].title).toBe("initial");
  const rows = records(trace);
  expect(rows.find(row => row.update?.sessionUpdate === "tool_call_chunk")?.update).toEqual(chunk);
  expect(rows.find(row => row.update?.sessionUpdate === "tool_call_update")?.update?.rawInput).toEqual(finalInput);
  expect(rows.find(row => row.event === "aggregate_at_return")?.calls?.[0]?.input.commandPresent).toBe(false);
});

test("a failed orphan is reported as a rejected call even when a preceding chunk contains input", async () => {
  const project = directory(), trace = join(project, "trace.ndjson");
  const diagnostic = "The tool input does not match the tool schema: missing field `command`";
  const { session } = adapter(trace, (_request, emit, current) => {
    emit(update({ sessionUpdate: "tool_call_chunk", toolCallId: "bad",
      rawInput: { command: "create", path: "artifact.md" } }, current.sessionId));
    emit(update({ sessionUpdate: "tool_call_update", toolCallId: "bad", status: "failed",
      content: [{ content: { type: "text", text: diagnostic } }],
      rawOutput: { code: "fixture-validation-error" } }, current.sessionId));
    return { stopReason: "end_turn" };
  });
  const result = await driveKiroAcp({ projectDir: project, session, prompt: "fixture-only", keepAlive: true });
  expect(result.toolCalls).toEqual([]);
  // The host never announced a start for this call, so it is the agent reaching
  // for something that is not there: reported separately, not a watched failure.
  expect(result.toolCallIssues).toEqual([]);
  expect(result.rejectedToolCalls).toEqual([{ toolCallId: "bad", status: "failed", output: [diagnostic], orphan: true }]);
  const wireFailure = records(trace).find(row => row.update?.status === "failed");
  expect(wireFailure?.update?.content).toEqual([{ content: { type: "text", text: diagnostic } }]);
  expect(wireFailure?.update?.rawOutput).toEqual({ code: "fixture-validation-error" });
});

test("instances, turns, wire sessions and channels disambiguate shared traces", () => {
  const project = directory(), trace = join(project, "shared.ndjson");
  const first = adapter(trace), second = adapter(trace);
  first.session.beginDiagnosticTurn();
  second.session.beginDiagnosticTurn();
  first.emit(update({ sessionUpdate: "tool_call_chunk", toolCallId: "same", part: 1 }, "wire-a"));
  second.emit(update({ sessionUpdate: "tool_call_chunk", toolCallId: "same", part: 2 }, "wire-b", "_kiro.dev/session/update"));
  first.session.beginDiagnosticTurn();
  first.emit(update({ sessionUpdate: "tool_call_chunk", toolCallId: "same", part: 3 }, "wire-a"));
  const rows = records(trace);
  expect(rows.map(row => row.sequence)).toEqual([1, 2, 3]);
  expect(rows[0].instance).not.toBe(rows[1].instance);
  expect(rows[0].cliPid).not.toBe(rows[1].cliPid);
  expect(rows.map(row => row.turn)).toEqual([1, 1, 2]);
  expect(rows.map(row => row.wireSessionId)).toEqual(["wire-a", "wire-b", "wire-a"]);
  expect(rows.map(row => row.channel)).toEqual(["session/update", "_kiro.dev/session/update", "session/update"]);
});

test("external cancellation is recorded despite the internal title-cancel flag staying false", async () => {
  const project = directory(), trace = join(project, "trace.ndjson");
  const { session, sent } = adapter(trace, (_request, _emit, current) => {
    current.notify("session/cancel", { sessionId: current.sessionId });
    return { stopReason: "cancelled" };
  });
  const result = await driveKiroAcp({ projectDir: project, session, prompt: "private-prompt-canary", keepAlive: true });
  expect(result.stopReason).toBe("cancelled");
  expect(sent.filter(packet => packet.method === "session/cancel")).toHaveLength(1);
  const rows = records(trace);
  expect(rows.filter(row => row.event === "outbound_cancel")).toHaveLength(1);
  expect(rows.find(row => row.event === "aggregate_at_return")?.internalTitleCancel).toBe(false);
  expect(readFileSync(`${trace}.protocol.ndjson`, "utf8")).not.toContain("private-prompt-canary");
});

test("metadata allowlist excludes prose/auth bodies and preserves protocol/version identity", async () => {
  const project = directory(), trace = join(project, "trace.ndjson");
  const fixture = adapter(trace, () => ({
    protocolVersion: 1, agentInfo: { name: "fixture", title: "Fixture CLI", version: "0.test", secret: "agent-secret-canary" },
    authMethods: [{ token: "auth-secret-canary" }],
  }));
  await fixture.session.request("initialize", { private: "request-secret-canary" }, remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS)!);
  fixture.emit(update({ sessionUpdate: "agent_message_chunk", content: { text: "prose-canary" } }, fixture.session.sessionId));
  fixture.emit(update({ sessionUpdate: "agent_thought_chunk", content: { text: "thought-canary" } }, fixture.session.sessionId));
  fixture.emit({ method: "_kiro.dev/auth", params: { token: "auth-notification-canary" } });
  const text = readFileSync(`${trace}.protocol.ndjson`, "utf8");
  for (const canary of ["agent-secret-canary", "auth-secret-canary", "request-secret-canary",
    "prose-canary", "thought-canary", "auth-notification-canary"]) expect(text).not.toContain(canary);
  expect(records(trace).find(row => row.event === "initialize_metadata")).toMatchObject({
    protocolVersion: 1, agentInfo: { name: "fixture", title: "Fixture CLI", version: "0.test" },
  });
  if (process.platform !== "win32") expect(statSync(`${trace}.protocol.ndjson`).mode & 0o777).toBe(0o600);
});

test("JSON parser gaps are explicit and do not copy unclassified line contents", async () => {
  const project = directory(), trace = join(project, "trace.ndjson");
  const fixture = adapter(trace);
  (fixture.session.proc as unknown as { stdout: AsyncIterable<Uint8Array> }).stdout = (async function* () {
    yield new TextEncoder().encode("not-json-secret-canary\n");
  })();
  await fixture.internal.readLoop();
  const row = records(trace)[0];
  expect(row.event).toBe("json_parse_error");
  expect(row.bytes).toBe("not-json-secret-canary".length);
  expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(readFileSync(`${trace}.protocol.ndjson`, "utf8")).not.toContain("not-json-secret-canary");
});

test("oversized event emits one explicit incomplete marker and stops sidecar capture", () => {
  const project = directory(), trace = join(project, "trace.ndjson");
  const fixture = adapter(trace);
  fixture.session.traceDiagnostic("fixture-large", { payload: "x".repeat(1_048_576) });
  fixture.session.traceDiagnostic("must-not-follow", {});
  const rows = records(trace);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ event: "diagnostic_incomplete", reason: "capture budget exceeded" });
  expect(rows[0].omittedBytes).toBeGreaterThan(1_048_576);
  expect(rows[0].omittedSha256).toMatch(/^[a-f0-9]{64}$/);
});

test("total file budget emits an explicit marker without a silently incomplete record", () => {
  const project = directory(), trace = join(project, "trace.ndjson");
  const fixture = adapter(trace);
  const payload = "x".repeat(900_000);
  for (let i = 0; i < 76; i++) fixture.session.traceDiagnostic("fixture-budget", { payload });
  const lines = readFileSync(`${trace}.protocol.ndjson`, "utf8").trim().split("\n");
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ event: "diagnostic_incomplete", reason: "capture budget exceeded" });
  expect(lines.filter(line => line.includes('"event":"diagnostic_incomplete"'))).toHaveLength(1);
  expect(statSync(`${trace}.protocol.ndjson`).size).toBeLessThanOrEqual(67_108_864 + 1024);
});

test("diagnostics disabled creates no protocol sidecar", () => {
  const project = directory(), trace = join(project, "off.ndjson");
  const driver = pathToFileURL(fileURLToPath(new URL("../harness/kiro-acp-drive.ts", import.meta.url))).href;
  const script = `
    import { existsSync } from "node:fs";
    const { AcpSession } = await import(${JSON.stringify(driver)});
    const s = Object.assign(Object.create(AcpSession.prototype), {
      tracePath: ${JSON.stringify(trace)}, proc: { pid: 123 }, sessionId: "fixture"
    });
    s.traceDiagnostic("fixture", { value: "not-written" });
    process.exit(existsSync(${JSON.stringify(`${trace}.protocol.ndjson`)}) ? 1 : 0);
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env: { ...process.env, AIDLC_ACP_DIAGNOSTIC_TRACE: "0" }, stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
});
