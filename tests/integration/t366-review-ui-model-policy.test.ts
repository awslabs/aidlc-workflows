// t366 - Settings: the browser edits the project's model policy through the
// one writer the terminal uses (`aidlc config models`).
//
// What a consumer observes: POST /api/models-policy with a preset, a group
// effort, a per-agent exception, or a reset writes the chosen layer
// (aidlc.settings.json for `project`, aidlc.settings.local.json for `local`),
// the agent surfaces carry the new effort, and the next /api/workflow shows the
// effective per-group result with the layers recorded; malformed changes are
// refused with 400 and write nothing; an unauthenticated call is 401.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverInfoPath, type ServerInfo } from "../../core/tools/aidlc-review-ui-shared.ts";
import type { ModelsPolicyView } from "../../core/tools/aidlc-review-ui-workflow.ts";
import { writeClaudeDefaultSessionEffort } from "../../core/tools/aidlc-review-ui-acp.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DAEMON = join(ROOT, "core", "tools", "aidlc-review-ui.ts");
const TOKEN_HEADER = "X-AIDLC-Token";

let temp = "";
let project = "";
let infoPath = "";
let info: ServerInfo;
let daemon: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;

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
      throw new Error(`daemon exited ${daemon?.exitCode}: ${await new Response(daemon!.stderr).text()}`);
    }
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for review UI server.json");
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers({ [TOKEN_HEADER]: info.token });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

async function policy(): Promise<ModelsPolicyView> {
  const workflow = (await api("GET", "/api/workflow")).body as { models_policy: ModelsPolicyView };
  return workflow.models_policy;
}

function group(view: ModelsPolicyView, id: string) {
  return view.groups.find((entry) => entry.id === id)!;
}

function agentEffort(name: string): string | null {
  const text = readFileSync(join(project, ".claude", "agents", `aidlc-${name}-agent.md`), "utf-8");
  return /^effort:\s*(\S+)/m.exec(text)?.[1] ?? null;
}

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), "aidlc-review-policy-"));
  project = join(temp, "project");
  // A real install: the CLI needs the harness tree and the workspace shell.
  cpSync(join(ROOT, "dist", "claude", ".claude"), join(project, ".claude"), { recursive: true });
  cpSync(join(ROOT, "dist", "claude", "aidlc"), join(project, "aidlc"), { recursive: true });
  const env = {
    ...process.env,
    AIDLC_REVIEW_HOME: join(temp, "review-home"),
    AIDLC_REVIEW_PORT: "0",
    AIDLC_REVIEW_HOST: "127.0.0.1",
    AIDLC_REVIEW_OPEN: "0",
    AIDLC_REVIEW_UI: "1",
    AIDLC_REVIEW_RUNNER: "0",
    AIDLC_HARNESS_DIR: ".claude",
    AIDLC_STAGE_GRAPH: join(ROOT, "dist", "claude", ".claude", "tools", "data", "stage-graph.json"),
  } as Record<string, string>;
  infoPath = serverInfoPath(project, env);
  daemon = Bun.spawn([process.execPath, DAEMON, "serve", "--project-dir", project], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  info = await waitForServerInfo();
});

afterAll(async () => {
  if (daemon) {
    daemon.kill("SIGTERM");
    await daemon.exited;
  }
  if (temp) rmSync(temp, { recursive: true, force: true });
});

