import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import {
  serverInfoPath,
  type ServerInfo,
} from "../../core/tools/aidlc-review-ui-shared.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DAEMON = join(ROOT, "core", "tools", "aidlc-review-ui.ts");
const ORCHESTRATE = join(ROOT, "core", "tools", "aidlc-orchestrate.ts");
const AIDLC_LOG = join(ROOT, "core", "tools", "aidlc-log.ts");
const INTENT = "decision-fixture-12345678";
let temp = "";
let project = "";
let reviewHome = "";
let graphPath = "";
let record = "";
let stageDir = "";
let statePath = "";
let infoPath = "";
let info: ServerInfo;
let daemon: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;

function projectRelative(path: string): string {
  return relative(project, path).split(sep).join("/");
}

async function waitForServerInfo(): Promise<ServerInfo> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(infoPath)) {
      try {
        const parsed = JSON.parse(readFileSync(infoPath, "utf-8")) as ServerInfo;
        if (parsed.port > 0 && parsed.token) return parsed;
      } catch {
        // Atomic replacement can race this read.
      }
    }
    if (daemon?.exitCode !== null) {
      const stderr = daemon?.stderr instanceof ReadableStream
        ? await new Response(daemon.stderr).text()
        : "";
      throw new Error(`daemon exited ${daemon?.exitCode}: ${stderr}`);
    }
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for review UI server.json");
}

function authorized(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-AIDLC-Token", info.token);
  return fetch(`http://127.0.0.1:${info.port}${path}`, { ...init, headers });
}

function decisionBody(decision: "approve" | "request-changes" = "request-changes") {
  return {
    stage: "requirements-analysis",
    unit: null,
    revision: 1,
    decision,
    notes: decision === "request-changes" ? "Tighten the retention SLA." : undefined,
  };
}

