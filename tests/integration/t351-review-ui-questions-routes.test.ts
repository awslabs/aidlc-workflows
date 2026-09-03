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
const TOKEN_HEADER = "X-AIDLC-Token";
const INTENT = "questions-fixture-12345678";

let temp = "";
let project = "";
let reviewHome = "";
let graphPath = "";
let statePath = "";
let questionsPath = "";
let questionsFile = "";
let stagePath = "";
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
        // The discovery file is atomically replaced and can race a read.
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
  headers.set(TOKEN_HEADER, info.token);
  return fetch(`http://127.0.0.1:${info.port}${path}`, { ...init, headers });
}

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), "aidlc-review-questions-"));
  project = join(temp, "project");
  reviewHome = join(temp, "review-home");
  graphPath = join(temp, "stage-graph.json");
  const record = join(project, "aidlc", "spaces", "default", "intents", INTENT);
  stagePath = join(record, "inception", "requirements-analysis");
  questionsPath = join(stagePath, "requirements-analysis-questions.md");
  questionsFile = projectRelative(questionsPath);
  statePath = join(record, "aidlc-state.md");

  mkdirSync(stagePath, { recursive: true });
  writeFileSync(join(project, "aidlc", "active-space"), "default\n");
  writeFileSync(join(project, "aidlc", "spaces", "default", "intents", "active-intent"), `${INTENT}\n`);
  writeFileSync(
    statePath,
    [
      "# AI-DLC State Tracking",
      "",
      "## Runtime State",
      "- **Revision Count**: 0",
      "",
      "## Stage Progress",
      "- [-] requirements-analysis — EXECUTE",
      "- [ ] code-generation — EXECUTE",
      "",
      "## Current Status",
      "- **Lifecycle Phase**: INCEPTION",
      "- **Current Stage**: requirements-analysis",
      "- **Status**: Running",
      "",
    ].join("\n"),
  );
  writeFileSync(
    questionsPath,
    [
      "# Requirements Questions",
      "",
      "## Q1. Which deployment model?",
      "",
      "Choose one model.",
      "",
      "A. Regional",
      "B. Global",
      "X. Other",
      "",
      "[Answer]:",
      "[Note]:",
      "",
      "## Q2: Which controls? (select all that apply)",
      "",
      "Choose the required controls.",
      "",
      "A. Encryption",
      "B. Audit logs",
      "",
      "[Answer]:",
      "",
      "## Consolidated Summary Confirmation",
      "",
      "- Looks correct",
      "- Request changes",
      "",
      "[Answer]:",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(stagePath, "requirements-analysis-questions-guide.html"),
    "<!doctype html><title>Requirements questions guide</title>\n",
  );
  writeFileSync(join(stagePath, "other.md"), "# Not the current questions file\n");
  writeFileSync(
    graphPath,
    `${JSON.stringify([
      {
        slug: "requirements-analysis",
        number: "2.2",
        name: "Requirements Analysis",
        phase: "inception",
        execution: "CONDITIONAL",
        lead_agent: "aidlc-product-agent",
        support_agents: [],
        mode: "gated",
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
        for_each: "unit-of-work",
      },
    ], null, 2)}\n`,
  );

  const env = {
    ...process.env,
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
      // This integration test owns a real daemon process; poll its actual exit
      // state so teardown can escalate instead of leaving a process behind.
      while (daemon.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
      if (daemon.exitCode === null) {
        daemon.kill("SIGKILL");
        await daemon.exited;
      }
    }
    const discoveryDeadline = Date.now() + 2_000;
    while (existsSync(infoPath) && Date.now() < discoveryDeadline) await Bun.sleep(20);
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
});

