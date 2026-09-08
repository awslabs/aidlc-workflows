// t365 — Start runs: the review daemon creates the intent and drives an agent
// over ACP (a scripted agent stands in for Claude).
//
// What a consumer observes: POST /api/intents with a workflow creates the
// record (its `Effort` recorded) and starts a run bound to it; the agent's
// permission request and form question wait in /api/run until the browser
// answers and the turn then ends; a second Start while a run is live is
// refused (409) and nothing is created; the workflow payload marks the intent's
// run state; Continue re-prompts an idle session; Stop cancels a hanging turn;
// a daemon restart re-attaches the run with session/load and Continue works
// on the restored session; /api/intents/propose names the engine's inference.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverInfoPath, type ServerInfo } from "../../core/tools/aidlc-review-ui-shared.ts";
import { readPendingIntentRequests } from "../../core/tools/aidlc-lib.ts";
import type { RunView } from "../../core/tools/aidlc-review-ui-runs.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DAEMON = join(ROOT, "core", "tools", "aidlc-review-ui.ts");
const FIXTURE = join(ROOT, "tests", "fixtures", "fake-acp-agent.ts");
const TOKEN_HEADER = "X-AIDLC-Token";

let temp = "";
let project = "";
let infoPath = "";
let info: ServerInfo;
let daemon: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
let env: Record<string, string>;

async function startDaemon(extraEnv: Record<string, string> = {}): Promise<void> {
  try {
    rmSync(infoPath, { force: true });
  } catch {
    // absent is fine
  }
  daemon = Bun.spawn([process.execPath, DAEMON, "serve", "--project-dir", project], { cwd: ROOT, env: { ...env, ...extraEnv }, stdout: "pipe", stderr: "pipe" });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(infoPath)) {
      try {
        const parsed = JSON.parse(readFileSync(infoPath, "utf-8")) as ServerInfo;
        if (parsed.port > 0 && parsed.token && parsed.pid === daemon.pid) {
          info = parsed;
          return;
        }
      } catch {
        // atomic replace can race a read
      }
    }
    if (daemon.exitCode !== null) throw new Error(`daemon exited ${daemon.exitCode}: ${await new Response(daemon.stderr).text()}`);
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for review UI server.json");
}

async function stopDaemon(): Promise<string> {
  if (!daemon) return "";
  const stderr = new Response(daemon.stderr).text();
  if (daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    const deadline = Date.now() + 5_000;
    while (daemon.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
    if (daemon.exitCode === null) {
      daemon.kill("SIGKILL");
      await daemon.exited;
    }
  }
  daemon = null;
  return stderr;
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers({ [TOKEN_HEADER]: info.token });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: ((await response.json().catch(() => null)) ?? {}) as Record<string, unknown> };
}

async function runView(intent: string): Promise<RunView> {
  return (await api("GET", `/api/run?intent=${intent}`)).body as unknown as RunView;
}

async function until(intent: string, predicate: (view: RunView) => boolean, ms = 10_000): Promise<RunView> {
  const deadline = Date.now() + ms;
  let view = await runView(intent);
  while (!predicate(view) && Date.now() < deadline) {
    await Bun.sleep(50);
    view = await runView(intent);
  }
  if (!predicate(view)) throw new Error(`run did not reach the expected state: ${JSON.stringify(view.run)} pending=${view.pending.length}`);
  return view;
}

function texts(view: RunView): string {
  return view.events.filter((event) => event.kind === "text").map((event) => (event as { text: string }).text).join("|");
}

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), "aidlc-review-runs-"));
  project = join(temp, "project");
  mkdirSync(join(project, "aidlc", "spaces", "default", "memory"), { recursive: true });
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(join(project, "aidlc", "active-space"), "default\n");
  env = {
    ...process.env,
    AIDLC_REVIEW_HOME: join(temp, "review-home"),
    AIDLC_REVIEW_PORT: "0",
    AIDLC_REVIEW_HOST: "127.0.0.1",
    AIDLC_REVIEW_OPEN: "0",
    AIDLC_REVIEW_UI: "1",
    AIDLC_HARNESS_DIR: ".claude",
    AIDLC_STAGE_GRAPH: join(ROOT, "dist", "claude", ".claude", "tools", "data", "stage-graph.json"),
    // The scripted agent stands in for claude-agent-acp; the runner only needs
    // a claude executable to exist, so any binary satisfies the probe.
    AIDLC_ACP_CLAUDE_COMMAND: `${process.execPath} ${FIXTURE}`,
    CLAUDE_CODE_EXECUTABLE: process.execPath,
  } as Record<string, string>;
  infoPath = serverInfoPath(project, env);
  await startDaemon();
});

