// t365 — Start runs: the review daemon creates the intent and drives an agent
// over ACP (a scripted agent stands in for Claude).
//
// What a consumer observes: POST /api/intents with a workflow creates the
// record and starts a run bound to it (its session effort applied); the agent's
// permission request and form question wait in /api/run until the browser
// answers and the turn then ends; a second Start while a run is live is
// refused (409) and nothing is created; the workflow payload marks the intent's
// run state; Continue re-prompts an idle session; Stop cancels a hanging turn;
// a daemon restart re-attaches the run with session/load and Continue works
// on the restored session; /api/intents/propose names the engine's inference.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

    expect((await api("POST", "/api/intents", { text: "x", space: "default", scope: "express", session_effort: "turbo" })).status).toBe(400);
    const start = await api("POST", "/api/intents", { text: "Build a tiny todo CLI", space: "default", scope: "express", session_effort: "medium" });
    expect(start.status).toBe(201);
    expect(start.body.mode).toBe("running");
    intent = String(start.body.intent);
    expect(intent).toMatch(/^\d{6}-build-a-tiny-todo-cli/);
    // The record is real (state file) and no envelope was left behind.
    const state = readFileSync(join(project, "aidlc", "spaces", "default", "intents", intent, "aidlc-state.md"), "utf-8");
    expect(state).toContain("**Scope**: express");
    expect(readPendingIntentRequests(project, "default")).toEqual([]);

    // The agent asked for a tool; the run waits on the human.
    let view = await until(intent, (candidate) => candidate.pending.some((input) => input.kind === "permission"));
    expect(view.run.state).toBe("waiting");
    expect(texts(view)).toContain(`run=default/${intent}`); // the session binding reached the agent's environment
    // The claude profile takes the effort as a config option after session/new.
    expect(view.run.session_effort).toBe("medium");
    expect(texts(view)).toContain("config=effort=medium");
    const permission = view.pending.find((input) => input.kind === "permission")!;
    expect(permission.kind === "permission" && permission.tool_call.title).toBe("Run `bun test`");

    // A second Start while this one is live is refused and creates nothing.
    // The scripted agent never binds its session (no SessionStart hook runs), so
    // this run holds the project: a second Start is refused and creates nothing.
    expect(view.run.bound).toBe(false);
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

  test("bound sessions run several intents at once; an unbound one holds the project", async () => {
    await stopDaemon();
    const other = join(temp, "project-multi");
    mkdirSync(join(other, "aidlc", "spaces", "default", "memory"), { recursive: true });
    mkdirSync(join(other, ".claude"), { recursive: true });
    writeFileSync(join(other, "aidlc", "active-space"), "default\n");
    const saved = { project, infoPath };
    project = other;
    infoPath = serverInfoPath(other, env);
    try {
      await startDaemon({ FAKE_ACP_BIND: "1", FAKE_ACP_SCRIPT: "hang" });
      const first = await api("POST", "/api/intents", { text: "First piece of work", space: "default", scope: "express" });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const one = String(first.body.intent);
      let view = await until(one, (candidate) => candidate.run?.state === "running");
      expect(view.run.bound).toBe(true);
      // A second intent starts while the first is still running.
      const second = await api("POST", "/api/intents", { text: "Second piece of work", space: "default", scope: "express" });
      expect(second.status, JSON.stringify(second.body)).toBe(201);
      const two = String(second.body.intent);
      expect(two).not.toBe(one);
      view = await until(two, (candidate) => candidate.run?.state === "running" && texts(candidate).includes(`run=default/${two}`));
      // Both live; the workflow payload marks both rows.
      const workflow = (await api("GET", "/api/workflow")).body as { intents: Array<{ slug: string; run: string | null }> };
      expect(workflow.intents.filter((entry) => entry.run === "running").map((entry) => entry.slug).sort()).toEqual([one, two].sort());
      // The same intent cannot start twice.
      expect((await api("POST", "/api/run/prompt", { intent: one })).status).toBe(409);
      expect((await api("POST", "/api/run/cancel", { intent: one })).status).toBe(200);
      expect((await api("POST", "/api/run/cancel", { intent: two })).status).toBe(200);
      await until(one, (candidate) => candidate.run.state === "idle");
    } finally {
      await stopDaemon();
      project = saved.project;
      infoPath = saved.infoPath;
    }
    await startDaemon();
  }, 60_000);

  test("every harness runs its own agent: the profile picks the command and the first prompt", async () => {
    await stopDaemon();
    // A fresh project per harness (a live run in the shared one would make Start a 409).
    for (const [harness, dir, override, prompt] of [
      ["kiro", ".kiro", "AIDLC_ACP_KIRO_COMMAND", "/aidlc"],
      ["codex", ".codex", "AIDLC_ACP_CODEX_COMMAND", "$aidlc"],
      ["opencode", ".aidlc", "AIDLC_ACP_OPENCODE_COMMAND", "/aidlc"],
    ] as const) {
      const other = join(temp, `project-${harness}`);
      mkdirSync(join(other, "aidlc", "spaces", "default", "memory"), { recursive: true });
      mkdirSync(join(other, dir, "tools", "data"), { recursive: true });
      writeFileSync(join(other, "aidlc", "active-space"), "default\n");
      writeFileSync(join(other, dir, "tools", "data", "harness.json"), JSON.stringify({ name: harness, harnessDir: dir, rulesSubdir: "rules" }));
      const saved = { project, infoPath };
      project = other;
      infoPath = serverInfoPath(other, env);
      try {
        await startDaemon({
          AIDLC_HARNESS_DIR: dir,
          AIDLC_STAGE_GRAPH: join(ROOT, "dist", harness, dir, "tools", "data", "stage-graph.json"),
          // Only this harness's command is provided; the claude one must not be used.
          AIDLC_ACP_CLAUDE_COMMAND: "",
          CLAUDE_CODE_EXECUTABLE: "",
          PATH: "/nonexistent",
          [override]: `${process.execPath} ${FIXTURE}`,
          FAKE_ACP_SCRIPT: "quiet",
        });
        const workflow = (await api("GET", "/api/workflow")).body as { runner: boolean };
        expect(workflow.runner, harness).toBe(true);
        const start = await api("POST", "/api/intents", { text: `Todo CLI on ${harness}`, space: "default", scope: "express", session_effort: "high" });
        expect(start.status, JSON.stringify(start.body)).toBe(201);
        expect(start.body.mode).toBe("running");
        const view = await until(String(start.body.intent), (candidate) => candidate.run?.state === "idle");
        expect(view.run.backend).toBe(harness);
        expect(view.start_prompt).toBe(prompt);
        expect(texts(view)).toContain(`Working on: ${prompt} (run=default/${start.body.intent}`);
        // Kiro takes the effort as a launch flag; Codex and opencode have no dial, so nothing is pinned.
        if (harness === "kiro") {
          expect(view.run.session_effort).toBe("high");
          expect(texts(view)).toContain("argv=--effort high");
        } else {
          expect(view.run.session_effort).toBeNull();
          expect(view.effort_control).toBe(false);
        }
      } finally {
        await stopDaemon();
        project = saved.project;
        infoPath = saved.infoPath;
      }
    }
    await startDaemon();
  }, 90_000);

  test("a turn that ends mid-stage is nudged with the resume prompt, at most twice", async () => {
    await stopDaemon();
    const other = join(temp, "project-nudge");
    mkdirSync(join(other, "aidlc", "spaces", "default", "memory"), { recursive: true });
    mkdirSync(join(other, ".claude"), { recursive: true });
    writeFileSync(join(other, "aidlc", "active-space"), "default\n");
    const saved = { project, infoPath };
    project = other;
    infoPath = serverInfoPath(other, env);
    try {
      await startDaemon({ FAKE_ACP_BIND: "1", FAKE_ACP_SCRIPT: "quiet" });
      const start = await api("POST", "/api/intents", { text: "Nudge me", space: "default", scope: "express" });
      expect(start.status, JSON.stringify(start.body)).toBe(201);
      const slug = String(start.body.intent);
      // intent-create leaves the first post-init stage in progress ([-]); the
      // quiet agent ends every turn at once without touching it. No round or
      // gate is open, so the daemon nudges - twice - then parks the run.
      const view = await until(slug, (candidate) => candidate.run?.state === "idle" && candidate.events.some((event) => event.kind === "note" && /stopped 2 times/.test((event as { text: string }).text)), 30_000);
      expect(view.run.turns).toBe(3); // Start, nudge 1, nudge 2
      const notes = view.events.filter((event) => event.kind === "note").map((event) => (event as { text: string }).text);
      expect(notes.filter((text) => /\(1\/2\)|\(2\/2\)/.test(text))).toHaveLength(2);
      expect(notes.some((text) => /press Continue or reply/.test(text))).toBe(true);
      // A human action restarts the count: Continue runs one more turn and one more nudge round begins.
      expect((await api("POST", "/api/run/prompt", { intent: slug })).status).toBe(200);
      const after = await until(slug, (candidate) => candidate.run?.turns >= 5, 20_000);
      expect(after.events.filter((event) => event.kind === "note" && /\(1\/2\)/.test((event as { text: string }).text))).toHaveLength(2);
    } finally {
      await stopDaemon();
      project = saved.project;
      infoPath = saved.infoPath;
    }
    await startDaemon();
  }, 90_000);

  test("the personal default effort is read and written through the runner profile", async () => {
    const settings = join(project, ".claude", "settings.local.json");
    writeFileSync(settings, `${JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }, null, 2)}\n`);
    let workflow = (await api("GET", "/api/workflow")).body as { runner_default_effort: unknown; runner_default_effort_editable: boolean };
    expect(workflow.runner_default_effort_editable).toBe(true);
    expect((await api("POST", "/api/default-effort", { level: "turbo" })).status).toBe(400);
    const set = await api("POST", "/api/default-effort", { level: "high" });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.default_effort).toEqual({ level: "high", source: ".claude/settings.local.json" });
    expect(JSON.parse(readFileSync(settings, "utf-8"))).toEqual({ permissions: { allow: ["Bash(ls:*)"] }, effortLevel: "high" });
    workflow = (await api("GET", "/api/workflow")).body as typeof workflow;
    expect(workflow.runner_default_effort).toEqual({ level: "high", source: ".claude/settings.local.json" });
    expect((await api("POST", "/api/default-effort", { level: null })).status).toBe(200);
    expect(JSON.parse(readFileSync(settings, "utf-8"))).toEqual({ permissions: { allow: ["Bash(ls:*)"] } });

    // The model, the same way; the picker's choices are what the agent listed at session/new.
    const models = (await api("GET", "/api/workflow")).body as { runner_models: unknown; runner_default_model: unknown; runner_default_model_editable: boolean };
    expect(models.runner_default_model_editable).toBe(true);
    expect(models.runner_models).toEqual([{ id: "fake-fast", name: "Fake Fast", description: "the quick one" }, { id: "fake-deep", name: "Fake Deep", description: null }]);
    expect((await api("POST", "/api/default-model", { model: "not a model!" })).status).toBe(400);
    const pinnedModel = await api("POST", "/api/default-model", { model: "fake-deep" });
    expect(pinnedModel.status, JSON.stringify(pinnedModel.body)).toBe(200);
    expect(pinnedModel.body.default_model).toEqual({ value: "fake-deep", source: ".claude/settings.local.json" });
    expect(JSON.parse(readFileSync(settings, "utf-8"))).toEqual({ permissions: { allow: ["Bash(ls:*)"] }, model: "fake-deep" });
    expect(((await api("GET", "/api/workflow")).body as typeof models).runner_default_model).toEqual({ value: "fake-deep", source: ".claude/settings.local.json" });
    expect((await api("POST", "/api/default-model", { model: null })).status).toBe(200);
    expect(JSON.parse(readFileSync(settings, "utf-8"))).toEqual({ permissions: { allow: ["Bash(ls:*)"] } });
    // Unset locally does not mean unset: a project-level value shows through with its source,
    // which is what the picker's first option must name.
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ model: "sonnet" }));
    expect(((await api("GET", "/api/workflow")).body as typeof models).runner_default_model).toEqual({ value: "sonnet", source: ".claude/settings.json" });
    rmSync(join(project, ".claude", "settings.json"));
    rmSync(settings);
  }, 30_000);

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

  test("as the compiled binary, Start creates the workspace and intent through the aidlc CLI, not a tool file", async () => {
    await stopDaemon();
    // A compiled `aidlc` has no sibling .ts files and process.execPath is not
    // bun. AIDLC_COMPILED_EXECUTABLE is the same seam the compiled binary
    // sets for itself; a shell stub that re-enters the authored dispatcher
    // stands in for it and records every invocation it receives.
    const stubDir = join(temp, "compiled");
    mkdirSync(stubDir, { recursive: true });
    const calls = join(stubDir, "calls.log");
    const stub = join(stubDir, "aidlc");
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, "core", "tools", "aidlc.ts"))} "$@"\n`, { mode: 0o755 });
    const other = join(temp, "project-compiled");
    mkdirSync(join(other, "aidlc", "spaces", "default", "memory"), { recursive: true });
    mkdirSync(join(other, ".claude"), { recursive: true });
    writeFileSync(join(other, "aidlc", "active-space"), "default\n");
    const saved = { project, infoPath };
    project = other;
    infoPath = serverInfoPath(other, env);
    try {
      await startDaemon({ AIDLC_COMPILED_EXECUTABLE: stub, FAKE_ACP_BIND: "1", FAKE_ACP_SCRIPT: "quiet" });
      const space = await api("POST", "/api/spaces", { name: "browser" });
      expect(space.status, JSON.stringify(space.body)).toBe(201);
      expect(existsSync(join(other, "aidlc", "spaces", "browser", "memory"))).toBe(true);
      const started = await api("POST", "/api/intents", { text: "Work started from the binary", space: "browser", scope: "express" });
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      const slug = String(started.body.intent);
      expect(existsSync(join(other, "aidlc", "spaces", "browser", "intents", slug, "aidlc-state.md"))).toBe(true);
      await until(slug, (candidate) => candidate.run?.state === "idle" || candidate.run?.state === "running", 20_000);
      // The daemon names its (canonical) project on every call, so the binary
      // never has to infer it from a tool file's location or its cwd.
      const canonical = realpathSync(other);
      const recorded = readFileSync(calls, "utf-8").trim().split("\n");
      expect(recorded).toContain(`engine space create browser --project-dir ${canonical}`);
      expect(recorded.some((line) => line.startsWith("engine intent create --space browser --scope express ") && line.endsWith(`--project-dir ${canonical}`))).toBe(true);
    } finally {
      await stopDaemon();
      project = saved.project;
      infoPath = saved.infoPath;
    }
  }, 90_000);
});