describe("t351 review UI questions routes", () => {
  test("derives the current questions target and exclusively records validated answers", async () => {
    const base = `http://127.0.0.1:${info.port}`;
    expect((await fetch(`${base}/api/questions?path=${encodeURIComponent(questionsFile)}`)).status).toBe(401);
    expect((await fetch(`${base}/api/answers`, { method: "POST", body: "{}" })).status).toBe(401);

    const state = await authorized("/api/state");
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({
      questions: {
        file: questionsFile,
        guide: projectRelative(join(stagePath, "requirements-analysis-questions-guide.html")),
        stage: "requirements-analysis",
        stage_dir: projectRelative(stagePath),
      },
    });

    const questionsResponse = await authorized(`/api/questions?path=${encodeURIComponent(questionsFile)}`);
    expect(questionsResponse.status).toBe(200);
    const questions = await questionsResponse.json() as {
      path: string;
      sha256: string;
      stage: string;
      questions: Array<Record<string, unknown>>;
    };
    expect(questions).toMatchObject({
      path: questionsFile,
      stage: "requirements-analysis",
      questions: [
        {
          id: "Q1",
          title: "Q1. Which deployment model?",
          prompt: "Choose one model.",
          options: [
            { letter: "A", text: "Regional" },
            { letter: "B", text: "Global" },
            { letter: "X", text: "Other" },
          ],
          multi: false,
          answer: null,
          note: null,
          confirmation: false,
        },
        {
          id: "Q2",
          multi: true,
          confirmation: false,
        },
        {
          id: "summary-confirmation",
          options: [
            { letter: null, text: "Looks correct" },
            { letter: null, text: "Request changes" },
          ],
          confirmation: true,
        },
      ],
    });
    expect(questions.sha256).toMatch(/^[0-9a-f]{64}$/);

    const badLetter = await authorized("/api/answers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questions_file: questionsFile,
        source_sha256: questions.sha256,
        answers: [{ id: "Q1", labels: ["Z"] }],
      }),
    });
    expect(badLetter.status).toBe(400);
    expect(await badLetter.json()).toEqual({
      error: 'invalid question answers: label "Z" is not valid for question "Q1"',
    });

    const escapedGet = await authorized("/api/questions?path=aidlc%2F..%2Foutside.md");
    expect(escapedGet.status).toBe(403);
    const escapedPost = await authorized("/api/answers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questions_file: "aidlc/../outside.md",
        source_sha256: questions.sha256,
        answers: [],
      }),
    });
    expect(escapedPost.status).toBe(403);
    const otherFile = projectRelative(join(stagePath, "other.md"));
    expect((await authorized(`/api/questions?path=${encodeURIComponent(otherFile)}`)).status).toBe(409);

    const saved = await authorized("/api/answers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questions_file: questionsFile,
        source_sha256: questions.sha256,
        answers: [
          { id: "Q1", labels: ["b"], note: "Prefer global failover." },
          { id: "Q2", labels: ["A", "B"] },
        ],
      }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ file: "answers-001.json" });
    const diskSubmission = JSON.parse(
      readFileSync(join(stagePath, ".review-ui", "answers-001.json"), "utf-8"),
    );
    expect(diskSubmission).toMatchObject({
      version: 1,
      questions_file: questionsFile,
      source_sha256: questions.sha256,
      answers: [
        { id: "Q1", labels: ["B"], note: "Prefer global failover." },
        { id: "Q2", labels: ["A", "B"] },
      ],
    });
    expect(diskSubmission.created).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

    writeFileSync(questionsPath, `${readFileSync(questionsPath, "utf-8")}<!-- changed -->\n`);
    const stale = await authorized("/api/answers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questions_file: questionsFile,
        source_sha256: questions.sha256,
        answers: [{ id: "Q1", labels: ["A"] }],
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "questions file changed; reload" });

    const oversized = await authorized("/api/answers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(256 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);

    const perUnitStage = join(
      project,
      "aidlc",
      "spaces",
      "default",
      "intents",
      INTENT,
      "construction",
      "code-generation",
    );
    mkdirSync(perUnitStage, { recursive: true });
    writeFileSync(join(perUnitStage, "code-generation-questions.md"), "## Q1\n\nA. Proceed\n\n[Answer]:\n");
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8")
        .replace("- **Lifecycle Phase**: INCEPTION", "- **Lifecycle Phase**: CONSTRUCTION")
        .replace("- **Current Stage**: requirements-analysis", "- **Current Stage**: code-generation"),
    );
    const perUnitState = await authorized("/api/state");
    expect(perUnitState.status).toBe(200);
    expect((await perUnitState.json()).questions).toBeNull();
  });
});