function auditText(): string {
  const auditDir = join(record, "audit");
  if (!existsSync(auditDir)) return "";
  return Array.from(new Bun.Glob("*.md").scanSync(auditDir))
    .map((file) => readFileSync(join(auditDir, file), "utf-8"))
    .join("\n");
}

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), "aidlc-review-decision-"));
  project = join(temp, "project");
  reviewHome = join(temp, "review-home");
  graphPath = join(temp, "stage-graph.json");
  record = join(project, "aidlc", "spaces", "default", "intents", INTENT);
  stageDir = join(record, "inception", "requirements-analysis");
  statePath = join(record, "aidlc-state.md");
  mkdirSync(join(stageDir, ".review-ui"), { recursive: true });
  writeFileSync(join(project, "aidlc", "active-space"), "default\n");
  mkdirSync(join(record, ".review-ui"), { recursive: true });
  writeFileSync(join(project, "aidlc", "spaces", "default", "intents", "active-intent"), `${INTENT}\n`);
  writeFileSync(
    statePath,
    [
      "# AI-DLC State Tracking",
      "",
      "- **State Version**: 8",
      "- **Workflow**: feature",
      "- **Scope**: feature",
      "- **Revision Count**: 1",
      "- **Lifecycle Phase**: INCEPTION",
      "- **Current Stage**: requirements-analysis",
      "- **Status**: Waiting",
      "",
      "## Stage Progress",
      "- [?] requirements-analysis — EXECUTE",
      "- [ ] code-generation — EXECUTE",
      "",
    ].join("\n"),
  );
  writeFileSync(join(stageDir, "requirements.md"), "# Requirements\n");
  writeFileSync(join(stageDir, "requirements-analysis-questions.md"), "# Questions\n");
  writeFileSync(join(stageDir, ".review-ui", "feedback-001.md"), [
    "---",
    "aidlc_review_feedback: 1",
    "stage: requirements-analysis",
    "unit: null",
    "revision: 1",
    "created: 2026-09-05T10:00:00Z",
    "decision_hint: request-changes",
    "---",
    "Browser feedback.",
  ].join("\n"));
  writeFileSync(join(record, ".review-ui", "current.json"), `${JSON.stringify({
    version: 1,
    state: "awaiting-approval",
    stage: "requirements-analysis",
    unit: null,
    stage_dir: projectRelative(stageDir),
    revision: 1,
    updated_at: "2026-09-05T10:00:00Z",
    open: null,
  }, null, 2)}\n`);
  writeFileSync(graphPath, `${JSON.stringify([
    {
      slug: "requirements-analysis",
      number: "2.2",
      name: "Requirements Analysis",
      phase: "inception",
      execution: "CONDITIONAL",
      lead_agent: "aidlc-product-agent",
      support_agents: [],
      mode: "gated",
      produces: ["requirements.md"],
    },
    {
      slug: "code-generation",
      number: "3.5",
      name: "Code Generation",
      phase: "construction",
      execution: "CONDITIONAL",
      lead_agent: "aidlc-developer-agent",
      support_agents: [],
      mode: "gated",
    },
  ], null, 2)}\n`);
  const env = {
    ...process.env,
    AIDLC_REVIEW_UI: "1",
    AIDLC_REVIEW_HOME: reviewHome,
    AIDLC_REVIEW_PORT: "0",
    AIDLC_REVIEW_HOST: "127.0.0.1",
    AIDLC_REVIEW_OPEN: "0",
    AIDLC_STAGE_GRAPH: graphPath,
  };
  infoPath = serverInfoPath(project, env);
  daemon = Bun.spawn([process.execPath, DAEMON, "serve", "--project-dir", project], {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
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

describe("t362 review UI decision", () => {
  test("authenticates, rejects stale state, and writes schema plus HUMAN_TURN", async () => {
    const base = `http://127.0.0.1:${info.port}`;
    expect((await fetch(`${base}/api/decision`, { method: "POST", body: "{}" })).status).toBe(401);

    const stale = await authorized("/api/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...decisionBody(), revision: 0 }),
    });
    expect(stale.status).toBe(409);

    const saved = await authorized("/api/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(decisionBody()),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ file: "decision-001.json" });
    expect(JSON.parse(readFileSync(join(stageDir, ".review-ui", "decision-001.json"), "utf-8"))).toMatchObject({
      version: 1,
      stage: "requirements-analysis",
      unit: null,
      revision: 1,
      decision: "request-changes",
      notes: "Tighten the retention SLA.",
      feedback_file: "feedback-001.md",
    });
    expect(auditText()).toContain("**Event**: HUMAN_TURN");
    expect(auditText()).toContain("**Mode**: browser");
    expect(auditText()).toContain("**Source**: review-ui");
    expect(auditText()).toContain("**Submission**: decision-001.json");
    const commandEnv = { ...process.env, AIDLC_STAGE_GRAPH: graphPath };
    const waited = Bun.spawnSync({
      cmd: [process.execPath, AIDLC_LOG, "decision-wait", "--stage", "requirements-analysis", "--timeout", "0", "--project-dir", project],
      env: commandEnv,
      stdout: "pipe",
    });
    expect(waited.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(waited.stdout))).toEqual({
      ready: true,
      file: "decision-001.json",
    });
    const applied = Bun.spawnSync({
      cmd: [process.execPath, AIDLC_LOG, "decision-apply", "--stage", "requirements-analysis", "--project-dir", project],
      env: commandEnv,
      stdout: "pipe",
    });
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(applied.stdout))).toMatchObject({
      decision: "request-changes",
      notes: "Tighten the retention SLA.",
    });
    const timedOut = Bun.spawnSync({
      cmd: [process.execPath, AIDLC_LOG, "decision-wait", "--stage", "code-generation", "--timeout", "0", "--project-dir", project],
      env: commandEnv,
      stdout: "pipe",
    });
    expect(timedOut.exitCode).toBe(3);
    expect(JSON.parse(new TextDecoder().decode(timedOut.stdout))).toEqual({
      ready: false,
      waited_seconds: 0,
    });
  });

  test("report uses decision notes and consumes the decision", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        ORCHESTRATE,
        "report",
        "--stage",
        "requirements-analysis",
        "--result",
        "rejected",
        "--user-input",
        "Request Changes",
        "--project-dir",
        project,
      ],
      cwd: ROOT,
      env: {
        ...process.env,
        AIDLC_REVIEW_UI: "1",
        AIDLC_REVIEW_HOME: reviewHome,
        AIDLC_STAGE_GRAPH: graphPath,
        AIDLC_RUNTIME_HARNESS_ROOT: join(ROOT, "dist", "claude", ".claude"),
        AIDLC_SKIP_ARTIFACT_GUARD: "1",
        AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = JSON.parse(new TextDecoder().decode(result.stdout).trim()) as { kind: string; message?: string };
    expect(output.kind, output.message).not.toBe("error");
    const consumed = JSON.parse(readFileSync(join(stageDir, ".review-ui", "consumed.json"), "utf-8"));
    expect(consumed.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "decision-001.json", result: "decision-applied" }),
    ]));
    expect(auditText()).toContain("Tighten the retention SLA.");
  }, 30_000);
});