describe("t366 review UI model policy settings", () => {
  test("a fresh install shows the shipped policy and no recorded layers", async () => {
    const view = await policy();
    expect(view).toMatchObject({ harness: "claude", preset: null, shipped_defaults: true, exceptions: [] });
    expect(view.recorded).toEqual({ global: null, project: null, local: null });
    expect(group(view, "reviewing").effort).toBe("medium");
    expect(group(view, "deciding").effort).toBe("inherit");
    expect(view.efforts).toContain("xhigh");
  }, 30_000);

  test("auth and validation: 401 without the token, 400 for malformed changes, nothing written", async () => {
    expect((await fetch(`http://127.0.0.1:${info.port}/api/models-policy`, { method: "POST", body: "{}" })).status).toBe(401);
    for (const body of [
      {},
      { scope: "global", action: "preset", preset: "thorough" },
      { scope: "project", action: "preset", preset: "maximal" },
      { scope: "project", action: "group", group: "everyone", effort: "high" },
      { scope: "project", action: "group", group: "reviewing", effort: "turbo" },
      { scope: "project", action: "agent", agent: "Architect!", effort: "high" },
      { scope: "project", action: "agent", agent: "architect", effort: "high", model: "not a model id" },
      { scope: "project", action: "explode" },
      { scope: "project", action: "clear-group", group: "reviewing" },
    ]) {
      expect((await api("POST", "/api/models-policy", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(existsSync(join(project, "aidlc.settings.json"))).toBe(false);
    expect(existsSync(join(project, "aidlc.settings.local.json"))).toBe(false);
  }, 30_000);

  test("a project preset, a group dial, and a per-agent exception land in the committed layer and the agent surfaces", async () => {
    const preset = await api("POST", "/api/models-policy", { scope: "project", action: "preset", preset: "thorough" });
    expect(preset.status, JSON.stringify(preset.body)).toBe(200);
    let view = preset.body.models_policy as ModelsPolicyView;
    expect(view.preset).toBe("thorough");
    expect(group(view, "reviewing").effort).toBe("xhigh");
    expect(view.recorded.project?.preset).toBe("thorough");
    expect(agentEffort("product-lead")).toBe("xhigh");

    expect((await api("POST", "/api/models-policy", { scope: "project", action: "group", group: "writing-up", effort: "low" })).status).toBe(200);
    view = await policy();
    expect(group(view, "writing-up").effort).toBe("low");
    expect(view.recorded.project?.groups["writing-up"]).toBe("low");
    expect(agentEffort("delivery")).toBe("low");

    const exception = await api("POST", "/api/models-policy", { scope: "project", action: "agent", agent: "architect", effort: "xhigh" });
    expect(exception.status, JSON.stringify(exception.body)).toBe(200);
    view = exception.body.models_policy as ModelsPolicyView;
    expect(view.exceptions).toEqual([{ agent: "architect", group: "deciding", model: null, effort: "xhigh" }]);
    expect(group(view, "deciding").agents).not.toContain("architect");
    expect(agentEffort("architect")).toBe("xhigh");

    const recorded = JSON.parse(readFileSync(join(project, "aidlc.settings.json"), "utf-8")) as { models: Record<string, unknown> };
    expect(recorded.models).toMatchObject({ preset: "thorough", groups: { "writing-up": { effort: "low" } }, agents: { architect: { effort: "xhigh" } } });

    // A model pin is stored per harness (`model: { claude: ... }`); the recorded view resolves it for this one.
    const pinned = await api("POST", "/api/models-policy", { scope: "project", action: "agent", agent: "operations", effort: "high", model: "claude-sonnet-5" });
    expect(pinned.status, JSON.stringify(pinned.body)).toBe(200);
    view = pinned.body.models_policy as ModelsPolicyView;
    expect(view.recorded.project?.agents.operations).toEqual({ effort: "high", model: "claude-sonnet-5" });
    expect(view.exceptions.find((entry) => entry.agent === "operations")).toMatchObject({ effort: "high", model: "claude-sonnet-5" });
    const stored = JSON.parse(readFileSync(join(project, "aidlc.settings.json"), "utf-8")) as { models: { agents: Record<string, { model?: unknown }> } };
    expect(stored.models.agents.operations.model).toEqual({ claude: "claude-sonnet-5" });
  }, 30_000);

  test("the personal default effort is written into the harness's own settings, keeping every other key", async () => {
    // The runner is off in this daemon (no launch), so the write is refused: 409, nothing created.
    const refused = await api("POST", "/api/default-effort", { level: "high" });
    expect(refused.status).toBe(409);
    expect(existsSync(join(project, ".claude", "settings.local.json"))).toBe(false);

    // The Claude profile's writer itself: merge one key into settings.local.json atomically.
    const local = join(project, ".claude", "settings.local.json");
    writeFileSync(local, `${JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, effortLevel: "medium" }, null, 2)}\n`);
    expect(writeClaudeDefaultSessionEffort(project, "xhigh")).toEqual({ level: "xhigh", source: ".claude/settings.local.json" });
    expect(JSON.parse(readFileSync(local, "utf-8"))).toEqual({ permissions: { allow: ["Bash(ls:*)"] }, effortLevel: "xhigh" });
    expect(writeClaudeDefaultSessionEffort(project, null)?.source ?? null).not.toBe(".claude/settings.local.json");
    expect(JSON.parse(readFileSync(local, "utf-8"))).toEqual({ permissions: { allow: ["Bash(ls:*)"] } });
    writeFileSync(local, "[]\n");
    expect(() => writeClaudeDefaultSessionEffort(project, "low")).toThrow(/not a JSON object/);
    expect(readFileSync(local, "utf-8")).toBe("[]\n");
    rmSync(local);
  }, 30_000);

  test("the local layer overrides the committed one for this machine only, and reset clears just that layer", async () => {
    expect((await api("POST", "/api/models-policy", { scope: "local", action: "group", group: "reviewing", effort: "medium" })).status).toBe(200);
    let view = await policy();
    expect(group(view, "reviewing").effort).toBe("medium");
    expect(view.recorded.local?.groups.reviewing).toBe("medium");
    expect(view.recorded.project?.preset).toBe("thorough");
    expect(agentEffort("product-lead")).toBe("medium");

    expect((await api("POST", "/api/models-policy", { scope: "local", action: "reset" })).status).toBe(200);
    view = await policy();
    expect(view.recorded.local).toBeNull();
    expect(group(view, "reviewing").effort).toBe("xhigh");
    expect(agentEffort("product-lead")).toBe("xhigh");
  }, 30_000);
});
