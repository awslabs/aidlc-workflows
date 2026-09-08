import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverInfoPath, type ServerInfo } from "../../core/tools/aidlc-review-ui-shared.ts";
import { PENDING_INTENT_REQUESTS_FILE, readPendingIntentRequests } from "../../core/tools/aidlc-lib.ts";

// An intent asked for in the review UI: the daemon records a pending request
// (no record, no state), the Inbox lists it as `requested`, and a bare `next`
// in a session picks it up as if the words had been typed - the creation move
// consumes the envelope only once the record exists.

const ROOT = join(import.meta.dir, "..", "..");
const DAEMON = join(ROOT, "core", "tools", "aidlc-review-ui.ts");
const ORCHESTRATE = join(ROOT, "core", "tools", "aidlc-orchestrate.ts");
const UTILITY = join(ROOT, "core", "tools", "aidlc-utility.ts");
const TOKEN_HEADER = "X-AIDLC-Token";

let temp = "";
let project = "";
let reviewHome = "";
let infoPath = "";
let info: ServerInfo;
let daemon: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
let env: Record<string, string>;

async function waitForServerInfo(): Promise<ServerInfo> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(infoPath)) {
      try {
        const parsed = JSON.parse(readFileSync(infoPath, "utf-8")) as ServerInfo;
        if (parsed.port > 0 && parsed.token) return parsed;
      } catch {
        // atomic replace can race a read
      }
    }
    if (daemon?.exitCode !== null) {
      const stderr = daemon?.stderr instanceof ReadableStream ? await new Response(daemon.stderr).text() : "";
      throw new Error(`daemon exited ${daemon?.exitCode}: ${stderr}`);
    }
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for review UI server.json");
}

function authorized(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(TOKEN_HEADER, info.token);
  if (init.body) headers.set("Content-Type", "application/json");
  return fetch(`http://127.0.0.1:${info.port}${path}`, { ...init, headers });
}

function engine(args: string[]): { kind: string; message: string; exit: number } {
  const result = Bun.spawnSync({ cmd: [process.execPath, ORCHESTRATE, ...args], cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const out = result.stdout.toString().trim();
  let parsed: { kind?: string; message?: string; question?: string; error?: string } = {};
  try {
    parsed = JSON.parse(out);
  } catch {
    parsed = { kind: "raw", message: `${out}\n${result.stderr.toString()}` };
  }
  return { kind: parsed.kind ?? "?", message: parsed.message ?? parsed.question ?? parsed.error ?? "", exit: result.exitCode };
}

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), "aidlc-review-intents-"));
  project = join(temp, "project");
  reviewHome = join(temp, "review-home");
  // A fresh install: a default space with memory and no intents at all.
  mkdirSync(join(project, "aidlc", "spaces", "default", "memory"), { recursive: true });
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(join(project, "aidlc", "active-space"), "default\n");
  env = {
    ...process.env,
    AIDLC_REVIEW_HOME: reviewHome,
    AIDLC_REVIEW_PORT: "0",
    AIDLC_REVIEW_HOST: "127.0.0.1",
    AIDLC_REVIEW_OPEN: "0",
    AIDLC_REVIEW_UI: "1",
    // No agent runner: this test pins the request envelope, the path Start
    // takes when the daemon cannot run an agent (t365 covers the runner).
    AIDLC_REVIEW_RUNNER: "0",
    // The scope catalogue and the engine read the compiled stage graph; the
    // authored core/ tree has none, the packaged tree does.
    AIDLC_STAGE_GRAPH: join(ROOT, "dist", "claude", ".claude", "tools", "data", "stage-graph.json"),
  } as Record<string, string>;
  infoPath = serverInfoPath(project, env);
  daemon = Bun.spawn([process.execPath, DAEMON, "serve", "--project-dir", project], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  info = await waitForServerInfo();
});

