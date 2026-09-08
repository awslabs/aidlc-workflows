// t364 — the review daemon's ACP client against a scripted agent.
//
// What a consumer observes: the handshake completes, a prompt turn streams
// updates and stops with the agent's reason, a permission request and a form
// question each wait for the bridge's answer and carry it back, an unknown
// server->client request is refused (-32601) rather than left hanging, cancel
// ends the turn as `cancelled`, a persisted session loads across processes,
// and a process that dies rejects the in-flight request.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AcpClient,
  AcpError,
  resolveClaudeAcpLaunch,
  type AcpElicitationRequest,
  type AcpLaunch,
  type AcpPermissionRequest,
  type AcpSessionUpdate,
} from "../../core/tools/aidlc-review-ui-acp.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "fake-acp-agent.ts");

function launch(env: Record<string, string> = {}): AcpLaunch {
  return { backend: "claude", command: [process.execPath, FIXTURE], env };
}

interface Harness {
  client: AcpClient;
  updates: AcpSessionUpdate[];
  permissions: AcpPermissionRequest[];
  questions: AcpElicitationRequest[];
  text(): string;
}

function harness(
  cwd: string,
  options: {
    permission?: (request: AcpPermissionRequest) => Promise<{ outcome: "selected"; optionId: string } | { outcome: "cancelled" }>;
    question?: (request: AcpElicitationRequest) => Promise<{ action: "accept"; content: Record<string, unknown> } | { action: "decline" } | { action: "cancel" }>;
    env?: Record<string, string>;
  } = {},
): Harness {
  const updates: AcpSessionUpdate[] = [];
  const permissions: AcpPermissionRequest[] = [];
  const questions: AcpElicitationRequest[] = [];
  const client = new AcpClient(launch(options.env), cwd, {
    onUpdate: (update) => updates.push(update),
    onPermission: async (request) => {
      permissions.push(request);
      return options.permission ? options.permission(request) : { outcome: "selected", optionId: "allow" };
    },
    onElicitation: async (request) => {
      questions.push(request);
      return options.question ? options.question(request) : { action: "accept", content: { question_0: "SQLite" } };
    },
  });
  return {
    client,
    updates,
    permissions,
    questions,
    text: () =>
      updates
        .filter((update) => update.update.sessionUpdate === "agent_message_chunk")
        .map((update) => (update.update.content as { text?: string })?.text ?? "")
        .join(""),
  };
}

describe("t364 review UI ACP client", () => {
  const roots: string[] = [];
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "t364-"));
    roots.push(dir);
    return dir;
  };
  process.on("exit", () => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });

  test("handshake, a full turn through both bridges, and the unknown-request refusal", async () => {
    const cwd = scratch();
    const h = harness(cwd, { env: { AIDLC_REVIEW_RUN: "default/260908-todo" } });
    const init = await h.client.start();
    expect(init.agentInfo?.name).toBe("fake-acp-agent");
    expect(init.agentCapabilities?.loadSession).toBe(true);
    const { sessionId } = await h.client.newSession();
    expect(sessionId).toMatch(/^fake-/);

    const stop = await h.client.prompt(sessionId, "/aidlc");
    expect(stop).toBe("end_turn");
    // The binding env reached the agent process.
    expect(h.text()).toContain("run=default/260908-todo");
    // The permission request carried the tool call and the ACP-shaped options.
    expect(h.permissions).toHaveLength(1);
    expect(h.permissions[0].toolCall.title).toBe("Run `bun test`");
    expect(h.permissions[0].options.map((option) => option.optionId)).toEqual(["allow", "allow_always", "reject"]);
    expect(h.text()).toContain("permission=allow");
    // A server->client request this client does not implement is answered -32601.
    expect(h.text()).toContain("unknown-request=-32601");
    // The form question arrived with its schema and the answer went back as content.
    expect(h.questions).toHaveLength(1);
    expect(h.questions[0].message).toBe("Which database should the todo app use?");
    expect(Object.keys(h.questions[0].requestedSchema.properties ?? {})).toEqual(["question_0", "question_0_custom"]);
    expect(h.text()).toContain("answer=accept:SQLite");
    // Tool calls stream as tool_call + tool_call_update.
    expect(h.updates.map((update) => update.update.sessionUpdate)).toContain("tool_call_update");
    h.client.close();
  }, 20_000);

  test("a rejected permission ends the turn without asking further; a declined question yields no answer", async () => {
    const cwd = scratch();
    const rejected = harness(cwd, { permission: async () => ({ outcome: "selected", optionId: "reject" }) });
    await rejected.client.start();
    const first = await rejected.client.newSession();
    expect(await rejected.client.prompt(first.sessionId, "go")).toBe("end_turn");
    expect(rejected.questions).toHaveLength(0);
    expect(rejected.text()).toContain("permission=reject");
    rejected.client.close();

    const declined = harness(cwd, { question: async () => ({ action: "decline" }) });
    await declined.client.start();
    const second = await declined.client.newSession();
    await declined.client.prompt(second.sessionId, "go");
    expect(declined.text()).toContain("answer=decline:");
    declined.client.close();
  }, 20_000);

  test("cancel ends a hanging turn as cancelled", async () => {
    const cwd = scratch();
    const h = harness(cwd, { env: { FAKE_ACP_SCRIPT: "hang" } });
    await h.client.start();
    const { sessionId } = await h.client.newSession();
    const turn = h.client.prompt(sessionId, "loop forever");
    await Bun.sleep(100);
    h.client.cancel(sessionId);
    expect(await turn).toBe("cancelled");
    h.client.close();
  }, 20_000);

  test("a persisted session loads in a new process; an unknown one is refused", async () => {
    const cwd = scratch();
    const first = harness(cwd, { env: { FAKE_ACP_SCRIPT: "quiet" } });
    await first.client.start();
    const { sessionId } = await first.client.newSession();
    await first.client.prompt(sessionId, "one");
    first.client.close();

    const second = harness(cwd, { env: { FAKE_ACP_SCRIPT: "quiet" } });
    await second.client.start();
    await second.client.loadSession(sessionId);
    // The replayed transcript arrived as updates before the load resolved.
    expect(second.text()).toContain("restored");
    expect(await second.client.prompt(sessionId, "two")).toBe("end_turn");
    expect(second.client.loadSession("fake-nope")).rejects.toBeInstanceOf(AcpError);
    second.client.close();
  }, 20_000);

  test("a dying agent rejects the request in flight", async () => {
    const cwd = scratch();
    const h = harness(cwd, { env: { FAKE_ACP_EXIT_AFTER_INIT: "1" } });
    await h.client.start();
    expect(h.client.newSession()).rejects.toThrow(/exited/);
    await Bun.sleep(100);
    expect(h.client.exited).toBe(true);
  }, 20_000);

  test("launch resolution needs a claude executable and honours the command override", () => {
    expect(resolveClaudeAcpLaunch({ PATH: "/nonexistent" })).toBeNull();
    const resolved = resolveClaudeAcpLaunch({ CLAUDE_CODE_EXECUTABLE: "/usr/bin/true", AIDLC_ACP_CLAUDE_COMMAND: "bun fake.ts --flag" });
    expect(resolved?.command).toEqual(["bun", "fake.ts", "--flag"]);
    expect(resolved?.env.CLAUDE_CODE_EXECUTABLE).toBe("/usr/bin/true");
  });
});