afterAll(async () => {
  try {
    await stopDaemon();
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
});

describe("t365 review UI agent runs", () => {
  let intent = "";

  test("Start creates the record and runs the agent; both bridges round-trip; a second Start is refused", async () => {
    expect((await api("GET", "/api/intents/propose?text=fix%20the%20login%20bug")).body).toEqual({ scope: "bugfix", source: "keyword" });

    const start = await api("POST", "/api/intents", { text: "Build a tiny todo CLI", space: "default", scope: "express", effort: { preset: "minimal" } });
    expect(start.status).toBe(201);
    expect(start.body.mode).toBe("running");
    intent = String(start.body.intent);
    expect(intent).toMatch(/^\d{6}-build-a-tiny-todo-cli/);
    // The record is real (state file, Effort recorded) and no envelope was left behind.
    const state = readFileSync(join(project, "aidlc", "spaces", "default", "intents", intent, "aidlc-state.md"), "utf-8");
    expect(state).toContain("**Effort**: minimal");
    expect(state).toContain("**Scope**: express");
    expect(readPendingIntentRequests(project, "default")).toEqual([]);

    // The agent asked for a tool; the run waits on the human.
    let view = await until(intent, (candidate) => candidate.pending.some((input) => input.kind === "permission"));
    expect(view.run.state).toBe("waiting");
    expect(texts(view)).toContain(`run=default/${intent}`); // the session binding reached the agent's environment
    const permission = view.pending.find((input) => input.kind === "permission")!;
    expect(permission.kind === "permission" && permission.tool_call.title).toBe("Run `bun test`");

    // A second Start while this one is live is refused and creates nothing.
    const busy = await api("POST", "/api/intents", { text: "Another thing", space: "default", scope: "express" });
    expect(busy.status).toBe(409);
    expect(String(busy.body.error)).toContain(intent);
    expect(existsSync(join(project, "aidlc", "spaces", "default", "intents", "pending-intents.json"))).toBe(false);

    // The workflow payload marks the run on the intent row.
    const workflow = (await api("GET", "/api/workflow")).body as { intents: Array<{ slug: string; run: string | null }>; runner: boolean };
    expect(workflow.runner).toBe(true);
    expect(workflow.intents.find((entry) => entry.slug === intent)?.run).toBe("waiting");

    expect((await api("POST", "/api/run/permission", { intent, id: permission.id, option_id: "nope" })).status).toBe(409);
    expect((await api("POST", "/api/run/permission", { intent, id: permission.id, option_id: "allow" })).status).toBe(200);

    view = await until(intent, (candidate) => candidate.pending.some((input) => input.kind === "question"));
    const question = view.pending.find((input) => input.kind === "question")!;
    expect(question.kind === "question" && question.message).toBe("Which database should the todo app use?");
    expect((await api("POST", "/api/run/question", { intent, id: question.id, action: "accept", content: { question_0_custom: "DynamoDB" } })).status).toBe(200);

    view = await until(intent, (candidate) => candidate.run.state === "idle");
    expect(view.run.last_stop_reason).toBe("end_turn");
    expect(view.run.turns).toBe(1);
    const text = texts(view);
    expect(text).toContain("permission=allow");
    expect(text).toContain("unknown-request=-32601");
    expect(text).toContain("answer=accept:DynamoDB");
    // The record carries the run.
    const stored = JSON.parse(readFileSync(join(project, "aidlc", "spaces", "default", "intents", intent, ".review-ui", "run.json"), "utf-8")) as { state: string; session_id: string };
    expect(stored.state).toBe("idle");
    expect(stored.session_id).toMatch(/^fake-/);
  }, 60_000);

  test("Continue re-prompts the idle session; Stop cancels a turn that waits on the human", async () => {
    expect((await api("POST", "/api/run/prompt", { intent })).status).toBe(200);
    let view = await until(intent, (candidate) => candidate.pending.length > 0);
    expect(view.run.turns).toBe(2);
    expect(view.run.state).toBe("waiting");
    // A prompt while the turn is live is refused; Stop cancels the turn and its pending input.
    expect((await api("POST", "/api/run/prompt", { intent })).status).toBe(409);
    expect((await api("POST", "/api/run/cancel", { intent })).status).toBe(200);
    view = await until(intent, (candidate) => candidate.run.state === "idle");
    expect(view.run.last_stop_reason).toBe("cancelled");
    expect(view.pending).toEqual([]);
  }, 30_000);

  test("a daemon restart re-attaches the run with session/load and Continue works on it", async () => {
    const before = JSON.parse(readFileSync(join(project, "aidlc", "spaces", "default", "intents", intent, ".review-ui", "run.json"), "utf-8")) as { session_id: string };
    await stopDaemon();
    await startDaemon({ FAKE_ACP_SCRIPT: "quiet" });
    const view = await until(intent, (candidate) => candidate.run?.state === "idle" && candidate.events.some((event) => event.kind === "note"), 15_000);
    expect(view.run.session_id).toBe(before.session_id);
    expect(texts(view)).toContain("restored");
    expect((await api("POST", "/api/run/prompt", { intent, text: "carry on" })).status).toBe(200);
    const after = await until(intent, (candidate) => candidate.run.turns === 3 && candidate.run.state === "idle");
    expect(texts(after)).toContain("Working on: carry on");
  }, 60_000);

  test("without a runner Start records a request instead", async () => {
    await stopDaemon();
    await startDaemon({ AIDLC_REVIEW_RUNNER: "0" });
    const requested = await api("POST", "/api/intents", { text: "Something for later", space: "default", scope: "express" });
    expect(requested.status).toBe(201);
    expect(requested.body.mode).toBe("requested");
    expect(readPendingIntentRequests(project, "default").map((entry) => entry.text)).toEqual(["Something for later"]);
    const workflow = (await api("GET", "/api/workflow")).body as { runner: boolean };
    expect(workflow.runner).toBe(false);
    expect((await api("GET", `/api/run?intent=${intent}`)).body.available).toBe(false);
  }, 30_000);
});