afterAll(async () => {
  try {
    if (daemon && daemon.exitCode === null) {
      daemon.kill("SIGTERM");
      const deadline = Date.now() + 5_000;
      while (daemon.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
      if (daemon.exitCode === null) {
        daemon.kill("SIGKILL");
        await daemon.exited;
      }
    }
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
});

describe("t363 review UI intent requests", () => {
  test("records a request, lists it as requested, and a bare next picks it up; intent-create consumes it", async () => {
    // guards
    expect((await fetch(`http://127.0.0.1:${info.port}/api/intents`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await authorized("/api/intents", { method: "POST", body: JSON.stringify({ text: "   " }) })).status).toBe(400);
    expect((await authorized("/api/intents", { method: "POST", body: JSON.stringify({ text: "x", scope: "no-such-scope" }) })).status).toBe(400);
    expect((await authorized("/api/intents", { method: "POST", body: JSON.stringify({ text: "x", space: "nowhere" }) })).status).toBe(404);

    // a request with an explicit workflow
    const created = await authorized("/api/intents", {
      method: "POST",
      body: JSON.stringify({ text: "Build a tiny todo CLI that stores tasks in a local JSON file", space: "default", scope: "express" }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(id).toMatch(/^req-/);
    expect(existsSync(join(project, "aidlc", "spaces", "default", "intents", PENDING_INTENT_REQUESTS_FILE))).toBe(true);
    // no record, no registry: a request is not an intent yet
    expect(existsSync(join(project, "aidlc", "spaces", "default", "intents", "intents.json"))).toBe(false);

    // the Inbox sees it
    const workflow = (await (await authorized("/api/workflow")).json()) as { intents: Array<Record<string, unknown>> };
    const row = workflow.intents.find((entry) => entry.slug === id);
    expect(row).toMatchObject({ status: "requested", scope: "express", needs: { kind: "request" }, request: { id } });

    // a bare next: the request stands in for typed text; creation is a print carrying the request id
    const pickup = engine(["next"]);
    expect(pickup.kind).toBe("print");
    expect(pickup.message).toContain("engine intent create --scope express");
    expect(pickup.message).toContain("--arguments='Build a tiny todo CLI that stores tasks in a local JSON file'");
    expect(pickup.message).toContain(`--request ${id}`);

    // run the creation move the conductor would run: the envelope is consumed
    const create = Bun.spawnSync({
      cmd: [process.execPath, UTILITY, "intent-create", "--scope", "express", "--arguments=Build a tiny todo CLI that stores tasks in a local JSON file", "--label", "todo cli", "--request", id],
      cwd: project,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(create.exitCode, create.stderr.toString()).toBe(0);
    expect(readPendingIntentRequests(project, "default")).toEqual([]);
    const registry = JSON.parse(readFileSync(join(project, "aidlc", "spaces", "default", "intents", "intents.json"), "utf-8")) as Array<{ dirName: string }>;
    expect(registry).toHaveLength(1);
    const dirName = registry[0].dirName;
    const state = readFileSync(join(project, "aidlc", "spaces", "default", "intents", dirName, "aidlc-state.md"), "utf-8");
    expect(state).toContain("- **Scope**: express");
    expect(state).toContain("- **Project**: Build a tiny todo CLI that stores tasks in a local JSON file");
    const after = (await (await authorized("/api/workflow")).json()) as { intents: Array<Record<string, unknown>> };
    expect(after.intents.some((entry) => entry.status === "requested")).toBe(false);
  }, 60_000);

  test("a composer request routes through the inference ask, and creation by text still consumes it; withdraw removes it", async () => {
    // a second space to request into
    expect((await authorized("/api/spaces", { method: "POST", body: JSON.stringify({ name: "Bad Name" }) })).status).toBe(400);
    const space = await authorized("/api/spaces", { method: "POST", body: JSON.stringify({ name: "platform" }) });
    expect(space.status).toBe(201);
    expect(existsSync(join(project, "aidlc", "spaces", "platform", "memory"))).toBe(true);
    expect((await authorized("/api/spaces", { method: "POST", body: JSON.stringify({ name: "platform" }) })).status).toBe(409);

    // the record from the first test is active; move it aside so the workspace is fresh again for pickup
    rmSync(join(project, "aidlc", "spaces", "default", "intents"), { recursive: true, force: true });

    const created = await authorized("/api/intents", {
      method: "POST",
      body: JSON.stringify({ text: "Rework how the reporting service paginates very large exports", space: "default", scope: null }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    // no scope: the bare next takes Branch 8's route - an ask, never a silent default
    const pickup = engine(["next"]);
    expect(pickup.kind).toBe("ask");
    expect(pickup.message).toContain("Rework how the reporting service paginates very large exports");

    // the conductor reaches creation later with the text and a chosen scope; the envelope is found by its text
    const create = engine(["next", "--scope", "feature", "--", "Rework how the reporting service paginates very large exports"]);
    expect(create.kind).toBe("print");
    expect(create.message).toContain(`--request ${id}`);

    // withdrawn from the browser: gone from the file and the payload
    expect((await authorized(`/api/intents?id=${encodeURIComponent(id)}`, { method: "DELETE" })).status).toBe(200);
    expect((await authorized(`/api/intents?id=${encodeURIComponent(id)}`, { method: "DELETE" })).status).toBe(404);
    expect(readPendingIntentRequests(project, "default")).toEqual([]);
    const bare = engine(["next"]);
    expect(bare.kind).toBe("error");
    expect(bare.message).toContain("No workflow state found");
  }, 60_000);
});
